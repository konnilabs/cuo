package core_test

import (
	"context"
	"cuo.local/cuo/internal/agent"
	"cuo.local/cuo/internal/core"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDurableCoreDockerUpdate(t *testing.T) {
	if os.Getenv("CUO_DOCKER_E2E") != "1" {
		t.Skip("opt-in disposable Docker/Core integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		out, e := exec.CommandContext(ctx, "docker", args...).Output()
		if e != nil {
			t.Fatalf("Docker fixture failed: %s %v", out, e)
		}
		return strings.TrimSpace(string(out))
	}
	suffix := fmt.Sprint(time.Now().UnixNano())
	name := "cuo-core-e2e-" + suffix
	rawID := run("run", "-d", "--name", name, "--label", "cuo.managed=true", "--label", "cuo.test="+suffix, "busybox:1.36.0", "sleep", "3600")
	t.Cleanup(func() {
		out, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=cuo.test="+suffix).Output()
		ids := strings.Fields(string(out))
		if len(ids) > 0 {
			exec.Command("docker", append([]string{"rm", "-f"}, ids...)...).Run()
		}
	})
	d := agent.NewDocker()
	if e := d.Init(ctx); e != nil {
		t.Fatal(e)
	}
	a := &agent.Agent{Docker: d, Token: strings.Repeat("z", 32), Dir: t.TempDir()}
	as := httptest.NewServer(a)
	defer as.Close()
	store, e := core.Open(filepath.Join(t.TempDir(), "core.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer store.DB.Close()
	engine := core.NewEngine(store)
	engine.AgentURL = as.URL
	engine.AgentToken = a.Token
	items, e := engine.Discover(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var container core.Container
	for _, c := range items {
		if c.Name == name {
			container = c
		}
	}
	if container.EngineID != rawID || container.ID == rawID {
		t.Fatal("logical engine identity boundary failed", container)
	}
	target, _, e := agent.RegistryManifest(ctx, "busybox:1.37.0", container.Platform)
	if e != nil {
		t.Fatal(e)
	}
	// A deterministic registry-tag-change fixture; execution still performs real
	// digest pulling, source/platform checks, recreation and health verification.
	candidate := core.Candidate{ContainerID: container.ID, Source: container.ImageID, Target: target, Ref: container.Image, Platform: container.Platform, Discovered: time.Now().UTC().Format(time.RFC3339)}
	_ = store.Put("candidate", container.ID, candidate)
	_, _ = engine.Discover(ctx)
	_ = store.Put("policy", "fixture", core.Policy{ID: "fixture", Scope: "container", Target: container.ID, Mode: "approval-required", Concurrency: 1})
	server := &core.Server{Engine: engine, Token: "internal-test"}
	call := func(path, body, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer internal-test")
		r.Header.Set("X-CUO-Actor", "test-owner")
		r.Header.Set("X-CUO-Role", "Owner")
		r.Header.Set("X-CUO-Hosts", "local")
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	created := call("/api/v1/update-jobs", fmt.Sprintf(`{"containerId":%q,"reason":"isolated integration test","confirmed":true}`, container.ID), "create-e2e-job")
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	var job core.Job
	if json.Unmarshal(created.Body.Bytes(), &job) != nil || job.State != "pending_approval" {
		t.Fatal(created.Body.String())
	}
	if response := call("/api/v1/update-jobs/"+job.ID+"/approve", `{"reason":"test approval","confirmed":true}`, "approve-e2e-job"); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	workerCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); engine.Worker(workerCtx) }()
	defer func() { stop(); <-done }()
	engine.Notify()
	for i := 0; i < 500; i++ {
		_ = store.Get("job", job.ID, &job)
		if job.State == "succeeded" {
			break
		}
		if job.State == "failed" || job.State == "intervention_required" {
			t.Fatal(job)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if job.State != "succeeded" {
		t.Fatal("durable job did not complete", job)
	}
	items, e = engine.Discover(ctx)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, c := range items {
		if c.ID == container.ID {
			found = true
			if c.EngineID == rawID || c.Mode != "approval-required" {
				t.Fatal("identity or policy lost after actual recreation", c)
			}
		}
	}
	if !found {
		t.Fatal("logical workload missing")
	}
	events, e := store.Events(0, core.Principal{Hosts: []string{"local"}})
	if e != nil {
		t.Fatal(e)
	}
	stages := map[string]bool{}
	for _, event := range events {
		if event.JobID == job.ID {
			stages[event.Stage] = true
		}
	}
	for _, stage := range []string{"pending_approval", "queued", "preflight", "pulling", "recreating", "verifying", "succeeded"} {
		if !stages[stage] {
			t.Fatal("missing durable stage", stage)
		}
	}
	if e = store.Recover(); e != nil {
		t.Fatal(e)
	}
	_ = store.Get("job", job.ID, &job)
	if job.State != "succeeded" {
		t.Fatal("completed job replayed on recovery")
	}
	t.Log("real Core API -> durable approval/job -> authenticated agent -> Docker update; stable policy/history and full event stages verified")
}

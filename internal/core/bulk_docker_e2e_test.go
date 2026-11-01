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

func TestDisposableBulkRun(t *testing.T) {
	if os.Getenv("CUO_DOCKER_E2E") != "1" {
		t.Skip("opt-in disposable bulk Docker integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("fixture command failed: %s %v", output, err)
		}
		return strings.TrimSpace(string(output))
	}
	suffix := fmt.Sprint(time.Now().UnixNano())
	prefix := "cuo-bulk-e2e-" + suffix
	t.Cleanup(func() {
		output, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=cuo.test="+suffix).Output()
		if ids := strings.Fields(string(output)); len(ids) > 0 {
			exec.Command("docker", append([]string{"rm", "-f"}, ids...)...).Run()
		}
	})
	for _, id := range []string{"one", "two"} {
		run("run", "-d", "--name", prefix+"-"+id, "--label", "cuo.managed=true", "--label", "cuo.test="+suffix, "busybox:1.36.0", "sleep", "3600")
	}
	docker := agent.NewDocker()
	if err := docker.Init(ctx); err != nil {
		t.Fatal(err)
	}
	a := &agent.Agent{Docker: docker, Token: strings.Repeat("b", 32), Dir: t.TempDir()}
	upstream := httptest.NewServer(a)
	defer upstream.Close()
	store, err := core.Open(filepath.Join(t.TempDir(), "core.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	engine := core.NewEngine(store)
	engine.AgentURL = upstream.URL
	engine.AgentToken = a.Token
	items, err := engine.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The test-owned database permits updates only for the two uniquely labelled
	// fixtures. No existing workload receives a candidate or execution policy.
	_ = store.Put("policy", "global", core.Policy{ID: "global", Scope: "global", Mode: "scan-only", Concurrency: 2})
	originals := map[string]core.Container{}
	for _, c := range items {
		if !strings.HasPrefix(c.Name, prefix+"-") {
			continue
		}
		target, _, err := agent.RegistryManifest(ctx, "busybox:1.37.0", c.Platform)
		if err != nil {
			t.Fatal(err)
		}
		originals[c.ID] = c
		candidate := core.Candidate{ContainerID: c.ID, Source: c.ImageID, Target: target, Ref: c.Image, Platform: c.Platform, Discovered: time.Now().UTC().Format(time.RFC3339)}
		_ = store.Put("candidate", c.ID, candidate)
		_ = store.Put("policy", c.ID, core.Policy{ID: c.ID, Scope: "container", Target: c.ID, Mode: "approval-required", Concurrency: 1})
	}
	if len(originals) != 2 {
		t.Fatal("fixture discovery failed", len(originals))
	}
	if _, err = engine.Discover(ctx); err != nil {
		t.Fatal(err)
	}
	server := &core.Server{Engine: engine, Token: "bulk-test"}
	request := httptest.NewRequest("POST", "/api/v1/update-runs", strings.NewReader(`{"all":true,"confirmed":true,"reason":"disposable bulk integration"}`))
	for key, value := range map[string]string{"Authorization": "Bearer bulk-test", "X-CUO-Actor": "bulk-admin", "X-CUO-Role": "Administrator", "X-CUO-Hosts": "local", "Idempotency-Key": "bulk-integration"} {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	var batch core.UpdateRun
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &batch) != nil || len(batch.Jobs) != 2 {
		t.Fatal(response.Code, response.Body)
	}
	workerCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { engine.Worker(workerCtx); close(done) }()
	defer func() { stop(); <-done }()
	for {
		succeeded := 0
		for _, created := range batch.Jobs {
			var job core.Job
			if err = store.Get("job", created.ID, &job); err != nil {
				t.Fatal(err)
			}
			if job.State == "failed" || job.State == "intervention_required" || job.State == "cancelled" {
				t.Fatal("bulk execution failed", job)
			}
			if job.State == "succeeded" {
				succeeded++
			}
		}
		if succeeded == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("bulk run timed out")
		case <-time.After(50 * time.Millisecond):
		}
	}
	items, err = engine.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	verified := 0
	for _, c := range items {
		old, ok := originals[c.ID]
		if !ok {
			continue
		}
		if c.EngineID == old.EngineID || c.ImageID == old.ImageID || c.Mode != "approval-required" {
			t.Fatal("bulk replacement lost identity, image or policy", c)
		}
		verified++
	}
	if verified != 2 {
		t.Fatal("updated fixture missing", verified)
	}
	t.Log("two isolated workloads updated through the confirmed Core bulk API and authenticated concurrent Agent")
}

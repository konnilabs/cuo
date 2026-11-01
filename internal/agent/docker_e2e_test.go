package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Opt-in integration test: touches only containers and a volume created by this test.
func TestDisposableDockerUpdate(t *testing.T) {
	if os.Getenv("CUO_DOCKER_E2E") != "1" {
		t.Skip("set CUO_DOCKER_E2E=1 to create isolated disposable test workloads")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		out, e := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if e != nil {
			t.Fatalf("docker %v: %s %v", args, out, e)
		}
		return strings.TrimSpace(string(out))
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	name := "cuo-e2e-" + suffix
	volume := name + "-data"
	run("pull", "busybox:1.36.0")
	run("volume", "create", volume)
	id := run("run", "-d", "--name", name, "--label", "cuo.managed=true", "--label", "cuo.test="+suffix, "--env", "CUSTOM=preserved", "--publish", "127.0.0.1::8080", "--mount", "type=volume,source="+volume+",target=/data", "--health-cmd", "test -f /data/sentinel", "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "3", "busybox:1.36.0", "sh", "-c", "test -f /data/sentinel || echo stable > /data/sentinel; exec sleep 3600")
	publishedPort := run("port", id, "8080/tcp")
	newID := ""
	defer func() {
		ids := []string{id}
		if newID != "" {
			ids = append(ids, newID)
		}
		exec.Command("docker", append([]string{"rm", "-f"}, ids...)...).Run()
		exec.Command("docker", "volume", "rm", volume).Run()
	}()
	d := NewDocker()
	if e := d.Init(ctx); e != nil {
		t.Fatal(e)
	}
	before, e := d.Inspect(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	im := map[string]any{}
	if e = d.Request(ctx, "GET", d.Path("/images/"+str(before, "Image")+"/json"), nil, &im); e != nil {
		t.Fatal(e)
	}
	platform := str(im, "Os") + "/" + str(im, "Architecture")
	if v := str(im, "Variant"); v != "" {
		platform += "/" + v
	}
	target, _, e := RegistryManifest(ctx, "busybox:1.37.0", platform)
	if e != nil {
		t.Fatal(e)
	}
	op := Operation{JobID: strings.Repeat("a", 32), ContainerID: id, Source: str(before, "Image"), Target: target, Image: "busybox:1.36.0", Platform: platform}
	a := &Agent{Docker: d, Dir: t.TempDir()}
	w := httptest.NewRecorder()
	a.Execute(w, op)
	decoder := json.NewDecoder(w.Body)
	var last Frame
	for decoder.More() {
		var f Frame
		if e = decoder.Decode(&f); e != nil {
			t.Fatal(e)
		}
		last = f
		if f.NewID != "" {
			newID = f.NewID
		}
	}
	if last.Stage != "succeeded" {
		t.Fatal("update failed", last, w.Body.String())
	}
	after, e := d.Inspect(ctx, newID)
	if e != nil {
		t.Fatal(e)
	}
	if str(after, "Image") == str(before, "Image") {
		t.Fatal("image did not change")
	}
	if run("exec", newID, "cat", "/data/sentinel") != "stable" {
		t.Fatal("volume data was lost")
	}
	env := obj(after, "Config")["Env"].([]any)
	found := false
	for _, v := range env {
		found = found || v == "CUSTOM=preserved"
	}
	if !found {
		t.Fatal("custom environment was lost")
	}
	if str(obj(obj(after, "Config"), "Labels"), "cuo.test") != suffix {
		t.Fatal("runtime labels were lost")
	}
	old, e := d.Inspect(ctx, id)
	if e != nil || boolean(obj(old, "State"), "Running") {
		t.Fatal("old container must remain stopped for manual recovery")
	}
	if run("port", newID, "8080/tcp") != publishedPort {
		t.Fatal("published port changed during update")
	}
	t.Log("real Docker update preserved volume, environment, labels and healthcheck; old workload retained stopped")
}

package agent

import (
	"context"
	"cuo.local/cuo/internal/core"
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
	id := run("run", "-d", "--name", name, "--label", "cuo.managed=true", "--label", "cuo.test="+suffix, "--env", "CUSTOM=preserved", "--publish", "127.0.0.1::8080", "--mount", "type=volume,source="+volume+",target=/data", "--mount", "type=bind,source=/proc,target=/host/proc,readonly", "--mount", "type=bind,source=/sys,target=/host/sys,readonly", "--health-cmd", "test -f /data/sentinel && test -r /host/proc/stat && test -r /host/sys/kernel/uevent_seqnum", "--health-interval", "1s", "--health-timeout", "1s", "--health-retries", "3", "busybox:1.36.0", "sh", "-c", "test -f /data/sentinel || echo stable > /data/sentinel; exec sleep 3600")
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
	denied := httptest.NewRecorder()
	deniedOperation := op
	deniedOperation.JobID = strings.Repeat("b", 32)
	a.Execute(denied, deniedOperation)
	if !strings.Contains(denied.Body.String(), "Host control mounts require") || strings.Contains(denied.Body.String(), `"stage":"pulling"`) {
		t.Fatal("host monitoring must be blocked before pull without permission", denied.Body.String())
	}
	op.Permissions = core.ExecutionPermissions{ReadOnlyHostMonitoring: true}
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
	for _, target := range []string{"/host/proc", "/host/sys"} {
		found := false
		for _, entry := range asArray(after["Mounts"]) {
			mount, _ := entry.(map[string]any)
			if str(mount, "Destination") != target {
				continue
			}
			found = true
			if str(mount, "Type") != "bind" || str(mount, "Source") != strings.TrimPrefix(target, "/host") || mount["RW"] != false {
				t.Fatal("read-only monitoring mount changed", mount)
			}
		}
		if !found {
			t.Fatal("monitoring mount missing", target)
		}
	}
	t.Log("real Docker update preserved read-only host monitoring mounts, volume, environment, labels, port and healthcheck; old workload retained stopped")
}

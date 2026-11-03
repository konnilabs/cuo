package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDisposableComposeReconcile(t *testing.T) {
	if os.Getenv("CUO_DOCKER_E2E") != "1" {
		t.Skip("requires freshly built cuo-agent:0.3.0 and disposable Docker fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("Docker fixture operation failed: %s %v", out, err)
		}
		return strings.TrimSpace(string(out))
	}
	dir := t.TempDir()
	project := fmt.Sprintf("cuo-e2e-compose-%d", time.Now().UnixNano())
	source := filepath.Join(dir, "compose.yaml")
	compose := `services:
  app:
    image: busybox:1.36.0
    command: [sh, -c, "test -f /data/sentinel || echo preserved > /data/sentinel; exec sleep 3600"]
    env_file: [config.env]
    environment: {MESSAGE: "${DOTENV_VALUE}"}
    labels: {cuo.managed: "true", cuo.compose.file: "compose.yaml"}
    volumes: ["data:/data", "./binding:/binding:ro"]
    healthcheck:
      test: [CMD, sh, -c, "test -f /data/sentinel && test -f /binding/marker"]
      interval: 1s
      timeout: 1s
      retries: 3
volumes: {data: {}}
`
	if err := os.WriteFile(source, []byte(compose), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DOTENV_VALUE=from-dotenv\n"), 0600)
	_ = os.WriteFile(filepath.Join(dir, "config.env"), []byte("CUSTOM=from-file\n"), 0600)
	_ = os.Mkdir(filepath.Join(dir, "binding"), 0700)
	_ = os.WriteFile(filepath.Join(dir, "binding", "marker"), []byte("host-binding"), 0600)
	args := []string{"compose", "-p", project, "-f", source}
	run(append(append([]string{}, args...), "up", "-d")...)
	t.Cleanup(func() { exec.Command("docker", append(args, "down", "-v")...).Run() })
	id := run(append(append([]string{}, args...), "ps", "-q", "app")...)
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	token := hex.EncodeToString(key)
	agentName := project + "-agent"
	journalVolume := project + "-journal"
	run("run", "-d", "--name", agentName, "-p", "127.0.0.1::8092", "-e", "CUO_AGENT_TOKEN="+token, "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", dir+":/projects:ro", "-v", journalVolume+":/data", "cuo-agent:0.3.0")
	t.Cleanup(func() {
		exec.Command("docker", "rm", "-f", agentName).Run()
		exec.Command("docker", "volume", "rm", journalVolume).Run()
	})
	port := run("inspect", "--format", `{{(index (index .NetworkSettings.Ports "8092/tcp") 0).HostPort}}`, agentName)
	endpoint := "http://127.0.0.1:" + port
	client := &http.Client{Timeout: time.Minute}
	for i := 0; i < 40; i++ {
		r, err := client.Get(endpoint + "/health")
		if err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				break
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	d := NewDocker()
	if err := d.Init(ctx); err != nil {
		t.Fatal(err)
	}
	update := func(targetRef, jobID string) string {
		t.Helper()
		before, err := d.Inspect(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		image := map[string]any{}
		if err = d.Request(ctx, "GET", d.Path("/images/"+str(before, "Image")+"/json"), nil, &image); err != nil {
			t.Fatal(err)
		}
		platform := str(image, "Os") + "/" + str(image, "Architecture")
		if variant := str(image, "Variant"); variant != "" {
			platform += "/" + variant
		}
		target, _, err := RegistryManifest(ctx, targetRef, platform)
		if err != nil {
			t.Fatal(err)
		}
		op := Operation{JobID: jobID, ContainerID: id, Source: str(before, "Image"), Target: target, Image: str(obj(before, "Config"), "Image"), Platform: platform}
		request, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/execute", strings.NewReader(string(marshal(op))))
		request.Header.Set("Authorization", "Bearer "+token)
		r, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			data, _ := io.ReadAll(r.Body)
			t.Fatal(r.StatusCode, string(data))
		}
		decoder := json.NewDecoder(r.Body)
		last := Frame{}
		for {
			var f Frame
			err = decoder.Decode(&f)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			last = f
		}
		if last.Stage != "succeeded" {
			logs, _ := exec.Command("docker", "logs", agentName).CombinedOutput()
			t.Fatal(last, string(logs))
		}
		return last.NewID
	}
	id = update("busybox:1.37.0", strings.Repeat("c", 32))
	if run("exec", id, "cat", "/binding/marker") != "host-binding" || run("exec", id, "cat", "/data/sentinel") != "preserved" {
		t.Fatal("Compose mounts were not preserved")
	}
	if run("exec", id, "printenv", "CUSTOM") != "from-file" || run("exec", id, "printenv", "MESSAGE") != "from-dotenv" {
		t.Fatal("Compose environment source was not resolved")
	}
	id = update("busybox:1.36.0", strings.Repeat("d", 32))
	if run("exec", id, "cat", "/binding/marker") != "host-binding" {
		t.Fatal("subsequent reconciliation lost original host-directory mapping")
	}
	t.Log("two real Compose reconciliations preserved desired pins, .env, env_file, named volume and relative host bind across engine-ID changes")
}

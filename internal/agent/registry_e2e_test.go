package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cuo.local/cuo/internal/provision"
	"cuo.local/cuo/internal/unioci"
)

// Self-contained real private-registry/pull test. Every modified Docker resource
// belongs to this fixture; production/installed CUO volumes are never mounted.
func TestPrivateZotScanCopyAndDockerUpdate(t *testing.T) {
	if os.Getenv("CUO_DOCKER_E2E") != "1" {
		t.Skip("requires freshly built 0.2 images and disposable Docker fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker operation %s failed: %s", args[0], out)
		}
		return strings.TrimSpace(string(out))
	}
	suffix := fmt.Sprint(time.Now().UnixNano())
	name := "cuo-private-e2e-" + suffix
	volume := name + "-data"
	secretVolume := name + "-secrets"
	workload := name + "-app"
	targetRepo := "universal/" + suffix
	defer func() {
		exec.Command("docker", "rm", "-f", name, workload).Run()
		exec.Command("docker", "volume", "rm", volume, secretVolume).Run()
	}()
	run("volume", "create", volume)
	run("volume", "create", secretVolume)
	run("run", "--rm", "--network", "none", "--user", "0", "--mount", "type=volume,source="+secretVolume+",target=/setup", "cuo-core:0.3.0", "provision", "--directory", "/setup", "--registry", "--registry-host", "localhost:5055")
	raw := run("run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "cat", "--mount", "type=volume,source="+secretVolume+",target=/setup,readonly", "cuo-core:0.3.0", "/setup/zot-client.json")
	var credentials provision.RegistryCredentials
	if json.Unmarshal([]byte(raw), &credentials) != nil {
		t.Fatal("invalid fixture bootstrap")
	}
	run("run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "chown", "--mount", "type=volume,source="+volume+",target=/registry", "cuo-core:0.3.0", "10001:10001", "/registry")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fixturePort := fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	run("run", "-d", "--name", name, "--user", "10001:10001", "--publish", "127.0.0.1:"+fixturePort+":5000", "--mount", "type=volume,source="+secretVolume+",target=/etc/zot,volume-subpath=zot,readonly", "--mount", "type=volume,source="+volume+",target=/var/lib/registry", "ghcr.io/project-zot/zot-linux-amd64@sha256:b68f727fe35c1eb45b2ae91519dfb0e33192d69b5104882c3e7809b7146c4a02", "serve", "/etc/zot/config.json")
	host := "localhost:" + strings.Split(run("port", name, "5000/tcp"), ":")[1]
	endpoint := "http://" + host
	t.Setenv("CUO_ZOT_INTERNAL_URL", endpoint)
	t.Setenv("CUO_ZOT_HOST", host)
	cfg := unioci.Config{Host: host, Endpoint: endpoint, Repositories: []string{"universal/*", "imported/*"}, PrivateNetwork: true}
	read, err := unioci.New(cfg, unioci.Credentials{Username: credentials.PullUsername, Password: credentials.PullPassword}, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		if read.Probe(ctx) == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Docker itself publishes to the private endpoint using an isolated config.
	authDir := t.TempDir()
	auth := base64.StdEncoding.EncodeToString([]byte(credentials.PushUsername + ":" + credentials.PushPassword))
	config, _ := json.Marshal(map[string]any{"auths": map[string]any{host: map[string]string{"auth": auth}}})
	os.WriteFile(filepath.Join(authDir, "config.json"), config, 0600)
	run("pull", "busybox:1.37.0")
	run("pull", "busybox:1.36.0")
	privateTag := host + "/" + targetRepo + ":stable"
	run("tag", "busybox:1.37.0", privateTag)
	defer exec.Command("docker", "image", "rm", privateTag).Run()
	pushPlatform := run("image", "inspect", "busybox:1.37.0", "--format", "{{.Os}}/{{.Architecture}}")
	run("--config", authDir, "push", "--platform", pushPlatform, privateTag)
	for _, username := range []string{"", credentials.PullUsername} {
		req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v2/universal/forbidden/blobs/uploads/", nil)
		if username != "" {
			req.SetBasicAuth(username, credentials.PullPassword)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 401 && response.StatusCode != 403 {
			t.Fatal("unauthorized push allowed", response.StatusCode)
		}
	}
	d := NewDocker()
	if err = d.Init(ctx); err != nil {
		t.Fatal(err)
	}
	id := run("run", "-d", "--name", workload, "--label", "cuo.managed=true", "--env", "PRESERVED=fixture", "busybox:1.36.0", "sleep", "3600")
	before, err := d.Inspect(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	image := map[string]any{}
	d.Request(ctx, "GET", d.Path("/images/"+str(before, "Image")+"/json"), nil, &image)
	platform := str(image, "Os") + "/" + str(image, "Architecture")
	access := &unioci.Access{Config: cfg, Credentials: unioci.Credentials{Username: credentials.PullUsername, Password: credentials.PullPassword}, Expires: time.Now().Add(2 * time.Minute).Unix()}
	dg, _, err := registryManifestAccess(ctx, privateTag, platform, access)
	if err != nil {
		t.Fatal("private scan", err)
	}
	write, _ := unioci.New(cfg, unioci.Credentials{Username: credentials.PushUsername, Password: credentials.PushPassword}, endpoint)
	if err = unioci.CopyByDigest(ctx, read, targetRepo, dg, write, "imported/test"); err != nil {
		t.Fatal("digest copy", err)
	}
	copied, err := read.Resolve(ctx, "imported/test", dg, platform)
	if err != nil || copied.Digest != dg {
		t.Fatal("copied digest", err)
	}
	bad := *access
	bad.Credentials.Password = "incorrect-fixture-password"
	if _, _, err = registryManifestAccess(ctx, privateTag, platform, &bad); err == nil {
		t.Fatal("wrong credential scanned")
	}
	bad.Expires = time.Now().Add(-time.Minute).Unix()
	if validAccess(&bad, privateTag) {
		t.Fatal("expired envelope admitted")
	}
	a := &Agent{Docker: d, Dir: t.TempDir()}
	op := Operation{JobID: strings.Repeat("e", 32), ContainerID: id, Source: str(before, "Image"), Image: "busybox:1.36.0", TargetImage: privateTag, Target: dg, Platform: platform}
	out := httptest.NewRecorder()
	a.executeWithRegistry(out, op, access)
	if !strings.Contains(out.Body.String(), `"stage":"succeeded"`) {
		t.Fatal("private Docker pull/update failed", out.Body.String())
	}
	for _, entry := range mustReadDir(t, a.Dir) {
		if entry.IsDir() {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(a.Dir, entry.Name()))
		if strings.Contains(string(data), credentials.PullPassword) || strings.Contains(string(data), credentials.PushPassword) {
			t.Fatal("agent journal leaked secret")
		}
	}
	after, err := d.Inspect(ctx, workload)
	if err != nil || str(obj(after, "Config"), "Image") != host+"/"+targetRepo+"@"+dg {
		t.Fatal("target not pinned", err)
	}
	run("restart", name)
	if err = read.Probe(ctx); err != nil {
		for i := 0; i < 200 && err != nil; i++ {
			time.Sleep(100 * time.Millisecond)
			err = read.Probe(ctx)
		}
	}
	if err != nil {
		t.Log(run("logs", "--tail", "20", name))
		t.Fatal("registry restart", err)
	}
	if _, err = read.Resolve(ctx, targetRepo, dg, platform); err != nil {
		t.Fatal("registry lost blobs", err)
	}
}
func mustReadDir(t *testing.T, path string) []os.DirEntry {
	t.Helper()
	items, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

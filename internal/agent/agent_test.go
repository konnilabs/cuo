package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestImageReferenceBoundary(t *testing.T) {
	for _, ref := range []string{"alpine:3", "docker.io/library/alpine:3", "ghcr.io/org/image:stable"} {
		_, _, _, e := splitRef(ref)
		if e != nil {
			t.Fatal(ref, e)
		}
	}
	for _, ref := range []string{"localhost:5000/internal:tag", "169.254.169.254/x:latest", "x\nheader", "evil.example/repo:tag", "alpine/../../x"} {
		_, _, _, e := splitRef(ref)
		if e == nil {
			t.Fatal("unsafe ref accepted", ref)
		}
	}
	if _, e := pinned("alpine:3", "sha256:short"); e == nil {
		t.Fatal("invalid digest accepted")
	}
}
func TestAgentRejectsUnauthenticatedAndArbitraryRoutes(t *testing.T) {
	a := &Agent{Token: strings.Repeat("x", 32)}
	for _, path := range []string{"/inventory", "/containers/create", "/execute"} {
		r := httptest.NewRequest("POST", path, strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal(path, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/containers/create", nil)
	r.Header.Set("Authorization", "Bearer "+a.Token)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestDockerErrorsDoNotLeakEngineSecrets(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); w.Write([]byte(`secret=password`)) }))
	defer backend.Close()
	transport := &http.Transport{Proxy: http.ProxyURL(mustURL(backend.URL))}
	d := &Docker{HTTP: &http.Client{Transport: transport}}
	e := d.Request(context.Background(), "GET", "/bad", nil, nil)
	if e == nil || strings.Contains(e.Error(), "password") {
		t.Fatal(e)
	}
}
func TestOperationJournalSurvivesRestart(t *testing.T) {
	a := &Agent{Dir: t.TempDir()}
	op := Operation{JobID: strings.Repeat("a", 32)}
	if e := a.journal(op, Frame{Stage: "recreating", Message: "safe"}); e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	a.Execute(w, op)
	var result Frame
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil || result.Stage != "intervention_required" {
		t.Fatal(result, e)
	}
}

func mustURL(value string) *url.URL { u, _ := url.Parse(value); return u }
func TestHostControlMountBoundaryPreservesOrdinaryDockerVolumes(t *testing.T) {
	for _, m := range []map[string]any{{"Type": "volume", "Source": "/var/lib/docker/volumes/data/_data", "Destination": "/data"}, {"Type": "bind", "Source": "/srv/app/data", "Destination": "/data"}} {
		if controlMount(m, false) {
			t.Fatal("ordinary data mount rejected", m)
		}
	}
	for _, m := range []map[string]any{{"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/control"}, {"Type": "bind", "Source": "/", "Destination": "/host"}, {"Type": "bind", "Source": "/proc/sys", "Destination": "/settings"}} {
		if !controlMount(m, false) {
			t.Fatal("host control mount accepted", m)
		}
	}
}

func TestReadOnlyHostMonitoringMountBoundary(t *testing.T) {
	for _, source := range []string{"/proc", "/proc/stat", "/proc/sys", "/sys", "/sys/fs/cgroup"} {
		for _, rw := range []any{false, true, nil, "false"} {
			mount := map[string]any{"Type": "bind", "Source": source, "Destination": "/host/metrics", "RW": rw}
			if blocked := controlMount(mount, true); blocked != (rw != false) {
				t.Errorf("monitoring mount source=%s RW=%v: blocked=%v", source, rw, blocked)
			}
			if !controlMount(mount, false) {
				t.Errorf("host monitoring accepted without permission: %v", mount)
			}
		}
	}
	// Read-only monitoring is not a grant to replace container system trees,
	// expose the host's root/device/Docker state, or access a control socket.
	for _, mount := range []map[string]any{
		{"Type": "bind", "Source": "/proc", "Destination": "/proc", "RW": false},
		{"Type": "bind", "Source": "/proc", "Destination": "/sys/kernel", "RW": false},
		{"Type": "bind", "Source": "/sys", "Destination": "/dev/metrics", "RW": false},
		{"Type": "bind", "Source": "/proc/../dev", "Destination": "/host/metrics", "RW": false},
		{"Type": "bind", "Source": "/srv/data", "Destination": "/host/../proc/sys", "RW": false},
		{"Type": "bind", "Source": "/", "Destination": "/host", "RW": false},
		{"Type": "bind", "Source": "/dev", "Destination": "/host/dev", "RW": false},
		{"Type": "bind", "Source": "/var/lib/docker", "Destination": "/host/docker", "RW": false},
		{"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/control", "RW": false},
		{"Type": "bind", "Source": "/sys", "Destination": "/host/docker.sock", "RW": false},
	} {
		if !controlMount(mount, true) {
			t.Errorf("sensitive mount accepted: %v", mount)
		}
	}
}

func TestDefaultVersusPrivilegedCapabilities(t *testing.T) {
	if unsafeCapabilities([]any{"CHOWN", "CAP_NET_BIND_SERVICE", "SETUID"}) {
		t.Fatal("Docker default capabilities rejected")
	}
	for _, value := range []string{"SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "ALL", "CAP_BPF", "unknown"} {
		if !unsafeCapabilities([]any{value}) {
			t.Fatal("unsafe capability accepted", value)
		}
	}
}

func TestInventoryUsesConfiguredReferenceWhenDockerTagMoved(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			w.Write([]byte(`[{"Id":"engine","Names":["/app"],"Image":"sha256:old","ImageID":"sha256:old","State":"running","Labels":{"cuo.managed":"true"}}]`))
		case "/containers/engine/json":
			w.Write([]byte(`{"Name":"/app-cuo-deadbeef","Image":"sha256:old","Config":{"Image":"example/app:stable","Labels":{"cuo.managed":"true"}},"State":{"Status":"exited"}}`))
		case "/images/sha256:old/json":
			w.Write([]byte(`{"Os":"linux","Architecture":"amd64","RepoDigests":["example/app@sha256:old"]}`))
		default:
			t.Error("unexpected request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer backend.Close()
	a := &Agent{Docker: &Docker{HTTP: &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(mustURL(backend.URL))}}}}
	rows, err := a.Inventory(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	if rows[0].Image != "example/app:stable" || rows[0].ImageID != "sha256:old" || rows[0].State != "exited" || rows[0].Name != "app-cuo-deadbeef" || rows[0].Managed {
		t.Fatal("inventory used Docker's stale display alias/state instead of inspected configuration", rows[0])
	}
}

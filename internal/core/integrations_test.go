package core

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	digest "github.com/opencontainers/go-digest"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gh "cuo.local/cuo/internal/github"
	"cuo.local/cuo/internal/integrations"
)

func integrationEngine(t *testing.T) *Engine {
	t.Helper()
	s := testStore(t)
	e := NewEngine(s)
	key := filepath.Join(t.TempDir(), "key")
	os.WriteFile(key, []byte(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{17}, 32))), 0600)
	var err error
	e.Vault, err = integrations.OpenVault(s.DB, key)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func TestCapabilityDelegationRevisionAndRealAPI(t *testing.T) {
	e := integrationEngine(t)
	server := &Server{Engine: e, Token: "internal"}
	counter := 0
	call := func(role, method, path string, input any) *httptest.ResponseRecorder {
		counter++
		r := httptest.NewRequest(method, path, strings.NewReader(encode(input)))
		r.Header.Set("Authorization", "Bearer internal")
		r.Header.Set("X-CUO-Actor", "matrix-user")
		r.Header.Set("X-CUO-Role", role)
		r.Header.Set("X-CUO-Hosts", "local")
		r.Header.Set("Idempotency-Key", fmt.Sprint("matrix-test-", counter))
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	for _, cap := range Capabilities {
		for _, role := range []string{"Viewer", "Operator", "Administrator", "Owner"} {
			want := role == "Owner"
			for _, grant := range defaultPermissions().Roles {
				if grant.Role == role {
					for _, v := range grant.Capabilities {
						want = want || v == cap.ID
					}
				}
			}
			if e.Store.Allows(Principal{ID: "u", Role: role, Hosts: []string{"local"}}, cap.ID) != want {
				t.Fatal(role, cap.ID)
			}
		}
	}
	if w := call("Administrator", "POST", "/api/v1/registries", RegistryRequest{}); w.Code != 403 {
		t.Fatal(w.Code, w.Body)
	}
	policy := defaultPermissions()
	policy.Reason = "Delegate registry read configuration"
	for i := range policy.Roles {
		if policy.Roles[i].Role == "Operator" {
			policy.Roles[i].Capabilities = append(policy.Roles[i].Capabilities, "registry.manage", "execution.monitoring.grant")
		}
	}
	if w := call("Owner", "PUT", "/api/v1/permission-policy", policy); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call("Owner", "PUT", "/api/v1/permission-policy", policy); w.Code != 409 {
		t.Fatal("lost update accepted", w.Code, w.Body)
	}
	input := RegistryRequest{Name: "Universal", Provider: "oci", Host: "registry.example.com", Endpoint: "https://registry.example.com", Repositories: []string{"test/*"}, Enabled: true, Confirmed: true, Reason: "New private source", Username: "pull", Password: "never-public-password"}
	w := call("Operator", "POST", "/api/v1/registries", input)
	if w.Code != 200 || strings.Contains(w.Body.String(), input.Password) {
		t.Fatal(w.Code, w.Body)
	}
	var registry RegistryConnection
	json.Unmarshal(w.Body.Bytes(), &registry)
	if value, err := e.Vault.Get(registry.CredentialID, "registry"); err != nil || value != input.Password {
		t.Fatal("secret persistence", err)
	}
	var events []Event
	events, _ = e.Store.Events(0, Principal{Hosts: []string{"local"}})
	for _, event := range events {
		if strings.Contains(encode(event), input.Password) {
			t.Fatal("audit leaked secret")
		}
	}
	for _, c := range Capabilities {
		if c.OwnerOnly {
			invalid := e.Store.PermissionPolicy()
			invalid.Reason = "Try privilege escalation"
			invalid.Roles[0].Capabilities = append(invalid.Roles[0].Capabilities, c.ID)
			if validatePermissions(invalid) == nil {
				t.Fatal("delegated governance", c.ID)
			}
		}
	}
	if e.Store.Allows(Principal{Role: "Owner", Hosts: []string{"foreign"}}, "registry.manage") {
		t.Fatal("host ACL bypass")
	}
}
func TestWebhookDurableDedupConflictAndSignature(t *testing.T) {
	e := integrationEngine(t)
	id := ID()
	secret := strings.Repeat("fixture-hmac-", 4)
	e.Vault.Put("github/hook/"+id, "github-hook", secret)
	e.Store.Put("github", id, GitHubConnection{ID: id, Configured: true, Enabled: true, InstallationID: "42"})
	server := &Server{Engine: e, Token: "internal"}
	call := func(data, delivery, signature string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/internal/github/webhooks/"+id, strings.NewReader(data))
		r.Header.Set("Authorization", "Bearer internal")
		r.Header.Set("X-GitHub-Event", "workflow_run")
		r.Header.Set("X-GitHub-Delivery", delivery)
		if signature == "valid" {
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write([]byte(data))
			signature = "sha256=" + hex.EncodeToString(mac.Sum(nil))
		}
		r.Header.Set("X-Hub-Signature-256", signature)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	body := `{"action":"completed","installation":{"id":42},"repository":{"id":7},"workflow_run":{"id":99}}`
	if w := call(body, "delivery-0001", ""); w.Code != 401 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(body, "delivery-0001", "valid"); w.Code != 202 {
		t.Fatal(w.Code, w.Body)
	}
	// A new Server instance sees the persisted delivery before acknowledging it.
	server = &Server{Engine: NewEngine(e.Store), Token: "internal"}
	server.Engine.Vault = e.Vault
	if w := call(body, "delivery-0001", "valid"); w.Code != 202 || !strings.Contains(w.Body.String(), "duplicate") {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(body+" ", "delivery-0001", "valid"); w.Code != 409 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(strings.ReplaceAll(body, `"id":42`, `"id":43`), "delivery-0002", "valid"); w.Code != 403 {
		t.Fatal("foreign installation", w.Code, w.Body)
	}
	if w := call(strings.Repeat("x", (2<<20)+1), "delivery-0003", "valid"); w.Code != 413 {
		t.Fatal(w.Code)
	}
	var count int
	e.Store.DB.QueryRow(`SELECT count(*) FROM webhook_payloads`).Scan(&count)
	if count != 1 || len(e.Store.Jobs()) != 0 {
		t.Fatal("inbox side effect", count)
	}
}
func TestReleaseValidationCompletenessOrderAndAtomicJobBinding(t *testing.T) {
	e := integrationEngine(t)
	sub := Subscription{ID: ID(), Enabled: true, Revision: 1, Actor: "owner", ActorRole: "Owner", RepositoryID: "7", WorkflowID: "8", Branch: "main", Channel: "stable", Created: "2026-01-01T00:00:00Z", Targets: []SubscriptionTarget{{Component: "api", ContainerID: "one", Reference: "ghcr.io/universal/api"}, {Component: "web", ContainerID: "two", Reference: "ghcr.io/universal/web"}}}
	e.Store.Put("subscription", sub.ID, sub)
	run := gh.Run{ID: 99, RunAttempt: 1, RunNumber: 10, WorkflowID: 8, Event: "push", Status: "completed", Conclusion: "success", HeadBranch: "main", HeadSHA: strings.Repeat("a", 40), CreatedAt: "2026-11-02T00:00:00Z", HeadRepository: gh.Repository{ID: 7}}
	manifest := ReleaseManifest{Schema: "unioci.release.v1", Source: ReleaseSource{RepositoryID: "7", Revision: run.HeadSHA, WorkflowRunID: "99", RunAttempt: 1}, Version: "1.0.0", Channel: "stable", Images: []ReleaseImage{{Component: "api", Reference: "ghcr.io/universal/api", Digest: "sha256:" + strings.Repeat("b", 64)}, {Component: "web", Reference: "ghcr.io/universal/web", Digest: "sha256:" + strings.Repeat("c", 64)}}}
	if !runAllowed(sub, run) || validateRelease(manifest, sub, run) != nil {
		t.Fatal("valid release rejected")
	}
	for _, variant := range []string{"partial", "foreign", "duplicate", "revision", "channel"} {
		invalid := manifest
		invalid.Images = append([]ReleaseImage{}, manifest.Images...)
		switch variant {
		case "partial":
			invalid.Images = invalid.Images[:1]
		case "foreign":
			invalid.Images[0].Reference = "ghcr.io/attacker/api"
		case "duplicate":
			invalid.Images[1] = invalid.Images[0]
		case "revision":
			invalid.Source.Revision = strings.Repeat("d", 40)
		case "channel":
			invalid.Channel = "other"
		}
		if validateRelease(invalid, sub, run) == nil {
			t.Fatal("accepted", variant)
		}
	}
	for _, event := range []string{"pull_request", "pull_request_target", "fork"} {
		invalid := run
		invalid.Event = event
		if runAllowed(sub, invalid) {
			t.Fatal("PR/fork accepted")
		}
	}
	for i, target := range sub.Targets {
		c := runContainer(target.ContainerID)
		c.Candidate.SubscriptionID = sub.ID
		c.Candidate.ReleaseSetID = "release"
		c.Candidate.TargetOrder = i
		e.Store.Put("container", c.ID, c)
		e.Store.DB.Exec(`INSERT INTO release_targets VALUES(?,?,?,?,?)`, sub.ID, "release", c.ID, "", "ready")
	}
	e.Store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 2})
	var c Container
	e.Store.Get("container", "one", &c)
	job, err := e.CreateJob(c, Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}, "test release", false)
	if err != nil {
		t.Fatal(err)
	}
	var binding string
	e.Store.DB.QueryRow(`SELECT job FROM release_targets WHERE container='one'`).Scan(&binding)
	if binding != job.ID {
		t.Fatal("missing atomic binding")
	}
	later := job
	later.ContainerID = "two"
	later.TargetOrder = 1
	if ready, failed := e.releaseCanStart(later); ready || failed {
		t.Fatal("later step started prematurely")
	}
	job.State = "failed"
	e.Store.Put("job", job.ID, job)
	if ready, failed := e.releaseCanStart(later); ready || !failed {
		t.Fatal("failure did not stop rollout")
	}
	// Missing target binding must roll back the job, not leave an unbound outbox.
	before := len(e.Store.Jobs())
	e.Store.DB.Exec(`DELETE FROM release_targets WHERE container='two'`)
	e.Store.Get("container", "two", &c)
	if _, err = e.CreateJob(c, Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}, "missing binding", false); err == nil || len(e.Store.Jobs()) != before {
		t.Fatal("unbound job committed")
	}
	// Authorization is checked before any registry write.
	sub.ActorRole = "Viewer"
	e.Store.Put("subscription", sub.ID, sub)
	if err = e.applyRelease(context.Background(), sub, run, []byte(encode(manifest))); err == nil || !strings.Contains(err.Error(), "Berechtigung") {
		t.Fatal("revoked actor", err)
	}
}
func TestStoppedWorkloadsAndScheduledSlotAreNotRecreated(t *testing.T) {
	e := NewEngine(testStore(t))
	e.Store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 1, WindowID: "window"})
	now := time.Now().UTC()
	w := Window{ID: "window", Name: "test", Timezone: "UTC", Days: []int{int(now.Weekday())}, Start: now.Add(-time.Minute).Format("15:04"), Duration: 60, Enabled: true}
	e.Store.Put("window", w.ID, w)
	c := runContainer("container")
	c.State = "created"
	e.Store.Put("container", c.ID, c)
	e.Tick(now)
	if len(e.Store.Jobs()) != 0 {
		t.Fatal("started stopped workload")
	}
	c.State = "running"
	e.Store.Put("container", c.ID, c)
	j, err := e.CreateJob(c, Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}, "planned", false)
	if err != nil {
		t.Fatal(err)
	}
	e.Tick(now)
	e.Store.Get("job", j.ID, &j)
	j.State = "failed"
	e.Store.Put("job", j.ID, j)
	e.Tick(now)
	if len(e.Store.Jobs()) != 1 {
		t.Fatal("duplicate automatic job in same slot", e.Store.Jobs())
	}
}

func TestReleaseAdmissionAllOrNothingAndReplay(t *testing.T) {
	e := integrationEngine(t)
	manifests := map[string][]byte{}
	digests := []string{}
	for _, value := range []string{"a", "b"} {
		data := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:` + strings.Repeat(value, 64) + `","size":1},"layers":[]}`)
		dg := digest.FromBytes(data).String()
		manifests[dg] = data
		digests = append(digests, dg)
	}
	broken := true
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		selector := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		data := manifests[selector]
		if len(data) == 0 || broken && strings.Contains(r.URL.Path, "/web/") {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		w.Header().Set("Docker-Content-Digest", selector)
		w.Write(data)
	}))
	defer registry.Close()
	host := strings.TrimPrefix(registry.URL, "http://")
	t.Setenv("CUO_ZOT_INTERNAL_URL", registry.URL)
	rc := RegistryConnection{ID: ID(), Provider: "zot", Host: host, Endpoint: registry.URL, Repositories: []string{"universal/*"}, PrivateNetwork: true, Enabled: true}
	e.Store.Put("registry", rc.ID, rc)
	sub := Subscription{ID: ID(), Enabled: true, Revision: 1, Actor: "owner", ActorRole: "Owner", RepositoryID: "7", WorkflowID: "8", Branch: "main", Channel: "stable", Created: "2026-01-01T00:00:00Z", RegistryID: rc.ID, Mode: "approval", Targets: []SubscriptionTarget{{Component: "api", ContainerID: "one", Reference: host + "/universal/api"}, {Component: "web", ContainerID: "two", Reference: host + "/universal/web"}}}
	e.Store.Put("subscription", sub.ID, sub)
	e.Store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 2})
	for _, id := range []string{"one", "two"} {
		c := runContainer(id)
		c.Candidate = nil
		c.Platform = "linux/amd64"
		e.Store.Put("container", id, c)
	}
	run := gh.Run{ID: 99, WorkflowID: 8, RunAttempt: 1, RunNumber: 10, Event: "push", Status: "completed", Conclusion: "success", HeadBranch: "main", HeadSHA: strings.Repeat("a", 40), HeadRepository: gh.Repository{ID: 7}, CreatedAt: "2026-11-02T00:00:00Z"}
	manifest := ReleaseManifest{Schema: "unioci.release.v1", Source: ReleaseSource{RepositoryID: "7", WorkflowRunID: "99", RunAttempt: 1, Revision: run.HeadSHA}, Version: "1.2.0", Channel: "stable", Images: []ReleaseImage{{Component: "api", Reference: host + "/universal/api", Digest: digests[0]}, {Component: "web", Reference: host + "/universal/web", Digest: digests[1]}}}
	body := []byte(encode(manifest))
	if err := e.applyRelease(context.Background(), sub, run, body); err == nil {
		t.Fatal("partial release accepted")
	}
	if len(e.Store.Jobs()) != 0 || len(collection[Candidate](e.Store, "candidate")) != 0 {
		t.Fatal("partial release leaked candidates")
	}
	broken = false
	if err := e.applyRelease(context.Background(), sub, run, body); err != nil {
		t.Fatal(err)
	}
	if len(e.Store.Jobs()) != 2 || len(collection[ReleaseSet](e.Store, "release-set")) != 1 {
		t.Fatal("complete release not committed")
	}
	for _, job := range e.Store.Jobs() {
		if job.State != "pending_approval" || !job.SubscriptionGenerated {
			t.Fatal("approval bypass", job)
		}
	}
	if err := e.applyRelease(context.Background(), sub, run, body); err != nil || len(e.Store.Jobs()) != 2 {
		t.Fatal("duplicate release", err)
	}
	manifest.Version = "changed"
	if err := e.applyRelease(context.Background(), sub, run, []byte(encode(manifest))); err == nil {
		t.Fatal("mutated immutable set accepted")
	}
	// An old run cannot replace an already newer desired release.
	run.ID = 98
	run.RunNumber = 9
	manifest.Version = "0.9.0"
	manifest.Source.WorkflowRunID = "98"
	var fresh Subscription
	e.Store.Get("subscription", sub.ID, &fresh)
	if err := e.applyRelease(context.Background(), fresh, run, []byte(encode(manifest))); err != nil || len(e.Store.Jobs()) != 2 {
		t.Fatal("old run affected desired release", err)
	}
}

func TestEveryDelegableCapabilityControlsItsAPIRoute(t *testing.T) {
	routes := map[string][2]string{
		"inventory.read": {"GET", "/api/v1/containers"}, "updates.scan": {"POST", "/api/v1/scans"}, "updates.request": {"POST", "/api/v1/update-jobs"}, "updates.approve": {"POST", "/api/v1/update-runs"}, "policies.manage": {"PUT", "/api/v1/policies/test"}, "registry.read": {"GET", "/api/v1/registries"}, "registry.manage": {"POST", "/api/v1/registries"}, "registry.scan": {"POST", "/api/v1/registries/" + strings.Repeat("a", 32) + "/probe"}, "registry.import": {"POST", "/api/v1/import-jobs"}, "webhook.read": {"GET", "/api/v1/webhook-deliveries"}, "webhook.retry": {"POST", "/api/v1/webhook-deliveries/" + strings.Repeat("a", 32) + "/retry"}, "subscriptions.manage": {"POST", "/api/v1/subscriptions"}, "github.manage": {"POST", "/api/v1/integrations/github"}, "roles.manage": {"GET", "/api/v1/permission-policy"}}
	for _, cap := range Capabilities {
		route, ok := routes[cap.ID]
		if !ok {
			continue
		}
		t.Run(cap.ID, func(t *testing.T) {
			e := integrationEngine(t)
			server := &Server{Engine: e, Token: "test"}
			policy := defaultPermissions()
			for i := range policy.Roles {
				if policy.Roles[i].Role == "Operator" {
					policy.Roles[i].Capabilities = []string{}
				}
			}
			e.Store.Put("permission-policy", "current", policy)
			call := func() *httptest.ResponseRecorder {
				r := httptest.NewRequest(route[0], route[1], strings.NewReader(`{}`))
				r.Header.Set("Authorization", "Bearer test")
				r.Header.Set("X-CUO-Actor", "test-user")
				r.Header.Set("X-CUO-Role", "Operator")
				r.Header.Set("X-CUO-Hosts", "local")
				r.Header.Set("Idempotency-Key", ID())
				w := httptest.NewRecorder()
				server.ServeHTTP(w, r)
				return w
			}
			if w := call(); w.Code != 403 {
				t.Fatal("denied capability reached handler", w.Code)
			}
			for i := range policy.Roles {
				if policy.Roles[i].Role == "Operator" {
					policy.Roles[i].Capabilities = []string{cap.ID}
				}
			}
			e.Store.Put("permission-policy", "current", policy)
			if cap.OwnerOnly {
				if w := call(); w.Code != 403 {
					t.Fatal("delegated governance")
				}
			} else if route[1] != "/api/v1/scans" {
				if w := call(); w.Code == 403 {
					t.Fatal("delegated capability did not reach handler", w.Body)
				}
			}
		})
	}
}

func TestGitHubSetupCorrelationCannotReplay(t *testing.T) {
	e := integrationEngine(t)
	id := ID()
	e.Store.Put("github", id, GitHubConnection{ID: id, Name: "Setup"})
	s := &Server{Engine: e, Token: "service"}
	code, value := s.githubMutate("/api/v1/integrations/github/"+id+"/setup", "POST", []byte(`{}`), Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}})
	if code != 200 {
		t.Fatal(code, value)
	}
	result := value.(map[string]any)
	u, _ := url.Parse(result["registrationURL"].(string))
	state := u.Query().Get("state")
	nonce := result["_correlation"].(string)
	call := func(nonce string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/internal/github/install-callback", strings.NewReader(encode(map[string]string{"state": state, "nonce": nonce, "installationId": "42"})))
		r.Header.Set("Authorization", "Bearer service")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := call("different-browser"); w.Code != 403 {
		t.Fatal("foreign browser accepted", w.Code)
	}
	// A valid correlation is consumed before any GitHub exchange. This fixture
	// deliberately has no configured key; retry must still require a fresh setup.
	if w := call(nonce); w.Code != 422 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(nonce); w.Code != 403 {
		t.Fatal("state replay", w.Code)
	}
}
func TestPollingRecoversLongRunningPublishWithoutWebhook(t *testing.T) {
	e := integrationEngine(t)
	image := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:` + strings.Repeat("a", 64) + `","size":1},"layers":[]}`)
	dg := digest.FromBytes(image).String()
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		w.Header().Set("Docker-Content-Digest", dg)
		w.Write(image)
	}))
	defer registry.Close()
	host := strings.TrimPrefix(registry.URL, "http://")
	t.Setenv("CUO_ZOT_INTERNAL_URL", registry.URL)
	rc := RegistryConnection{ID: ID(), Host: host, Endpoint: registry.URL, Repositories: []string{"universal/*"}, PrivateNetwork: true, Enabled: true}
	e.Store.Put("registry", rc.ID, rc)
	connection := GitHubConnection{ID: ID(), AppID: "1", InstallationID: "42", Configured: true, Enabled: true}
	e.Store.Put("github", connection.ID, connection)
	sub := Subscription{ID: ID(), ConnectionID: connection.ID, RepositoryID: "7", Repository: "universal/app", WorkflowID: "8", Branch: "main", Channel: "stable", Created: time.Now().Add(-6 * time.Hour).UTC().Format(time.RFC3339), LastSync: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), RegistryID: rc.ID, Targets: []SubscriptionTarget{{Component: "app", ContainerID: "app", Reference: host + "/universal/app"}}, Mode: "preview", Enabled: true, Actor: "owner", ActorRole: "Owner", Revision: 1}
	e.Store.Put("subscription", sub.ID, sub)
	c := runContainer("app")
	c.Platform = "linux/amd64"
	c.Candidate = nil
	e.Store.Put("container", c.ID, c)
	run := gh.Run{ID: 99, RunNumber: 1, RunAttempt: 1, WorkflowID: 8, HeadSHA: strings.Repeat("b", 40), HeadBranch: "main", Event: "push", CreatedAt: time.Now().Add(-5 * time.Hour).UTC().Format(time.RFC3339), HeadRepository: gh.Repository{ID: 7}, Status: "in_progress"}
	manifest := ReleaseManifest{Schema: "unioci.release.v1", Source: ReleaseSource{RepositoryID: "7", WorkflowRunID: "99", RunAttempt: 1, Revision: run.HeadSHA}, Version: "1.0.0", Channel: "stable", Images: []ReleaseImage{{Component: "app", Reference: host + "/universal/app", Digest: dg}}}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	file, _ := writer.Create("unioci-release.json")
	file.Write([]byte(encode(manifest)))
	writer.Close()
	completed := false
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/app/installations/42":
			w.Write([]byte(`{"id":42,"app_id":1,"suspended_at":null}`))
		case strings.HasSuffix(r.URL.Path, "/access_tokens"):
			json.NewEncoder(w).Encode(map[string]any{"token": "fixture", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
		case strings.HasSuffix(r.URL.Path, "/workflows/8/runs"):
			items := []gh.Run{}
			if !completed {
				items = append(items, run)
			}
			json.NewEncoder(w).Encode(map[string]any{"workflow_runs": items})
		case strings.HasSuffix(r.URL.Path, "/runs/99/artifacts"):
			w.Write([]byte(`{"artifacts":[{"id":123,"name":"unioci-release","expired":false,"size_in_bytes":500}]}`))
		case strings.HasSuffix(r.URL.Path, "/artifacts/123/zip"):
			w.Header().Set("Content-Type", "application/zip")
			w.Write(archive.Bytes())
		case strings.HasSuffix(r.URL.Path, "/runs/99"):
			json.NewEncoder(w).Encode(run)
		default:
			w.WriteHeader(404)
		}
	}))
	defer github.Close()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	e.GitHubFactory = func(GitHubConnection) (*gh.Client, error) {
		return &gh.Client{AppID: "1", Key: key, HTTP: github.Client(), BaseURL: github.URL}, nil
	}
	if err := e.pollSubscription(context.Background(), sub); err != nil {
		t.Fatal(err)
	}
	if len(collection[pendingRun](e.Store, "pending-run")) != 1 {
		t.Fatal("running workflow not persisted")
	}
	completed = true
	run.Status = "completed"
	run.Conclusion = "success"
	e.Store.Get("subscription", sub.ID, &sub)
	if err := e.pollSubscription(context.Background(), sub); err != nil {
		t.Fatal(err)
	}
	if len(collection[ReleaseSet](e.Store, "release-set")) != 1 || len(collection[Candidate](e.Store, "candidate")) != 1 || len(e.Store.Jobs()) != 0 {
		t.Fatal("polling did not recover complete preview release")
	}
	if len(collection[pendingRun](e.Store, "pending-run")) != 0 {
		t.Fatal("completed workflow retained as pending")
	}
}

func TestEventStreamStopsAfterCapabilityRevocation(t *testing.T) {
	e := integrationEngine(t)
	server := httptest.NewServer(&Server{Engine: e, Token: "service"})
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/v1/events", nil)
	r.Header.Set("Authorization", "Bearer service")
	r.Header.Set("X-CUO-Actor", "viewer")
	r.Header.Set("X-CUO-Role", "Viewer")
	r.Header.Set("X-CUO-Hosts", "local")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "keepalive") {
			break
		}
	}
	policy := e.Store.PermissionPolicy()
	for i := range policy.Roles {
		if policy.Roles[i].Role == "Viewer" {
			policy.Roles[i].Capabilities = []string{"registry.read"}
		}
	}
	e.Store.Put("permission-policy", "current", policy)
	e.Store.Event(Event{HostID: "local", Message: "must-not-reach-revoked-stream"})
	remaining, err := io.ReadAll(reader)
	if err != nil || strings.Contains(string(remaining), "must-not-reach") {
		t.Fatal("revoked stream remained authorized", err, string(remaining))
	}
}

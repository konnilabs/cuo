package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"cuo.local/cuo/internal/unioci"
)

type secretChange struct{ ID, Purpose, Value string }

func (e *Engine) saveIntegration(kind, id string, value any, p Principal, operation, message string, changes ...secretChange) error {
	tx, err := e.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, change := range changes {
		if change.Value == "" {
			_, err = tx.Exec(`DELETE FROM secrets WHERE id=?`, change.ID)
		} else {
			var sealed []byte
			sealed, err = e.Vault.Seal(change.ID, change.Purpose, change.Value)
			if err == nil {
				_, err = tx.Exec(`INSERT INTO secrets(id,purpose,ciphertext,version,updated) VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose,ciphertext=excluded.ciphertext,version=secrets.version+1,updated=excluded.updated`, change.ID, change.Purpose, sealed, time.Now().UTC().Format(time.RFC3339Nano))
			}
		}
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, kind, id, encode(value)); err != nil {
		return err
	}
	event := Event{HostID: "local", Actor: p.ID, Operation: operation, Stage: "saved", Severity: "info", Message: message, Time: time.Now().UTC().Format(time.RFC3339Nano)}
	if _, err = tx.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, "local", encode(event)); err != nil {
		return err
	}
	return tx.Commit()
}
func integrationPath(path string) bool {
	for _, prefix := range []string{"registries", "integrations/github", "webhook-deliveries", "release-sets", "subscriptions", "permission-policy", "permissions/me", "import-jobs"} {
		if path == "/api/v1/"+prefix || strings.HasPrefix(path, "/api/v1/"+prefix+"/") {
			return true
		}
	}
	return false
}
func integrationFailure(err error) (int, any) {
	return 422, map[string]string{"code": "INTEGRATION_INVALID", "message": err.Error()}
}
func safeStoreFailure() (int, any) {
	return 500, map[string]string{"code": "STORE_ERROR", "message": "Änderung konnte nicht dauerhaft gespeichert werden"}
}
func collection[T any](store *Store, kind string) []T {
	items := []T{}
	_ = store.List(kind, &items)
	return items
}
func registryConfig(r RegistryConnection) unioci.Config {
	return unioci.Config{Host: r.Host, Endpoint: r.Endpoint, Repositories: r.Repositories, AuthHosts: r.AuthHosts, BlobHosts: r.BlobHosts, CAPEM: r.CAPEM, PrivateNetwork: r.PrivateNetwork}
}
func (e *Engine) registryAccess(id string) (*unioci.Access, error) {
	var r RegistryConnection
	if e.Store.Get("registry", id, &r) != nil || !r.Enabled {
		return nil, errors.New("Registry-Verbindung ist nicht aktiv")
	}
	credential := unioci.Credentials{Username: r.Username}
	if r.CredentialConfigured {
		var err error
		credential.Password, err = e.Vault.Get(r.CredentialID, "registry")
		if err != nil {
			return nil, err
		}
	}
	return &unioci.Access{Config: registryConfig(r), Credentials: credential, Expires: time.Now().Add(2 * time.Minute).Unix()}, nil
}
func (e *Engine) registryClient(id string) (*unioci.Client, error) {
	a, err := e.registryAccess(id)
	if err != nil {
		return nil, err
	}
	return unioci.New(a.Config, a.Credentials, os.Getenv("CUO_ZOT_INTERNAL_URL"))
}
func (e *Engine) registryWriteClient(id string) (*unioci.Client, error) {
	var r RegistryConnection
	if e.Store.Get("registry", id, &r) != nil || !r.Enabled || !r.PushCredentialConfigured {
		return nil, errors.New("Separate Registry-Push-Credentials sind erforderlich")
	}
	password, err := e.Vault.Get(r.PushCredentialID, "registry-push")
	if err != nil {
		return nil, err
	}
	return unioci.New(registryConfig(r), unioci.Credentials{Username: r.PushUsername, Password: password}, os.Getenv("CUO_ZOT_INTERNAL_URL"))
}
func (e *Engine) accessForImage(image string) (*unioci.Access, error) {
	ref, err := unioci.ParseReference(image)
	if err != nil {
		return nil, err
	}
	var selected *RegistryConnection
	best := -1
	for _, r := range collection[RegistryConnection](e.Store, "registry") {
		if r.Host != ref.Host || !registryConfig(r).Allows(ref.Repository) {
			continue
		}
		score := 0
		for _, scope := range r.Repositories {
			if scope == ref.Repository || strings.HasSuffix(scope, "/*") && strings.HasPrefix(ref.Repository, strings.TrimSuffix(scope, "*")) {
				if len(scope) > score {
					score = len(scope)
				}
			}
		}
		score *= 2
		if r.CredentialConfigured {
			score++
		}
		if score > best {
			v := r
			selected = &v
			best = score
		}
	}
	if selected != nil {
		return e.registryAccess(selected.ID)
	}
	return nil, nil
}

func (s *Server) integrationGet(w http.ResponseWriter, r *http.Request, p Principal) {
	e := s.Engine
	store := e.Store
	path := r.URL.Path
	if path == "/api/v1/permissions/me" {
		caps := []string{}
		for _, c := range Capabilities {
			if store.Allows(p, c.ID) {
				caps = append(caps, c.ID)
			}
		}
		respond(w, 200, map[string]any{"capabilities": caps, "revision": store.PermissionPolicy().Revision})
		return
	}
	if path == "/api/v1/permission-policy" {
		respond(w, 200, map[string]any{"policy": store.PermissionPolicy(), "capabilities": Capabilities})
		return
	}
	kinds := map[string]string{"/api/v1/registries": "registry", "/api/v1/integrations/github": "github", "/api/v1/webhook-deliveries": "delivery", "/api/v1/release-sets": "release-set", "/api/v1/subscriptions": "subscription", "/api/v1/import-jobs": "import"}
	if kind, ok := kinds[path]; ok {
		if kind == "release-set" {
			sets := collection[ReleaseSet](store, kind)
			for i := range sets {
				sets[i].State = e.releaseStatus(sets[i])
			}
			respond(w, 200, map[string]any{"items": sets})
			return
		}
		var items []json.RawMessage
		_ = store.List(kind, &items)
		if items == nil {
			items = []json.RawMessage{}
		}
		respond(w, 200, map[string]any{"items": items})
		return
	}
	if strings.HasPrefix(path, "/api/v1/registries/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/v1/registries/"), "/")
		var registry RegistryConnection
		if !jobIDPattern.MatchString(parts[0]) || store.Get("registry", parts[0], &registry) != nil {
			fail(w, 404, "NOT_FOUND", "Registry nicht gefunden")
			return
		}
		if len(parts) == 1 {
			respond(w, 200, registry)
			return
		}
		client, err := e.registryClient(registry.ID)
		if err != nil {
			fail(w, 422, "REGISTRY_UNAVAILABLE", err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		repo := r.URL.Query().Get("repository")
		selector := r.URL.Query().Get("reference")
		if selector == "" {
			selector = "latest"
		}
		switch parts[1] {
		case "repositories":
			items := []string{}
			for _, v := range registry.Repositories {
				if !strings.Contains(v, "*") {
					items = append(items, v)
				}
			}
			if registry.Provider == "zot" || len(items) == 0 {
				items, err = client.Catalog(ctx)
			}
			if err == nil {
				respond(w, 200, map[string]any{"items": items})
				return
			}
		case "tags":
			var items []string
			items, err = client.Tags(ctx, repo, r.URL.Query().Get("last"))
			if err == nil {
				respond(w, 200, map[string]any{"items": items})
				return
			}
		case "artifact":
			var artifact unioci.Artifact
			artifact, err = client.Resolve(ctx, repo, selector, r.URL.Query().Get("platform"))
			if err == nil {
				refs, refErr := client.Referrers(ctx, repo, artifact.Digest)
				if refErr == nil {
					artifact.Referrers = refs
				}
				respond(w, 200, map[string]any{"artifact": artifact, "referrersAvailable": refErr == nil, "verification": "not_verified"})
				return
			}
		case "retention-preview":
			protected := map[string]bool{}
			for _, j := range store.Jobs() {
				if !terminal(j.State) || j.State == "succeeded" {
					protected[j.Target] = true
					protected[j.Source] = true
				}
			}
			for _, c := range collection[Container](store, "container") {
				if c.Candidate != nil {
					protected[c.Candidate.Target] = true
				}
			}
			respond(w, 200, map[string]any{"automaticDeletion": false, "protectedDigests": protected, "message": "Nur Vorschau. Externe Registry-Verbraucher sind CUO möglicherweise unbekannt; automatische Löschung ist deaktiviert."})
			return
		case "storage":
			if registry.Provider != "zot" {
				fail(w, 422, "CAPABILITY_UNAVAILABLE", "Speicherinformationen sind nur für den integrierten Zot-Dienst verfügbar")
				return
			}
			response, e2 := e.agent(ctx, "GET", "/registry-info", nil)
			if e2 != nil {
				fail(w, 502, "AGENT_UNAVAILABLE", "Speicherinformationen nicht verfügbar")
				return
			}
			defer response.Body.Close()
			var result map[string]any
			if json.NewDecoder(response.Body).Decode(&result) != nil {
				fail(w, 502, "AGENT_UNAVAILABLE", "Speicherinformationen nicht verfügbar")
				return
			}
			respond(w, response.StatusCode, result)
			return
		}
		if err != nil {
			fail(w, 502, "REGISTRY_QUERY_FAILED", err.Error())
			return
		}
	}
	if strings.HasPrefix(path, "/api/v1/integrations/github/") {
		s.githubGet(w, r, p)
		return
	}
	fail(w, 404, "NOT_FOUND", "Endpunkt nicht gefunden")
}

var jobIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *Server) integrationMutate(path, method string, body []byte, p Principal) (int, any) {
	e := s.Engine
	store := e.Store
	if path == "/api/v1/permission-policy" && method == "PUT" {
		var policy PermissionPolicy
		if decode(body, &policy) != nil {
			return integrationFailure(errors.New("Ungültige Berechtigungsmatrix"))
		}
		if err := validatePermissions(policy); err != nil {
			return integrationFailure(err)
		}
		old := store.PermissionPolicy()
		if policy.Revision != old.Revision {
			return 409, map[string]string{"code": "REVISION_CONFLICT", "message": "Berechtigungen wurden zwischenzeitlich geändert"}
		}
		policy.Revision++
		message := "Rollenberechtigungen geändert: " + policy.Reason + "; vorher=" + encode(old.Roles) + "; nachher=" + encode(policy.Roles)
		if e.saveIntegration("permission-policy", "current", policy, p, "roles.update", message) != nil {
			return safeStoreFailure()
		}
		return 200, policy
	}
	if path == "/api/v1/registries" && method == "POST" || strings.HasPrefix(path, "/api/v1/registries/") && method == "PUT" {
		id := strings.TrimPrefix(path, "/api/v1/registries/")
		fresh := method == "POST"
		var old RegistryConnection
		if fresh {
			id = ID()
		} else if !jobIDPattern.MatchString(id) || store.Get("registry", id, &old) != nil {
			return 404, map[string]string{"code": "NOT_FOUND", "message": "Registry nicht gefunden"}
		}
		var input RegistryRequest
		if decode(body, &input) != nil || !input.Confirmed || len(strings.TrimSpace(input.Reason)) < 3 {
			return integrationFailure(errors.New("Registry-Änderung bestätigen und begründen"))
		}
		if !fresh && input.Revision != old.Revision {
			return 409, map[string]string{"code": "REVISION_CONFLICT", "message": "Registry wurde zwischenzeitlich geändert"}
		}
		if len(input.Name) < 1 || len(input.Name) > 100 || len(input.Repositories) == 0 || len(input.Repositories) > 100 || len(input.CAPEM) > 32768 || len(input.Username) > 200 || len(input.Password) > 4096 || len(input.AuthHosts) > 8 || len(input.BlobHosts) > 8 {
			return integrationFailure(errors.New("Ungültige Registry-Einstellungen"))
		}
		if !slices.Contains([]string{"oci", "ghcr", "zot"}, input.Provider) {
			return integrationFailure(errors.New("Unbekannter Registry-Provider"))
		}
		for _, repo := range input.Repositories {
			if repo == "*" {
				continue
			}
			v := strings.TrimSuffix(repo, "/*")
			if _, err := unioci.ParseReference(input.Host + "/" + v + ":latest"); err != nil {
				return integrationFailure(err)
			}
		}
		if input.Endpoint == "" {
			input.Endpoint = "https://" + input.Host
		}
		input.Endpoint = strings.TrimSuffix(input.Endpoint, "/")
		if input.Host == "registry-1.docker.io" && len(input.AuthHosts) == 0 {
			input.AuthHosts = []string{"auth.docker.io"}
		}
		if input.Host == "ghcr.io" && len(input.BlobHosts) == 0 {
			input.BlobHosts = []string{"pkg-containers.githubusercontent.com"}
		}
		if input.Endpoint == os.Getenv("CUO_ZOT_INTERNAL_URL") && input.Host != os.Getenv("CUO_ZOT_HOST") {
			return integrationFailure(errors.New("Der lokale Zot-Endpunkt benötigt seinen konfigurierten kanonischen Host"))
		}
		r := RegistryConnection{ID: id, Name: input.Name, Provider: input.Provider, Host: input.Host, Endpoint: input.Endpoint, Repositories: input.Repositories, AuthHosts: input.AuthHosts, BlobHosts: input.BlobHosts, CAPEM: input.CAPEM, PrivateNetwork: input.PrivateNetwork, Username: input.Username, CredentialConfigured: old.CredentialConfigured, Capabilities: []string{"manifests", "tags", "copy"}, Status: "unchecked", Enabled: input.Enabled, Revision: old.Revision + 1}
		if _, err := unioci.New(registryConfig(r), unioci.Credentials{}, os.Getenv("CUO_ZOT_INTERNAL_URL")); err != nil {
			return integrationFailure(err)
		}
		changedEndpoint := old.Host != r.Host || old.Endpoint != r.Endpoint || old.Username != r.Username || !slices.Equal(old.AuthHosts, r.AuthHosts) || !slices.Equal(old.BlobHosts, r.BlobHosts) || old.CAPEM != r.CAPEM
		if old.CredentialConfigured && changedEndpoint && input.Password == "" && !input.RemoveCredential {
			return integrationFailure(errors.New("Bei Änderung des Credential-Ziels neue Zugangsdaten angeben oder gespeicherte Credentials entfernen"))
		}
		r.CredentialID = old.CredentialID
		changes := []secretChange{}
		if input.RemoveCredential || input.Password != "" {
			if old.CredentialID != "" {
				changes = append(changes, secretChange{ID: old.CredentialID, Purpose: "registry"})
			}
			r.CredentialConfigured = false
			r.CredentialID = ""
		}
		if input.Password != "" {
			r.CredentialConfigured = true
			r.CredentialID = "registry/" + ID()
			changes = append(changes, secretChange{ID: r.CredentialID, Purpose: "registry", Value: input.Password})
		}
		r.PushUsername = input.PushUsername
		r.PushCredentialID = old.PushCredentialID
		r.PushCredentialConfigured = old.PushCredentialConfigured
		if old.PushCredentialConfigured && (changedEndpoint || old.PushUsername != input.PushUsername) && input.PushPassword == "" && !input.RemovePushCredential {
			return integrationFailure(errors.New("Bei Änderung des Push-Ziels neue Push-Credentials angeben oder entfernen"))
		}
		if input.RemovePushCredential || input.PushPassword != "" {
			if old.PushCredentialID != "" {
				changes = append(changes, secretChange{ID: old.PushCredentialID, Purpose: "registry-push"})
			}
			r.PushCredentialID = ""
			r.PushCredentialConfigured = false
		}
		if input.PushPassword != "" {
			if len(input.PushPassword) > 4096 {
				return integrationFailure(errors.New("Push-Credential zu groß"))
			}
			r.PushCredentialConfigured = true
			r.PushCredentialID = "registry-push/" + ID()
			changes = append(changes, secretChange{ID: r.PushCredentialID, Purpose: "registry-push", Value: input.PushPassword})
		}
		if err := e.saveIntegration("registry", id, r, p, "registry.save", "Registry "+r.Name+" gespeichert; "+input.Reason, changes...); err != nil {
			return integrationFailure(errors.New("Registry konnte nicht mit ihren Credentials gespeichert werden; Installationsschlüssel prüfen"))
		}
		return 200, r
	}
	if strings.HasPrefix(path, "/api/v1/registries/") && strings.HasSuffix(path, "/probe") && method == "POST" {
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/registries/"), "/probe")
		var r RegistryConnection
		if store.Get("registry", id, &r) != nil {
			return 404, map[string]string{"code": "NOT_FOUND", "message": "Registry nicht gefunden"}
		}
		client, err := e.registryClient(id)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err = client.Probe(ctx)
			cancel()
		}
		r.Status = "ready"
		r.LastError = ""
		r.LastChecked = time.Now().UTC().Format(time.RFC3339)
		if err != nil {
			r.Status = "error"
			r.LastError = err.Error()
		}
		if e.saveIntegration("registry", id, r, p, "registry.probe", "Registry-Verbindung geprüft: "+r.Status) != nil {
			return safeStoreFailure()
		}
		return 200, r
	}
	if path == "/api/v1/import-jobs" && method == "POST" {
		var input struct {
			SourceRegistryID      string `json:"sourceRegistryId"`
			Repository            string `json:"repository"`
			Digest                string `json:"digest"`
			DestinationRegistryID string `json:"destinationRegistryId"`
			DestinationRepository string `json:"destinationRepository"`
			Confirmed             bool   `json:"confirmed"`
			Reason                string `json:"reason"`
		}
		if decode(body, &input) != nil || !input.Confirmed || len(input.Reason) < 3 || !strings.HasPrefix(input.Digest, "sha256:") {
			return integrationFailure(errors.New("Digest-Import bestätigen und begründen"))
		}
		for _, id := range []string{input.SourceRegistryID, input.DestinationRegistryID} {
			if _, err := e.registryClient(id); err != nil {
				return integrationFailure(err)
			}
		}
		j := ImportJob{ID: ID(), SourceRegistryID: input.SourceRegistryID, Repository: input.Repository, Digest: input.Digest, DestinationRegistryID: input.DestinationRegistryID, DestinationRepository: input.DestinationRepository, State: "queued", Actor: p.ID, ActorRole: p.Role, Created: time.Now().UTC().Format(time.RFC3339)}
		if e.saveIntegration("import", j.ID, j, p, "registry.import.request", input.Reason) != nil {
			return safeStoreFailure()
		}
		e.NotifyIntegrations()
		return 202, j
	}
	if strings.HasPrefix(path, "/api/v1/integrations/github") {
		return s.githubMutate(path, method, body, p)
	}
	if strings.HasPrefix(path, "/api/v1/webhook-deliveries/") && strings.HasSuffix(path, "/retry") {
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/webhook-deliveries/"), "/retry")
		var d WebhookDelivery
		if store.Get("delivery", id, &d) != nil {
			return 404, map[string]string{"code": "NOT_FOUND", "message": "Zustellung nicht gefunden"}
		}
		if d.State != "failed" && d.State != "retry" {
			return integrationFailure(errors.New("Nur fehlgeschlagene Zustellungen können wiederaufgenommen werden"))
		}
		d.State = "pending"
		d.Attempts = 0
		d.NextAttempt = ""
		d.Error = ""
		if e.saveIntegration("delivery", id, d, p, "webhook.retry", "Zustellung erneut eingeplant") != nil {
			return safeStoreFailure()
		}
		e.NotifyIntegrations()
		return 202, d
	}
	if strings.HasPrefix(path, "/api/v1/subscriptions") {
		return s.subscriptionMutate(path, method, body, p)
	}
	return 404, map[string]string{"code": "NOT_FOUND", "message": "Endpunkt nicht gefunden"}
}

func (e *Engine) NotifyIntegrations() {
	select {
	case e.IntegrationWake <- struct{}{}:
	default:
	}
}
func apiOrigin() string {
	v := strings.TrimSuffix(os.Getenv("CUO_ORIGIN"), "/")
	if v == "" {
		return "http://127.0.0.1:8095"
	}
	return v
}
func originURL(path string) string { return apiOrigin() + path }
func publicWebhook() bool {
	u, _ := url.Parse(apiOrigin())
	return u != nil && u.Scheme == "https" && u.Hostname() != "localhost"
}
func (e *Engine) migrateRegistries() error {
	for _, host := range append([]string{"registry-1.docker.io", "ghcr.io", "quay.io"}, strings.Split(os.Getenv("CUO_REGISTRIES"), ",")...) {
		if host == "" {
			continue
		}
		exists := false
		for _, existing := range collection[RegistryConnection](e.Store, "registry") {
			exists = exists || existing.Host == host
		}
		if exists {
			continue
		}
		r := RegistryConnection{ID: stableID("registry", host), Name: host, Provider: "oci", Host: host, Endpoint: "https://" + host, Repositories: []string{"*"}, AuthHosts: []string{}, BlobHosts: []string{}, Capabilities: []string{"manifests", "tags", "copy"}, Enabled: true, Status: "unchecked", Revision: 1}
		if host == "registry-1.docker.io" {
			r.AuthHosts = []string{"auth.docker.io"}
		}
		if host == "ghcr.io" {
			r.Provider = "ghcr"
			r.BlobHosts = []string{"pkg-containers.githubusercontent.com"}
		}
		if _, err := unioci.New(registryConfig(r), unioci.Credentials{}, ""); err != nil {
			return fmt.Errorf("invalid legacy registry host: %s", host)
		}
		if err := e.Store.Put("registry", r.ID, r); err != nil {
			return err
		}
	}
	return nil
}
func stableID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:16])
}

func (e *Engine) accessForJob(job Job) (*unioci.Access, error) {
	image := job.Image
	if job.TargetImage != "" {
		image = job.TargetImage
	}
	if job.SubscriptionID == "" {
		return e.accessForImage(image)
	}
	var sub Subscription
	var connection GitHubConnection
	if e.Store.Get("subscription", job.SubscriptionID, &sub) != nil || !sub.Enabled || e.Store.Get("github", sub.ConnectionID, &connection) != nil || !connection.Enabled {
		return nil, errors.New("Subscription oder GitHub-Verbindung wurde deaktiviert")
	}
	if job.TargetOrder < 0 || job.TargetOrder >= len(sub.Targets) || sub.Targets[job.TargetOrder].ContainerID != job.ContainerID {
		return nil, errors.New("Subscription-Ziel wurde geändert")
	}
	var source RegistryConnection
	if e.Store.Get("registry", sub.RegistryID, &source) != nil || !source.Enabled {
		return nil, errors.New("Subscription-Quellverbindung wurde deaktiviert")
	}
	registryID := sub.RegistryID
	expected, err := unioci.ParseReference(sub.Targets[job.TargetOrder].Reference)
	if err != nil {
		return nil, err
	}
	if sub.ImportRegistryID != "" {
		registryID = sub.ImportRegistryID
		expected.Repository = sub.ImportPrefix + "/" + sub.Targets[job.TargetOrder].Component
	}
	access, err := e.registryAccess(registryID)
	if err != nil {
		return nil, err
	}
	ref, err := unioci.ParseReference(image)
	if err != nil || ref.Host != access.Config.Host || ref.Repository != expected.Repository || !access.Config.Allows(ref.Repository) {
		return nil, errors.New("Release-Ziel passt nicht mehr zur aktiven Registry-Freigabe")
	}
	return access, nil
}

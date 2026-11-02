package core

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	gh "cuo.local/cuo/internal/github"
)

func (e *Engine) githubClient(connection GitHubConnection) (*gh.Client, error) {
	if !connection.Configured {
		return nil, errors.New("GitHub-App noch nicht eingerichtet")
	}
	if e.GitHubFactory != nil {
		return e.GitHubFactory(connection)
	}
	key, err := e.Vault.Get("github/key/"+connection.ID, "github-key")
	if err != nil {
		return nil, err
	}
	return gh.New(connection.AppID, key)
}
func (s *Server) githubGet(w http.ResponseWriter, r *http.Request, p Principal) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/integrations/github/"), "/")
	var c GitHubConnection
	if !jobIDPattern.MatchString(parts[0]) || s.Engine.Store.Get("github", parts[0], &c) != nil {
		fail(w, 404, "NOT_FOUND", "GitHub-Verbindung nicht gefunden")
		return
	}
	if len(parts) == 1 {
		respond(w, 200, c)
		return
	}
	client, err := s.Engine.githubClient(c)
	if err != nil {
		fail(w, 422, "GITHUB_UNAVAILABLE", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	switch parts[1] {
	case "installations":
		items, e := client.Installations(ctx)
		if e == nil {
			respond(w, 200, map[string]any{"items": items})
			return
		}
		err = e
	case "repositories":
		items, e := client.Repositories(ctx, c.InstallationID)
		if e == nil {
			respond(w, 200, map[string]any{"items": items})
			return
		}
		err = e
	case "workflows":
		items, e := client.Workflows(ctx, c.InstallationID, r.URL.Query().Get("repository"))
		if e == nil {
			respond(w, 200, map[string]any{"items": items})
			return
		}
		err = e
	case "runs":
		items, e := client.Runs(ctx, c.InstallationID, r.URL.Query().Get("repository"), r.URL.Query().Get("workflow"), "")
		if e == nil {
			respond(w, 200, map[string]any{"items": items})
			return
		}
		err = e
	default:
		fail(w, 404, "NOT_FOUND", "Endpunkt nicht gefunden")
		return
	}
	fail(w, 502, "GITHUB_API_FAILED", err.Error())
}

type githubSetup struct {
	ConnectionID string `json:"connectionId"`
	Actor        string `json:"actor"`
	NonceHash    string `json:"nonceHash"`
	Expires      int64  `json:"expires"`
}

func (s *Server) githubMutate(path, method string, body []byte, p Principal) (int, any) {
	e := s.Engine
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/integrations/github"), "/")
	id := ""
	var old GitHubConnection
	if len(parts) > 1 {
		id = parts[1]
	}
	fresh := path == "/api/v1/integrations/github" && method == "POST"
	if fresh {
		id = ID()
	} else if !jobIDPattern.MatchString(id) || e.Store.Get("github", id, &old) != nil {
		return 404, map[string]string{"code": "NOT_FOUND", "message": "GitHub-Verbindung nicht gefunden"}
	}
	if len(parts) == 3 && parts[2] == "setup" && method == "POST" {
		if e.Vault == nil {
			return integrationFailure(errors.New("Installationsschlüssel nicht verfügbar"))
		}
		var input struct {
			Organization string `json:"organization"`
		}
		if decode(body, &input) != nil || input.Organization != "" && !regexp.MustCompile(`^[A-Za-z0-9-]{1,100}$`).MatchString(input.Organization) {
			return integrationFailure(errors.New("Ungültige GitHub-Organisation"))
		}
		state := ID() + ID()
		nonce := ID() + ID()
		hash := sha256.Sum256([]byte(nonce))
		setup := githubSetup{ConnectionID: id, Actor: p.ID, NonceHash: hex.EncodeToString(hash[:]), Expires: time.Now().Add(15 * time.Minute).Unix()}
		if e.saveIntegration("github-setup", state, setup, p, "github.setup.start", "GitHub-App-Registrierung gestartet") != nil {
			return safeStoreFailure()
		}
		registrationURL := "https://github.com/settings/apps/new?state=" + state
		if input.Organization != "" {
			registrationURL = "https://github.com/organizations/" + input.Organization + "/settings/apps/new?state=" + state
		}
		manifest := map[string]any{"name": "CUO-" + id[:8], "url": apiOrigin(), "redirect_url": originURL("/connect/github/manifest/callback"), "setup_url": originURL("/connect/github/install/callback"), "public": false, "hook_attributes": map[string]any{"url": originURL("/hooks/github/" + id), "active": publicWebhook()}, "default_permissions": map[string]string{"metadata": "read", "actions": "read"}, "default_events": []string{"workflow_run"}}
		return 200, map[string]any{"registrationURL": registrationURL, "manifest": manifest, "_correlation": nonce}
	}
	if len(parts) == 3 && parts[2] == "install" && method == "POST" {
		if !old.Configured || old.Slug == "" {
			return integrationFailure(errors.New("Zuerst GitHub-App erstellen oder verbinden"))
		}
		state := ID() + ID()
		nonce := ID() + ID()
		hash := sha256.Sum256([]byte(nonce))
		setup := githubSetup{ConnectionID: id, Actor: p.ID, NonceHash: hex.EncodeToString(hash[:]), Expires: time.Now().Add(15 * time.Minute).Unix()}
		if e.saveIntegration("github-setup", state, setup, p, "github.install.start", "GitHub-App-Installation gestartet") != nil {
			return safeStoreFailure()
		}
		return 200, map[string]any{"installationURL": "https://github.com/apps/" + old.Slug + "/installations/new?state=" + state, "_correlation": nonce}
	}
	if len(parts) == 3 && parts[2] == "probe" && method == "POST" {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		client, err := e.githubClient(old)
		if err == nil {
			_, err = client.Installation(ctx, old.InstallationID)
		}
		old.Status = "ready"
		old.LastError = ""
		if err != nil {
			old.Status = "error"
			old.LastError = err.Error()
		}
		if e.saveIntegration("github", id, old, p, "github.probe", "GitHub-Verbindung geprüft: "+old.Status) != nil {
			return safeStoreFailure()
		}
		return 200, old
	}
	if !fresh && method != "PUT" {
		return 405, map[string]string{"code": "METHOD_NOT_ALLOWED", "message": "Methode nicht unterstützt"}
	}
	var input GitHubRequest
	if decode(body, &input) != nil || !input.Confirmed || len(input.Reason) < 3 || len(input.Reason) > 500 || input.Name == "" || len(input.Name) > 100 {
		return integrationFailure(errors.New("GitHub-Einrichtung bestätigen und begründen"))
	}
	if !fresh && input.Revision != old.Revision {
		return 409, map[string]string{"code": "REVISION_CONFLICT", "message": "GitHub-Verbindung wurde zwischenzeitlich geändert"}
	}
	c := GitHubConnection{ID: id, Name: input.Name, AppID: input.AppID, Slug: old.Slug, InstallationID: input.InstallationID, Account: old.Account, Configured: old.Configured, Enabled: input.Enabled, Status: "unchecked", WebhookURL: originURL("/hooks/github/" + id), CallbackURL: originURL("/connect/github/manifest/callback"), WebhookReachable: publicWebhook(), Revision: old.Revision + 1}
	changes := []secretChange{}
	if input.PrivateKey != "" || input.WebhookSecret != "" {
		if len(input.WebhookSecret) < 32 || len(input.WebhookSecret) > 512 {
			return integrationFailure(errors.New("Webhook-Secret benötigt mindestens 32 Zeichen"))
		}
		client, err := gh.New(input.AppID, input.PrivateKey)
		if err != nil {
			return integrationFailure(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		app, err := client.App(ctx)
		cancel()
		if err != nil {
			return integrationFailure(err)
		}
		if fmt.Sprint(app.ID) != input.AppID {
			return integrationFailure(errors.New("App-ID stimmt nicht mit GitHub überein"))
		}
		c.Slug = app.Slug
		c.Configured = true
		changes = append(changes, secretChange{ID: "github/key/" + id, Purpose: "github-key", Value: input.PrivateKey}, secretChange{ID: "github/hook/" + id, Purpose: "github-hook", Value: input.WebhookSecret})
	} else if c.AppID != old.AppID {
		return integrationFailure(errors.New("Bei Änderung der App-ID den zugehörigen Schlüssel und Webhook-Secret angeben"))
	}
	if c.Enabled && (!c.Configured || c.InstallationID == "") {
		return integrationFailure(errors.New("Vor Aktivierung App und Installation einrichten"))
	}
	if c.InstallationID != "" && c.InstallationID != old.InstallationID {
		client, err := e.githubClient(old)
		if input.PrivateKey != "" {
			client, err = gh.New(c.AppID, input.PrivateKey)
		}
		if err != nil {
			return integrationFailure(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		installation, err := client.Installation(ctx, c.InstallationID)
		cancel()
		if err != nil {
			return integrationFailure(err)
		}
		c.Account = installation.Account.Login
	}
	if err := e.saveIntegration("github", id, c, p, "github.save", "GitHub-Verbindung gespeichert; "+input.Reason, changes...); err != nil {
		return integrationFailure(errors.New("GitHub-Verbindung konnte nicht sicher gespeichert werden"))
	}
	return 200, c
}

func (s *Server) githubInternal(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		fail(w, 405, "METHOD_NOT_ALLOWED", "POST erforderlich")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/internal/github/webhooks/") {
		s.acceptWebhook(w, r, strings.TrimPrefix(r.URL.Path, "/internal/github/webhooks/"))
		return
	}
	if r.URL.Path != "/internal/github/manifest-callback" && r.URL.Path != "/internal/github/install-callback" {
		fail(w, 404, "NOT_FOUND", "Endpunkt nicht gefunden")
		return
	}
	var input struct {
		State          string `json:"state"`
		Code           string `json:"code"`
		Nonce          string `json:"nonce"`
		InstallationID string `json:"installationId"`
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || decode(data, &input) != nil {
		fail(w, 400, "INVALID_SETUP", "Ungültiger Setup-Rückweg")
		return
	}
	e := s.Engine
	e.Store.Mu.Lock()
	var setup githubSetup
	err = e.Store.Get("github-setup", input.State, &setup)
	hash := sha256.Sum256([]byte(input.Nonce))
	valid := err == nil && setup.Expires >= time.Now().Unix() && hmac.Equal([]byte(setup.NonceHash), []byte(hex.EncodeToString(hash[:])))
	if valid {
		err = e.Store.Delete("github-setup", input.State)
		valid = err == nil
	}
	e.Store.Mu.Unlock()
	if !valid {
		fail(w, 403, "INVALID_SETUP", "Setup ist abgelaufen, bereits verwendet oder gehört zu einem anderen Browser")
		return
	}
	var connection GitHubConnection
	if e.Store.Get("github", setup.ConnectionID, &connection) != nil {
		fail(w, 404, "NOT_FOUND", "GitHub-Verbindung nicht gefunden")
		return
	}
	p := Principal{ID: setup.Actor, Role: "Owner", Hosts: []string{"local"}}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	if r.URL.Path == "/internal/github/manifest-callback" {
		result, err := gh.ExchangeManifest(ctx, input.Code)
		if err != nil {
			fail(w, 422, "GITHUB_SETUP_FAILED", err.Error())
			return
		}
		if _, err = gh.New(fmt.Sprint(result.ID), result.PEM); err != nil {
			fail(w, 422, "GITHUB_SETUP_FAILED", err.Error())
			return
		}
		connection.AppID = fmt.Sprint(result.ID)
		connection.Slug = result.Slug
		connection.Configured = true
		connection.Enabled = false
		connection.Status = "installation_required"
		connection.Revision++
		err = e.saveIntegration("github", connection.ID, connection, p, "github.setup.complete", "GitHub-App erstellt", secretChange{ID: "github/key/" + connection.ID, Purpose: "github-key", Value: result.PEM}, secretChange{ID: "github/hook/" + connection.ID, Purpose: "github-hook", Value: result.WebhookSecret})
		if err != nil {
			fail(w, 500, "STORE_ERROR", "App konnte nicht gespeichert werden")
			return
		}
		respond(w, 200, map[string]string{"connectionId": connection.ID})
		return
	}
	client, err := e.githubClient(connection)
	if err != nil {
		fail(w, 422, "GITHUB_SETUP_FAILED", err.Error())
		return
	}
	installation, err := client.Installation(ctx, input.InstallationID)
	if err != nil {
		fail(w, 422, "GITHUB_SETUP_FAILED", err.Error())
		return
	}
	connection.InstallationID = input.InstallationID
	connection.Account = installation.Account.Login
	connection.Status = "unchecked"
	connection.Revision++
	if e.saveIntegration("github", connection.ID, connection, p, "github.installation.selected", "GitHub-Installation zugeordnet") != nil {
		fail(w, 500, "STORE_ERROR", "Installation konnte nicht gespeichert werden")
		return
	}
	respond(w, 200, map[string]string{"connectionId": connection.ID})
}

type githubPayload struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository  gh.Repository `json:"repository"`
	WorkflowRun gh.Run        `json:"workflow_run"`
}

func (s *Server) acceptWebhook(w http.ResponseWriter, r *http.Request, id string) {
	e := s.Engine
	var connection GitHubConnection
	if !jobIDPattern.MatchString(id) || e.Store.Get("github", id, &connection) != nil || !connection.Configured {
		fail(w, 404, "NOT_FOUND", "Webhook nicht verfügbar")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		fail(w, 413, "BODY_TOO_LARGE", "Webhook überschreitet das Größenlimit")
		return
	}
	secret, err := e.Vault.Get("github/hook/"+id, "github-hook")
	if err != nil {
		fail(w, 503, "CREDENTIAL_UNAVAILABLE", "Webhook-Prüfung nicht verfügbar")
		return
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(data)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(r.Header.Get("X-Hub-Signature-256"))) {
		fail(w, 401, "INVALID_SIGNATURE", "Ungültige Webhook-Signatur")
		return
	}
	deliveryID := r.Header.Get("X-GitHub-Delivery")
	event := r.Header.Get("X-GitHub-Event")
	if !regexp.MustCompile(`^[A-Za-z0-9-]{8,100}$`).MatchString(deliveryID) || len(event) > 100 {
		fail(w, 400, "INVALID_DELIVERY", "Ungültige Zustellungs-ID")
		return
	}
	var payload githubPayload
	if json.Unmarshal(data, &payload) != nil {
		fail(w, 400, "INVALID_PAYLOAD", "Ungültiger Webhook-Inhalt")
		return
	}
	if connection.InstallationID != "" && fmt.Sprint(payload.Installation.ID) != connection.InstallationID && event != "ping" {
		fail(w, 403, "INSTALLATION_MISMATCH", "Webhook gehört nicht zur konfigurierten Installation")
		return
	}
	keyHash := sha256.Sum256([]byte(id + "\x00" + deliveryID))
	key := hex.EncodeToString(keyHash[:16])
	bodyHash := sha256.Sum256(data)
	hash := hex.EncodeToString(bodyHash[:])
	now := time.Now().UTC().Format(time.RFC3339Nano)
	e.Store.Mu.Lock()
	defer e.Store.Mu.Unlock()
	var old WebhookDelivery
	if e.Store.Get("delivery", key, &old) == nil {
		if old.PayloadHash != hash {
			fail(w, 409, "DELIVERY_CONFLICT", "Zustellungs-ID wurde mit verändertem Inhalt wiederholt")
			return
		}
		respond(w, 202, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	var pending int
	if e.Store.DB.QueryRow(`SELECT count(*) FROM records WHERE kind='delivery' AND json_extract(data,'$.state') IN ('pending','retry','processing')`).Scan(&pending) != nil || pending >= 1000 {
		fail(w, 503, "INBOX_FULL", "Webhook-Inbox ist ausgelastet")
		return
	}
	delivery := WebhookDelivery{ID: key, ConnectionID: id, DeliveryID: deliveryID, Event: event, Action: payload.Action, State: "pending", PayloadHash: hash, Created: now, Updated: now}
	switch event {
	case "ping", "installation", "installation_repositories", "workflow_run":
	default:
		delivery.State = "ignored"
	}
	minimal, _ := json.Marshal(payload)
	tx, err := e.Store.DB.Begin()
	if err != nil {
		fail(w, 503, "STORE_ERROR", "Inbox nicht verfügbar")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO records VALUES('delivery',?,?)`, key, encode(delivery)); err == nil {
		_, err = tx.Exec(`INSERT INTO webhook_payloads VALUES(?,?)`, key, minimal)
	}
	if err == nil {
		event := Event{HostID: "local", Actor: "github-webhook", Operation: "webhook.receive", Stage: delivery.State, Severity: "info", Message: "Signierte GitHub-Zustellung " + deliveryID + " angenommen", Time: now}
		_, err = tx.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, "local", encode(event))
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "STORE_ERROR", "Zustellung konnte nicht dauerhaft angenommen werden")
		return
	}
	e.NotifyIntegrations()
	respond(w, 202, map[string]any{"accepted": true, "id": key})
}

func randomBytes(n int) []byte {
	out := make([]byte, n)
	if _, err := rand.Read(out); err != nil {
		panic(err)
	}
	return out
}

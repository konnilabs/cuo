package core

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"cuo.local/cuo/internal/integrations"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

type Server struct {
	Engine *Engine
	Token  string
}

func Run() error {
	dir := os.Getenv("CUO_DATA")
	if dir == "" {
		dir = "/data"
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	s, e := Open(filepath.Join(dir, "cuo.db"))
	if e != nil {
		return e
	}
	defer s.DB.Close()
	if e = s.Recover(); e != nil {
		return e
	}
	var policy Policy
	if e = s.Get("policy", "global", &policy); e == sql.ErrNoRows {
		if e = s.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "scan-only", Concurrency: 1}); e != nil {
			return e
		}
	}
	token := os.Getenv("CUO_CORE_TOKEN")
	if len(token) < 32 {
		return errors.New("CUO_CORE_TOKEN must have at least 32 characters")
	}
	engine := NewEngine(s)
	keyFile := os.Getenv("CUO_INTEGRATION_KEY_FILE")
	if keyFile == "" {
		keyFile = "/run/secrets/cuo-integration-key"
	}
	engine.Vault, e = integrations.OpenVault(s.DB, keyFile)
	if e != nil {
		return e
	}
	if e = engine.migrateRegistries(); e != nil {
		return e
	}
	if e = engine.provisionZotConnection(); e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Worker(ctx)
	go engine.RetentionWorker(ctx)
	go engine.IntegrationWorker(ctx)
	go func() {
		_, _ = engine.Discover(ctx)
		interval, err := time.ParseDuration(os.Getenv("CUO_SCAN_INTERVAL"))
		if err != nil || interval < time.Minute {
			interval = 6 * time.Hour
		}
		_ = s.Put("meta", "nextScan", map[string]string{"time": time.Now().UTC().Add(interval).Format(time.RFC3339)})
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = s.Put("meta", "nextScan", map[string]string{"time": time.Now().UTC().Add(interval).Format(time.RFC3339)})
				if err := engine.Scan(ctx, "scheduler"); err != nil {
					_ = s.Event(Event{Actor: "scheduler", Operation: "scan", Stage: "failed", Severity: "warning", Message: err.Error()})
				}
			}
		}
	}()
	engine.Notify()
	addr := os.Getenv("CUO_LISTEN")
	if addr == "" {
		addr = ":8091"
	}
	return (&http.Server{Addr: addr, Handler: &Server{Engine: engine, Token: token}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}).ListenAndServe()
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, msg string) {
	respond(w, status, map[string]any{"code": code, "message": msg})
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		respond(w, 200, map[string]any{"ok": true, "version": "0.3.1"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.Token)) != 1 {
		fail(w, 401, "UNAUTHENTICATED", "Internal authentication required")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/internal/github/") {
		s.githubInternal(w, r)
		return
	}
	p := Principal{ID: r.Header.Get("X-CUO-Actor"), Role: r.Header.Get("X-CUO-Role"), Hosts: strings.Split(r.Header.Get("X-CUO-Hosts"), ",")}
	if _, ok := ranks[p.Role]; !ok || p.ID == "" {
		fail(w, 403, "FORBIDDEN", "Principal required")
		return
	}
	if !p.Host("local") {
		fail(w, 403, "HOST_FORBIDDEN", "Host access denied")
		return
	}
	capability := capabilityFor(r.URL.Path, r.Method)
	if capability != "" && !s.Engine.Store.Allows(p, capability) {
		fail(w, 403, "CAPABILITY_REQUIRED", "Berechtigung fehlt: "+capability)
		return
	}
	if r.Method == "GET" {
		if integrationPath(r.URL.Path) {
			s.integrationGet(w, r, p)
			return
		}
		s.get(w, r, p)
		return
	}
	if r.Method != "POST" && r.Method != "PUT" {
		fail(w, 405, "METHOD_NOT_ALLOWED", "Method not supported")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 128 {
		fail(w, 400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key (8..128 characters) required")
		return
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
	if e != nil {
		fail(w, 413, "BODY_TOO_LARGE", "Request body exceeds limit")
		return
	}
	sum := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
	fingerprint := hex.EncodeToString(sum[:])
	s.Engine.Store.Mu.Lock()
	defer s.Engine.Store.Mu.Unlock()
	var oldFingerprint, response string
	var status int
	e = s.Engine.Store.DB.QueryRow(`SELECT fingerprint,response,status FROM idempotency WHERE actor=? AND key=?`, p.ID, key).Scan(&oldFingerprint, &response, &status)
	if e == nil {
		if fingerprint != oldFingerprint {
			fail(w, 409, "IDEMPOTENCY_CONFLICT", "Key already used for a different request")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, response+"\n")
		return
	}
	if e != sql.ErrNoRows {
		fail(w, 500, "STORE_ERROR", "Persistent storage unavailable")
		return
	}
	// Reserve before side effects. An interrupted request is never executed twice.
	_, e = s.Engine.Store.DB.Exec(`INSERT INTO idempotency VALUES(?,?,?,?,?)`, p.ID, key, fingerprint, encode(map[string]any{"code": "REQUEST_INTERRUPTED", "message": "Inspect jobs and audit history before issuing a new request"}), 409)
	if e != nil {
		fail(w, 500, "STORE_ERROR", "Could not reserve request")
		return
	}
	s.Engine.Mu.Lock()
	status, v := s.mutate(r.URL.Path, r.Method, body, p)
	s.Engine.Mu.Unlock()
	response = encode(v)
	if _, e = s.Engine.Store.DB.Exec(`UPDATE idempotency SET response=?,status=? WHERE actor=? AND key=?`, response, status, p.ID, key); e != nil {
		fail(w, 500, "STORE_ERROR", "Result storage failed; inspect audit history")
		return
	}
	respond(w, status, v)
}
func (s *Server) get(w http.ResponseWriter, r *http.Request, p Principal) {
	store := s.Engine.Store
	if s.processGet(w, r, p) {
		return
	}
	switch {
	case r.URL.Path == "/api/v1/hosts":
		host := Host{ID: "local", Name: "Lokaler Docker-Host", Endpoint: "constrained-agent", Capabilities: []string{"inventory", "registry-scan", "standalone-update", "registered-compose-reconcile"}}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		response, err := s.Engine.agent(ctx, "GET", "/info", nil)
		if err == nil {
			defer response.Body.Close()
			if response.StatusCode == 200 {
				var info Host
				if json.NewDecoder(response.Body).Decode(&info) == nil {
					host.Connected = info.Connected
					host.DockerVersion = info.DockerVersion
					host.APIVersion = info.APIVersion
				}
			}
		}
		respond(w, 200, map[string]any{"items": []Host{host}})
	case r.URL.Path == "/api/v1/containers":
		var list []Container
		if r.URL.Query().Get("refresh") == "true" {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			v, e := s.Engine.Discover(ctx)
			if e != nil {
				fail(w, 502, "AGENT_UNAVAILABLE", "Docker-Agent nicht erreichbar")
				return
			}
			list = v
		} else {
			_ = store.List("container", &list)
		}
		filtered := []Container{}
		q := strings.ToLower(r.URL.Query().Get("q"))
		for _, c := range list {
			if strings.Contains(strings.ToLower(c.Name+" "+c.Image), q) {
				filtered = append(filtered, c)
			}
		}
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Name < filtered[j].Name })
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit < 1 || limit > 200 {
			limit = 50
		}
		if offset < 0 {
			offset = 0
		}
		if offset > len(filtered) {
			offset = len(filtered)
		}
		end := offset + limit
		if end > len(filtered) {
			end = len(filtered)
		}
		respond(w, 200, map[string]any{"items": filtered[offset:end], "total": len(filtered), "offset": offset, "limit": limit})
	case r.URL.Path == "/api/v1/update-candidates":
		var list []Candidate
		_ = store.List("candidate", &list)
		current := []Candidate{}
		for _, candidate := range list {
			var container Container
			if store.Get("container", candidate.ContainerID, &container) == nil && candidateMatches(container, candidate) {
				current = append(current, candidate)
			}
		}
		respond(w, 200, map[string]any{"items": current})
	case r.URL.Path == "/api/v1/update-jobs":
		jobs := store.Jobs()
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].Created > jobs[j].Created })
		respond(w, 200, map[string]any{"items": jobs})
	case strings.HasPrefix(r.URL.Path, "/api/v1/update-jobs/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/update-jobs/")
		var j Job
		if store.Get("job", id, &j) != nil {
			fail(w, 404, "NOT_FOUND", "Job not found")
			return
		}
		respond(w, 200, j)
	case r.URL.Path == "/api/v1/policies":
		respond(w, 200, map[string]any{"items": store.Policies()})
	case strings.HasPrefix(r.URL.Path, "/api/v1/policies/"):
		var policy Policy
		if store.Get("policy", strings.TrimPrefix(r.URL.Path, "/api/v1/policies/"), &policy) != nil {
			fail(w, 404, "NOT_FOUND", "Policy not found")
			return
		}
		respond(w, 200, policy)
	case r.URL.Path == "/api/v1/maintenance-windows":
		var list []Window
		_ = store.List("window", &list)
		for i := range list {
			if next := NextWindowStart(list[i], time.Now()); !next.IsZero() {
				list[i].NextStart = next.UTC().Format(time.RFC3339)
			}
		}
		respond(w, 200, map[string]any{"items": list})
	case r.URL.Path == "/api/v1/events":
		s.events(w, r, p)
	case r.URL.Path == "/api/v1/activity":
		after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		items, e := store.LatestEvents(p)
		if r.URL.Query().Has("after") {
			items, e = store.Events(after, p)
		}
		if e != nil {
			fail(w, 500, "STORE_ERROR", "Event storage unavailable")
			return
		}
		respond(w, 200, map[string]any{"items": items})
	default:
		fail(w, 404, "NOT_FOUND", "Endpoint not found")
	}
}
func decode(body []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(string(body)))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("invalid trailing JSON")
	}
	return nil
}
func (s *Server) mutate(path, method string, body []byte, p Principal) (int, any) {
	if status, value, handled := s.processMutation(path, method, body, p); handled {
		return status, value
	}

	if integrationPath(path) {
		return s.integrationMutate(path, method, body, p)
	}
	store := s.Engine.Store
	bad := func(code, msg string) (int, any) { return 422, map[string]any{"code": code, "message": msg} }
	switch {
	case path == "/api/v1/update-runs" && method == "POST":
		var input struct {
			All       bool   `json:"all"`
			Reason    string `json:"reason"`
			Confirmed bool   `json:"confirmed"`
		}
		if decode(body, &input) != nil || !input.All || !input.Confirmed || len(strings.TrimSpace(input.Reason)) < 3 || len(input.Reason) > 500 {
			return bad("CONFIRMATION_REQUIRED", "Bestätige alle Neustarts und gib einen Grund an")
		}
		run, err := s.Engine.CreateRun(p, strings.TrimSpace(input.Reason))
		if err != nil {
			return bad("RUN_FAILED", err.Error())
		}
		if len(run.Jobs) == 0 {
			return 409, map[string]any{"code": "NO_ELIGIBLE_UPDATES", "message": "Keine ausführbaren Updates vorhanden. Richtlinien, aktive Jobs und Prüfergebnisse kontrollieren.", "skipped": run.Skipped}
		}
		return 201, run
	case path == "/api/v1/scans" && method == "POST":
		if !s.Engine.ScanMu.TryLock() {
			return 409, map[string]string{"code": "SCAN_RUNNING", "message": "Eine Prüfung läuft bereits"}
		}
		s.Engine.ScanMu.Unlock()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			if e := s.Engine.Scan(ctx, p.ID); e != nil {
				_ = store.Event(Event{Actor: p.ID, Operation: "scan", Stage: "failed", Severity: "error", Message: e.Error()})
			}
		}()
		return 202, map[string]any{"accepted": true}
	case path == "/api/v1/update-jobs" && method == "POST":
		var input struct {
			ContainerID string `json:"containerId"`
			Reason      string `json:"reason"`
			Confirmed   bool   `json:"confirmed"`
		}
		if decode(body, &input) != nil || !input.Confirmed || len(input.Reason) < 3 || len(input.Reason) > 500 {
			return bad("CONFIRMATION_REQUIRED", "Bestätige den Neustart und gib einen Grund an")
		}
		var c Container
		if store.Get("container", input.ContainerID, &c) != nil {
			return bad("NOT_FOUND", "Container nicht gefunden")
		}
		j, e := s.Engine.CreateJob(c, p, input.Reason, false)
		if e != nil {
			return bad("POLICY_BLOCKED", e.Error())
		}
		return 201, j
	case strings.HasPrefix(path, "/api/v1/update-jobs/") && method == "POST":
		parts := strings.Split(strings.TrimPrefix(path, "/api/v1/update-jobs/"), "/")
		if len(parts) != 2 {
			return bad("INVALID_PATH", "Invalid job command")
		}
		var j Job
		if store.Get("job", parts[0], &j) != nil {
			return bad("NOT_FOUND", "Job not found")
		}
		if parts[1] == "cancel" {
			if j.State != "queued" && j.State != "scheduled" && j.State != "pending_approval" {
				return bad("NOT_CANCELLABLE", "Job has passed its cancellation point")
			}
			s.Engine.update(&j, "cancelled", "Durch "+p.ID+" abgebrochen")
			return 200, j
		}
		if parts[1] != "approve" || j.State != "pending_approval" {
			return bad("INVALID_STATE", "Job is not awaiting approval")
		}
		if !store.Allows(p, "updates.approve") {
			return 403, map[string]string{"code": "FORBIDDEN", "message": "Administrator role required for approval"}
		}
		var input struct {
			Confirmed bool   `json:"confirmed"`
			Reason    string `json:"reason"`
		}
		if decode(body, &input) != nil || !input.Confirmed || len(input.Reason) < 3 || len(input.Reason) > 500 {
			return bad("CONFIRMATION_REQUIRED", "Approval reason required")
		}
		state := "queued"
		if j.WindowID != "" {
			state = "scheduled"
		}
		j.Approved = true
		s.Engine.update(&j, state, "Freigegeben durch "+p.ID+": "+input.Reason)
		s.Engine.Notify()
		return 200, j
	case strings.HasPrefix(path, "/api/v1/policies/") && method == "PUT":
		var policy Policy
		if decode(body, &policy) != nil {
			return bad("INVALID_INPUT", "Invalid policy")
		}
		policy.ID = strings.TrimPrefix(path, "/api/v1/policies/")
		var previous Policy
		_ = store.Get("policy", policy.ID, &previous)
		permissionChanged := policy.Permissions != previous.Permissions || policy.PermissionReason != previous.PermissionReason
		if previous.Permissions.Any() || policy.Permissions.Any() {
			permissionChanged = permissionChanged || previous.Scope != policy.Scope || previous.Target != policy.Target
		}
		grantCapability := "execution.monitoring.grant"
		if previous.Permissions.Elevated() || policy.Permissions.Elevated() {
			grantCapability = "execution.host-preservation.grant"
		}
		if permissionChanged && !store.Allows(p, grantCapability) {
			return 403, map[string]string{"code": "CAPABILITY_REQUIRED", "message": "Ausführungsfreigaben benötigen eine gesonderte Rollenberechtigung"}
		}
		if e := ValidatePolicy(policy); e != nil {
			return bad("INVALID_POLICY", e.Error())
		}
		if policy.Permissions.Any() {
			var container Container
			if store.Get("container", policy.Target, &container) != nil || !p.Host(container.HostID) {
				return bad("INVALID_CONTAINER", "Die Ausführungsfreigabe benötigt einen vorhandenen, zugänglichen Container")
			}
		}
		if policy.WindowID != "" {
			var w Window
			if store.Get("window", policy.WindowID, &w) != nil {
				return bad("INVALID_WINDOW", "Maintenance window does not exist")
			}
		}
		for _, existing := range store.Policies() {
			if existing.ID != policy.ID && existing.Scope == policy.Scope && existing.Target == policy.Target {
				return bad("POLICY_CONFLICT", "Für diesen Geltungsbereich existiert bereits eine Richtlinie")
			}
		}
		if e := store.SavePolicy(policy, p.ID, permissionChanged); e != nil {
			return bad("STORE_ERROR", e.Error())
		}
		var containers []Container
		_ = store.List("container", &containers)
		for _, c := range containers {
			effective := ResolvePolicy(c, store.Policies())
			c.Mode = effective.Mode
			c.Excluded = effective.Excluded || effective.Mode == "disabled"
			_ = store.Put("container", c.ID, c)
		}
		s.Engine.Notify()
		return 200, policy
	case path == "/api/v1/maintenance-windows" && method == "POST":
		var window Window
		if decode(body, &window) != nil {
			return bad("INVALID_INPUT", "Invalid window")
		}
		if e := ValidateWindow(window); e != nil {
			return bad("INVALID_WINDOW", e.Error())
		}
		var list []Window
		_ = store.List("window", &list)
		if len(list) >= 100 {
			return bad("WINDOW_LIMIT", "Maximal 100 Wartungsfenster erlaubt")
		}
		for _, existing := range list {
			if WindowsOverlap(existing, window, time.Now()) {
				return bad("WINDOW_OVERLAP", "Wartungsfenster überschneidet sich mit "+existing.Name)
			}
		}
		window.ID = ID()
		window.NextStart = ""
		if e := store.Put("window", window.ID, window); e != nil {
			return bad("STORE_ERROR", e.Error())
		}
		_ = store.Event(Event{Actor: p.ID, Operation: "window.create", Stage: "saved", Severity: "info", Message: "Wartungsfenster " + window.Name + " angelegt"})
		return 201, window
	default:
		return 404, map[string]string{"code": "NOT_FOUND", "message": "Endpoint not found"}
	}
}
func (s *Server) events(w http.ResponseWriter, r *http.Request, p Principal) {
	after, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if q := r.URL.Query().Get("after"); q != "" {
		after, _ = strconv.ParseInt(q, 10, 64)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "STREAM_UNAVAILABLE", "Streaming unavailable")
		return
	}
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	io.WriteString(w, ": connected\n\n")
	flusher.Flush()
	for {
		if !s.Engine.Store.Allows(p, "inventory.read") {
			return
		}
		items, e := s.Engine.Store.Events(after, p)
		if e != nil {
			return
		}
		for _, event := range items {
			fmt.Fprintf(w, "id: %d\nevent: activity\ndata: %s\n\n", event.ID, encode(event))
			after = event.ID
		}
		if len(items) == 0 {
			io.WriteString(w, ": keepalive\n\n")
		}
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
		}
	}
}

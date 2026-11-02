package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Engine struct {
	Store      *Store
	AgentURL   string
	AgentToken string
	Client     *http.Client
	Wake       chan struct{}
	Mu         sync.Mutex
	ScanMu     sync.Mutex
	DiscoverMu sync.Mutex
}

func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func (e *Engine) agent(ctx context.Context, method, path string, input any) (*http.Response, error) {
	var body io.Reader
	if input != nil {
		body = strings.NewReader(encode(input))
	}
	r, err := http.NewRequestWithContext(ctx, method, e.AgentURL+path, body)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+e.AgentToken)
	r.Header.Set("Content-Type", "application/json")
	return e.Client.Do(r)
}
func (e *Engine) Discover(ctx context.Context) ([]Container, error) {
	e.DiscoverMu.Lock()
	defer e.DiscoverMu.Unlock()
	r, err := e.agent(ctx, "GET", "/inventory", nil)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, errors.New("agent unavailable")
	}
	var list []Container
	if err = json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&list); err != nil {
		return nil, err
	}
	policies := e.Store.Policies()
	seen := map[string]bool{}
	for i := range list {
		c := &list[i]
		if c.EngineID == "" {
			c.EngineID = c.ID
		}
		identity := sha256.Sum256([]byte(c.HostID + "\x00" + c.Name))
		c.ID = hex.EncodeToString(identity[:])
		seen[c.ID] = true
		p := ResolvePolicy(*c, policies)
		c.Mode = p.Mode
		c.Excluded = p.Excluded || p.Mode == "disabled"
		var candidate Candidate
		if e.Store.Get("candidate", c.ID, &candidate) == nil && candidate.Source == c.ImageID {
			c.Candidate = &candidate
		}
		if err = e.Store.Put("container", c.ID, c); err != nil {
			return nil, err
		}
	}
	var old []Container
	_ = e.Store.List("container", &old)
	for _, c := range old {
		if !seen[c.ID] {
			_ = e.Store.Delete("container", c.ID)
			_ = e.Store.Delete("candidate", c.ID)
		}
	}
	return list, nil
}
func (e *Engine) Scan(ctx context.Context, actor string) error {
	if !e.ScanMu.TryLock() {
		return errors.New("scan already running")
	}
	defer e.ScanMu.Unlock()
	list, err := e.Discover(ctx)
	if err != nil {
		return err
	}
	_ = e.Store.Event(Event{Actor: actor, Operation: "scan", Stage: "started", Severity: "info", Message: fmt.Sprintf("Prüfe %d lokale Container", len(list))})
	for _, c := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if c.Mode == "disabled" {
			continue
		}
		if strings.HasPrefix(c.Image, "sha256:") || !strings.Contains(c.Image, ":") && len(c.Image) == 64 {
			continue
		}
		r, err := e.agent(ctx, "POST", "/scan", c)
		if err != nil {
			return err
		}
		if r.StatusCode != 200 {
			r.Body.Close()
			continue
		}
		var candidate Candidate
		err = json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&candidate)
		r.Body.Close()
		if err != nil {
			return err
		}
		if err = e.Store.Put("candidate", c.ID, candidate); err != nil {
			return err
		}
		c.Candidate = &candidate
		_ = e.Store.Put("container", c.ID, c)
		message := c.Name + ": aktuell"
		severity := "info"
		if candidate.Error != "" {
			message = c.Name + ": " + candidate.Error
			severity = "warning"
		} else if candidate.Target != "" {
			message = c.Name + ": neuer Plattform-Digest verfügbar"
		}
		_ = e.Store.Event(Event{Actor: actor, Operation: "scan", Stage: "discovered", Severity: severity, Message: message})
	}
	_ = e.Store.Put("meta", "lastScan", map[string]any{"time": time.Now().UTC().Format(time.RFC3339)})
	_ = e.Store.Event(Event{Actor: actor, Operation: "scan", Stage: "completed", Severity: "info", Message: "Update-Prüfung abgeschlossen"})
	e.Notify()
	return nil
}
func (e *Engine) Notify() {
	select {
	case e.Wake <- struct{}{}:
	default:
	}
}
func (e *Engine) CreateJob(c Container, p Principal, reason string, automatic bool) (Job, error) {
	j, err := e.prepareJob(c, p, reason, automatic, false)
	if err != nil {
		return Job{}, err
	}
	if err = e.Store.Put("job", j.ID, j); err != nil {
		return j, err
	}
	_ = e.Store.Event(Event{JobID: j.ID, Actor: p.ID, Operation: "job.create", Stage: j.State, Severity: "info", Message: c.Name + ": Update angelegt"})
	e.Notify()
	return j, nil
}
func (e *Engine) prepareJob(c Container, p Principal, reason string, automatic, immediate bool) (Job, error) {
	policy := ResolvePolicy(c, e.Store.Policies())
	if policy.Excluded || policy.Mode == "disabled" || policy.Mode == "scan-only" {
		return Job{}, errors.New("policy does not permit execution")
	}
	if !p.Host(c.HostID) {
		return Job{}, errors.New("host access denied")
	}
	if immediate && (!p.Can("Administrator") || c.State != "running") {
		return Job{}, errors.New("immediate updates require administrator access and a running container")
	}
	if c.Candidate == nil || c.Candidate.Target == "" || c.Candidate.Error != "" {
		return Job{}, errors.New("no valid update candidate")
	}
	if c.Candidate.Source != c.ImageID {
		return Job{}, errors.New("stale candidate")
	}
	for _, j := range e.Store.Jobs() {
		if j.ContainerID == c.ID && !terminal(j.State) {
			return Job{}, errors.New("container already has an active job")
		}
	}
	state := "queued"
	if policy.Mode == "approval-required" && !automatic {
		state = "pending_approval"
	}
	if automatic && policy.Mode != "automatic" {
		return Job{}, errors.New("automatic execution not permitted")
	}
	if policy.WindowID != "" && state == "queued" {
		state = "scheduled"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	j := Job{ID: ID(), EngineID: c.EngineID, HostID: c.HostID, ContainerID: c.ID, Name: c.Name, State: state, Target: c.Candidate.Target, Source: c.Candidate.Source, Image: c.Image, Platform: c.Platform, Requester: p.ID, Reason: reason, WindowID: policy.WindowID, Created: now, Updated: now}
	if immediate {
		j.State = "queued"
		j.WindowID = ""
		j.Approved = true
		j.Immediate = true
	}
	return j, nil
}
func terminal(s string) bool {
	return s == "succeeded" || s == "failed" || s == "intervention_required" || s == "cancelled"
}
func (e *Engine) update(j *Job, state, message string) {
	j.State = state
	j.Updated = time.Now().UTC().Format(time.RFC3339)
	if terminal(state) {
		j.Reason = message
	}
	if err := e.Store.Put("job", j.ID, j); err != nil {
		panic(err)
	}
	severity := "info"
	if state == "failed" || state == "intervention_required" {
		severity = "error"
	}
	if err := e.Store.Event(Event{JobID: j.ID, Actor: "core", Operation: "update", Stage: state, Severity: severity, Message: j.Name + ": " + message}); err != nil {
		panic(err)
	}
}
func (e *Engine) execute(j Job) {
	e.executeContext(context.Background(), j)
}
func (e *Engine) executeContext(parent context.Context, j Job) {
	e.Mu.Lock()
	var persisted Job
	if e.Store.Get("job", j.ID, &persisted) != nil || persisted.State != "queued" {
		e.Mu.Unlock()
		return
	}
	j = persisted
	var current Container
	err := e.Store.Get("container", j.ContainerID, &current)
	p := ResolvePolicy(current, e.Store.Policies())
	if err != nil || current.EngineID != j.EngineID || p.Excluded || p.Mode == "disabled" || p.Mode == "scan-only" {
		e.update(&j, "cancelled", "Richtlinie blockiert die Ausführung")
		e.Mu.Unlock()
		return
	}
	if p.Mode == "approval-required" && !j.Approved {
		e.update(&j, "pending_approval", "Richtlinie verlangt eine Freigabe")
		e.Mu.Unlock()
		return
	}
	if p.WindowID != "" && !j.Immediate {
		var window Window
		_ = e.Store.Get("window", p.WindowID, &window)
		if active, _ := ActiveWindow(window, time.Now()); !active {
			j.WindowID = p.WindowID
			e.update(&j, "scheduled", "Warte auf Wartungsfenster")
			e.Mu.Unlock()
			return
		}
	}
	e.update(&j, "preflight", "Vorprüfung gestartet")
	e.Mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, 16*time.Minute)
	defer cancel()
	r, err := e.agent(ctx, "POST", "/execute", map[string]any{"jobId": j.ID, "containerId": j.EngineID, "sourceDigest": j.Source, "targetDigest": j.Target, "image": j.Image, "platform": j.Platform, "permissions": p.Permissions})
	if err != nil {
		e.update(&j, "intervention_required", "Agent-Verbindung unterbrochen; Journal prüfen")
		return
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		e.update(&j, "failed", fmt.Sprintf("Agent HTTP %d", r.StatusCode))
		return
	}
	decoder := json.NewDecoder(r.Body)
	done := false
	for {
		var f struct{ Stage, Message, Error, NewID string }
		if err = decoder.Decode(&f); err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		switch f.Stage {
		case "preflight", "pulling", "recreating", "verifying", "succeeded", "failed", "intervention_required":
		default:
			continue
		}
		e.update(&j, f.Stage, f.Message)
		if terminal(f.Stage) {
			done = true
			break
		}
	}
	if !done {
		e.update(&j, "intervention_required", "Ausführung ohne Abschluss; Agent-Journal prüfen")
	}
	discoverCtx, discoverCancel := context.WithTimeout(parent, 15*time.Second)
	defer discoverCancel()
	_, _ = e.Discover(discoverCtx)
}
func (e *Engine) Tick(now time.Time) {
	e.Mu.Lock()
	var windows []Window
	_ = e.Store.List("window", &windows)
	for _, j := range e.Store.Jobs() {
		if j.State != "scheduled" {
			continue
		}
		for _, w := range windows {
			if w.ID == j.WindowID {
				if active, _ := ActiveWindow(w, now); active {
					e.update(&j, "queued", "Wartungsfenster geöffnet")
				}
			}
		}
	}
	var containers []Container
	_ = e.Store.List("container", &containers)
	for _, c := range containers {
		p := ResolvePolicy(c, e.Store.Policies())
		if p.Mode != "automatic" || p.Excluded || c.Candidate == nil || c.Candidate.Target == "" || c.Candidate.Error != "" {
			continue
		}
		slot := "candidate:" + c.Candidate.Target
		eligible := p.WindowID == ""
		for _, w := range windows {
			if w.ID == p.WindowID {
				eligible, slot = ActiveWindow(w, now)
			}
		}
		if !eligible {
			continue
		}
		_, err := e.Store.DB.Exec(`INSERT INTO schedule_runs VALUES(?,?)`, slot, c.ID)
		if err != nil {
			continue
		}
		if _, err = e.CreateJob(c, Principal{ID: "scheduler", Role: "Owner", Hosts: []string{"local"}}, "Automatische Richtlinie", true); err != nil {
			_, _ = e.Store.DB.Exec(`DELETE FROM schedule_runs WHERE slot=? AND container=?`, slot, c.ID)
		}
	}
	e.Mu.Unlock()
}
func (e *Engine) Worker(ctx context.Context) {
	timer := time.NewTicker(15 * time.Second)
	defer timer.Stop()
	completed := make(chan string, 4)
	active := map[string]Container{}
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.Wake:
		case id := <-completed:
			delete(active, id)
		case <-timer.C:
		}
		e.Tick(time.Now())
		e.dispatch(ctx, active, completed, &workers)
	}
}
func NewEngine(s *Store) *Engine {
	endpoint := os.Getenv("CUO_AGENT_URL")
	if endpoint == "" {
		endpoint = "http://agent:8092"
	}
	return &Engine{Store: s, AgentURL: endpoint, AgentToken: os.Getenv("CUO_AGENT_TOKEN"), Client: &http.Client{Timeout: 17 * time.Minute}, Wake: make(chan struct{}, 1)}
}

package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.DB.Close() })
	return s
}
func TestPolicyPrecedenceAndStickyExclusion(t *testing.T) {
	c := Container{ID: "c", HostID: "local", Group: "db", Managed: true}
	policies := []Policy{{ID: "g", Scope: "global", Mode: "scan-only", Concurrency: 1}, {ID: "h", Scope: "host", Target: "local", Mode: "automatic", Excluded: true, Concurrency: 1}, {ID: "group", Scope: "group", Target: "db", Mode: "disabled", Concurrency: 1}, {ID: "c", Scope: "container", Target: "c", Mode: "approval-required", Concurrency: 1}}
	p := ResolvePolicy(c, policies)
	if p.Mode != "approval-required" || !p.Excluded {
		t.Fatalf("precedence or exclusion wrong: %+v", p)
	}
	c.Managed = false
	if !ResolvePolicy(c, nil).Excluded {
		t.Fatal("unmanaged container must be excluded")
	}
}
func TestDSTSkippedAndRepeatedHours(t *testing.T) {
	w := Window{ID: "w", Name: "night", Timezone: "Europe/Berlin", Days: []int{0}, Start: "02:30", Duration: 60, Enabled: true}
	for _, test := range []struct{ date, want string }{{"2026-03-29T12:00:00Z", "2026-03-29T01:00:00Z"}, {"2026-10-25T12:00:00Z", "2026-10-25T00:30:00Z"}} {
		day, _ := time.Parse(time.RFC3339, test.date)
		got := WindowStart(w, day)
		if got.UTC().Format(time.RFC3339) != test.want {
			t.Fatalf("%s got %s want %s", test.date, got.UTC(), test.want)
		}
	}
	w.Duration = 30
	repeated, _ := time.Parse(time.RFC3339, "2026-10-25T01:35:00Z")
	if active, _ := ActiveWindow(w, repeated); active {
		t.Fatal("second occurrence of repeated wall hour must not run")
	}
}
func TestWindowMidnightBlackoutAndMissedRun(t *testing.T) {
	w := Window{ID: "night", Name: "night", Timezone: "Europe/Berlin", Days: []int{1}, Start: "23:30", Duration: 90, Enabled: true}
	inside, _ := time.Parse(time.RFC3339, "2026-11-02T23:15:00Z")
	if active, _ := ActiveWindow(w, inside); !active {
		t.Fatal("window spanning midnight not active")
	}
	expired := inside.Add(2 * time.Hour)
	if active, _ := ActiveWindow(w, expired); active {
		t.Fatal("expired window cannot be replayed")
	}
	w.Blackouts = []string{"2026-11-02"}
	if active, _ := ActiveWindow(w, inside); active {
		t.Fatal("blackout must suppress entire window")
	}
}
func TestJobRecoveryPersistsIntervention(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "db")
	s, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	j := Job{ID: "job", State: "recreating"}
	if e = s.Put("job", j.ID, j); e != nil {
		t.Fatal(e)
	}
	s.DB.Close()
	s, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	if e = s.Recover(); e != nil {
		t.Fatal(e)
	}
	if e = s.Get("job", j.ID, &j); e != nil || j.State != "intervention_required" {
		t.Fatalf("unsafe recovery: %+v %v", j, e)
	}
	events, e := s.Events(0, Principal{Hosts: []string{"local"}})
	if e != nil || len(events) != 1 || events[0].Operation != "recovery" {
		t.Fatal(events, e)
	}
}
func TestIdempotencyConflictRBACAndHostScope(t *testing.T) {
	store := testStore(t)
	e := NewEngine(store)
	server := &Server{Engine: e, Token: "secret"}
	input := Policy{Scope: "global", Mode: "scan-only", Concurrency: 1}
	call := func(role, hosts, key string, p Policy) *httptest.ResponseRecorder {
		body, _ := json.Marshal(p)
		r := httptest.NewRequest("PUT", "/api/v1/policies/global", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer secret")
		r.Header.Set("X-CUO-Actor", "owner")
		r.Header.Set("X-CUO-Role", role)
		r.Header.Set("X-CUO-Hosts", hosts)
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	a := call("Owner", "local", "same-request", input)
	b := call("Owner", "local", "same-request", input)
	if a.Code != 200 || b.Code != 200 || a.Body.String() != b.Body.String() {
		t.Fatal(a, b)
	}
	events, _ := store.Events(0, Principal{Hosts: []string{"local"}})
	if len(events) != 1 {
		t.Fatal("retry repeated mutation", events)
	}
	input.Mode = "automatic"
	if w := call("Owner", "local", "same-request", input); w.Code != 409 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call("Viewer", "local", "viewer-request", input); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := call("Owner", "other", "host-request", input); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := call("Owner", "local", "", input); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestCandidateCannotBypassScanOnlyOrDuplicateActiveJob(t *testing.T) {
	store := testStore(t)
	e := NewEngine(store)
	c := Container{ID: "c", HostID: "local", Name: "test", Managed: true, ImageID: "sha256:a", Candidate: &Candidate{Source: "sha256:a", Target: "sha256:b"}}
	p := Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}
	if _, err := e.CreateJob(c, p, "test", false); err == nil {
		t.Fatal("scan-only must reject execution")
	}
	_ = store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "approval-required", Concurrency: 1})
	j, err := e.CreateJob(c, p, "test", false)
	if err != nil || j.State != "pending_approval" {
		t.Fatal(j, err)
	}
	if _, err = e.CreateJob(c, p, "again", false); err == nil {
		t.Fatal("duplicate active job accepted")
	}
}
func TestSSEEventsAreScopedAndResumable(t *testing.T) {
	store := testStore(t)
	_ = store.Event(Event{HostID: "secret", Message: "forbidden"})
	_ = store.Event(Event{HostID: "local", Message: "allowed"})
	p := Principal{Hosts: []string{"local"}}
	events, err := store.Events(0, p)
	if err != nil || len(events) != 1 || events[0].Message != "allowed" {
		t.Fatal(events, err)
	}
	next, err := store.Events(events[0].ID, p)
	if err != nil || len(next) != 0 {
		t.Fatal("resume repeated event", next, err)
	}
}
func TestWorkerRecoversQueuedJobWhenAgentFails(t *testing.T) {
	store := testStore(t)
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer agent.Close()
	e := NewEngine(store)
	e.AgentURL = agent.URL
	_ = store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 1})
	_ = store.Put("container", "c", Container{ID: "c", Managed: true, HostID: "local"})
	j := Job{ID: "j", ContainerID: "c", State: "queued", Name: "test"}
	_ = store.Put("job", j.ID, j)
	e.execute(j)
	_ = store.Get("job", j.ID, &j)
	if j.State != "failed" {
		t.Fatal(j)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	e.Worker(ctx)
}
func TestMinuteSizedWindowCollisionAcrossZones(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-01T00:00:00Z")
	a := Window{ID: "a", Name: "a", Enabled: true, Timezone: "Europe/Berlin", Start: "03:01", Duration: 1, Days: []int{0}}
	b := Window{ID: "b", Name: "b", Enabled: true, Timezone: "UTC", Start: "02:01", Duration: 1, Days: []int{0}}
	if !WindowsOverlap(a, b, now) {
		t.Fatal("one-minute overlap missed")
	}
	b.Start = "02:02"
	if WindowsOverlap(a, b, now) {
		t.Fatal("adjacent intervals should be allowed")
	}
}
func TestCancelledQueueSnapshotCannotExecute(t *testing.T) {
	store := testStore(t)
	e := NewEngine(store)
	j := Job{ID: "cancelled", State: "cancelled"}
	_ = store.Put("job", j.ID, j)
	stale := j
	stale.State = "queued"
	e.execute(stale)
	_ = store.Get("job", j.ID, &j)
	if j.State != "cancelled" {
		t.Fatal("stale worker snapshot executed cancelled job")
	}
}
func TestNewerSchemaCannotBeSilentlyDowngraded(t *testing.T) {
	file := filepath.Join(t.TempDir(), "future.db")
	s, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec("PRAGMA user_version=2")
	if err != nil {
		t.Fatal(err)
	}
	s.DB.Close()
	if newer, err := Open(file); err == nil {
		newer.DB.Close()
		t.Fatal("newer database schema accepted")
	}
}
func TestContainerIdentityAndPolicySurviveEngineReplacement(t *testing.T) {
	store := testStore(t)
	engineID := strings.Repeat("a", 64)
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]Container{{ID: engineID, EngineID: engineID, HostID: "local", Name: "app", Managed: true}})
	}))
	defer agent.Close()
	e := NewEngine(store)
	e.AgentURL = agent.URL
	first, err := e.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = store.Put("policy", "app", Policy{ID: "app", Scope: "container", Target: first[0].ID, Mode: "approval-required", Concurrency: 1})
	engineID = strings.Repeat("b", 64)
	second, err := e.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first[0].ID != second[0].ID || first[0].EngineID == second[0].EngineID || second[0].Mode != "approval-required" {
		t.Fatal("logical identity or policy lost", first, second)
	}
}
func TestEventTailAndHostFilteringDoNotStallAfterLargeForeignBatch(t *testing.T) {
	store := testStore(t)
	for i := 0; i < 510; i++ {
		if err := store.Event(Event{HostID: "other", Message: "hidden"}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 205; i++ {
		_ = store.Event(Event{HostID: "local", Message: fmt.Sprint(i)})
	}
	principal := Principal{Hosts: []string{"local"}}
	forward, err := store.Events(0, principal)
	if err != nil || len(forward) != 205 {
		t.Fatal("foreign event batch stalled visible stream", len(forward), err)
	}
	tail, err := store.LatestEvents(principal)
	if err != nil || len(tail) != 200 || tail[0].Message != "5" || tail[199].Message != "204" {
		t.Fatal("log tail is stale or unbounded", tail, err)
	}
}
func TestNextMaintenanceOccurrenceUsesTimezoneAndBlackouts(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-01T04:30:00Z")
	w := Window{ID: "next", Name: "next", Timezone: "Europe/Berlin", Start: "03:00", Duration: 60, Enabled: true, Days: []int{0}, Blackouts: []string{"2026-11-08"}}
	next := NextWindowStart(w, now)
	if next.UTC().Format(time.RFC3339) != "2026-11-15T02:00:00Z" {
		t.Fatal("wrong next maintenance time", next)
	}
}

package core

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

var localOwner = Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}

func processCall(s *Server, method, path, role, key string, input any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(input)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("Authorization", "Bearer test")
	r.Header.Set("X-CUO-Actor", "owner")
	r.Header.Set("X-CUO-Role", role)
	r.Header.Set("X-CUO-Hosts", "local")
	r.Header.Set("Idempotency-Key", key)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestProcessTelemetryUsesLiveJobsAndIndependentLogPagination(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	j := Job{ID: "child", RunID: "bulk", HostID: "local", ContainerID: "web", Name: "web", State: "queued", Created: now.Add(-time.Minute).Format(time.RFC3339), Stages: []StageTiming{{Stage: "queued", Started: now.Add(-time.Minute).Format(time.RFC3339)}}}
	recordStage(&j, "preflight", now)
	j.State = "preflight"
	recordStage(&j, "preflight", now.Add(time.Second))
	if len(j.Stages) != 2 {
		t.Fatal("same phase duplicated")
	}
	recordStage(&j, "succeeded", now.Add(2*time.Second))
	j.State = "succeeded"
	_ = s.Put("job", j.ID, j)
	_ = s.Put("run", "bulk", UpdateRun{ID: "bulk", Jobs: []Job{{ID: j.ID, State: "queued"}}})
	for n := 0; n < 451; n++ {
		_ = s.Event(Event{JobID: j.ID, Message: fmt.Sprint(n)})
	}
	for n := 0; n < 260; n++ {
		_ = s.Event(Event{Message: "unrelated"})
	}
	d, err := e.ProcessDetail("bulk", localOwner, 0, now)
	if err != nil || d.Run.State != "succeeded" || d.Run.DurationMS != 2000 || d.Run.QueueMS != 60000 || len(d.Events) != 200 || d.EventCount != 451 || !d.MoreEvents {
		t.Fatalf("%+v %v", d.Run, err)
	}
	d2, err := e.ProcessDetail("bulk", localOwner, d.NextEventID, now)
	if err != nil || len(d2.Events) != 200 || d2.Events[0].ID <= d.NextEventID {
		t.Fatal("cursor", d2, err)
	}
	if _, err = e.ProcessDetail("bulk", Principal{Hosts: []string{"other"}}, 0, now); err == nil {
		t.Fatal("foreign run leaked")
	}
	if _, err = filterProcesses(e.Processes(localOwner, now), url.Values{"from": {"2026-11-04"}, "to": {"2026-11-03"}}); err == nil {
		t.Fatal("invalid range accepted")
	}
	for i := 0; i < 3; i++ {
		old := j
		old.ID = fmt.Sprint("old", i)
		old.RunID = ""
		old.Created = now.Add(time.Duration(i-10) * time.Hour).Format(time.RFC3339)
		old.Started = old.Created
		old.Finished = parseTime(old.Started).Add(time.Second).Format(time.RFC3339)
		_ = s.Put("job", old.ID, old)
	}
	j.Finished = now.Add(40 * time.Second).Format(time.RFC3339)
	_ = s.Put("job", j.ID, j)
	runs := e.Processes(localOwner, now)
	if runs[0].BaselineMS != 1000 || runs[0].BaselineSamples != 3 || len(runs[0].Anomalies) != 1 || runs[0].Anomalies[0].Code != "slow_run" {
		t.Fatalf("baseline %+v", runs[0])
	}
}
func TestForecastIDsAreStableAndDoNotCreateJobs(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	c := runContainer("web")
	c.State = "exited"
	_ = s.Put("container", c.ID, c)
	_ = s.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 1, WindowID: "night"})
	_ = s.Put("window", "night", Window{ID: "night", Timezone: "Europe/Berlin", Days: []int{0, 1, 2, 3, 4, 5, 6}, Start: "03:00", Duration: 60, Enabled: true})
	first := e.Upcoming(localOwner, now)
	second := e.Upcoming(localOwner, now.Add(time.Minute))
	if len(first) != 1 || first[0].ID != second[0].ID || first[0].State != "blocked" || len(s.Jobs()) != 0 {
		t.Fatal(first, second)
	}
	_ = s.Put("job", "pending", Job{ID: "pending", ContainerID: c.ID, HostID: "local", State: "scheduled"})
	if len(e.Upcoming(localOwner, now)) != 0 {
		t.Fatal("forecast duplicates durable job")
	}
}
func TestScanTelemetryRecoveryAndExport(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	r, err := e.beginScan("test")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Event(Event{RunID: r.ID, Operation: "scan", Message: "scan event"})
	if s.openProcesses() != 1 {
		t.Fatal("active scan not counted")
	}
	if err = s.Recover(); err != nil {
		t.Fatal(err)
	}
	d, err := e.ProcessDetail(r.ID, localOwner, 0, time.Now())
	if err != nil || d.Run.State != "intervention_required" || len(d.Run.Stages) != 1 || d.Run.Stages[0].Finished == "" || len(d.Events) != 1 {
		t.Fatal(d, err)
	}
	server := &Server{Engine: e, Token: "test"}
	w := processCall(server, "GET", "/api/v1/exports?dataset=detail&format=xlsx&runId="+r.ID, "Owner", "", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var file DataExport
	_ = json.Unmarshal(w.Body.Bytes(), &file)
	data, _ := base64.StdEncoding.DecodeString(file.Content)
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(z.File) < 9 || file.Rows < 3 {
		t.Fatal("invalid detail workbook", file.Rows, err)
	}
}
func TestLogRetentionProtectsActiveGroupsAndPreservesHistory(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	now := time.Now().UTC()
	for _, j := range []Job{{ID: "done", State: "succeeded", HostID: "local"}, {ID: "live", State: "pulling", HostID: "local", RunID: "batch"}, {ID: "sibling", State: "succeeded", HostID: "local", RunID: "batch"}} {
		_ = s.Put("job", j.ID, j)
		_ = s.Event(Event{JobID: j.ID, RunID: processID(j), Time: now.Add(-60 * 24 * time.Hour).Format(time.RFC3339), Message: j.ID})
	}
	active, err := e.beginScan("test")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Event(Event{RunID: active.ID, Message: "active scan"})
	finished := active
	finished.ID = "completed-scan"
	finished.State = "succeeded"
	_ = s.Put("scan-run", finished.ID, finished)
	_ = s.Event(Event{RunID: finished.ID, Message: "done scan"})
	_ = s.Event(Event{RunID: "batch", Message: "group event"})
	_ = s.Event(Event{Message: "loose audit"})
	_, _ = s.DB.Exec(`INSERT INTO schedule_runs VALUES('slot','web')`)
	if s.RetentionPolicy().Enabled {
		t.Fatal("rotation must be opt in")
	}
	if _, err = e.MaintainLogs("compact", "test", "test reason", now); err == nil {
		t.Fatal("compact accepted active scan/job")
	}
	result, err := e.MaintainLogs("reset", "test", "confirmed reset", now)
	if err != nil || result.Deleted != 3 || result.ProtectedJobs != 2 {
		t.Fatal(result, err)
	}
	ev, _ := s.Events(0, localOwner)
	for _, event := range ev {
		if event.Message == "done" || event.Message == "done scan" || event.Message == "loose audit" {
			t.Fatal("deleted event remains")
		}
	}
	var j Job
	_ = s.Get("job", "done", &j)
	if !j.LogsPruned || j.State != "succeeded" {
		t.Fatal(j)
	}
	j = Job{}
	_ = s.Get("job", "sibling", &j)
	if j.LogsPruned {
		t.Fatal("active group sibling pruned")
	}
	var scan ProcessRun
	_ = s.Get("scan-run", finished.ID, &scan)
	if !scan.LogsPruned {
		t.Fatal("scan prune flag missing")
	}
	var count int
	_ = s.DB.QueryRow(`SELECT count(*) FROM schedule_runs`).Scan(&count)
	if count != 1 || len(s.Jobs()) != 3 {
		t.Fatal("history/dedup deleted")
	}
	if ev[len(ev)-1].ID <= 7 {
		t.Fatal("SSE cursor reused")
	}
}
func TestRetentionAuthorizationRevisionIdempotencyAndAuditAtomicity(t *testing.T) {
	s := testStore(t)
	server := &Server{Engine: NewEngine(s), Token: "test"}
	input := LogMaintenanceRequest{Revision: 1, Enabled: true, Days: 7, MaxEvents: 100, IntervalHours: 24, Confirmed: true, Reason: "test retention"}
	for _, role := range []string{"Viewer", "Operator", "Administrator"} {
		w := processCall(server, "PUT", "/api/v1/log-retention", role, "forbidden-"+role, input)
		if w.Code != 403 {
			t.Fatal(role, w.Code, w.Body)
		}
	}
	w := processCall(server, "PUT", "/api/v1/log-retention", "Owner", "retention-save", input)
	again := processCall(server, "PUT", "/api/v1/log-retention", "Owner", "retention-save", input)
	if w.Code != 200 || again.Body.String() != w.Body.String() {
		t.Fatal(w.Code, w.Body, again.Body)
	}
	if w = processCall(server, "PUT", "/api/v1/log-retention", "Owner", "retention-conflict", input); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w = processCall(server, "POST", "/api/v1/log-retention/reset", "Owner", "reset-unsafe", input); w.Code != 422 {
		t.Fatal("missing typed confirmation", w.Code)
	}
	_, _ = s.DB.Exec(`CREATE TRIGGER reject_log_settings BEFORE INSERT ON events WHEN json_extract(new.data,'$.operation')='logs.settings' BEGIN SELECT RAISE(ABORT,'audit down'); END`)
	input.Revision = 2
	input.Days = 9
	if w = processCall(server, "PUT", "/api/v1/log-retention", "Owner", "audit-rollback", input); w.Code != 500 || s.RetentionPolicy().Days != 7 {
		t.Fatal(w.Code, w.Body, s.RetentionPolicy())
	}
}
func TestRotationAgeAndCountAndFilteredExport(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	now := time.Now().UTC()
	_ = s.Put("log-retention", "current", LogRetention{Revision: 1, Days: 7, MaxEvents: 100, IntervalHours: 1})
	for n := 0; n < 135; n++ {
		_ = s.Event(Event{Time: now.Add(-time.Duration(n) * 24 * time.Hour).Format(time.RFC3339), Message: fmt.Sprint("event-", n)})
	}
	result, err := e.MaintainLogs("rotate", "test", "test rule", now)
	if err != nil || result.Deleted != 135 {
		t.Fatal(result, err)
	}
	// Filtering occurs in SQL before the limit, even when over 10,000 non-matching events exist.
	tx, _ := s.DB.Begin()
	for n := 0; n < 10002; n++ {
		_, err = tx.Exec(`INSERT INTO events(host,data) VALUES('local',?)`, encode(Event{HostID: "local", Time: now.Format(time.RFC3339), Message: "ordinary"}))
		if err != nil {
			t.Fatal(err)
		}
	}
	_, _ = tx.Exec(`INSERT INTO events(host,data) VALUES('local',?)`, encode(Event{HostID: "local", Time: now.Format(time.RFC3339), Message: "=malicious unique"}))
	_ = tx.Commit()
	server := &Server{Engine: e, Token: "test"}
	w := processCall(server, "GET", "/api/v1/exports?dataset=logs&format=csv&q=unique", "Viewer", "", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	var file DataExport
	_ = json.Unmarshal(w.Body.Bytes(), &file)
	data, _ := base64.StdEncoding.DecodeString(file.Content)
	if file.Rows != 1 || !strings.Contains(string(data), "'=malicious unique") {
		t.Fatal(file.Rows, string(data))
	}
	if w = processCall(server, "GET", "/api/v1/exports?dataset=logs&format=csv", "Viewer", "", nil); w.Code != 422 {
		t.Fatal("silent truncation", w.Code)
	}
}

func TestActiveTelemetryAndCompactionReclaimsSpace(t *testing.T) {
	s := testStore(t)
	e := NewEngine(s)
	now := time.Now().UTC()
	scan, err := e.beginScan("test")
	if err != nil {
		t.Fatal(err)
	}
	runs := e.Processes(localOwner, now.Add(3*time.Second))
	if len(runs) != 1 || runs[0].DurationMS < 2900 || runs[0].Stages[0].DurationMS < 2900 {
		t.Fatal(runs)
	}
	e.finishScan(&scan, nil)
	tx, _ := s.DB.Begin()
	for n := 0; n < 1200; n++ {
		_, err = tx.Exec(`INSERT INTO events(host,data) VALUES('local',?)`, encode(Event{HostID: "local", Message: strings.Repeat("x", 4096), Time: now.Format(time.RFC3339)}))
		if err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()
	before := s.LogStorage()
	if _, err = e.MaintainLogs("reset", "test", "temporary test data", now); err != nil {
		t.Fatal(err)
	}
	if _, err = e.MaintainLogs("compact", "test", "reclaim space", now); err != nil {
		t.Fatal(err)
	}
	after := s.LogStorage()
	if after.DatabaseBytes >= before.DatabaseBytes/2 {
		t.Fatal("space not reclaimed", before, after)
	}
	if len(e.Processes(localOwner, now)) != 1 {
		t.Fatal("scan history removed")
	}
}

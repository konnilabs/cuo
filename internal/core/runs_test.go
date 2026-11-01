package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func runContainer(id string) Container {
	return Container{ID: id, EngineID: id, HostID: "local", Name: id, Managed: true, State: "running", ImageID: "sha256:old", Candidate: &Candidate{Source: "sha256:old", Target: "sha256:new"}}
}
func runRequest(server *Server, role, key string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest("POST", "/api/v1/update-runs", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer test")
	request.Header.Set("X-CUO-Actor", "operator")
	request.Header.Set("X-CUO-Role", role)
	request.Header.Set("X-CUO-Hosts", "local")
	request.Header.Set("Idempotency-Key", key)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}
func TestImmediateRunSelectionAuthorizationAndIdempotency(t *testing.T) {
	store := testStore(t)
	engine := NewEngine(store)
	server := &Server{Engine: engine, Token: "test"}
	_ = store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "approval-required", Concurrency: 2, WindowID: "closed"})
	for _, id := range []string{"eligible", "unmanaged", "excluded", "scan-only", "active", "stopped", "stale", "failed-scan", "foreign"} {
		c := runContainer(id)
		switch id {
		case "unmanaged":
			c.Managed = false
		case "stopped":
			c.State = "exited"
		case "stale":
			c.Candidate.Source = "sha256:stale"
		case "failed-scan":
			c.Candidate.Error = "registry failed"
		case "foreign":
			c.HostID = "private"
		}
		_ = store.Put("container", id, c)
	}
	_ = store.Put("policy", "excluded", Policy{ID: "excluded", Scope: "container", Target: "excluded", Mode: "automatic", Excluded: true, Concurrency: 1})
	_ = store.Put("policy", "scan-only", Policy{ID: "scan-only", Scope: "container", Target: "scan-only", Mode: "scan-only", Concurrency: 1})
	_ = store.Put("job", "existing", Job{ID: "existing", ContainerID: "active", State: "queued"})
	body := []byte(`{"all":true,"reason":"Manual maintenance","confirmed":true}`)
	for _, role := range []string{"Viewer", "Operator"} {
		if response := runRequest(server, role, "forbidden-"+role, body); response.Code != 403 {
			t.Fatal(role, response.Code, response.Body)
		}
	}
	if response := runRequest(server, "Administrator", "not-confirmed", []byte(`{"all":true,"reason":"test","confirmed":false}`)); response.Code != 422 {
		t.Fatal(response.Code, response.Body)
	}
	first := runRequest(server, "Administrator", "batch-request", body)
	if first.Code != 201 {
		t.Fatal(first.Code, first.Body)
	}
	var run UpdateRun
	if err := json.Unmarshal(first.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if len(run.Jobs) != 1 || run.Jobs[0].ContainerID != "eligible" || !run.Jobs[0].Approved || !run.Jobs[0].Immediate || run.Jobs[0].State != "queued" || run.Jobs[0].WindowID != "" || run.Jobs[0].RunID != run.ID {
		t.Fatalf("wrong run: %+v", run)
	}
	if len(run.Skipped) != 7 {
		t.Fatal("missing skip explanations", run.Skipped)
	}
	for _, skip := range run.Skipped {
		if skip.ContainerID == "foreign" {
			t.Fatal("foreign host leaked")
		}
	}
	again := runRequest(server, "Administrator", "batch-request", body)
	if again.Code != 201 || again.Body.String() != first.Body.String() || len(store.Jobs()) != 2 {
		t.Fatal("idempotent retry duplicated run", again.Code, again.Body)
	}
	if response := runRequest(server, "Administrator", "new-batch-request", body); response.Code != 409 {
		t.Fatal("active work queued twice", response.Code, response.Body)
	}
	var persisted UpdateRun
	if err := store.Get("run", run.ID, &persisted); err != nil || len(persisted.Jobs) != 1 {
		t.Fatal("batch not durable", persisted, err)
	}
}
func TestRunTransactionRollsBackPartialJobAndAuditWrites(t *testing.T) {
	store := testStore(t)
	engine := NewEngine(store)
	_ = store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 2})
	_ = store.Put("container", "one", runContainer("one"))
	_, err := store.DB.Exec(`CREATE TRIGGER reject_run BEFORE INSERT ON records WHEN NEW.kind='run' BEGIN SELECT RAISE(ABORT,'test failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = engine.CreateRun(Principal{ID: "admin", Role: "Administrator", Hosts: []string{"local"}}, "test run"); err == nil {
		t.Fatal("injected store failure ignored")
	}
	events, _ := store.Events(0, Principal{Hosts: []string{"local"}})
	if len(store.Jobs()) != 0 || len(events) != 0 {
		t.Fatal("partial batch escaped rollback", store.Jobs(), events)
	}
}
func TestConcurrencyHonorsGlobalAndGroupLimits(t *testing.T) {
	a := Container{ID: "a", HostID: "local", Group: "database"}
	b := Container{ID: "b", HostID: "local", Group: "database"}
	c := Container{ID: "c", HostID: "local", Group: "apps"}
	policies := []Policy{{ID: "global", Scope: "global", Concurrency: 3}, {ID: "db", Scope: "group", Target: "database", Concurrency: 1}}
	if canStart(b, []Container{a}, policies) {
		t.Fatal("group limit ignored")
	}
	if !canStart(c, []Container{a}, policies) {
		t.Fatal("unrelated group blocked")
	}
	if canStart(c, []Container{a, b, {ID: "d"}}, policies) {
		t.Fatal("global limit ignored")
	}
	if canStart(a, []Container{a}, policies) {
		t.Fatal("duplicate container admitted")
	}
	if canStart(c, []Container{a}, nil) {
		t.Fatal("serial fallback ignored")
	}
}
func TestWorkerExecutesImmediateRunWithConfiguredParallelism(t *testing.T) {
	for _, limit := range []int{1, 2, 4} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			store := testStore(t)
			started := make(chan string, 16)
			release := make(chan struct{})
			var current, peak atomic.Int32
			agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/execute" {
					w.WriteHeader(503)
					return
				}
				var op struct {
					ContainerID string `json:"containerId"`
				}
				_ = json.NewDecoder(r.Body).Decode(&op)
				count := current.Add(1)
				for {
					old := peak.Load()
					if count <= old || peak.CompareAndSwap(old, count) {
						break
					}
				}
				defer current.Add(-1)
				started <- op.ContainerID
				<-release
				_ = json.NewEncoder(w).Encode(map[string]string{"Stage": "succeeded", "Message": "updated"})
			}))
			defer agent.Close()
			engine := NewEngine(store)
			engine.AgentURL = agent.URL
			_ = store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "approval-required", Concurrency: limit, WindowID: "closed"})
			for i := 0; i < 5; i++ {
				c := runContainer(fmt.Sprint(i))
				_ = store.Put("container", c.ID, c)
			}
			run, err := engine.CreateRun(Principal{ID: "admin", Role: "Administrator", Hosts: []string{"local"}}, "test now")
			if err != nil || len(run.Jobs) != 5 {
				t.Fatal(run, err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { engine.Worker(ctx); close(done) }()
			for i := 0; i < limit; i++ {
				select {
				case <-started:
				case <-time.After(2 * time.Second):
					cancel()
					close(release)
					t.Fatal("worker did not fill configured slots")
				}
			}
			select {
			case <-started:
				cancel()
				close(release)
				t.Fatal("worker exceeded configured slots")
			case <-time.After(40 * time.Millisecond):
			}
			close(release)
			deadline := time.Now().Add(2 * time.Second)
			for {
				complete := 0
				for _, job := range store.Jobs() {
					if job.State == "succeeded" {
						complete++
					}
				}
				if complete == 5 {
					break
				}
				if time.Now().After(deadline) {
					cancel()
					t.Fatal("queue did not drain", store.Jobs())
				}
				time.Sleep(5 * time.Millisecond)
			}
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("worker failed to stop")
			}
			if peak.Load() != int32(limit) {
				t.Fatal("parallelism mismatch", peak.Load(), limit)
			}
		})
	}
}

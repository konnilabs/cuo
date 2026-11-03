package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestDiscoveryInvalidatesCandidateWhenImageReferenceOrPlatformChanges(t *testing.T) {
	for _, change := range []string{"unchanged", "image", "reference", "platform"} {
		t.Run(change, func(t *testing.T) {
			c := Container{ID: "engine-before", HostID: "local", Name: "app", Image: "example/app:stable", ImageID: "sha256:old", Platform: "linux/amd64", State: "exited", Managed: true}
			agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode([]Container{c}) }))
			defer agent.Close()
			e := NewEngine(testStore(t))
			e.AgentURL = agent.URL
			rows, err := e.Discover(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			original := rows[0]
			candidate := Candidate{ContainerID: original.ID, Source: original.ImageID, Ref: original.Image, Platform: original.Platform, Target: "sha256:new"}
			if err = e.Store.Put("candidate", original.ID, candidate); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "image":
				c.ImageID = "sha256:new"
			case "reference":
				c.Image = "example/app:held"
			case "platform":
				c.Platform = "linux/arm64"
			}
			rows, err = e.Discover(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if change == "unchanged" {
				if rows[0].Candidate == nil {
					t.Fatal("valid stopped-image observation lost")
				}
				return
			}
			if rows[0].Candidate != nil {
				t.Fatal("stale candidate attached to changed workload", rows[0])
			}
			var saved Candidate
			if err = e.Store.Get("candidate", original.ID, &saved); !errors.Is(err, sql.ErrNoRows) {
				t.Fatal("stale candidate remained in candidate API cache", saved, err)
			}
		})
	}
}

func TestLateScanCannotRestoreReplacedContainerSnapshot(t *testing.T) {
	var mu sync.Mutex
	current := Container{ID: "engine-before", HostID: "local", Name: "app", Image: "example/app:stable", ImageID: "sha256:old", Platform: "linux/amd64", State: "running", Managed: true}
	started, release := make(chan struct{}), make(chan struct{})
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/inventory" {
			mu.Lock()
			c := current
			mu.Unlock()
			json.NewEncoder(w).Encode([]Container{c})
			return
		}
		if r.URL.Path == "/scan" {
			var c Container
			if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			close(started)
			<-release
			json.NewEncoder(w).Encode(Candidate{ContainerID: c.ID, Source: c.ImageID, Ref: c.Image, Platform: c.Platform, Target: "sha256:new"})
			return
		}
		w.WriteHeader(404)
	}))
	defer agent.Close()
	e := NewEngine(testStore(t))
	e.AgentURL = agent.URL
	done := make(chan error, 1)
	go func() { done <- e.Scan(context.Background(), "test") }()
	<-started
	mu.Lock()
	current.ID = "engine-after"
	current.ImageID = "sha256:new"
	current.State = "exited"
	mu.Unlock()
	rows, err := e.Discover(context.Background())
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	id := rows[0].ID
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	var saved Container
	if err = e.Store.Get("container", id, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.EngineID != "engine-after" || saved.ImageID != "sha256:new" || saved.State != "exited" || saved.Candidate != nil {
		t.Fatal("late registry response restored stale running container/update", saved)
	}
}

func TestCandidateAPIAndJobAdmissionRejectChangedReference(t *testing.T) {
	store := testStore(t)
	e := NewEngine(store)
	c := runContainer("app")
	c.Image = "alpine:held"
	if err := store.Put("container", c.ID, c); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("candidate", c.ID, c.Candidate); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.CreateJob(c, Principal{ID: "owner", Role: "Owner", Hosts: []string{"local"}}, "test", false); err == nil || err.Error() != "stale candidate" {
		t.Fatal("changed reference was admitted", err)
	}
	server := &Server{Engine: e, Token: "test"}
	request := httptest.NewRequest("GET", "/api/v1/update-candidates", nil)
	for key, value := range map[string]string{"Authorization": "Bearer test", "X-CUO-Actor": "owner", "X-CUO-Role": "Owner", "X-CUO-Hosts": "local"} {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	var body struct {
		Items []Candidate `json:"items"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || len(body.Items) != 0 {
		t.Fatal("candidate API exposed stale reference", response.Code, response.Body.String())
	}
}

func TestExecutionAnnouncesRefreshedInventoryAfterTerminalEvent(t *testing.T) {
	current := Container{ID: "engine-old", HostID: "local", Name: "app", Image: "example/app:stable", ImageID: "sha256:old", Platform: "linux/amd64", State: "running", Managed: true}
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/inventory" {
			json.NewEncoder(w).Encode([]Container{current})
			return
		}
		if r.URL.Path == "/execute" {
			current.ID = "engine-new"
			current.ImageID = "sha256:new"
			current.State = "exited"
			w.Write([]byte(`{"stage":"succeeded","message":"fixture"}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer agent.Close()
	e := NewEngine(testStore(t))
	e.AgentURL = agent.URL
	rows, err := e.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c := rows[0]
	if err = e.Store.Put("policy", "global", Policy{ID: "global", Scope: "global", Mode: "automatic", Concurrency: 1}); err != nil {
		t.Fatal(err)
	}
	job := Job{ID: "job", ContainerID: c.ID, HostID: c.HostID, EngineID: c.EngineID, Image: c.Image, State: "queued"}
	if err = e.Store.Put("job", job.ID, job); err != nil {
		t.Fatal(err)
	}
	e.executeContext(context.Background(), job)
	events, err := e.Store.Events(0, Principal{Hosts: []string{"local"}})
	if err != nil {
		t.Fatal(err)
	}
	terminalID, refreshedID := int64(0), int64(0)
	for _, event := range events {
		if event.JobID != job.ID {
			continue
		}
		if event.Stage == "succeeded" {
			terminalID = event.ID
		}
		if event.Operation == "inventory" && event.Stage == "refreshed" {
			refreshedID = event.ID
		}
	}
	if terminalID == 0 || refreshedID <= terminalID {
		t.Fatal("UI was not notified after reconciliation", events)
	}
	var saved Container
	if err = e.Store.Get("container", c.ID, &saved); err != nil || saved.State != "exited" || saved.ImageID != "sha256:new" {
		t.Fatal(saved, err)
	}
}

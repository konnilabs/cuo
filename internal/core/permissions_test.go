package core

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestExecutionPermissionRequiresOwnerContainerReasonAndConfirmation(t *testing.T) {
	store := testStore(t)
	id := strings.Repeat("a", 64)
	_ = store.Put("container", id, Container{ID: id, HostID: "local", Managed: true, Image: "alpine:3", State: "running"})
	server := &Server{Engine: NewEngine(store), Token: "secret"}
	request := 0
	call := func(role string, input Policy) *httptest.ResponseRecorder {
		request++
		body, _ := json.Marshal(input)
		r := httptest.NewRequest("PUT", "/api/v1/policies/"+id, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer secret")
		r.Header.Set("X-CUO-Actor", "permission-owner")
		r.Header.Set("X-CUO-Role", role)
		r.Header.Set("X-CUO-Hosts", "local")
		r.Header.Set("Idempotency-Key", fmt.Sprintf("permission-request-%d", request))
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	input := Policy{Scope: "container", Target: id, Mode: "automatic", Concurrency: 1, Permissions: ExecutionPermissions{ReadOnlyHostMonitoring: true}, PermissionReason: "Read-only monitoring approved", PermissionsConfirmed: true}
	if w := call("Administrator", input); w.Code != 403 {
		t.Fatal("administrator granted host access", w.Code, w.Body)
	}
	for _, variant := range []string{"global", "confirmation", "reason", "unknown-target"} {
		invalid := input
		switch variant {
		case "global":
			invalid.Scope = "global"
		case "confirmation":
			invalid.PermissionsConfirmed = false
		case "reason":
			invalid.PermissionReason = " "
		case "unknown-target":
			invalid.Target = strings.Repeat("b", 64)
		}
		if w := call("Owner", invalid); w.Code != 422 {
			t.Fatal(variant, w.Code, w.Body)
		}
	}
	if w := call("Owner", input); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	input.Mode = "approval-required"
	if w := call("Administrator", input); w.Code != 200 {
		t.Fatal("administrator could not preserve an existing grant", w.Code, w.Body)
	}
	revoke := input
	revoke.Permissions = ExecutionPermissions{}
	revoke.PermissionReason = ""
	revoke.PermissionsConfirmed = false
	if w := call("Administrator", revoke); w.Code != 403 {
		t.Fatal("administrator changed an Owner grant", w.Code, w.Body)
	}
	if w := call("Owner", revoke); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	events, _ := store.Events(0, Principal{Hosts: []string{"local"}})
	count := 0
	for _, event := range events {
		if event.Operation == "policy.permissions" {
			count++
			if event.Actor != "permission-owner" || event.Severity != "warning" {
				t.Fatal("permission audit incomplete", event)
			}
		}
	}
	if count != 2 {
		t.Fatal("grant and revocation must both be audited", events)
	}
}

func TestExecutionPermissionsCannotBeInheritedFromBroadPolicies(t *testing.T) {
	c := Container{ID: strings.Repeat("a", 64), HostID: "local", Managed: true, Image: "alpine:3", State: "running"}
	global := Policy{Scope: "global", Mode: "automatic", Permissions: ExecutionPermissions{ReadOnlyHostMonitoring: true}}
	if ResolvePolicy(c, []Policy{global}).Permissions.ReadOnlyHostMonitoring {
		t.Fatal("broad policy granted host access")
	}
	specific := Policy{Scope: "container", Target: c.ID, Mode: "automatic", Permissions: ExecutionPermissions{ReadOnlyHostMonitoring: true}}
	if !ResolvePolicy(c, []Policy{global, specific}).Permissions.ReadOnlyHostMonitoring {
		t.Fatal("specific permission was lost")
	}
	c.ID = strings.Repeat("b", 64)
	if ResolvePolicy(c, []Policy{global, specific}).Permissions.ReadOnlyHostMonitoring {
		t.Fatal("another container inherited host access")
	}
}

func TestPermissionAuditFailureRollsBackGrant(t *testing.T) {
	store := testStore(t)
	_, err := store.DB.Exec(`CREATE TRIGGER reject_permission_audit BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.operation')='policy.permissions' BEGIN SELECT RAISE(FAIL,'audit fixture unavailable'); END`)
	if err != nil {
		t.Fatal(err)
	}
	policy := Policy{ID: "fixture", Scope: "container", Target: strings.Repeat("a", 64), Permissions: ExecutionPermissions{ReadOnlyHostMonitoring: true}}
	if store.SavePolicy(policy, "owner", true) == nil {
		t.Fatal("permission was granted without its audit record")
	}
	var saved Policy
	if err = store.Get("policy", policy.ID, &saved); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("unaudited permission persisted", saved, err)
	}
	events, _ := store.Events(0, Principal{Hosts: []string{"local"}})
	if len(events) != 0 {
		t.Fatal("partial policy audit persisted", events)
	}
}

func TestJobRequestCannotInjectAgentPermissions(t *testing.T) {
	store := testStore(t)
	server := &Server{Engine: NewEngine(store), Token: "secret"}
	r := httptest.NewRequest("POST", "/api/v1/update-jobs", strings.NewReader(`{"containerId":"fixture","reason":"Operator request","confirmed":true,"permissions":{"readOnlyHostMonitoring":true}}`))
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("X-CUO-Actor", "operator")
	r.Header.Set("X-CUO-Role", "Operator")
	r.Header.Set("X-CUO-Hosts", "local")
	r.Header.Set("Idempotency-Key", "job-permission-injection")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 422 || len(store.Jobs()) != 0 {
		t.Fatal("public job request supplied Agent permissions", w.Code, w.Body)
	}
}

func TestExecuteRechecksCurrentPermissionsIncludingRevocation(t *testing.T) {
	for _, granted := range []bool{false, true} {
		t.Run(fmt.Sprint(granted), func(t *testing.T) {
			store := testStore(t)
			id := strings.Repeat("a", 64)
			c := Container{ID: id, EngineID: strings.Repeat("b", 64), HostID: "local", Managed: true, Image: "alpine:3", State: "running"}
			_ = store.Put("container", id, c)
			j := Job{ID: strings.Repeat("c", 32), State: "queued", ContainerID: id, EngineID: c.EngineID, Image: c.Image}
			_ = store.Put("job", j.ID, j)
			// A queued job never stores a permission that survives revocation.
			_ = store.Put("policy", id, Policy{ID: id, Scope: "container", Target: id, Mode: "automatic", Permissions: ExecutionPermissions{ReadOnlyHostMonitoring: granted}})
			var seen atomic.Bool
			agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/inventory" {
					fmt.Fprint(w, "[]")
					return
				}
				var payload struct{ Permissions ExecutionPermissions }
				if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Permissions.ReadOnlyHostMonitoring != granted {
					t.Error("current permission not forwarded")
				}
				seen.Store(true)
				fmt.Fprintln(w, `{"stage":"succeeded","message":"fixture"}`)
			}))
			defer agent.Close()
			engine := NewEngine(store)
			engine.AgentURL = agent.URL
			engine.executeContext(context.Background(), j)
			if !seen.Load() {
				t.Fatal("Agent was not reached")
			}
		})
	}
}

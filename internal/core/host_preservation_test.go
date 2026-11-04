package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHostPreservationGrantsRequireOwnerAndAreRevocable(t *testing.T) {
	s := testStore(t)
	id := strings.Repeat("d", 64)
	_ = s.Put("container", id, Container{ID: id, HostID: "local", Managed: true})
	server := &Server{Engine: NewEngine(s), Token: "secret"}
	counter := 0
	call := func(role string, p Policy) *httptest.ResponseRecorder {
		counter++
		data, _ := json.Marshal(p)
		r := httptest.NewRequest("PUT", "/api/v1/policies/"+id, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer secret")
		r.Header.Set("X-CUO-Actor", "owner")
		r.Header.Set("X-CUO-Role", role)
		r.Header.Set("X-CUO-Hosts", "local")
		r.Header.Set("Idempotency-Key", fmt.Sprint("host-grant-", counter))
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	p := Policy{Scope: "container", Target: id, Mode: "automatic", Concurrency: 1, PermissionReason: "Trusted existing monitoring configuration", PermissionsConfirmed: true, Permissions: ExecutionPermissions{PreserveSysAdmin: true, PreserveSysPtrace: true, PreserveDacReadSearch: true, PreserveHostPID: true}}
	policy := s.PermissionPolicy()
	for i := range policy.Roles {
		if policy.Roles[i].Role == "Administrator" {
			policy.Roles[i].Capabilities = append(policy.Roles[i].Capabilities, "execution.monitoring.grant")
		}
	}
	_ = s.Put("permission-policy", "current", policy)
	if w := call("Administrator", p); w.Code != 403 {
		t.Fatal("monitoring grant implied host grants", w.Code, w.Body)
	}
	for _, variant := range []string{"global", "missing-reason", "missing-confirmation", "unknown-container"} {
		v := p
		switch variant {
		case "global":
			v.Scope = "global"
		case "missing-reason":
			v.PermissionReason = ""
		case "missing-confirmation":
			v.PermissionsConfirmed = false
		default:
			v.Target = strings.Repeat("e", 64)
		}
		if w := call("Owner", v); w.Code != 422 {
			t.Fatal(variant, w.Code, w.Body)
		}
	}
	if w := call("Owner", p); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	p.Mode = "scan-only"
	if w := call("Administrator", p); w.Code != 200 {
		t.Fatal("could not preserve grants", w.Code, w.Body)
	}
	p.Permissions = ExecutionPermissions{}
	p.PermissionsConfirmed = false
	p.PermissionReason = ""
	if w := call("Administrator", p); w.Code != 403 {
		t.Fatal("non-owner revoked grants", w.Code, w.Body)
	}
	if w := call("Owner", p); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	events, _ := s.Events(0, Principal{Hosts: []string{"local"}})
	count := 0
	for _, event := range events {
		if event.Operation == "policy.permissions" {
			count++
			if count == 1 && !strings.Contains(event.Message, "preserveSysAdmin") {
				t.Fatal("missing grant details in audit", event)
			}
		}
	}
	if count != 2 {
		t.Fatal("missing grant/revoke audit", count)
	}
}

func TestHostPreservationDoesNotInheritOrSurviveBroadScope(t *testing.T) {
	c := Container{ID: strings.Repeat("a", 64), HostID: "local", Managed: true}
	p := Policy{Scope: "global", Permissions: ExecutionPermissions{PreserveSysAdmin: true, PreserveHostPID: true}}
	if ResolvePolicy(c, []Policy{p}).Permissions.Any() {
		t.Fatal("global host grant inherited")
	}
	p.Scope = "container"
	p.Target = c.ID
	if !ResolvePolicy(c, []Policy{p}).Permissions.PreserveHostPID {
		t.Fatal("container grant lost")
	}
	p.Target = strings.Repeat("b", 64)
	if ResolvePolicy(c, []Policy{p}).Permissions.Any() {
		t.Fatal("grant crossed container boundary")
	}
}

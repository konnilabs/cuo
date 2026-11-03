package core

import (
	"errors"
	"strings"
)

var Capabilities = []Capability{
	{ID: "logs.manage", Label: "Protokoll-Aufbewahrung und Log-Reset verwalten", OwnerOnly: true},
	{ID: "inventory.read", Label: "Bestände und Protokolle lesen"},
	{ID: "updates.scan", Label: "Update-Prüfung starten"},
	{ID: "updates.request", Label: "Update-Jobs anfordern"},
	{ID: "updates.approve", Label: "Updates freigeben und Sofortläufe starten"},
	{ID: "policies.manage", Label: "Richtlinien und Wartungsfenster verwalten"},
	{ID: "execution.monitoring.grant", Label: "Lesenden Host-Monitoring-Zugriff freigeben", Description: "Erlaubt zusätzliche containerbezogene Freigaben; die Host-Prüfungen bleiben wirksam."},
	{ID: "registry.read", Label: "Autorisierte Registry-Metadaten lesen"},
	{ID: "registry.manage", Label: "Registry-Verbindungen und Credentials verwalten", Description: "Zugangsdaten können ersetzt, aber nie ausgelesen werden."},
	{ID: "registry.scan", Label: "Registry-Verbindung prüfen"},
	{ID: "registry.import", Label: "Images per Digest importieren", Description: "Schreibt OCI-Inhalte in die Ziel-Registry."},
	{ID: "github.manage", Label: "GitHub-App verbinden und verwalten", OwnerOnly: true},
	{ID: "webhook.read", Label: "GitHub-Zustellungen und Release-Sets lesen"},
	{ID: "webhook.retry", Label: "Fehlgeschlagene Zustellungen wiederaufnehmen"},
	{ID: "subscriptions.manage", Label: "Release-Subscriptions verwalten", Description: "Automatisierung benötigt zusätzlich ausführbare Container-Richtlinien."},
	{ID: "users.manage", Label: "Untergeordnete Benutzer verwalten"},
	{ID: "roles.manage", Label: "Rollenberechtigungen verwalten", OwnerOnly: true},
}

func defaultPermissions() PermissionPolicy {
	p := PermissionPolicy{Revision: 1, Roles: []RoleGrant{}}
	for _, role := range []string{"Viewer", "Operator", "Administrator", "Owner"} {
		caps := []string{"inventory.read", "registry.read"}
		if ranks[role] >= 1 {
			caps = append(caps, "updates.scan", "updates.request", "registry.scan")
		}
		if ranks[role] >= 2 {
			caps = append(caps, "updates.approve", "policies.manage", "subscriptions.manage", "webhook.read", "webhook.retry", "users.manage")
		}
		if role == "Owner" {
			caps = []string{}
			for _, c := range Capabilities {
				caps = append(caps, c.ID)
			}
		}
		p.Roles = append(p.Roles, RoleGrant{Role: role, Capabilities: caps})
	}
	return p
}
func (s *Store) PermissionPolicy() PermissionPolicy {
	var p PermissionPolicy
	if s.Get("permission-policy", "current", &p) != nil {
		return defaultPermissions()
	}
	for i := range p.Roles {
		if p.Roles[i].Role == "Owner" {
			p.Roles[i].Capabilities = []string{}
			for _, c := range Capabilities {
				p.Roles[i].Capabilities = append(p.Roles[i].Capabilities, c.ID)
			}
		}
	}
	return p
}
func (s *Store) Allows(p Principal, capability string) bool {
	if _, ok := ranks[p.Role]; !ok || !p.Host("local") {
		return false
	}
	known := false
	ownerOnly := false
	for _, c := range Capabilities {
		if c.ID == capability {
			known = true
			ownerOnly = c.OwnerOnly
			break
		}
	}
	if !known {
		return false
	}
	if p.Role == "Owner" {
		return true
	}
	if ownerOnly {
		return false
	}
	for _, r := range s.PermissionPolicy().Roles {
		if r.Role == p.Role {
			for _, c := range r.Capabilities {
				if c == capability {
					return true
				}
			}
		}
	}
	return false
}
func validatePermissions(p PermissionPolicy) error {
	if len(p.Roles) != 4 || len(strings.TrimSpace(p.Reason)) < 3 || len(p.Reason) > 500 {
		return errors.New("all four roles and a change reason are required")
	}
	seen := map[string]bool{}
	known := map[string]Capability{}
	for _, c := range Capabilities {
		known[c.ID] = c
	}
	for _, r := range p.Roles {
		if _, ok := ranks[r.Role]; !ok || seen[r.Role] {
			return errors.New("invalid or duplicate role")
		}
		seen[r.Role] = true
		caps := map[string]bool{}
		for _, id := range r.Capabilities {
			c, ok := known[id]
			if !ok || caps[id] || c.OwnerOnly && r.Role != "Owner" {
				return errors.New("invalid, duplicate or nondelegable capability")
			}
			caps[id] = true
		}
		if r.Role == "Owner" && len(caps) != len(known) {
			return errors.New("Owner capabilities cannot be removed")
		}
	}
	return nil
}
func capabilityFor(path, method string) string {
	if strings.HasPrefix(path, "/api/v1/log-retention") && method != "GET" {
		return "logs.manage"
	}
	if path == "/api/v1/permission-policy" {
		if method == "GET" {
			return "roles.manage"
		}
		return "roles.manage"
	}
	if path == "/api/v1/permissions/me" {
		return ""
	}
	if strings.HasPrefix(path, "/api/v1/registries") {
		if method == "GET" {
			return "registry.read"
		}
		if strings.HasSuffix(path, "/probe") {
			return "registry.scan"
		}
		return "registry.manage"
	}
	if strings.HasPrefix(path, "/api/v1/import-jobs") {
		if method == "GET" {
			return "registry.read"
		}
		return "registry.import"
	}
	if strings.HasPrefix(path, "/api/v1/integrations/github") {
		if method == "GET" && !strings.HasSuffix(path, "/installations") {
			return "webhook.read"
		}
		return "github.manage"
	}
	if strings.HasPrefix(path, "/api/v1/webhook-deliveries") {
		if method == "GET" {
			return "webhook.read"
		}
		return "webhook.retry"
	}
	if strings.HasPrefix(path, "/api/v1/release-sets") {
		return "webhook.read"
	}
	if strings.HasPrefix(path, "/api/v1/subscriptions") {
		if method == "GET" {
			return "webhook.read"
		}
		return "subscriptions.manage"
	}
	if method == "GET" {
		return "inventory.read"
	}
	if strings.Contains(path, "/policies/") || strings.Contains(path, "/maintenance-windows") {
		return "policies.manage"
	}
	if strings.HasSuffix(path, "/approve") || path == "/api/v1/update-runs" {
		return "updates.approve"
	}
	if path == "/api/v1/scans" {
		return "updates.scan"
	}
	return "updates.request"
}

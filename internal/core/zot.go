package core

import (
	"encoding/json"
	"errors"
	"os"

	"cuo.local/cuo/internal/provision"
	"cuo.local/cuo/internal/unioci"
)

func (e *Engine) provisionZotConnection() error {
	if os.Getenv("CUO_ZOT_ENABLED") != "1" {
		return nil
	}
	id := stableID("registry", "integrated-zot")
	var old RegistryConnection
	if e.Store.Get("registry", id, &old) == nil {
		return nil
	}
	data, err := os.ReadFile(os.Getenv("CUO_ZOT_CREDENTIALS_FILE"))
	if err != nil {
		return errors.New("Zot provisioning credentials unavailable")
	}
	var credentials provision.RegistryCredentials
	if json.Unmarshal(data, &credentials) != nil || credentials.PullPassword == "" || credentials.PushPassword == "" || credentials.Host != os.Getenv("CUO_ZOT_HOST") {
		return errors.New("Zot provisioning credentials do not match the configured registry host")
	}
	r := RegistryConnection{ID: id, Name: "Integrierte Registry", Provider: "zot", Host: credentials.Host, Endpoint: os.Getenv("CUO_ZOT_INTERNAL_URL"), Repositories: []string{"*"}, AuthHosts: []string{}, BlobHosts: []string{}, PrivateNetwork: true, Username: credentials.PullUsername, PushUsername: credentials.PushUsername, CredentialID: "registry/" + ID(), PushCredentialID: "registry-push/" + ID(), CredentialConfigured: true, PushCredentialConfigured: true, Enabled: true, Revision: 1, Status: "unchecked", Capabilities: []string{"manifests", "tags", "catalog", "copy", "retention-preview", "storage"}}
	if _, err = unioci.New(registryConfig(r), unioci.Credentials{}, os.Getenv("CUO_ZOT_INTERNAL_URL")); err != nil {
		return err
	}
	return e.saveIntegration("registry", id, r, Principal{ID: "installer", Role: "Owner", Hosts: []string{"local"}}, "zot.provision", "Lokale Zot-Verbindung mit getrennten Pull-/Push-Identitäten eingerichtet", secretChange{ID: r.CredentialID, Purpose: "registry", Value: credentials.PullPassword}, secretChange{ID: r.PushCredentialID, Purpose: "registry-push", Value: credentials.PushPassword})
}

package core

type RegistryConnection struct {
	ID                       string   `json:"id"`
	Name                     string   `json:"name"`
	Provider                 string   `json:"provider"`
	Host                     string   `json:"host"`
	Endpoint                 string   `json:"endpoint"`
	Repositories             []string `json:"repositories"`
	AuthHosts                []string `json:"authHosts"`
	BlobHosts                []string `json:"blobHosts"`
	CAPEM                    string   `json:"caPEM"`
	PrivateNetwork           bool     `json:"privateNetwork"`
	Username                 string   `json:"username"`
	CredentialConfigured     bool     `json:"credentialConfigured"`
	CredentialID             string   `json:"credentialId"`
	PushUsername             string   `json:"pushUsername"`
	PushCredentialID         string   `json:"pushCredentialId"`
	PushCredentialConfigured bool     `json:"pushCredentialConfigured"`
	Capabilities             []string `json:"capabilities"`
	Status                   string   `json:"status"`
	LastError                string   `json:"lastError"`
	LastChecked              string   `json:"lastChecked"`
	Enabled                  bool     `json:"enabled"`
	Revision                 int      `json:"revision"`
}
type RegistryRequest struct {
	Name                 string   `json:"name"`
	Provider             string   `json:"provider"`
	Host                 string   `json:"host"`
	Endpoint             string   `json:"endpoint"`
	Repositories         []string `json:"repositories"`
	AuthHosts            []string `json:"authHosts"`
	BlobHosts            []string `json:"blobHosts"`
	CAPEM                string   `json:"caPEM"`
	PrivateNetwork       bool     `json:"privateNetwork"`
	Username             string   `json:"username"`
	Password             string   `json:"password,omitempty"`
	PushUsername         string   `json:"pushUsername"`
	PushPassword         string   `json:"pushPassword,omitempty"`
	RemovePushCredential bool     `json:"removePushCredential,omitempty"`
	RemoveCredential     bool     `json:"removeCredential,omitempty"`
	Enabled              bool     `json:"enabled"`
	Revision             int      `json:"revision"`
	Reason               string   `json:"reason"`
	Confirmed            bool     `json:"confirmed"`
}
type GitHubConnection struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	AppID            string `json:"appId"`
	Slug             string `json:"slug"`
	InstallationID   string `json:"installationId"`
	Account          string `json:"account"`
	Configured       bool   `json:"configured"`
	Enabled          bool   `json:"enabled"`
	Status           string `json:"status"`
	LastError        string `json:"lastError"`
	LastSync         string `json:"lastSync"`
	WebhookURL       string `json:"webhookURL"`
	CallbackURL      string `json:"callbackURL"`
	WebhookReachable bool   `json:"webhookReachable"`
	Revision         int    `json:"revision"`
}
type GitHubRequest struct {
	Name           string `json:"name"`
	AppID          string `json:"appId"`
	PrivateKey     string `json:"privateKey,omitempty"`
	WebhookSecret  string `json:"webhookSecret,omitempty"`
	InstallationID string `json:"installationId"`
	Enabled        bool   `json:"enabled"`
	Revision       int    `json:"revision"`
	Reason         string `json:"reason"`
	Confirmed      bool   `json:"confirmed"`
}
type ReleaseImage struct {
	Component string `json:"component"`
	Reference string `json:"reference"`
	Digest    string `json:"digest"`
}
type ReleaseSource struct {
	RepositoryID  string `json:"repositoryId"`
	Revision      string `json:"revision"`
	WorkflowRunID string `json:"workflowRunId"`
	RunAttempt    int    `json:"runAttempt"`
}
type ReleaseManifest struct {
	Schema  string         `json:"schema"`
	Source  ReleaseSource  `json:"source"`
	Version string         `json:"version"`
	Channel string         `json:"channel"`
	Images  []ReleaseImage `json:"images"`
}
type ReleaseSet struct {
	ID             string          `json:"id"`
	ConnectionID   string          `json:"connectionId"`
	SubscriptionID string          `json:"subscriptionId"`
	Manifest       ReleaseManifest `json:"manifest"`
	State          string          `json:"state"`
	Error          string          `json:"error"`
	Created        string          `json:"createdAt"`
	Sequence       int64           `json:"sequence"`
}
type SubscriptionTarget struct {
	Component   string `json:"component"`
	ContainerID string `json:"containerId"`
	Reference   string `json:"reference"`
}
type Subscription struct {
	ID               string               `json:"id"`
	Name             string               `json:"name"`
	ConnectionID     string               `json:"connectionId"`
	RepositoryID     string               `json:"repositoryId"`
	Repository       string               `json:"repository"`
	WorkflowID       string               `json:"workflowId"`
	Branch           string               `json:"branch"`
	Channel          string               `json:"channel"`
	RegistryID       string               `json:"registryId"`
	ImportRegistryID string               `json:"importRegistryId"`
	ImportPrefix     string               `json:"importPrefix"`
	Targets          []SubscriptionTarget `json:"targets"`
	Mode             string               `json:"mode"`
	Enabled          bool                 `json:"enabled"`
	Actor            string               `json:"actor"`
	ActorRole        string               `json:"actorRole"`
	Revision         int                  `json:"revision"`
	LastSequence     int64                `json:"lastSequence"`
	LastSync         string               `json:"lastSync"`
	LastError        string               `json:"lastError"`
	Created          string               `json:"createdAt"`
	Reason           string               `json:"reason"`
	Confirmed        bool                 `json:"confirmed"`
}
type WebhookDelivery struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	DeliveryID   string `json:"deliveryId"`
	Event        string `json:"event"`
	Action       string `json:"action"`
	State        string `json:"state"`
	Attempts     int    `json:"attempts"`
	Error        string `json:"error"`
	PayloadHash  string `json:"payloadHash"`
	Created      string `json:"createdAt"`
	Updated      string `json:"updatedAt"`
	NextAttempt  string `json:"nextAttempt"`
}
type ImportJob struct {
	ID                    string `json:"id"`
	SourceRegistryID      string `json:"sourceRegistryId"`
	Repository            string `json:"repository"`
	Digest                string `json:"digest"`
	DestinationRegistryID string `json:"destinationRegistryId"`
	DestinationRepository string `json:"destinationRepository"`
	State                 string `json:"state"`
	Error                 string `json:"error"`
	Actor                 string `json:"actor"`
	ActorRole             string `json:"actorRole"`
	Created               string `json:"createdAt"`
}
type RoleGrant struct {
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
}
type PermissionPolicy struct {
	Revision int         `json:"revision"`
	Roles    []RoleGrant `json:"roles"`
	Reason   string      `json:"reason"`
}
type Capability struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	OwnerOnly   bool   `json:"ownerOnly"`
}

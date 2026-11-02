package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	gh "cuo.local/cuo/internal/github"
	"cuo.local/cuo/internal/unioci"
)

func (e *Engine) IntegrationWorker(ctx context.Context) {
	// OCI copies are content-addressed and safe to resume. This is intentionally
	// different from a possibly interrupted Docker container replacement.
	for _, job := range collection[ImportJob](e.Store, "import") {
		if job.State == "processing" {
			job.State = "queued"
			_ = e.Store.Put("import", job.ID, job)
		}
	}
	for _, delivery := range collection[WebhookDelivery](e.Store, "delivery") {
		if delivery.State == "processing" {
			delivery.State = "retry"
			delivery.NextAttempt = ""
			_ = e.Store.Put("delivery", delivery.ID, delivery)
		}
	}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	e.NotifyIntegrations()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.IntegrationWake:
		case <-ticker.C:
		}
		e.integrationTick(ctx)
	}
}
func (e *Engine) integrationTick(parent context.Context) {
	for _, job := range collection[ImportJob](e.Store, "import") {
		if parent.Err() != nil {
			return
		}
		if job.State != "queued" {
			continue
		}
		actor := Principal{ID: job.Actor, Role: job.ActorRole, Hosts: []string{"local"}}
		job.State = "processing"
		_ = e.Store.Put("import", job.ID, job)
		ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
		err := func() error {
			if !e.Store.Allows(actor, "registry.import") {
				return errors.New("Import-Berechtigung wurde entzogen")
			}
			source, err := e.registryClient(job.SourceRegistryID)
			if err != nil {
				return err
			}
			destination, err := e.registryWriteClient(job.DestinationRegistryID)
			if err != nil {
				return err
			}
			return unioci.CopyByDigest(ctx, source, job.Repository, job.Digest, destination, job.DestinationRepository)
		}()
		cancel()
		job.State = "succeeded"
		job.Error = ""
		if err != nil {
			job.State = "failed"
			job.Error = err.Error()
		}
		_ = e.saveIntegration("import", job.ID, job, actor, "registry.import.result", "OCI-Import: "+job.State)
	}
	deliveries := collection[WebhookDelivery](e.Store, "delivery")
	sort.SliceStable(deliveries, func(i, j int) bool { return deliveries[i].Created < deliveries[j].Created })
	processed := 0
	for _, delivery := range deliveries {
		if parent.Err() != nil {
			return
		}
		if processed >= 100 {
			break
		}
		if delivery.State != "pending" && delivery.State != "retry" {
			continue
		}
		if next, err := time.Parse(time.RFC3339, delivery.NextAttempt); err == nil && time.Now().Before(next) {
			continue
		}
		processed++
		delivery.State = "processing"
		delivery.Attempts++
		delivery.Updated = time.Now().UTC().Format(time.RFC3339Nano)
		if e.Store.Put("delivery", delivery.ID, delivery) != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(parent, 12*time.Minute)
		err := e.processDelivery(ctx, delivery)
		cancel()
		delivery.State = "processed"
		delivery.Error = ""
		delivery.NextAttempt = ""
		if err != nil {
			delivery.State = "retry"
			delivery.Error = err.Error()
			delay := 30 * time.Second * time.Duration(1<<min(delivery.Attempts-1, 5))
			if delay > 15*time.Minute {
				delay = 15 * time.Minute
			}
			next := time.Now().Add(delay)
			var limited *gh.RateLimitError
			if errors.As(err, &limited) && limited.RetryAt.After(next) {
				next = limited.RetryAt
			}
			delivery.NextAttempt = next.UTC().Format(time.RFC3339)
			if delivery.Attempts >= 8 {
				delivery.State = "failed"
			}
		}
		delivery.Updated = time.Now().UTC().Format(time.RFC3339Nano)
		_ = e.saveIntegration("delivery", delivery.ID, delivery, Principal{ID: "github-webhook", Role: "Owner", Hosts: []string{"local"}}, "webhook.process", "Zustellung "+delivery.DeliveryID+": "+delivery.State)
	}
	for _, subscription := range collection[Subscription](e.Store, "subscription") {
		if parent.Err() != nil {
			return
		}
		if !subscription.Enabled {
			continue
		}
		var state pollState
		_ = e.Store.Get("poll-state", subscription.ID, &state)
		if next, err := time.Parse(time.RFC3339, state.Next); err == nil && time.Now().Before(next) {
			continue
		}
		ctx, cancel := context.WithTimeout(parent, 12*time.Minute)
		err := e.pollSubscription(ctx, subscription)
		cancel()
		state.Next = time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339)
		if err == nil {
			state.Attempts = 0
		}
		if err != nil {
			state.Attempts++
			next := time.Now().Add(15 * time.Minute * time.Duration(1<<min(state.Attempts-1, 5)))
			var limited *gh.RateLimitError
			if errors.As(err, &limited) && limited.RetryAt.After(next) {
				next = limited.RetryAt
			}
			state.Next = next.UTC().Format(time.RFC3339)
			e.Store.Mu.Lock()
			var current Subscription
			if e.Store.Get("subscription", subscription.ID, &current) == nil {
				current.LastError = err.Error()
				_ = e.Store.Put("subscription", current.ID, current)
			}
			e.Store.Mu.Unlock()
		}
		_ = e.Store.Put("poll-state", subscription.ID, state)
	}
}
func (e *Engine) processDelivery(ctx context.Context, delivery WebhookDelivery) error {
	var connection GitHubConnection
	if e.Store.Get("github", delivery.ConnectionID, &connection) != nil {
		return errors.New("GitHub-Verbindung entfernt")
	}
	var data []byte
	if e.Store.DB.QueryRow(`SELECT body FROM webhook_payloads WHERE id=?`, delivery.ID).Scan(&data) != nil {
		return errors.New("Dauerhafter Webhook-Inhalt fehlt")
	}
	var payload githubPayload
	if json.Unmarshal(data, &payload) != nil {
		return errors.New("Webhook-Inhalt beschädigt")
	}
	if delivery.Event == "ping" {
		return nil
	}
	if delivery.Event == "installation" && (payload.Action == "deleted" || payload.Action == "suspend") {
		e.Store.Mu.Lock()
		defer e.Store.Mu.Unlock()
		_ = e.Store.Get("github", connection.ID, &connection)
		connection.Enabled = false
		connection.Status = "revoked"
		connection.Revision++
		return e.saveIntegration("github", connection.ID, connection, Principal{ID: "github", Role: "Owner", Hosts: []string{"local"}}, "github.revoked", "GitHub-Installation wurde widerrufen")
	}
	if delivery.Event == "installation_repositories" {
		client, err := e.githubClient(connection)
		if err != nil {
			return err
		}
		repos, err := client.Repositories(ctx, connection.InstallationID)
		if err != nil {
			return err
		}
		allowed := map[string]bool{}
		for _, repo := range repos {
			allowed[fmt.Sprint(repo.ID)] = true
		}
		e.Store.Mu.Lock()
		defer e.Store.Mu.Unlock()
		for _, subscription := range collection[Subscription](e.Store, "subscription") {
			if subscription.ConnectionID == connection.ID && !allowed[subscription.RepositoryID] {
				subscription.Enabled = false
				subscription.Revision++
				subscription.LastError = "Repository wurde aus der GitHub-App-Installation entfernt"
				if err = e.saveIntegration("subscription", subscription.ID, subscription, Principal{ID: "github", Role: "Owner", Hosts: []string{"local"}}, "subscription.revoked", subscription.LastError); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if !connection.Enabled || delivery.Event != "workflow_run" || payload.Action != "completed" {
		return nil
	}
	client, err := e.githubClient(connection)
	if err != nil {
		return err
	}
	for _, subscription := range collection[Subscription](e.Store, "subscription") {
		if !subscription.Enabled || subscription.ConnectionID != connection.ID || subscription.RepositoryID != fmt.Sprint(payload.Repository.ID) || subscription.WorkflowID != fmt.Sprint(payload.WorkflowRun.WorkflowID) {
			continue
		}
		run, err := client.Run(ctx, connection.InstallationID, subscription.Repository, fmt.Sprint(payload.WorkflowRun.ID))
		if err != nil {
			return err
		}
		if !runAllowed(subscription, run) {
			continue
		}
		data, err := client.ReleaseArtifact(ctx, connection.InstallationID, subscription.Repository, fmt.Sprint(run.ID))
		if err != nil {
			return err
		}
		if err = e.applyRelease(ctx, subscription, run, data); err != nil {
			return err
		}
	}
	return nil
}

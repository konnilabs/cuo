package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	gh "cuo.local/cuo/internal/github"
	"cuo.local/cuo/internal/unioci"
)

func (s *Server) subscriptionMutate(endpoint, method string, body []byte, p Principal) (int, any) {
	e := s.Engine
	id := strings.TrimPrefix(endpoint, "/api/v1/subscriptions/")
	var previous Subscription
	fresh := endpoint == "/api/v1/subscriptions" && method == "POST"
	if fresh {
		id = ID()
	} else if strings.HasSuffix(id, "/sync") && method == "POST" {
		id = strings.TrimSuffix(id, "/sync")
		if e.Store.Get("subscription", id, &previous) != nil {
			return 404, map[string]string{"code": "NOT_FOUND", "message": "Subscription nicht gefunden"}
		}
		_ = e.Store.Delete("poll-state", id)
		e.NotifyIntegrations()
		return 202, map[string]bool{"accepted": true}
	} else if method != "PUT" || !jobIDPattern.MatchString(id) || e.Store.Get("subscription", id, &previous) != nil {
		return 404, map[string]string{"code": "NOT_FOUND", "message": "Subscription nicht gefunden"}
	}
	var input Subscription
	if decode(body, &input) != nil || !input.Confirmed || len(input.Reason) < 3 || len(input.Reason) > 500 || input.Name == "" || len(input.Name) > 100 {
		return integrationFailure(errors.New("Subscription bestätigen und begründen"))
	}
	if !fresh && input.Revision != previous.Revision {
		return 409, map[string]string{"code": "REVISION_CONFLICT", "message": "Subscription wurde zwischenzeitlich geändert"}
	}
	if !slices.Contains([]string{"preview", "approval", "automatic"}, input.Mode) || len(input.Targets) == 0 || len(input.Targets) > 20 || input.Branch == "" || len(input.Branch) > 150 || len(input.Channel) > 64 || !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`).MatchString(input.Channel) {
		return integrationFailure(errors.New("Ungültiger Modus, Kanal, Ref oder Zielumfang"))
	}
	var connection GitHubConnection
	if e.Store.Get("github", input.ConnectionID, &connection) != nil || !connection.Enabled {
		return integrationFailure(errors.New("Aktive GitHub-Verbindung erforderlich"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	client, err := e.githubClient(connection)
	if err != nil {
		return integrationFailure(err)
	}
	repos, err := client.Repositories(ctx, connection.InstallationID)
	if err != nil {
		return integrationFailure(err)
	}
	allowed := false
	for _, repo := range repos {
		allowed = allowed || fmt.Sprint(repo.ID) == input.RepositoryID && repo.FullName == input.Repository
	}
	if !allowed {
		return integrationFailure(errors.New("Repository ist nicht für diese Installation freigegeben"))
	}
	workflows, err := client.Workflows(ctx, connection.InstallationID, input.Repository)
	if err != nil {
		return integrationFailure(err)
	}
	allowed = false
	for _, workflow := range workflows {
		allowed = allowed || fmt.Sprint(workflow.ID) == input.WorkflowID && workflow.State == "active"
	}
	if !allowed {
		return integrationFailure(errors.New("Aktiver freigegebener Publish-Workflow erforderlich"))
	}
	var registry RegistryConnection
	if e.Store.Get("registry", input.RegistryID, &registry) != nil || !registry.Enabled {
		return integrationFailure(errors.New("Aktive Quell-Registry erforderlich"))
	}
	if input.ImportRegistryID != "" {
		var destination RegistryConnection
		if !e.Store.Allows(p, "registry.import") || e.Store.Get("registry", input.ImportRegistryID, &destination) != nil || !destination.Enabled || destination.Provider != "zot" {
			return integrationFailure(errors.New("Für den Zot-Import fehlen Ziel-Registry oder Schreibberechtigung"))
		}
		if input.ImportPrefix == "" || strings.Contains(input.ImportPrefix, "*") {
			return integrationFailure(errors.New("Explizites Import-Namespace erforderlich"))
		}
		if _, err := unioci.ParseReference(destination.Host + "/" + input.ImportPrefix + "/probe:latest"); err != nil {
			return integrationFailure(err)
		}
	}
	seen := map[string]bool{}
	components := map[string]bool{}
	for _, target := range input.Targets {
		var c Container
		if e.Store.Get("container", target.ContainerID, &c) != nil || !p.Host(c.HostID) || !c.Managed || seen[c.ID] || components[target.Component] || !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}$`).MatchString(target.Component) {
			return integrationFailure(errors.New("Ziele müssen eindeutige Komponenten und autorisierte verwaltete Container sein"))
		}
		seen[c.ID] = true
		components[target.Component] = true
		ref, err := unioci.ParseReference(target.Reference)
		if err != nil || ref.Host != registry.Host || !registryConfig(registry).Allows(ref.Repository) {
			return integrationFailure(errors.New("Image-Ziel liegt außerhalb der Quell-Registry-Freigabe"))
		}
		for _, other := range collection[Subscription](e.Store, "subscription") {
			if other.ID == id || !other.Enabled {
				continue
			}
			for _, otherTarget := range other.Targets {
				if otherTarget.ContainerID == c.ID && input.Enabled {
					return integrationFailure(errors.New("Ein Container kann nur eine aktive Release-Subscription besitzen"))
				}
			}
		}
	}
	input.ID = id
	input.Actor = p.ID
	input.ActorRole = p.Role
	input.Revision = previous.Revision + 1
	input.LastSequence = previous.LastSequence
	input.LastSync = previous.LastSync
	input.LastError = ""
	input.Created = previous.Created
	if fresh {
		input.Created = time.Now().UTC().Format(time.RFC3339)
	}
	// A changed source starts from a new activation boundary rather than silently
	// rolling historical releases from a different workflow onto the old targets.
	if !fresh && (input.ConnectionID != previous.ConnectionID || input.RepositoryID != previous.RepositoryID || input.WorkflowID != previous.WorkflowID || input.Channel != previous.Channel) {
		input.LastSequence = 0
		input.LastSync = ""
		input.Created = time.Now().UTC().Format(time.RFC3339)
	}
	if e.saveIntegration("subscription", id, input, p, "subscription.save", "Subscription "+input.Name+" gespeichert; "+input.Reason) != nil {
		return safeStoreFailure()
	}
	_ = e.Store.Delete("poll-state", id)
	e.NotifyIntegrations()
	return 200, input
}

func validateRelease(manifest ReleaseManifest, subscription Subscription, run gh.Run) error {
	if manifest.Schema != "unioci.release.v1" || manifest.Source.RepositoryID != subscription.RepositoryID || manifest.Source.WorkflowRunID != fmt.Sprint(run.ID) || manifest.Source.Revision != run.HeadSHA || manifest.Source.RunAttempt != run.RunAttempt || manifest.Channel != subscription.Channel || len(manifest.Images) != len(subscription.Targets) || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$`).MatchString(manifest.Version) {
		return errors.New("Release-Dokument passt nicht zu Repository, Commit, Lauf, Kanal oder erwartetem Image-Set")
	}
	seen := map[string]bool{}
	for _, image := range manifest.Images {
		if seen[image.Component] || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(image.Digest) {
			return errors.New("Doppelte Komponente oder ungültiger Image-Digest")
		}
		seen[image.Component] = true
		found := false
		actual, err := unioci.ParseReference(image.Reference)
		if err != nil {
			return err
		}
		for _, target := range subscription.Targets {
			expected, e := unioci.ParseReference(target.Reference)
			if e == nil && target.Component == image.Component && expected.Host == actual.Host && expected.Repository == actual.Repository {
				found = true
			}
		}
		if !found {
			return errors.New("Release enthält ein nicht freigegebenes Image-Repository")
		}
	}
	return nil
}
func runAllowed(subscription Subscription, run gh.Run) bool {
	match, err := path.Match(subscription.Branch, run.HeadBranch)
	return err == nil && match && fmt.Sprint(run.WorkflowID) == subscription.WorkflowID && fmt.Sprint(run.HeadRepository.ID) == subscription.RepositoryID && run.Status == "completed" && run.Conclusion == "success" && slices.Contains([]string{"push", "release", "workflow_dispatch"}, run.Event) && run.RunAttempt > 0 && run.RunAttempt < 10000 && run.CreatedAt >= subscription.Created
}

func (e *Engine) applyRelease(ctx context.Context, subscription Subscription, run gh.Run, data []byte) error {
	if !runAllowed(subscription, run) {
		return nil
	}
	var manifest ReleaseManifest
	if decode(data, &manifest) != nil {
		return errors.New("Ungültiges UniOCI-Release-Dokument")
	}
	if err := validateRelease(manifest, subscription, run); err != nil {
		return err
	}
	id := stableID(subscription.ID, fmt.Sprint(run.ID), fmt.Sprint(run.RunAttempt))
	var existing ReleaseSet
	if e.Store.Get("release-set", id, &existing) == nil {
		if encode(existing.Manifest) != encode(manifest) {
			return errors.New("Bereits angenommener Workflow-Lauf enthält ein verändertes Release-Set")
		}
		return nil
	}
	sequence := run.RunNumber*10000 + int64(run.RunAttempt)
	if sequence <= subscription.LastSequence {
		return nil
	}
	var admitted Subscription
	if e.Store.Get("subscription", subscription.ID, &admitted) != nil || !admitted.Enabled || admitted.Revision != subscription.Revision {
		return errors.New("Subscription ist nicht mehr aktiv")
	}
	principal := Principal{ID: admitted.Actor, Role: admitted.ActorRole, Hosts: []string{"local"}}
	if !e.Store.Allows(principal, "subscriptions.manage") || !e.Store.Allows(principal, "updates.request") || admitted.ImportRegistryID != "" && !e.Store.Allows(principal, "registry.import") {
		return errors.New("Subscription-Berechtigung wurde entzogen")
	}
	source, err := e.registryClient(subscription.RegistryID)
	if err != nil {
		return err
	}
	var destination *unioci.Client
	if subscription.ImportRegistryID != "" {
		destination, err = e.registryWriteClient(subscription.ImportRegistryID)
		if err != nil {
			return err
		}
	}
	type resolvedTarget struct {
		Container Container
		Candidate Candidate
		Job       *Job
		State     string
	}
	resolved := []resolvedTarget{}
	for order, target := range subscription.Targets {
		var c Container
		if e.Store.Get("container", target.ContainerID, &c) != nil || !c.Managed {
			return errors.New("Release-Ziel ist nicht mehr vorhanden oder verwaltet")
		}
		for _, job := range e.Store.Jobs() {
			if job.ContainerID == c.ID && !terminal(job.State) {
				return errors.New("Release-Ziel hat bereits einen aktiven Update-Auftrag")
			}
		}
		var image ReleaseImage
		for _, entry := range manifest.Images {
			if entry.Component == target.Component {
				image = entry
			}
		}
		ref, _ := unioci.ParseReference(image.Reference)
		if ref.Host != source.Config.Host || !source.Config.Allows(ref.Repository) {
			return errors.New("Image liegt außerhalb der Quell-Verbindung")
		}
		repository := ref.Repository
		client := source
		selector := image.Digest
		if destination != nil {
			name := subscription.ImportPrefix + "/" + target.Component
			if err = unioci.CopyByDigest(ctx, source, repository, image.Digest, destination, name); err != nil {
				return err
			}
			client = destination
			repository = name
		}
		artifact, err := client.Resolve(ctx, repository, selector, c.Platform)
		if err != nil {
			return err
		}
		candidate := Candidate{ContainerID: c.ID, Source: c.ImageID, Target: artifact.Digest, Ref: c.Image, TargetImage: client.Config.Host + "/" + repository, Platform: c.Platform, Discovered: time.Now().UTC().Format(time.RFC3339), SubscriptionID: subscription.ID, ReleaseSetID: id, TargetOrder: order}
		state := "ready"
		if artifact.ConfigDigest == c.ImageID {
			candidate.Target = ""
			state = "unchanged"
		}
		resolved = append(resolved, resolvedTarget{Container: c, Candidate: candidate, State: state})
	}
	// The entire set is verified before any candidate or job is made visible.
	e.Store.Mu.Lock()
	defer e.Store.Mu.Unlock()
	e.Mu.Lock()
	defer e.Mu.Unlock()
	var current Subscription
	if e.Store.Get("subscription", subscription.ID, &current) != nil || !current.Enabled || current.Revision != subscription.Revision {
		return errors.New("Subscription wurde während der Prüfung geändert")
	}
	actor := Principal{ID: current.Actor, Role: current.ActorRole, Hosts: []string{"local"}}
	if !e.Store.Allows(actor, "subscriptions.manage") || !e.Store.Allows(actor, "updates.request") {
		return errors.New("Subscription-Berechtigung wurde entzogen")
	}
	if destination != nil && !e.Store.Allows(actor, "registry.import") {
		return errors.New("Import-Berechtigung wurde entzogen")
	}
	if sequence <= current.LastSequence {
		return nil
	}
	for i := range resolved {
		target := &resolved[i]
		var fresh Container
		if e.Store.Get("container", target.Container.ID, &fresh) != nil || fresh.ImageID != target.Container.ImageID || fresh.EngineID != target.Container.EngineID {
			return errors.New("Container während der Release-Prüfung verändert")
		}
		fresh.Candidate = &target.Candidate
		target.Container = fresh
		if target.Candidate.Target == "" || current.Mode == "preview" {
			continue
		}
		automatic := current.Mode == "automatic" && ResolvePolicy(fresh, e.Store.Policies()).Mode == "automatic"
		job, err := e.prepareJob(fresh, actor, "Release "+manifest.Version+" aus Subscription "+current.Name, automatic, false)
		if err == nil {
			if current.Mode == "approval" {
				job.State = "pending_approval"
			}
			job.SubscriptionGenerated = true
			target.Job = &job
		}
	}
	set := ReleaseSet{ID: id, ConnectionID: current.ConnectionID, SubscriptionID: current.ID, Manifest: manifest, State: "ready", Created: time.Now().UTC().Format(time.RFC3339Nano), Sequence: sequence}
	tx, err := e.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put := func(kind, id string, v any) error {
		_, err := tx.Exec(`INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, kind, id, encode(v))
		return err
	}
	if err = put("release-set", id, set); err != nil {
		return err
	}
	for _, target := range resolved {
		if err = put("candidate", target.Container.ID, target.Candidate); err != nil {
			return err
		}
		if err = put("container", target.Container.ID, target.Container); err != nil {
			return err
		}
		jobID := ""
		if target.Job != nil {
			jobID = target.Job.ID
			if err = put("job", jobID, *target.Job); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(`INSERT INTO release_targets(subscription,release,container,job,state) VALUES(?,?,?,?,?)`, current.ID, id, target.Container.ID, jobID, target.State); err != nil {
			return err
		}
	}
	current.LastSequence = sequence
	current.LastError = ""
	if err = put("subscription", current.ID, current); err != nil {
		return err
	}
	event := Event{HostID: "local", Actor: current.Actor, Operation: "release.accept", Stage: "ready", Severity: "info", Message: "Vollständiges Release-Set " + manifest.Version + " für " + current.Name + " angenommen", Time: set.Created}
	if _, err = tx.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, "local", encode(event)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	e.Notify()
	return nil
}

// Bind a manually created job to an already admitted immutable set. Called while
// Engine.Mu is held; the unique target row is the outbox/deduplication boundary.
func bindReleaseJob(tx *sql.Tx, j Job) error {
	if j.ReleaseSetID == "" {
		return nil
	}
	result, err := tx.Exec(`UPDATE release_targets SET job=? WHERE subscription=? AND release=? AND container=?`, j.ID, j.SubscriptionID, j.ReleaseSetID, j.ContainerID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		return errors.New("Release-Ziel fehlt")
	}
	return err
}
func (e *Engine) releaseCanStart(j Job) (bool, bool) {
	if j.ReleaseSetID == "" {
		return true, false
	}
	var sub Subscription
	if e.Store.Get("subscription", j.SubscriptionID, &sub) != nil || !sub.Enabled {
		return false, true
	}
	for index, target := range sub.Targets {
		if index >= j.TargetOrder {
			break
		}
		var jobID, state string
		if e.Store.DB.QueryRow(`SELECT job,state FROM release_targets WHERE subscription=? AND release=? AND container=?`, j.SubscriptionID, j.ReleaseSetID, target.ContainerID).Scan(&jobID, &state) != nil {
			return false, true
		}
		if state == "unchanged" {
			continue
		}
		if jobID == "" {
			return false, false
		}
		var previous Job
		if e.Store.Get("job", jobID, &previous) != nil {
			return false, true
		}
		if previous.State == "succeeded" {
			continue
		}
		return false, terminal(previous.State)
	}
	return true, false
}

type pollState struct {
	Next     string `json:"next"`
	Attempts int    `json:"attempts"`
}
type pendingRun struct {
	SubscriptionID string `json:"subscriptionId"`
	RunID          string `json:"runId"`
}

func (e *Engine) pollSubscription(ctx context.Context, subscription Subscription) error {
	var connection GitHubConnection
	if e.Store.Get("github", subscription.ConnectionID, &connection) != nil || !connection.Enabled {
		return errors.New("GitHub-Verbindung ist nicht aktiv")
	}
	client, err := e.githubClient(connection)
	if err != nil {
		return err
	}
	watermark, err := time.Parse(time.RFC3339, subscription.LastSync)
	if err != nil {
		watermark, _ = time.Parse(time.RFC3339, subscription.Created)
	}
	for window := 0; window < 4; window++ {
		end := watermark.Add(15 * time.Minute)
		if end.After(time.Now()) {
			end = time.Now()
		}
		start := watermark.Add(-15 * time.Minute)
		created, _ := time.Parse(time.RFC3339, subscription.Created)
		if start.Before(created) {
			start = created
		}
		runs, err := client.Runs(ctx, connection.InstallationID, subscription.Repository, subscription.WorkflowID, start.UTC().Format(time.RFC3339)+".."+end.UTC().Format(time.RFC3339))
		if err != nil {
			return err
		}
		for _, pending := range collection[pendingRun](e.Store, "pending-run") {
			if pending.SubscriptionID == subscription.ID {
				run, e2 := client.Run(ctx, connection.InstallationID, subscription.Repository, pending.RunID)
				if e2 != nil {
					return e2
				}
				runs = append(runs, run)
			}
		}
		sort.SliceStable(runs, func(i, j int) bool {
			return runs[i].RunNumber < runs[j].RunNumber || runs[i].RunNumber == runs[j].RunNumber && runs[i].RunAttempt < runs[j].RunAttempt
		})
		seen := map[int64]bool{}
		for _, run := range runs {
			if seen[run.ID] {
				continue
			}
			seen[run.ID] = true
			key := stableID(subscription.ID, fmt.Sprint(run.ID))
			if run.Status != "completed" {
				_ = e.Store.Put("pending-run", key, pendingRun{SubscriptionID: subscription.ID, RunID: fmt.Sprint(run.ID)})
				continue
			}
			if runAllowed(subscription, run) {
				data, err := client.ReleaseArtifact(ctx, connection.InstallationID, subscription.Repository, fmt.Sprint(run.ID))
				if err != nil {
					return err
				}
				if err = e.applyRelease(ctx, subscription, run, data); err != nil {
					return err
				}
				_ = e.Store.Get("subscription", subscription.ID, &subscription)
			}
			_ = e.Store.Delete("pending-run", key)
		}
		e.Store.Mu.Lock()
		var fresh Subscription
		if e.Store.Get("subscription", subscription.ID, &fresh) == nil && fresh.Revision == subscription.Revision {
			fresh.LastSync = end.UTC().Format(time.RFC3339)
			fresh.LastError = ""
			_ = e.Store.Put("subscription", fresh.ID, fresh)
			subscription = fresh
		}
		e.Store.Mu.Unlock()
		watermark = end
		if !end.Before(time.Now().Add(-time.Second)) {
			break
		}
	}
	return nil
}

// Rollout state is derived from durable target bindings and current jobs. The
// release manifest itself stays immutable, even after a partially failed rollout.
func (e *Engine) releaseStatus(set ReleaseSet) string {
	rows, err := e.Store.DB.Query(`SELECT job,state FROM release_targets WHERE subscription=? AND release=?`, set.SubscriptionID, set.ID)
	if err != nil {
		return "error"
	}
	type binding struct{ job, state string }
	var entries []binding
	for rows.Next() {
		var v binding
		if rows.Scan(&v.job, &v.state) != nil {
			rows.Close()
			return "error"
		}
		entries = append(entries, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "error"
	}
	done, failed, pending, active := 0, 0, 0, 0
	for _, v := range entries {
		if v.state == "unchanged" {
			done++
			continue
		}
		if v.job == "" {
			continue
		}
		var job Job
		if e.Store.Get("job", v.job, &job) != nil {
			failed++
			continue
		}
		switch job.State {
		case "succeeded":
			done++
		case "failed", "intervention_required", "cancelled":
			failed++
		case "pending_approval":
			pending++
		default:
			active++
		}
	}
	if failed > 0 {
		if done > 0 {
			return "partial"
		}
		return "failed"
	}
	if len(entries) > 0 && done == len(entries) {
		return "succeeded"
	}
	if active > 0 {
		return "processing"
	}
	if pending > 0 {
		return "pending_approval"
	}
	return "ready"
}

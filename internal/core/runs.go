package core

import (
	"errors"
	"fmt"
	"time"
)

// Called under Engine.Mu. Selection and the persisted batch share one snapshot;
// its jobs, run record and audit entries commit together before workers wake.
func (e *Engine) CreateRun(p Principal, reason string) (UpdateRun, error) {
	if !p.Can("Administrator") {
		return UpdateRun{}, errors.New("Administrator role required")
	}
	var containers []Container
	if err := e.Store.List("container", &containers); err != nil {
		return UpdateRun{}, err
	}
	run := UpdateRun{ID: ID(), Requester: p.ID, Created: time.Now().UTC().Format(time.RFC3339), Jobs: []Job{}, Skipped: []RunSkip{}}
	for _, c := range containers {
		if !p.Host(c.HostID) {
			continue
		}
		if c.Candidate == nil || c.Candidate.Target == "" {
			continue
		}
		j, err := e.prepareJob(c, p, reason, false, true)
		if err != nil {
			run.Skipped = append(run.Skipped, RunSkip{ContainerID: c.ID, Name: c.Name, Reason: err.Error()})
			continue
		}
		j.RunID = run.ID
		run.Jobs = append(run.Jobs, j)
	}
	if len(run.Jobs) == 0 {
		return run, nil
	}
	tx, err := e.Store.DB.Begin()
	if err != nil {
		return run, err
	}
	defer tx.Rollback()
	put := func(kind, id string, v any) error {
		_, err := tx.Exec(`INSERT INTO records VALUES(?,?,?)`, kind, id, encode(v))
		return err
	}
	event := func(v Event) error {
		v.Time = run.Created
		if v.HostID == "" {
			v.HostID = "local"
		}
		_, err := tx.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, v.HostID, encode(v))
		return err
	}
	for _, j := range run.Jobs {
		if err = put("job", j.ID, j); err != nil {
			return run, err
		}
		if err = event(Event{HostID: j.HostID, JobID: j.ID, Actor: p.ID, Operation: "job.create.immediate", Stage: "queued", Severity: "info", Message: j.Name + ": Sofortstart in Lauf " + run.ID + "; " + reason}); err != nil {
			return run, err
		}
	}
	if err = put("run", run.ID, run); err != nil {
		return run, err
	}
	if err = event(Event{Actor: p.ID, Operation: "run.create", Stage: "queued", Severity: "info", Message: fmt.Sprintf("Sofortlauf %s: %d Updates, %d übersprungen; %s", run.ID, len(run.Jobs), len(run.Skipped), reason)}); err != nil {
		return run, err
	}
	if err = tx.Commit(); err != nil {
		return run, err
	}
	e.Notify()
	return run, nil
}

package core

import (
	"time"
)

func (e *Engine) beginScan(actor string) (ProcessRun, error) {
	e.Mu.Lock()
	defer e.Mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r := ProcessRun{ID: ID(), Kind: "scan", Name: "Image-Prüfung", State: "running", Created: now, Started: now, Requester: actor, JobIDs: []string{}, ContainerIDs: []string{}, Anomalies: []ProcessAnomaly{}, Skipped: []RunSkip{}, TelemetryAvailable: true, Stages: []StageTiming{{Stage: "inventory", Started: now}}}
	return r, e.Store.Put("scan-run", r.ID, r)
}
func finishProcessStage(r *ProcessRun, now time.Time) {
	if len(r.Stages) == 0 {
		return
	}
	s := &r.Stages[len(r.Stages)-1]
	if s.Finished == "" {
		s.Finished = now.UTC().Format(time.RFC3339Nano)
		s.DurationMS = elapsed(s.Started, s.Finished, now)
	}
}
func (e *Engine) finishScan(r *ProcessRun, err error) {
	now := time.Now().UTC()
	finishProcessStage(r, now)
	r.Finished = now.Format(time.RFC3339Nano)
	r.DurationMS = elapsed(r.Started, r.Finished, now)
	r.State = "succeeded"
	if err != nil {
		r.State = "failed"
		r.Reason = err.Error()
		r.Anomalies = append(r.Anomalies, ProcessAnomaly{Code: "scan_failed", Severity: "error", Message: err.Error()})
	} else if r.Failed > 0 {
		r.State = "partial"
		r.Reason = "Prüfung abgeschlossen; einzelne Images konnten nicht geprüft werden"
	}
	_ = e.Store.Put("scan-run", r.ID, r)
	_ = e.Store.Event(Event{RunID: r.ID, Actor: r.Requester, Operation: "scan", Stage: r.State, Severity: map[bool]string{true: "warning", false: "info"}[r.State != "succeeded"], Message: r.Name + ": " + r.State})
}
func (s *Store) openProcesses() int {
	count := 0
	for _, j := range s.Jobs() {
		if !terminal(j.State) {
			count++
		}
	}
	var scans []ProcessRun
	_ = s.List("scan-run", &scans)
	for _, r := range scans {
		if !terminal(r.State) && r.State != "partial" {
			count++
		}
	}
	return count
}

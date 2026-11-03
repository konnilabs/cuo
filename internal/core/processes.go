package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

func snapshotContainer(c Container) *ContainerSnapshot {
	return &ContainerSnapshot{EngineID: c.EngineID, Name: c.Name, Image: c.Image, ImageID: c.ImageID, State: c.State, Platform: c.Platform, Managed: c.Managed}
}
func parseTime(s string) time.Time { t, _ := time.Parse(time.RFC3339Nano, s); return t }
func elapsed(start, end string, now time.Time) int64 {
	a := parseTime(start)
	if a.IsZero() {
		return 0
	}
	b := parseTime(end)
	if b.IsZero() {
		b = now
	}
	if b.Before(a) {
		return 0
	}
	return b.Sub(a).Milliseconds()
}
func recordStage(j *Job, state string, now time.Time) {
	stamp := now.Format(time.RFC3339Nano)
	if j.State == state {
		return
	}
	if len(j.Stages) > 0 {
		last := &j.Stages[len(j.Stages)-1]
		if last.Finished == "" {
			last.Finished = stamp
			last.DurationMS = elapsed(last.Started, stamp, now)
		}
	}
	if state == "preflight" && j.Started == "" {
		j.Started = stamp
	}
	if terminal(state) {
		j.Finished = stamp
	} else {
		j.Stages = append(j.Stages, StageTiming{Stage: state, Started: stamp})
	}
}
func processState(jobs []Job) string {
	counts := map[string]int{}
	for _, j := range jobs {
		counts[j.State]++
	}
	for _, s := range []string{"preflight", "pulling", "recreating", "verifying"} {
		if counts[s] > 0 {
			return "running"
		}
	}
	for _, s := range []string{"queued", "pending_approval", "scheduled"} {
		if counts[s] > 0 {
			return s
		}
	}
	if counts["failed"]+counts["intervention_required"] > 0 {
		if counts["succeeded"] > 0 {
			return "partial"
		}
		if counts["intervention_required"] > 0 {
			return "intervention_required"
		}
		return "failed"
	}
	if counts["cancelled"] > 0 {
		return "cancelled"
	}
	return "succeeded"
}
func (e *Engine) Processes(p Principal, now time.Time) []ProcessRun {
	groups := map[string][]Job{}
	for _, j := range e.Store.Jobs() {
		if !p.Host(j.HostID) {
			continue
		}
		id := j.RunID
		if id == "" {
			id = j.ID
		}
		groups[id] = append(groups[id], j)
	}
	out := []ProcessRun{}
	for id, jobs := range groups {
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].Created < jobs[j].Created })
		r := ProcessRun{ID: id, Kind: "run", Name: jobs[0].Name, State: processState(jobs), Created: jobs[0].Created, ContainerCount: len(jobs), JobIDs: []string{}, ContainerIDs: []string{}, Anomalies: []ProcessAnomaly{}, Skipped: []RunSkip{}, Requester: jobs[0].Requester, Reason: jobs[0].Reason, WindowID: jobs[0].WindowID}
		if len(jobs) > 1 {
			r.Name = fmt.Sprintf("Update-Lauf · %d Container", len(jobs))
		}
		for _, j := range jobs {
			r.JobIDs = append(r.JobIDs, j.ID)
			r.ContainerIDs = append(r.ContainerIDs, j.ContainerID)
			r.Names = append(r.Names, j.Name)
			if j.Started != "" && (r.Started == "" || j.Started < r.Started) {
				r.Started = j.Started
			}
			if j.Finished > r.Finished {
				r.Finished = j.Finished
			}
			if j.State == "succeeded" {
				r.Succeeded++
			} else if j.State == "failed" || j.State == "intervention_required" {
				r.Failed++
			} else if !terminal(j.State) {
				r.Pending++
			}
			if j.Started != "" {
				r.TelemetryAvailable = true
				r.QueueMS += elapsed(j.Created, j.Started, now)
			}
			if r.Pending > 0 && elapsed(j.Updated, "", now) > 120000 && strings.Contains(" preflight pulling recreating verifying ", " "+j.State+" ") {
				r.Anomalies = append(r.Anomalies, ProcessAnomaly{Code: "stalled", Severity: "warning", Message: j.Name + ": seit mehr als zwei Minuten kein Phasenfortschritt"})
			}
		}
		if r.Pending > 0 {
			r.Finished = ""
		}
		r.DurationMS = elapsed(r.Started, r.Finished, now)
		var batch UpdateRun
		if e.Store.Get("run", id, &batch) == nil {
			for _, skip := range batch.Skipped {
				var c Container
				if e.Store.Get("container", skip.ContainerID, &c) == nil && p.Host(c.HostID) {
					r.Skipped = append(r.Skipped, skip)
				}
			}
		}
		if r.Failed > 0 {
			r.Anomalies = append(r.Anomalies, ProcessAnomaly{Code: "execution_failed", Severity: "error", Message: fmt.Sprintf("%d Container mit Fehler oder erforderlichem Eingriff", r.Failed)})
		}
		if !r.TelemetryAvailable {
			r.Anomalies = append(r.Anomalies, ProcessAnomaly{Code: "historical_telemetry", Severity: "info", Message: "Historischer Lauf: genaue Ausführungszeiten wurden noch nicht aufgezeichnet"})
		}
		out = append(out, r)
	}
	var scans []ProcessRun
	_ = e.Store.List("scan-run", &scans)
	if p.Host("local") {
		for _, scan := range scans {
			scan.DurationMS = elapsed(scan.Started, scan.Finished, now)
			for i := range scan.Stages {
				stage := &scan.Stages[i]
				if stage.Finished == "" {
					stage.DurationMS = elapsed(stage.Started, "", now)
				}
			}
			out = append(out, scan)
		}
	}
	// Build a bounded rolling baseline per container set, in chronological order.
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	history := map[string][]ProcessRun{}
	for i := range out {
		r := &out[i]
		ids := append([]string{}, r.ContainerIDs...)
		sort.Strings(ids)
		key := r.Kind + ":" + strings.Join(ids, ",")
		samples := history[key]
		values := []int64{}
		for _, sample := range samples {
			if sample.Created < r.Created {
				values = append(values, sample.DurationMS)
			}
		}
		r.BaselineSamples = len(values)
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		if len(values) >= 3 {
			r.BaselineMS = values[len(values)/2]
			if r.DurationMS > 30000 && r.DurationMS > r.BaselineMS*3 {
				r.Anomalies = append(r.Anomalies, ProcessAnomaly{Code: "slow_run", Severity: "warning", Message: "Laufdauer über dem Dreifachen des Medians vergleichbarer erfolgreicher Läufe"})
			}
		}
		if r.State == "succeeded" && r.DurationMS > 0 {
			samples = append(samples, *r)
			if len(samples) > 10 {
				samples = samples[len(samples)-10:]
			}
			history[key] = samples
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Created == out[j].Created {
			return out[i].ID > out[j].ID
		}
		return out[i].Created > out[j].Created
	})
	return out
}
func (e *Engine) Upcoming(p Principal, now time.Time) []ProcessRun {
	out := []ProcessRun{}
	var nextScan map[string]string
	if e.Store.Get("meta", "nextScan", &nextScan) == nil && p.Host("local") {
		t := nextScan["time"]
		dg := sha256.Sum256([]byte("scan:" + t))
		out = append(out, ProcessRun{ID: "plan-" + hex.EncodeToString(dg[:16]), Kind: "forecast", Name: "Automatische Image-Prüfung", State: "planned", Created: t, NextStart: t, JobIDs: []string{}, ContainerIDs: []string{}, Anomalies: []ProcessAnomaly{}, Reason: "Intervallprüfung; ausführbare Updates entstehen nur nach Richtlinien und Freigaben", Skipped: []RunSkip{}})
	}
	var windows []Window
	_ = e.Store.List("window", &windows)
	var containers []Container
	_ = e.Store.List("container", &containers)
	for _, c := range containers {
		policy := ResolvePolicy(c, e.Store.Policies())
		if !p.Host(c.HostID) || policy.Mode != "automatic" || policy.Excluded {
			continue
		}
		if policy.WindowID == "" {
			represented := false
			for _, j := range e.Store.Jobs() {
				if j.ContainerID == c.ID && !terminal(j.State) {
					represented = true
					break
				}
			}
			if represented {
				continue
			}
			dg := sha256.Sum256([]byte("candidate:" + c.ID))
			reason := "Ereignisgesteuert: nach einer Image-Prüfung mit neuem Digest und erfüllten Freigaben"
			state := "event_driven"
			if c.State != "running" {
				state = "blocked"
				reason = "Container läuft nicht; CUO startet ihn nicht automatisch"
			}
			if c.Candidate != nil && c.Candidate.Target != "" {
				var used int
				_ = e.Store.DB.QueryRow(`SELECT count(*) FROM schedule_runs WHERE slot=? AND container=?`, "candidate:"+c.Candidate.Target, c.ID).Scan(&used)
				if used > 0 {
					state = "blocked"
					reason = "Dieser Digest wurde bereits eingeplant; keine automatische Wiederholung"
				}
			}
			out = append(out, ProcessRun{ID: "plan-" + hex.EncodeToString(dg[:16]), Kind: "forecast", Name: c.Name, State: state, Created: now.UTC().Format(time.RFC3339), ContainerCount: 1, ContainerIDs: []string{c.ID}, JobIDs: []string{}, Anomalies: []ProcessAnomaly{}, Skipped: []RunSkip{}, Reason: reason})
			continue
		}
		for _, w := range windows {
			if w.ID != policy.WindowID || !w.Enabled {
				continue
			}
			next := NextWindowStart(w, now)
			if next.IsZero() {
				continue
			}
			slot := w.ID + ":" + next.In(mustLocation(w.Timezone)).Format("2006-01-02")
			var used int
			_ = e.Store.DB.QueryRow(`SELECT count(*) FROM schedule_runs WHERE slot=? AND container=?`, slot, c.ID).Scan(&used)
			if used > 0 {
				continue
			}
			represented := false
			for _, j := range e.Store.Jobs() {
				if j.ContainerID == c.ID && !terminal(j.State) {
					represented = true
					break
				}
			}
			if represented {
				continue
			}
			dg := sha256.Sum256([]byte(slot + "\x00" + c.ID))
			state, reason := "planned", "Vorschau: wird nur bei gültigem Update-Kandidaten und erfüllten Freigaben ausgeführt"
			if c.State != "running" {
				state = "blocked"
				reason = "Container läuft nicht; CUO startet ihn nicht automatisch"
			} else if c.Candidate == nil || !candidateMatches(c, *c.Candidate) || c.Candidate.Target == "" || c.Candidate.Error != "" {
				state = "blocked"
				reason = "Aktuell kein gültiger neuer Image-Digest; nächste Prüfung abwarten"
			}
			out = append(out, ProcessRun{ID: "plan-" + hex.EncodeToString(dg[:16]), Kind: "forecast", Name: c.Name, State: state, Created: next.UTC().Format(time.RFC3339), NextStart: next.UTC().Format(time.RFC3339), ContainerCount: 1, ContainerIDs: []string{c.ID}, JobIDs: []string{}, Anomalies: []ProcessAnomaly{}, Reason: reason, WindowID: w.ID, Skipped: []RunSkip{}})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NextStart == out[j].NextStart {
			return out[i].ID < out[j].ID
		}
		return out[i].NextStart < out[j].NextStart
	})
	return out
}
func mustLocation(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return l
}
func (e *Engine) ProcessDetail(id string, p Principal, after int64, now time.Time) (ProcessDetail, error) {
	all := e.Processes(p, now)
	if strings.HasPrefix(id, "plan-") {
		all = e.Upcoming(p, now)
	}
	var r *ProcessRun
	for i := range all {
		if all[i].ID == id {
			r = &all[i]
			break
		}
	}
	if r == nil {
		return ProcessDetail{}, errors.New("process not found")
	}
	out := ProcessDetail{Run: *r, Jobs: []Job{}, Events: []Event{}}
	for _, jid := range r.JobIDs {
		var j Job
		if e.Store.Get("job", jid, &j) == nil && p.Host(j.HostID) {
			for i := range j.Stages {
				stage := &j.Stages[i]
				if stage.Finished == "" {
					stage.DurationMS = elapsed(stage.Started, "", now)
				}
			}
			out.Jobs = append(out.Jobs, j)
		}
	}
	if len(r.JobIDs) == 0 && r.Kind != "scan" {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(r.JobIDs)), ",")
	args := []any{}
	for _, id := range r.JobIDs {
		args = append(args, id)
	}
	where := `json_extract(data,'$.runId')=? AND host='local'`
	if len(r.JobIDs) > 0 {
		where = `(json_extract(data,'$.jobId') IN (` + placeholders + `) OR json_extract(data,'$.runId')=?) AND host='local'`
	}
	args = append(args, id)
	_ = e.Store.DB.QueryRow("SELECT count(*) FROM events WHERE "+where, args...).Scan(&out.EventCount)
	rows, err := e.Store.DB.Query("SELECT id,data FROM events WHERE "+where+" AND id>? ORDER BY id LIMIT 201", append(args, after)...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id int64
		var data string
		if err = rows.Scan(&id, &data); err != nil {
			rows.Close()
			return out, err
		}
		var ev Event
		if jsonErr := json.Unmarshal([]byte(data), &ev); jsonErr != nil {
			rows.Close()
			return out, jsonErr
		}
		ev.ID = id
		if p.Host(ev.HostID) {
			out.Events = append(out.Events, ev)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if len(out.Events) > 200 {
		out.MoreEvents = true
		out.Events = out.Events[:200]
	}
	if len(out.Events) > 0 {
		out.NextEventID = out.Events[len(out.Events)-1].ID
	}
	out.LogsPruned = r.LogsPruned
	for _, j := range out.Jobs {
		out.LogsPruned = out.LogsPruned || j.LogsPruned
	}
	return out, nil
}

func processID(j Job) string {
	if j.RunID != "" {
		return j.RunID
	}
	return j.ID
}

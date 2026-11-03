package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) RetentionPolicy() LogRetention {
	p := LogRetention{Revision: 1, Days: 30, MaxEvents: 100000, IntervalHours: 24}
	_ = s.Get("log-retention", "current", &p)
	return p
}
func (s *Store) LogStorage() LogStorage {
	out := LogStorage{Policy: s.RetentionPolicy()}
	_ = s.DB.QueryRow(`SELECT count(*) FROM events`).Scan(&out.Events)
	var pages, size, free int64
	_ = s.DB.QueryRow(`PRAGMA page_count`).Scan(&pages)
	_ = s.DB.QueryRow(`PRAGMA page_size`).Scan(&size)
	_ = s.DB.QueryRow(`PRAGMA freelist_count`).Scan(&free)
	out.DatabaseBytes = pages * size
	out.ReusableBytes = free * size
	out.ActiveJobs = s.openProcesses()
	return out
}
func validateRetention(p LogRetention) error {
	if p.Days < 1 || p.Days > 3650 || p.MaxEvents < 100 || p.MaxEvents > 1000000 || p.IntervalHours < 1 || p.IntervalHours > 720 {
		return errors.New("Aufbewahrung: 1–3650 Tage, 100–1000000 Ereignisse, Intervall 1–720 Stunden")
	}
	return nil
}

// The caller holds Engine.Mu, preventing new admissions during compaction.
// Job records, scheduler slots, idempotency keys and agent journals are retained.
func (e *Engine) MaintainLogs(mode, actor, reason string, now time.Time) (LogMaintenanceResult, error) {
	result := LogMaintenanceResult{}
	result.ProtectedJobs = e.Store.openProcesses()
	if mode == "compact" {
		if result.ProtectedJobs > 0 {
			return result, errors.New("Komprimierung benötigt einen Leerlauf ohne offene Jobs")
		}
		if _, err := e.Store.DB.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			return result, err
		}
		if _, err := e.Store.DB.Exec(`VACUUM`); err != nil {
			return result, err
		}
		result.Compacted = true
		return result, e.Store.Event(Event{Actor: actor, Operation: "logs.compact", Stage: "completed", Severity: "warning", Message: "Log-Datenbank komprimiert; " + reason})
	}
	if mode != "reset" && mode != "rotate" {
		return result, errors.New("Unbekannte Protokollaktion")
	}
	policy := e.Store.RetentionPolicy()
	if err := validateRetention(policy); err != nil {
		return result, err
	}
	tx, err := e.Store.DB.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	where := `host='local' AND NOT EXISTS (SELECT 1 FROM records j WHERE j.kind='job' AND json_extract(j.data,'$.state') NOT IN ('succeeded','failed','cancelled','intervention_required') AND (j.id=json_extract(events.data,'$.jobId') OR j.id=json_extract(events.data,'$.runId') OR (coalesce(json_extract(j.data,'$.runId'),'')!='' AND (json_extract(j.data,'$.runId')=json_extract(events.data,'$.runId') OR json_extract(j.data,'$.runId')=(SELECT json_extract(other.data,'$.runId') FROM records other WHERE other.kind='job' AND other.id=json_extract(events.data,'$.jobId'))))))`
	where += ` AND NOT EXISTS (SELECT 1 FROM records active_scan WHERE active_scan.kind='scan-run' AND active_scan.id=json_extract(events.data,'$.runId') AND json_extract(active_scan.data,'$.state')='running')`
	args := []any{}
	if mode == "rotate" {
		where += ` AND (julianday(json_extract(data,'$.time')) < julianday(?) OR id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?))`
		args = append(args, now.AddDate(0, 0, -policy.Days).Format(time.RFC3339Nano), policy.MaxEvents)
	}
	rows, err := tx.Query(`SELECT DISTINCT coalesce(json_extract(data,'$.jobId'),''),coalesce(json_extract(data,'$.runId'),'') FROM events WHERE `+where, args...)
	if err != nil {
		return result, err
	}
	ids := []string{}
	runIDs := []string{}
	for rows.Next() {
		var id, runID string
		if err = rows.Scan(&id, &runID); err != nil {
			rows.Close()
			return result, err
		}
		if id != "" {
			ids = append(ids, id)
		}
		if runID != "" {
			runIDs = append(runIDs, runID)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		if _, err = tx.Exec(`UPDATE records SET data=json_set(data,'$.logsPruned',json('true')) WHERE kind='job' AND id=?`, id); err != nil {
			return result, err
		}
	}
	for _, id := range runIDs {
		if _, err = tx.Exec(`UPDATE records SET data=json_set(data,'$.logsPruned',json('true')) WHERE kind='job' AND (id=? OR json_extract(data,'$.runId')=?)`, id, id); err != nil {
			return result, err
		}
		if _, err = tx.Exec(`UPDATE records SET data=json_set(data,'$.logsPruned',json('true')) WHERE kind='scan-run' AND id=?`, id); err != nil {
			return result, err
		}
	}
	deleted, err := tx.Exec(`DELETE FROM events WHERE `+where, args...)
	if err != nil {
		return result, err
	}
	result.Deleted, _ = deleted.RowsAffected()
	policy.LastRun = now.UTC().Format(time.RFC3339Nano)
	policy.LastDeleted = result.Deleted
	if _, err = tx.Exec(`INSERT INTO records VALUES('log-retention','current',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, encode(policy)); err != nil {
		return result, err
	}
	event := Event{HostID: "local", Actor: actor, Operation: "logs." + mode, Stage: "completed", Severity: "warning", Message: fmt.Sprintf("%d Protokolleinträge gelöscht; %d offene Jobs geschützt; Laufhistorie und Agent-Journale bleiben erhalten. %s", result.Deleted, result.ProtectedJobs, reason), Time: now.UTC().Format(time.RFC3339Nano)}
	if _, err = tx.Exec(`INSERT INTO events(host,data) VALUES('local',?)`, encode(event)); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	_, _ = e.Store.DB.Exec(`PRAGMA wal_checkpoint(PASSIVE)`)
	return result, nil
}
func (e *Engine) RetentionWorker(ctx context.Context) {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-timer.C:
			e.Store.Mu.Lock()
			e.Mu.Lock()
			policy := e.Store.RetentionPolicy()
			if policy.Enabled && (policy.LastRun == "" || elapsed(policy.LastRun, "", now) >= int64(policy.IntervalHours)*3600000) {
				if _, err := e.MaintainLogs("rotate", "retention", "Automatische Aufbewahrungsregel", now); err != nil {
					_ = e.Store.Event(Event{Actor: "retention", Operation: "logs.rotate", Stage: "failed", Severity: "warning", Message: err.Error()})
				}
			}
			e.Mu.Unlock()
			e.Store.Mu.Unlock()
		}
	}
}
func (s *Server) processMutation(path, method string, body []byte, p Principal) (int, any, bool) {
	if path != "/api/v1/log-retention" && !strings.HasPrefix(path, "/api/v1/log-retention/") {
		return 0, nil, false
	}
	var input LogMaintenanceRequest
	if json.Unmarshal(body, &input) != nil || !input.Confirmed || len(strings.TrimSpace(input.Reason)) < 3 || len(input.Reason) > 500 {
		return 422, map[string]string{"code": "CONFIRMATION_REQUIRED", "message": "Aktion bestätigen und begründen"}, true
	}
	if path == "/api/v1/log-retention" && method == "PUT" {
		old := s.Engine.Store.RetentionPolicy()
		if input.Revision != old.Revision {
			return 409, map[string]string{"code": "REVISION_CONFLICT", "message": "Einstellungen wurden inzwischen geändert"}, true
		}
		next := LogRetention{Revision: old.Revision + 1, Enabled: input.Enabled, Days: input.Days, MaxEvents: input.MaxEvents, IntervalHours: input.IntervalHours, LastRun: old.LastRun, LastDeleted: old.LastDeleted}
		if err := validateRetention(next); err != nil {
			return 422, map[string]string{"code": "INVALID_RETENTION", "message": err.Error()}, true
		}
		tx, err := s.Engine.Store.DB.Begin()
		if err != nil {
			return 500, map[string]string{"code": "STORE_ERROR", "message": "Datenbank nicht verfügbar"}, true
		}
		defer tx.Rollback()
		_, err = tx.Exec(`INSERT INTO records VALUES('log-retention','current',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, encode(next))
		if err == nil {
			_, err = tx.Exec(`INSERT INTO events(host,data) VALUES('local',?)`, encode(Event{HostID: "local", Time: time.Now().UTC().Format(time.RFC3339Nano), Actor: p.ID, Operation: "logs.settings", Stage: "saved", Severity: "warning", Message: "Aufbewahrungsregel gespeichert; " + input.Reason}))
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			return 500, map[string]string{"code": "STORE_ERROR", "message": "Aufbewahrung konnte nicht gespeichert werden"}, true
		}
		return 200, next, true
	}
	action := strings.TrimPrefix(path, "/api/v1/log-retention/")
	if method != "POST" || (action != "rotate" && action != "reset" && action != "compact") {
		return 404, map[string]string{"code": "NOT_FOUND", "message": "Aktion nicht gefunden"}, true
	}
	if action == "reset" && input.Confirmation != "LOGS LÖSCHEN" {
		return 422, map[string]string{"code": "RESET_CONFIRMATION_REQUIRED", "message": "Zum Löschen LOGS LÖSCHEN eingeben"}, true
	}
	result, err := s.Engine.MaintainLogs(action, p.ID, input.Reason, time.Now().UTC())
	if err != nil {
		return 409, map[string]string{"code": "LOG_MAINTENANCE_BLOCKED", "message": err.Error()}, true
	}
	return 200, result, true
}

package core

import (
	"database/sql"
	"encoding/json"
	"fmt"

	_ "modernc.org/sqlite"
	"strings"
	"sync"
	"time"
)

type Store struct {
	DB *sql.DB
	Mu sync.Mutex
}

func Open(path string) (*Store, error) {
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	var schemaVersion int
	if err := db.QueryRow("PRAGMA user_version").Scan(&schemaVersion); err != nil {
		db.Close()
		return nil, err
	}
	if schemaVersion > 2 {
		db.Close()
		return nil, fmt.Errorf("database schema %d is newer than supported schema 2", schemaVersion)
	}
	s := &Store{DB: db}
	_, e = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(actor TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,status INTEGER NOT NULL,PRIMARY KEY(actor,key));
CREATE TABLE IF NOT EXISTS schedule_runs(slot TEXT NOT NULL,container TEXT NOT NULL,PRIMARY KEY(slot,container));
CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,ciphertext BLOB NOT NULL,version INTEGER NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_payloads(id TEXT PRIMARY KEY,body BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS release_targets(subscription TEXT NOT NULL,release TEXT NOT NULL,container TEXT NOT NULL,job TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(subscription,release,container));
PRAGMA user_version=2;`)
	if e != nil {
		return nil, e
	}
	if _, e = db.Exec(`INSERT OR IGNORE INTO records(kind,id,data) VALUES('permission-policy','current',?)`, encode(defaultPermissions())); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Put(kind, id string, v any) error {
	_, e := s.DB.Exec(`INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, kind, id, encode(v))
	return e
}

// Permission decisions and their audit records must commit together.
func (s *Store) SavePolicy(policy Policy, actor string, permissionChanged bool) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO records VALUES('policy',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, policy.ID, encode(policy)); err != nil {
		return err
	}
	events := []Event{{Actor: actor, Operation: "policy.save", Stage: "saved", Severity: "info", Message: "Richtlinie " + policy.ID + " aktualisiert"}}
	if permissionChanged {
		message := "Lesender Host-Monitoring-Zugriff widerrufen"
		if policy.Permissions.ReadOnlyHostMonitoring {
			message = "Lesender Host-Monitoring-Zugriff freigegeben: " + policy.PermissionReason
		}
		events = append(events, Event{Actor: actor, Operation: "policy.permissions", Stage: "saved", Severity: "warning", Message: "Richtlinie " + policy.ID + ": " + message})
	}
	for _, event := range events {
		event.HostID = "local"
		event.Time = time.Now().UTC().Format(time.RFC3339Nano)
		if _, err = tx.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, event.HostID, encode(event)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Get(kind, id string, v any) error {
	var data string
	e := s.DB.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&data)
	if e != nil {
		return e
	}
	return json.Unmarshal([]byte(data), v)
}
func (s *Store) List(kind string, v any) error {
	rows, e := s.DB.Query(`SELECT data FROM records WHERE kind=? ORDER BY id`, kind)
	if e != nil {
		return e
	}
	defer rows.Close()
	data := []json.RawMessage{}
	for rows.Next() {
		var raw string
		if e = rows.Scan(&raw); e != nil {
			return e
		}
		data = append(data, json.RawMessage(raw))
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return json.Unmarshal([]byte(encode(data)), v)
}
func (s *Store) Delete(kind, id string) error {
	_, e := s.DB.Exec(`DELETE FROM records WHERE kind=? AND id=?`, kind, id)
	return e
}
func (s *Store) Event(e Event) error {
	if e.Time == "" {
		e.Time = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if e.HostID == "" {
		e.HostID = "local"
	}
	_, err := s.DB.Exec(`INSERT INTO events(host,data) VALUES(?,?)`, e.HostID, encode(e))
	return err
}
func (s *Store) Events(after int64, p Principal) ([]Event, error) {
	return s.queryEvents(after, p, false)
}
func (s *Store) LatestEvents(p Principal) ([]Event, error) { return s.queryEvents(0, p, true) }
func (s *Store) queryEvents(after int64, p Principal, latest bool) ([]Event, error) {
	if len(p.Hosts) == 0 {
		return []Event{}, nil
	}
	where := "id>?"
	args := []any{after}
	if !p.Host("*") {
		where += " AND host IN (" + strings.TrimSuffix(strings.Repeat("?,", len(p.Hosts)), ",") + ")"
		for _, host := range p.Hosts {
			args = append(args, host)
		}
	}
	order := " ORDER BY id LIMIT 500"
	if latest {
		order = " ORDER BY id DESC LIMIT 200"
	}
	rows, e := s.DB.Query("SELECT id,data FROM events WHERE "+where+order, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var n int64
		var data string
		if e = rows.Scan(&n, &data); e != nil {
			return nil, e
		}
		var ev Event
		if e = json.Unmarshal([]byte(data), &ev); e != nil {
			return nil, e
		}
		ev.ID = n
		if p.Host(ev.HostID) {
			out = append(out, ev)
		}
	}
	if latest {
		for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
			out[left], out[right] = out[right], out[left]
		}
	}
	return out, rows.Err()
}
func (s *Store) Policies() []Policy { var out []Policy; _ = s.List("policy", &out); return out }
func (s *Store) Jobs() []Job        { var out []Job; _ = s.List("job", &out); return out }
func (s *Store) Recover() error {
	for _, j := range s.Jobs() {
		switch j.State {
		case "preflight", "pulling", "recreating", "verifying":
			j.State = "intervention_required"
			j.Reason = "Core restarted during execution. Inspect agent journal and container before retrying."
			j.Updated = time.Now().UTC().Format(time.RFC3339)
			if e := s.Put("job", j.ID, j); e != nil {
				return e
			}
			if e := s.Event(Event{JobID: j.ID, Actor: "system", Operation: "recovery", Stage: j.State, Severity: "warning", Message: j.Reason}); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Store) Backup(path string) error {
	_, e := s.DB.Exec("VACUUM INTO ?", path)
	return e
}

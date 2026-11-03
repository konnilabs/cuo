package core

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"cuo.local/cuo/internal/dataexport"
)

const exportRows = 10000

func filterProcesses(items []ProcessRun, q url.Values) ([]ProcessRun, error) {
	var start, end time.Time
	var err error
	for _, v := range []struct {
		key    string
		target *time.Time
	}{{"from", &start}, {"to", &end}} {
		if q.Get(v.key) != "" {
			*v.target, err = time.Parse(time.RFC3339, q.Get(v.key))
			if err != nil {
				*v.target, err = time.Parse("2006-01-02", q.Get(v.key))
				if err == nil && v.key == "to" {
					*v.target = v.target.AddDate(0, 0, 1).Add(-time.Nanosecond)
				}
			}
			if err != nil {
				return nil, errors.New("Zeitraum als Datum oder ISO-Zeitpunkt angeben")
			}
		}
	}
	if !start.IsZero() && !end.IsZero() && end.Before(start) {
		return nil, errors.New("Enddatum liegt vor Startdatum")
	}
	state := q.Get("status")
	if !strings.Contains(" all active completed attention planned event_driven blocked running queued scheduled pending_approval succeeded partial failed intervention_required cancelled ", " "+state+" ") && state != "" {
		return nil, errors.New("Unbekannter Statusfilter")
	}
	out := []ProcessRun{}
	for _, r := range items {
		at := parseTime(r.Created)
		if !start.IsZero() && at.Before(start) || !end.IsZero() && at.After(end) {
			continue
		}
		if q.Get("q") != "" && !strings.Contains(strings.ToLower(r.ID+" "+r.Name+" "+r.Reason+" "+strings.Join(r.Names, " ")), strings.ToLower(q.Get("q"))) {
			continue
		}
		match := state == "" || state == "all" || state == r.State
		if state == "active" {
			match = r.Kind != "forecast" && (!terminal(r.State) && r.State != "partial")
		}
		if state == "completed" {
			match = terminal(r.State) || r.State == "partial"
		}
		if state == "attention" {
			match = false
			for _, a := range r.Anomalies {
				match = match || a.Severity == "error" || a.Severity == "warning"
			}
		}
		if match {
			out = append(out, r)
		}
	}
	return out, nil
}
func processSheet(items []ProcessRun) dataexport.Sheet {
	s := dataexport.Sheet{Name: "Läufe", Headers: []string{"Lauf-ID", "Typ", "Name", "Status", "Angelegt (UTC)", "Start (UTC)", "Ende (UTC)", "Nächster Start (UTC)", "Dauer ms", "Wartezeit ms", "Baseline ms", "Baseline-Stichproben", "Container", "Erfolgreich", "Fehler", "Ausstehend", "Anomalien", "Hinweis", "Anforderer"}, Rows: [][]any{}}
	for _, r := range items {
		a := []string{}
		for _, n := range r.Anomalies {
			a = append(a, n.Code+": "+n.Message)
		}
		s.Rows = append(s.Rows, []any{r.ID, r.Kind, r.Name, r.State, r.Created, r.Started, r.Finished, r.NextStart, r.DurationMS, r.QueueMS, r.BaselineMS, r.BaselineSamples, r.ContainerCount, r.Succeeded, r.Failed, r.Pending, strings.Join(a, " | "), r.Reason, r.Requester})
	}
	return s
}
func (s *Server) exportData(w http.ResponseWriter, r *http.Request, p Principal) {
	q := r.URL.Query()
	dataset, format := q.Get("dataset"), q.Get("format")
	if format != "csv" && format != "xlsx" {
		fail(w, 422, "INVALID_EXPORT", "CSV oder XLSX wählen")
		return
	}
	if dataset != "containers" {
		if _, err := filterProcesses(nil, q); err != nil {
			fail(w, 422, "INVALID_FILTER", err.Error())
			return
		}
	}
	now := time.Now().UTC()
	sheets := []dataexport.Sheet{}
	var err error
	switch dataset {
	case "processes", "upcoming":
		items := s.Engine.Processes(p, now)
		if dataset == "upcoming" {
			items = s.Engine.Upcoming(p, now)
		}
		items, err = filterProcesses(items, q)
		sheets = append(sheets, processSheet(items))
	case "containers":
		sheet := dataexport.Sheet{Name: "Container", Headers: []string{"Container-ID", "Docker-ID", "Name", "Image-Referenz", "Image-Konfiguration", "Laufzustand", "Verwaltet", "Ausgeschlossen", "Richtlinie", "Plattform", "Ziel-Digest", "Prüffehler"}, Rows: [][]any{}}
		var items []Container
		_ = s.Engine.Store.List("container", &items)
		for _, c := range items {
			if !p.Host(c.HostID) || q.Get("q") != "" && !strings.Contains(strings.ToLower(c.Name+" "+c.Image), strings.ToLower(q.Get("q"))) {
				continue
			}
			target, problem := "", ""
			if c.Candidate != nil && candidateMatches(c, *c.Candidate) {
				target = c.Candidate.Target
				problem = c.Candidate.Error
			}
			sheet.Rows = append(sheet.Rows, []any{c.ID, c.EngineID, c.Name, c.Image, c.ImageID, c.State, c.Managed, c.Excluded, c.Mode, c.Platform, target, problem})
		}
		sheets = append(sheets, sheet)
	case "jobs", "detail":
		jobs := []Job{}
		runStages := []StageTiming{}
		if q.Get("runId") != "" {
			d, e := s.Engine.ProcessDetail(q.Get("runId"), p, 0, now)
			if e != nil {
				fail(w, 404, "NOT_FOUND", "Lauf nicht gefunden")
				return
			}
			jobs = d.Jobs
			runStages = d.Run.Stages
			if dataset == "detail" {
				sheets = append(sheets, processSheet([]ProcessRun{d.Run}))
			}
		} else if dataset == "detail" {
			fail(w, 422, "INVALID_EXPORT", "Lauf auswählen")
			return
		} else {
			allowedJobs := map[string]bool{}
			runs, filterErr := filterProcesses(s.Engine.Processes(p, now), q)
			if filterErr != nil {
				fail(w, 422, "INVALID_FILTER", filterErr.Error())
				return
			}
			for _, run := range runs {
				for _, id := range run.JobIDs {
					allowedJobs[id] = true
				}
			}
			for _, j := range s.Engine.Store.Jobs() {
				if p.Host(j.HostID) && allowedJobs[j.ID] {
					jobs = append(jobs, j)
				}
			}
		}
		sheet := dataexport.Sheet{Name: "Jobs", Headers: []string{"Job-ID", "Lauf-ID", "Container-ID", "Name", "Status", "Angelegt UTC", "Start UTC", "Ende UTC", "Image", "Quelle", "Ziel", "Docker-ID vorher", "Image vorher", "Zustand vorher", "Docker-ID nachher", "Image nachher", "Zustand nachher", "Logs gekürzt", "Hinweis"}, Rows: [][]any{}}
		stages := dataexport.Sheet{Name: "Phasen", Headers: []string{"Job-ID", "Phase", "Start UTC", "Ende UTC", "Dauer ms"}, Rows: [][]any{}}
		for _, stage := range runStages {
			stages.Rows = append(stages.Rows, []any{q.Get("runId"), stage.Stage, stage.Started, stage.Finished, stage.DurationMS})
		}
		for _, j := range jobs {
			before, after := ContainerSnapshot{}, ContainerSnapshot{}
			if j.Before != nil {
				before = *j.Before
			}
			if j.After != nil {
				after = *j.After
			}
			sheet.Rows = append(sheet.Rows, []any{j.ID, j.RunID, j.ContainerID, j.Name, j.State, j.Created, j.Started, j.Finished, j.Image, j.Source, j.Target, before.EngineID, before.ImageID, before.State, after.EngineID, after.ImageID, after.State, j.LogsPruned, j.Reason})
			for _, stage := range j.Stages {
				stages.Rows = append(stages.Rows, []any{j.ID, stage.Stage, stage.Started, stage.Finished, stage.DurationMS})
			}
		}
		sheets = append(sheets, sheet)
		if dataset == "detail" {
			sheets = append(sheets, stages)
			logs, e := s.Engine.exportEvents(p, q)
			err = e
			sheets = append(sheets, logs)
		}
	case "logs":
		sheet, e := s.Engine.exportEvents(p, q)
		err = e
		sheets = append(sheets, sheet)
	default:
		fail(w, 422, "INVALID_EXPORT", "Unbekannter Datenbestand")
		return
	}
	if err != nil {
		fail(w, 422, "EXPORT_FAILED", err.Error())
		return
	}
	total := 0
	for _, sheet := range sheets {
		total += len(sheet.Rows)
	}
	if total > exportRows {
		fail(w, 422, "EXPORT_LIMIT", "Maximal 10000 Zeilen pro Export; Zeitraum oder Lauf einschränken")
		return
	}
	meta := dataexport.Sheet{Name: "Exportinfo", Headers: []string{"Eigenschaft", "Wert"}, Rows: [][]any{{"Erstellt UTC", now.Format(time.RFC3339Nano)}, {"Datenbestand", dataset}, {"Filter", q.Encode()}, {"Zeilen", total}, {"Zeitzone", "UTC"}, {"Aufbewahrung", "Log-Rotation kann ältere Ereignisse entfernt haben; aktive Jobs und Laufhistorie bleiben geschützt"}}}
	var data []byte
	mime := "text/csv;charset=utf-8"
	if format == "xlsx" {
		sheets = append(sheets, meta)
		data, err = dataexport.XLSX(sheets)
		mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	} else {
		data, err = dataexport.CSV(sheets[0])
	}
	if err != nil {
		fail(w, 500, "EXPORT_FAILED", "Export konnte nicht erstellt werden")
		return
	}
	if len(data) > 16<<20 {
		fail(w, 422, "EXPORT_LIMIT", "Export ist größer als 16 MiB; Filter einschränken")
		return
	}
	respond(w, 200, DataExport{Filename: "cuo-" + dataset + "-" + now.Format("20060102-150405") + "." + format, ContentType: mime, Content: base64.StdEncoding.EncodeToString(data), Rows: total, Generated: now.Format(time.RFC3339Nano)})
}
func (e *Engine) exportEvents(p Principal, q url.Values) (dataexport.Sheet, error) {
	sheet := dataexport.Sheet{Name: "Protokolle", Headers: []string{"Ereignis-ID", "Zeit UTC", "Host", "Lauf-ID", "Job-ID", "Akteur", "Operation", "Phase", "Stufe", "Meldung"}, Rows: [][]any{}}
	where := `host='local'`
	args := []any{}
	if !p.Host("local") {
		return sheet, errors.New("Host-Zugriff fehlt")
	}
	if id := q.Get("runId"); id != "" {
		d, err := e.ProcessDetail(id, p, 0, time.Now().UTC())
		if err != nil {
			return sheet, err
		}
		if len(d.Run.JobIDs) == 0 && d.Run.Kind != "scan" {
			return sheet, nil
		}
		if len(d.Run.JobIDs) > 0 {
			where += ` AND (json_extract(data,'$.jobId') IN (` + strings.TrimSuffix(strings.Repeat("?,", len(d.Run.JobIDs)), ",") + `) OR json_extract(data,'$.runId')=?)`
		} else {
			where += ` AND json_extract(data,'$.runId')=?`
		}
		for _, jid := range d.Run.JobIDs {
			args = append(args, jid)
		}
		args = append(args, id)
	}
	for _, key := range []string{"from", "to"} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				t, err = time.Parse("2006-01-02", v)
				if err == nil && key == "to" {
					t = t.AddDate(0, 0, 1).Add(-time.Nanosecond)
				}
			}
			if err != nil {
				return sheet, errors.New("Ungültiger Zeitraum")
			}
			op := ">="
			if key == "to" {
				op = "<="
			}
			where += " AND julianday(json_extract(data,'$.time')) " + op + " julianday(?)"
			args = append(args, t.Format(time.RFC3339Nano))
		}
	}
	if q.Get("q") != "" {
		where += ` AND instr(lower(coalesce(json_extract(data,'$.message'),'') || ' ' || coalesce(json_extract(data,'$.jobId'),'') || ' ' || coalesce(json_extract(data,'$.operation'),'')),lower(?))>0`
		args = append(args, q.Get("q"))
	}
	rows, err := e.Store.DB.Query(`SELECT id,data FROM events WHERE `+where+` ORDER BY id LIMIT 10001`, args...)
	if err != nil {
		return sheet, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var data string
		if err = rows.Scan(&id, &data); err != nil {
			return sheet, err
		}
		var ev Event
		if err = json.Unmarshal([]byte(data), &ev); err != nil {
			return sheet, err
		}
		if q.Get("q") != "" && !strings.Contains(strings.ToLower(ev.Message+" "+ev.JobID+" "+ev.Operation), strings.ToLower(q.Get("q"))) {
			continue
		}
		sheet.Rows = append(sheet.Rows, []any{id, ev.Time, ev.HostID, ev.RunID, ev.JobID, ev.Actor, ev.Operation, ev.Stage, ev.Severity, ev.Message})
	}
	if err = rows.Err(); err != nil {
		return sheet, err
	}
	if len(sheet.Rows) > exportRows {
		return sheet, fmt.Errorf("Mehr als %d Ereignisse; Zeitraum einschränken", exportRows)
	}
	return sheet, nil
}

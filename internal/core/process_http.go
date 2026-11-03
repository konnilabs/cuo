package core

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Server) processGet(w http.ResponseWriter, r *http.Request, p Principal) bool {
	path := r.URL.Path
	if path == "/api/v1/log-retention" {
		respond(w, 200, s.Engine.Store.LogStorage())
		return true
	}
	if path == "/api/v1/exports" {
		s.exportData(w, r, p)
		return true
	}
	if !strings.HasPrefix(path, "/api/v1/process-runs") {
		return false
	}
	if path != "/api/v1/process-runs" {
		id := strings.TrimPrefix(path, "/api/v1/process-runs/")
		after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		detail, err := s.Engine.ProcessDetail(id, p, after, time.Now().UTC())
		if err != nil {
			fail(w, 404, "NOT_FOUND", "Lauf nicht gefunden")
			return true
		}
		respond(w, 200, detail)
		return true
	}
	now := time.Now().UTC()
	items := s.Engine.Processes(p, now)
	upcoming := s.Engine.Upcoming(p, now)
	kind := r.URL.Query().Get("kind")
	if kind == "forecast" {
		items = upcoming
	} else if kind != "" && kind != "run" {
		fail(w, 422, "INVALID_FILTER", "Unbekannter Lauftyp")
		return true
	}
	filtered, err := filterProcesses(items, r.URL.Query())
	if err != nil {
		fail(w, 422, "INVALID_FILTER", err.Error())
		return true
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	if offset > len(filtered) {
		offset = len(filtered)
	}
	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}
	if len(upcoming) > 200 {
		upcoming = upcoming[:200]
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		if kind == "forecast" {
			return filtered[i].NextStart < filtered[j].NextStart
		}
		return filtered[i].Created > filtered[j].Created
	})
	respond(w, 200, map[string]any{"items": filtered[offset:end], "total": len(filtered), "offset": offset, "limit": limit, "upcoming": upcoming})
	return true
}

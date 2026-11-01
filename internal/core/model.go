package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

type Host struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Endpoint      string   `json:"endpoint"`
	Connected     bool     `json:"connected"`
	DockerVersion string   `json:"dockerVersion"`
	APIVersion    string   `json:"apiVersion"`
	Capabilities  []string `json:"capabilities"`
}
type Container struct {
	EngineID  string     `json:"engineId"`
	ID        string     `json:"id"`
	HostID    string     `json:"hostId"`
	Name      string     `json:"name"`
	Image     string     `json:"image"`
	ImageID   string     `json:"imageId"`
	State     string     `json:"state"`
	Platform  string     `json:"platform"`
	Group     string     `json:"group"`
	Compose   bool       `json:"compose"`
	Managed   bool       `json:"managed"`
	Excluded  bool       `json:"excluded"`
	Mode      string     `json:"mode"`
	Reason    string     `json:"reason"`
	Candidate *Candidate `json:"candidate,omitempty"`
}
type Candidate struct {
	ContainerID string `json:"containerId"`
	Source      string `json:"sourceDigest"`
	Target      string `json:"targetDigest"`
	Ref         string `json:"image"`
	Platform    string `json:"platform"`
	Discovered  string `json:"discoveredAt"`
	Error       string `json:"error,omitempty"`
}
type Policy struct {
	ID          string `json:"id"`
	Scope       string `json:"scope"`
	Target      string `json:"target"`
	Mode        string `json:"mode"`
	Excluded    bool   `json:"excluded"`
	WindowID    string `json:"windowId"`
	Concurrency int    `json:"concurrency"`
}
type Window struct {
	NextStart string   `json:"nextStart,omitempty"`
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Timezone  string   `json:"timezone"`
	Days      []int    `json:"days"`
	Start     string   `json:"start"`
	Duration  int      `json:"durationMinutes"`
	Blackouts []string `json:"blackouts"`
	Enabled   bool     `json:"enabled"`
}
type Job struct {
	RunID       string `json:"runId,omitempty"`
	Immediate   bool   `json:"immediate,omitempty"`
	EngineID    string `json:"engineId"`
	Approved    bool   `json:"approved"`
	ID          string `json:"id"`
	HostID      string `json:"hostId"`
	ContainerID string `json:"containerId"`
	Name        string `json:"name"`
	State       string `json:"state"`
	Target      string `json:"targetDigest"`
	Source      string `json:"sourceDigest"`
	Image       string `json:"image"`
	Platform    string `json:"platform"`
	Requester   string `json:"requester"`
	Reason      string `json:"reason"`
	WindowID    string `json:"windowId"`
	Created     string `json:"createdAt"`
	Updated     string `json:"updatedAt"`
}
type RunSkip struct {
	ContainerID string `json:"containerId"`
	Name        string `json:"name"`
	Reason      string `json:"reason"`
}
type UpdateRun struct {
	ID        string    `json:"id"`
	Requester string    `json:"requester"`
	Created   string    `json:"createdAt"`
	Jobs      []Job     `json:"jobs"`
	Skipped   []RunSkip `json:"skipped"`
}
type Event struct {
	ID        int64  `json:"id"`
	HostID    string `json:"hostId"`
	JobID     string `json:"jobId"`
	Actor     string `json:"actor"`
	Operation string `json:"operation"`
	Stage     string `json:"stage"`
	Severity  string `json:"severity"`
	Message   string `json:"message"`
	Time      string `json:"time"`
}
type Principal struct {
	ID    string
	Role  string
	Hosts []string
}

var ranks = map[string]int{"Viewer": 0, "Operator": 1, "Administrator": 2, "Owner": 3}

func (p Principal) Can(role string) bool { r, ok := ranks[p.Role]; return ok && r >= ranks[role] }
func (p Principal) Host(id string) bool {
	for _, h := range p.Hosts {
		if h == id || h == "*" {
			return true
		}
	}
	return false
}
func ResolvePolicy(c Container, policies []Policy) Policy {
	p := Policy{ID: "global", Mode: "scan-only", Concurrency: 1}
	for _, scope := range []string{"global", "host", "group", "container"} {
		for _, v := range policies {
			if v.Scope != scope {
				continue
			}
			if scope == "global" || scope == "host" && v.Target == c.HostID || scope == "group" && v.Target == c.Group || scope == "container" && v.Target == c.ID {
				excluded := p.Excluded || v.Excluded
				p = v
				p.Excluded = excluded
			}
		}
	}
	if !c.Managed {
		p.Excluded = true
	}
	if p.Concurrency < 1 {
		p.Concurrency = 1
	}
	return p
}
func ValidatePolicy(p Policy) error {
	if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`).MatchString(p.ID) {
		return errors.New("invalid policy id")
	}
	switch p.Scope {
	case "global", "host", "group", "container":
	default:
		return errors.New("invalid scope")
	}
	switch p.Mode {
	case "scan-only", "automatic", "approval-required", "disabled":
	default:
		return errors.New("invalid mode")
	}
	if p.Concurrency < 1 || p.Concurrency > 4 {
		return errors.New("concurrency must be 1..4")
	}
	return nil
}
func ValidateWindow(w Window) error {
	if w.Name == "" || len(w.Name) > 100 {
		return errors.New("name required")
	}
	if _, e := time.LoadLocation(w.Timezone); e != nil {
		return errors.New("invalid IANA timezone")
	}
	var h, m int
	if _, e := fmt.Sscanf(w.Start, "%d:%d", &h, &m); e != nil || len(w.Start) != 5 || h < 0 || h > 23 || m < 0 || m > 59 {
		return errors.New("invalid start time")
	}
	if w.Duration < 1 || w.Duration > 1440 || len(w.Days) == 0 {
		return errors.New("invalid duration or weekdays")
	}
	for _, d := range w.Days {
		if d < 0 || d > 6 {
			return errors.New("invalid weekday")
		}
	}
	for _, d := range w.Blackouts {
		if _, e := time.Parse("2006-01-02", d); e != nil {
			return errors.New("invalid blackout date")
		}
	}
	return nil
}

// WindowStart selects the first occurrence in a repeated hour and advances skipped
// wall-clock minutes to the first valid minute on the same local date.
func WindowStart(w Window, date time.Time) time.Time {
	loc, _ := time.LoadLocation(w.Timezone)
	d := date.In(loc)
	var h, m int
	fmt.Sscanf(w.Start, "%d:%d", &h, &m)
	midnight := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, loc)
	wanted := h*60 + m
	for n := 0; n < 27*60; n++ {
		t := midnight.Add(time.Duration(n) * time.Minute)
		l := t.In(loc)
		if l.Day() != d.Day() {
			break
		}
		if l.Hour()*60+l.Minute() >= wanted {
			return t
		}
	}
	return time.Time{}
}
func ActiveWindow(w Window, now time.Time) (bool, string) {
	if !w.Enabled {
		return false, ""
	}
	loc, e := time.LoadLocation(w.Timezone)
	if e != nil {
		return false, ""
	}
	for _, delta := range []int{0, -1} {
		d := now.In(loc).AddDate(0, 0, delta)
		date := d.Format("2006-01-02")
		blocked := false
		for _, b := range w.Blackouts {
			blocked = blocked || b == date
		}
		if blocked {
			continue
		}
		match := false
		for _, v := range w.Days {
			match = match || v == int(d.Weekday())
		}
		if !match {
			continue
		}
		start := WindowStart(w, d)
		if !start.IsZero() && !now.Before(start) && now.Before(start.Add(time.Duration(w.Duration)*time.Minute)) {
			return true, w.ID + ":" + date
		}
	}
	return false, ""
}
func encode(v any) string { b, _ := json.Marshal(v); return string(b) }

// WindowsOverlap compares real intervals, including minute-sized windows and DST.
func WindowsOverlap(a, b Window, now time.Time) bool {
	intervals := func(w Window) [][2]time.Time {
		out := [][2]time.Time{}
		if !w.Enabled {
			return out
		}
		loc, err := time.LoadLocation(w.Timezone)
		if err != nil {
			return out
		}
		for day := -1; day <= 15; day++ {
			date := now.In(loc).AddDate(0, 0, day)
			start := WindowStart(w, date)
			active, _ := ActiveWindow(w, start)
			if active {
				out = append(out, [2]time.Time{start, start.Add(time.Duration(w.Duration) * time.Minute)})
			}
		}
		return out
	}
	for _, left := range intervals(a) {
		for _, right := range intervals(b) {
			if left[0].Before(right[1]) && right[0].Before(left[1]) {
				return true
			}
		}
	}
	return false
}

func NextWindowStart(w Window, now time.Time) time.Time {
	if !w.Enabled {
		return time.Time{}
	}
	loc, err := time.LoadLocation(w.Timezone)
	if err != nil {
		return time.Time{}
	}
	for day := -1; day < 370; day++ {
		date := now.In(loc).AddDate(0, 0, day)
		start := WindowStart(w, date)
		active, _ := ActiveWindow(w, start)
		if active && now.Before(start.Add(time.Duration(w.Duration)*time.Minute)) {
			return start
		}
	}
	return time.Time{}
}

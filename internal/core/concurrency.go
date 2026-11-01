package core

import (
	"context"
	"sort"
	"sync"
)

func matchesPolicy(c Container, p Policy) bool {
	return p.Scope == "global" || p.Scope == "host" && p.Target == c.HostID || p.Scope == "group" && p.Target == c.Group || p.Scope == "container" && p.Target == c.ID
}

// Global, host and group limits apply together. An absent global policy keeps
// the safe default of one; the absolute execution ceiling is four workers.
func canStart(c Container, active []Container, policies []Policy) bool {
	if len(active) >= 4 {
		return false
	}
	hasGlobal := false
	for _, p := range policies {
		if p.Scope == "global" {
			hasGlobal = true
		}
		if !matchesPolicy(c, p) {
			continue
		}
		limit := p.Concurrency
		if limit < 1 {
			limit = 1
		}
		count := 0
		for _, running := range active {
			if running.ID == c.ID {
				return false
			}
			if matchesPolicy(running, p) {
				count++
			}
		}
		if count >= limit {
			return false
		}
	}
	return hasGlobal || len(active) == 0
}

func (e *Engine) dispatch(ctx context.Context, active map[string]Container, completed chan<- string, workers *sync.WaitGroup) {
	e.Mu.Lock()
	defer e.Mu.Unlock()
	jobs := e.Store.Jobs()
	sort.SliceStable(jobs, func(i, j int) bool {
		if jobs[i].Created == jobs[j].Created {
			return jobs[i].ID < jobs[j].ID
		}
		return jobs[i].Created < jobs[j].Created
	})
	policies := e.Store.Policies()
	for _, j := range jobs {
		if ctx.Err() != nil || len(active) >= 4 {
			return
		}
		if j.State != "queued" {
			continue
		}
		if _, ok := active[j.ID]; ok {
			continue
		}
		var c Container
		if e.Store.Get("container", j.ContainerID, &c) != nil {
			e.update(&j, "cancelled", "Container nicht mehr vorhanden")
			continue
		}
		running := []Container{}
		for _, item := range active {
			running = append(running, item)
		}
		if !canStart(c, running, policies) {
			continue
		}
		active[j.ID] = c
		workers.Add(1)
		go func(job Job) {
			defer workers.Done()
			e.executeContext(ctx, job)
			completed <- job.ID
		}(j)
	}
}

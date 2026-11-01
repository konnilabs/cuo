package agent

import "context"

// Core owns policy admission. Agent adds a hard ceiling and refuses overlapping
// operations against a container or journal, even across independent callers.
func (a *Agent) reserve(op Operation) bool {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	if a.Active == nil {
		a.Active = map[string]bool{}
	}
	if len(a.Active) >= 8 || a.Active["container:"+op.ContainerID] || a.Active["job:"+op.JobID] {
		return false
	}
	a.Active["container:"+op.ContainerID] = true
	a.Active["job:"+op.JobID] = true
	return true
}
func (a *Agent) release(op Operation) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	delete(a.Active, "container:"+op.ContainerID)
	delete(a.Active, "job:"+op.JobID)
}
func (a *Agent) projectLock(ctx context.Context, project string) (func(), error) {
	value, _ := a.Projects.LoadOrStore(project, make(chan struct{}, 1))
	lock := value.(chan struct{})
	select {
	case lock <- struct{}{}:
		return func() { <-lock }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

package agent

import (
	"context"
	"testing"
	"time"
)

func TestAgentAdmissionCapsWorkersAndProtectsContainerAndJournal(t *testing.T) {
	a := &Agent{}
	first := Operation{ContainerID: "one", JobID: "one"}
	if !a.reserve(first) || a.reserve(Operation{ContainerID: "one", JobID: "two"}) || a.reserve(Operation{ContainerID: "two", JobID: "one"}) {
		t.Fatal("duplicate operation admitted")
	}
	for _, id := range []string{"two", "three", "four"} {
		if !a.reserve(Operation{ContainerID: id, JobID: id}) {
			t.Fatal("independent operation blocked")
		}
	}
	if a.reserve(Operation{ContainerID: "five", JobID: "five"}) {
		t.Fatal("hard ceiling ignored")
	}
	a.release(first)
	if !a.reserve(Operation{ContainerID: "five", JobID: "five"}) {
		t.Fatal("released slot not reusable")
	}
}
func TestComposeProjectLocksSerializeSharedDesiredState(t *testing.T) {
	a := &Agent{}
	unlock, err := a.projectLock(context.Background(), "project-a")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err = a.projectLock(ctx, "project-a"); err == nil {
		t.Fatal("shared project lock bypassed")
	}
	other, err := a.projectLock(context.Background(), "project-b")
	if err != nil {
		t.Fatal("independent project blocked", err)
	}
	other()
	unlock()
	next, err := a.projectLock(context.Background(), "project-a")
	if err != nil {
		t.Fatal(err)
	}
	next()
}

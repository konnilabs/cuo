package core

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// A config digest alone does not identify the registry reference that was checked.
// Changing a tag or platform invalidates its result even if image bytes are equal.
func candidateMatches(c Container, candidate Candidate) bool {
	return candidate.ContainerID == c.ID && candidate.Source != "" && candidate.Source == c.ImageID && candidate.Ref == c.Image && candidate.Platform == c.Platform
}

// Registry requests run outside the inventory lock. Commit their result only if
// the same container/image is still current; never restore a pre-update snapshot.
func (e *Engine) publishCandidate(scanned Container, candidate Candidate) (bool, error) {
	e.DiscoverMu.Lock()
	defer e.DiscoverMu.Unlock()
	tx, err := e.Store.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var data string
	if err = tx.QueryRow(`SELECT data FROM records WHERE kind='container' AND id=?`, scanned.ID).Scan(&data); errors.Is(err, sql.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	var current Container
	if err = json.Unmarshal([]byte(data), &current); err != nil {
		return false, err
	}
	if current.EngineID != scanned.EngineID || current.ImageID != scanned.ImageID || current.Image != scanned.Image || current.Platform != scanned.Platform || !candidateMatches(current, candidate) {
		return false, nil
	}
	current.Candidate = &candidate
	if _, err = tx.Exec(`INSERT INTO records VALUES('candidate',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`, current.ID, encode(candidate)); err != nil {
		return false, err
	}
	if _, err = tx.Exec(`UPDATE records SET data=? WHERE kind='container' AND id=?`, encode(current), current.ID); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

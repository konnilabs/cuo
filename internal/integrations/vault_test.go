package integrations

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVaultBindingRotationAndWrongKey(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "secrets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE secrets(id TEXT PRIMARY KEY,purpose TEXT,ciphertext BLOB,version INTEGER,updated TEXT)`)
	if err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(t.TempDir(), "key")
	os.WriteFile(key, []byte(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32))), 0600)
	v, err := OpenVault(db, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = v.Put("one", "pull", "secret-a"); err != nil {
		t.Fatal(err)
	}
	if _, err = v.Get("one", "github"); err == nil {
		t.Fatal("accepted wrong purpose")
	}
	var ciphertext []byte
	db.QueryRow(`SELECT ciphertext FROM secrets WHERE id='one'`).Scan(&ciphertext)
	if bytes.Contains(ciphertext, []byte("secret-a")) {
		t.Fatal("plaintext stored")
	}
	db.Exec(`INSERT INTO secrets SELECT 'two',purpose,ciphertext,version,updated FROM secrets WHERE id='one'`)
	if _, err = v.Get("two", "pull"); err == nil {
		t.Fatal("accepted transplanted ciphertext")
	}
	v.Put("one", "pull", "secret-b")
	if value, err := v.Get("one", "pull"); err != nil || value != "secret-b" {
		t.Fatal("rotation", err)
	}
	os.WriteFile(key, []byte(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))), 0600)
	if _, err = OpenVault(db, key); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatal("wrong-key database started", err)
	}
	os.Chmod(key, 0644)
	if _, err = OpenVault(db, key); err == nil {
		t.Fatal("accepted public key file")
	}
}

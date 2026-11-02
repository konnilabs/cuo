// Package integrations owns secrets independently of public integration DTOs.
package integrations

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"time"
)

type Vault struct {
	DB   *sql.DB
	aead cipher.AEAD
}

func OpenVault(db *sql.DB, filename string) (*Vault, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("integration key must be an existing private regular file")
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, errors.New("integration key unavailable")
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != 32 {
		return nil, errors.New("integration key must contain a base64-encoded 32-byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	v := &Vault{DB: db, aead: aead}
	// Bind the database to its installation key. This also detects wrong-key
	// restores before the API or workers are started, rather than on first use.
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM secrets WHERE id='__installation_check'`).Scan(&count); err != nil {
		return nil, err
	}
	if count == 0 {
		if err = v.Put("__installation_check", "installation-check", "cuo.secret-store.v1"); err != nil {
			return nil, err
		}
	}
	check, err := v.Get("__installation_check", "installation-check")
	if err != nil || check != "cuo.secret-store.v1" {
		return nil, errors.New("integration key does not match this CUO database; restore the separately backed-up installation key")
	}
	return v, nil
}

func (v *Vault) Seal(id, purpose, value string) ([]byte, error) {
	if v == nil || v.aead == nil {
		return nil, errors.New("integration secret store is locked")
	}
	if value == "" || len(value) > 32768 {
		return nil, errors.New("invalid secret size")
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return v.aead.Seal(nonce, nonce, []byte(value), []byte("cuo.secret.v1\x00"+id+"\x00"+purpose)), nil
}

func (v *Vault) Put(id, purpose, value string) error {
	sealed, err := v.Seal(id, purpose, value)
	if err != nil {
		return err
	}
	_, err = v.DB.Exec(`INSERT INTO secrets(id,purpose,ciphertext,version,updated) VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose,ciphertext=excluded.ciphertext,version=secrets.version+1,updated=excluded.updated`, id, purpose, sealed, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (v *Vault) Get(id, purpose string) (string, error) {
	if v == nil {
		return "", errors.New("integration secret store is locked")
	}
	var ciphertext []byte
	var savedPurpose string
	if err := v.DB.QueryRow(`SELECT purpose,ciphertext FROM secrets WHERE id=?`, id).Scan(&savedPurpose, &ciphertext); err != nil {
		return "", errors.New("integration credential unavailable")
	}
	if savedPurpose != purpose || len(ciphertext) < v.aead.NonceSize() {
		return "", errors.New("integration credential purpose mismatch")
	}
	n := v.aead.NonceSize()
	plain, err := v.aead.Open(nil, ciphertext[:n], ciphertext[n:], []byte("cuo.secret.v1\x00"+id+"\x00"+purpose))
	if err != nil {
		return "", errors.New("integration credential cannot be decrypted with the installation key")
	}
	return string(plain), nil
}

func (v *Vault) Delete(id string) error {
	if v == nil {
		return errors.New("integration secret store is locked")
	}
	_, err := v.DB.Exec(`DELETE FROM secrets WHERE id=?`, id)
	return err
}

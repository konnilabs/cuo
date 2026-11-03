// Package backup validates offline CUO backups before any destination is changed.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const maxBytes = int64(16 << 30)

var owners = map[string]int{"identity": 1000, "core": 10001, "agent": 0}
var required = map[string]bool{"identity": true, "core": true, "agent": true}
var archiveOwners = map[string]int{"identity": 1000, "core": 10001, "agent": 0, "zot": 10001, "registry-config": 10001}

func restoredOwners(stage string) map[string]int {
	result := map[string]int{}
	for name, uid := range archiveOwners {
		if _, err := os.Stat(filepath.Join(stage, name)); err == nil {
			result[name] = uid
		}
	}
	return result
}

// Run stages and checks the entire stream, including gzip checksums and database
// integrity. Restore targets must be existing directories mounted by the caller.
// Replacement of three volumes is offline, not an atomic multi-volume commit.
func Run(input io.Reader, restore bool, root string) error {
	stage, err := os.MkdirTemp("", "cuo-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = unpack(input, stage); err != nil {
		return err
	}
	if err = check(stage); err != nil {
		return err
	}
	if !restore {
		return nil
	}
	for name := range restoredOwners(stage) {
		info, err := os.Lstat(filepath.Join(root, name))
		if err != nil || !info.IsDir() {
			return fmt.Errorf("restore requires an existing directory for %s", name)
		}
	}
	for name, uid := range restoredOwners(stage) {
		destination := filepath.Join(root, name)
		entries, err := os.ReadDir(destination)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := os.RemoveAll(filepath.Join(destination, entry.Name())); err != nil {
				return err
			}
		}
		if err := filepath.WalkDir(filepath.Join(stage, name), func(source string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, err := filepath.Rel(filepath.Join(stage, name), source)
			if err != nil {
				return err
			}
			target := filepath.Join(destination, rel)
			if entry.IsDir() {
				if err = os.MkdirAll(target, 0700); err != nil {
					return err
				}
				if err = os.Chmod(target, 0700); err != nil {
					return err
				}
			} else {
				in, err := os.Open(source)
				if err != nil {
					return err
				}
				out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err != nil {
					in.Close()
					return err
				}
				_, copyErr := io.Copy(out, in)
				in.Close()
				syncErr := out.Sync()
				closeErr := out.Close()
				if err = errors.Join(copyErr, syncErr, closeErr); err != nil {
					return err
				}
			}
			return os.Chown(target, uid, uid)
		}); err != nil {
			return err
		}
	}
	return nil
}

func unpack(input io.Reader, root string) error {
	gz, err := gzip.NewReader(input)
	if err != nil {
		return errors.New("invalid gzip backup")
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	seen := map[string]bool{}
	var total int64
	for count := 0; ; count++ {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("invalid tar backup")
		}
		name := strings.TrimSuffix(header.Name, "/")
		first := strings.SplitN(name, "/", 2)[0]
		_, known := archiveOwners[first]
		if name == "format.json" {
			known = true
		}
		if !known || path.Clean(name) != name || strings.Contains(name, "\\") || strings.ContainsAny(name, "\r\n\x00") || seen[name] {
			return errors.New("unsafe, duplicate or unexpected archive member")
		}
		seen[name] = true
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg {
			return errors.New("backup may contain only regular files and directories")
		}
		total += header.Size
		if header.Size < 0 || total > maxBytes || count >= 100000 {
			return errors.New("backup exceeds 16 GiB or 100000 entries")
		}
		target := filepath.Join(root, filepath.FromSlash(name))
		if header.Typeflag == tar.TypeDir {
			if err = os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(file, reader, header.Size)
		if err = errors.Join(copyErr, file.Close()); err != nil {
			return errors.New("incomplete backup member")
		}
	}
	// tar EOF alone does not verify the gzip footer/checksum.
	_, err = io.Copy(io.Discard, io.LimitReader(gz, maxBytes-total+1))
	if err != nil {
		return errors.New("incomplete gzip backup or checksum mismatch")
	}
	var trailing [1]byte
	if n, err := gz.Read(trailing[:]); n != 0 || err != io.EOF {
		return errors.New("oversized backup trailer")
	}
	return nil
}

func check(root string) error {
	var format archiveFormat
	if data, err := os.ReadFile(filepath.Join(root, "format.json")); err == nil {
		if json.Unmarshal(data, &format) != nil || format.Version != 2 {
			return errors.New("unsupported CUO backup format")
		}
	}
	_, zotErr := os.Stat(filepath.Join(root, "zot"))
	_, configErr := os.Stat(filepath.Join(root, "registry-config"))
	hasRegistry := zotErr == nil || configErr == nil
	if hasRegistry {
		if zotErr != nil || configErr != nil {
			return errors.New("registry backup needs both blob storage and configuration")
		}
		for _, file := range []string{"config.json", "htpasswd"} {
			info, err := os.Stat(filepath.Join(root, "registry-config", file))
			if err != nil || !info.Mode().IsRegular() {
				return errors.New("registry backup has incomplete configuration")
			}
		}
	}
	if format.Version == 2 && format.Registry != hasRegistry {
		return errors.New("registry backup format does not match its contents")
	}
	for name := range owners {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || !info.IsDir() {
			return fmt.Errorf("backup is missing %s", name)
		}
	}
	for file, maxSchema := range map[string]int{"core/cuo.db": 2, "identity/identity.db": 2} {
		db, err := sql.Open("sqlite", "file:"+filepath.Join(root, file)+"?mode=ro")
		if err != nil {
			return errors.New("cannot open backup database")
		}
		var integrity string
		var schema int
		err = db.QueryRow("PRAGMA quick_check").Scan(&integrity)
		if err == nil {
			err = db.QueryRow("PRAGMA user_version").Scan(&schema)
		}
		if err != nil || integrity != "ok" || schema < 1 || schema > maxSchema {
			db.Close()
			return fmt.Errorf("invalid integrity or unsupported schema in %s", file)
		}
		if file == "core/cuo.db" {
			rows, queryErr := db.Query("SELECT kind,data FROM records WHERE kind IN ('job','scan-run')")
			if queryErr != nil {
				db.Close()
				return errors.New("invalid Core records")
			}
			for rows.Next() {
				var kind, raw string
				var job struct {
					State string `json:"state"`
				}
				if err = rows.Scan(&kind, &raw); err == nil {
					err = json.Unmarshal([]byte(raw), &job)
				}
				if err != nil || (!quiescent(job.State) && !(kind == "scan-run" && job.State == "partial")) {
					rows.Close()
					db.Close()
					return errors.New("backup contains unfinished jobs; finish or cancel them before backup")
				}
			}
			err = errors.Join(rows.Err(), rows.Close())
		}
		err = errors.Join(err, db.Close())
		if err != nil {
			return err
		}
	}
	return filepath.WalkDir(filepath.Join(root, "agent"), func(file string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(file, ".json") {
			return err
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if !json.Valid(data) {
			return errors.New("invalid Agent JSON journal or desired state")
		}
		return nil
	})
}

func quiescent(state string) bool {
	return state == "succeeded" || state == "failed" || state == "cancelled" || state == "intervention_required"
}

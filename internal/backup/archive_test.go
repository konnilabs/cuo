package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"database/sql"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, jobState string) string {
	t.Helper()
	root := t.TempDir()
	for name := range owners {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for file, schema := range map[string]string{"core/cuo.db": "1", "identity/identity.db": "2"} {
		db, err := sql.Open("sqlite", filepath.Join(root, file))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec("CREATE TABLE records(kind TEXT, data TEXT); PRAGMA user_version=" + schema); err != nil {
			t.Fatal(err)
		}
		if jobState != "" && file == "core/cuo.db" {
			if _, err = db.Exec("INSERT INTO records VALUES('job',?)", `{"state":"`+jobState+`"}`); err != nil {
				t.Fatal(err)
			}
		}
		if err = db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "agent", "job.json"), []byte(`{"frame":{"stage":"succeeded"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func archive(t *testing.T, root string, extra *tar.Header) []byte {
	t.Helper()
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil || file == root {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		h, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		h.Name, err = filepath.Rel(root, file)
		if err != nil {
			return err
		}
		if err = tw.WriteHeader(h); err != nil {
			return err
		}
		if !entry.IsDir() {
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			f.Close()
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if extra != nil {
		if err = tw.WriteHeader(extra); err != nil {
			t.Fatal(err)
		}
	}
	if err = tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err = gz.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestValidOfflineBackup(t *testing.T) {
	if err := Run(bytes.NewReader(archive(t, fixture(t, "succeeded"), nil)), false, ""); err != nil {
		t.Fatal(err)
	}
}

func TestUnsafeArchivesDoNotTouchDestination(t *testing.T) {
	for name, h := range map[string]tar.Header{
		"traversal":  {Name: "identity/../../outside", Typeflag: tar.TypeReg},
		"absolute":   {Name: "/identity/escape", Typeflag: tar.TypeReg},
		"symlink":    {Name: "identity/link", Typeflag: tar.TypeSymlink, Linkname: "/core"},
		"hardlink":   {Name: "agent/link", Typeflag: tar.TypeLink, Linkname: "core/cuo.db"},
		"duplicate":  {Name: "core/cuo.db", Typeflag: tar.TypeReg},
		"unexpected": {Name: "etc/passwd", Typeflag: tar.TypeReg},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			sentinel := filepath.Join(root, "sentinel")
			os.WriteFile(sentinel, []byte("untouched"), 0600)
			if err := Run(bytes.NewReader(archive(t, fixture(t, ""), &h)), true, root); err == nil {
				t.Fatal("unsafe archive accepted")
			}
			if b, err := os.ReadFile(sentinel); err != nil || string(b) != "untouched" {
				t.Fatal("destination modified before validation")
			}
		})
	}
}

func TestRejectIncompleteOrIncompatibleBackup(t *testing.T) {
	for _, kind := range []string{"checksum", "truncated", "missing-volume", "future-schema", "broken-db", "invalid-agent", "queued", "scheduled", "pending_approval", "preflight"} {
		t.Run(kind, func(t *testing.T) {
			state := ""
			if kind == "queued" || kind == "scheduled" || kind == "pending_approval" || kind == "preflight" {
				state = kind
			}
			root := fixture(t, state)
			switch kind {
			case "missing-volume":
				os.RemoveAll(filepath.Join(root, "agent"))
			case "future-schema":
				db, _ := sql.Open("sqlite", filepath.Join(root, "core/cuo.db"))
				db.Exec("PRAGMA user_version=999")
				db.Close()
			case "broken-db":
				os.WriteFile(filepath.Join(root, "identity/identity.db"), []byte("not sqlite"), 0600)
			case "invalid-agent":
				os.WriteFile(filepath.Join(root, "agent/job.json"), []byte("{"), 0600)
			}
			data := archive(t, root, nil)
			if kind == "checksum" {
				data[len(data)-8] ^= 0xff
			}
			if kind == "truncated" {
				data = data[:len(data)-9]
			}
			if err := Run(bytes.NewReader(data), false, ""); err == nil {
				t.Fatal("invalid archive accepted")
			}
		})
	}
}

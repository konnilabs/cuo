package backup

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type archiveFormat struct {
	Version  int  `json:"version"`
	Registry bool `json:"registry"`
}

// Create streams regular files, deliberately materializing hard-linked Zot
// blobs so that restore never needs to follow archive links.
func Create(output io.Writer, root string) error {
	// Source volumes are mounted read-only. SQLite may need a writable SHM
	// file to inspect a clean offline WAL database; validate the staged archive
	// instead (backup.sh does this before installing the completed backup).
	for name := range required {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || !info.IsDir() {
			return errors.New("backup source volume missing")
		}
	}
	format := archiveFormat{Version: 2}
	if info, err := os.Stat(filepath.Join(root, "zot")); err == nil && info.IsDir() {
		format.Registry = true
	}
	gz := gzip.NewWriter(output)
	tw := tar.NewWriter(gz)
	data, _ := json.Marshal(format)
	if err := tw.WriteHeader(&tar.Header{Name: "format.json", Mode: 0600, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(data); err != nil {
		return err
	}
	var total int64
	count := 0
	for name := range archiveOwners {
		if !required[name] && !format.Registry {
			continue
		}
		base := filepath.Join(root, name)
		if err := filepath.WalkDir(base, func(source string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				return errors.New("backup source contains a non-regular file")
			}
			total += info.Size()
			count++
			if total > maxBytes || count > 100000 {
				return errors.New("backup exceeds resource limit")
			}
			rel, err := filepath.Rel(root, source)
			if err != nil {
				return err
			}
			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = filepath.ToSlash(rel)
			header.Mode = 0600
			if info.IsDir() {
				header.Mode = 0700
			}
			if err = tw.WriteHeader(header); err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}
			f, err := os.Open(source)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(tw, f)
			return errors.Join(copyErr, f.Close())
		}); err != nil {
			return err
		}
	}
	return errors.Join(tw.Close(), gz.Close())
}

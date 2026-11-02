// Package provision initializes only CUO-owned installation secrets and Zot data.
package provision

import (
	"crypto/rand"
	"cuo.local/cuo/internal/unioci"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

type RegistryCredentials struct {
	Host         string `json:"host"`
	PullUsername string `json:"pullUsername"`
	PullPassword string `json:"pullPassword"`
	PushUsername string `json:"pushUsername"`
	PushPassword string `json:"pushPassword"`
}

func randomSecret() string {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(value)
}
func privateFile(name string, data []byte, uid int) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return os.Chown(name, uid, uid)
}
func Setup(directory, host string, withRegistry bool, ownerUID int) error {
	if withRegistry {
		ref, err := unioci.ParseReference(host + "/bootstrap:latest")
		if err != nil || ref.Host != host {
			return errors.New("invalid canonical registry host")
		}
	}
	if !filepath.IsAbs(directory) {
		return errors.New("absolute setup directory required")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	key := filepath.Join(directory, "integration.key")
	if _, err := os.Lstat(key); os.IsNotExist(err) {
		data := make([]byte, 32)
		if _, err = rand.Read(data); err != nil {
			return err
		}
		if err = privateFile(key, []byte(base64.StdEncoding.EncodeToString(data)+"\n"), 10001); err != nil {
			return err
		}
	}
	info, err := os.Lstat(key)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("existing installation key must be a private regular file")
	}
	keyData, err := os.ReadFile(key)
	if err != nil {
		return err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(keyData)))
	if err != nil || len(decoded) != 32 {
		return errors.New("invalid existing installation key; refusing replacement")
	}
	clientFile := filepath.Join(directory, "zot-client.json")
	if !withRegistry {
		if _, err := os.Stat(clientFile); os.IsNotExist(err) {
			return privateFile(clientFile, []byte("{}\n"), 10001)
		}
		return nil
	}
	var credentials RegistryCredentials
	data, err := os.ReadFile(clientFile)
	if err == nil && strings.TrimSpace(string(data)) != "{}" {
		info, statErr := os.Lstat(clientFile)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || json.Unmarshal(data, &credentials) != nil || credentials.PullPassword == "" || credentials.PushPassword == "" {
			return errors.New("invalid existing Zot bootstrap credentials")
		}
		if credentials.Host != host {
			return errors.New("Zot host differs from provisioned host; migrate the endpoint explicitly")
		}
	} else {
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		credentials = RegistryCredentials{Host: host, PullUsername: "cuo-pull", PullPassword: randomSecret(), PushUsername: "cuo-import", PushPassword: randomSecret()}
		clientBytes, _ := json.MarshalIndent(credentials, "", "  ")
		if err == nil {
			if err = os.Remove(clientFile); err != nil {
				return err
			}
		}
		if err = privateFile(clientFile, append(clientBytes, '\n'), 10001); err != nil {
			return err
		}
	}
	ciFile := filepath.Join(directory, "zot-ci.env")
	ciPassword := ""
	if data, readErr := os.ReadFile(ciFile); readErr == nil {
		info, statErr := os.Lstat(ciFile)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return errors.New("CI credentials must be a private regular file")
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "ZOT_PASSWORD=") {
				ciPassword = strings.TrimPrefix(line, "ZOT_PASSWORD=")
			}
		}
		if ciPassword == "" {
			return errors.New("invalid existing CI credentials")
		}
	} else if os.IsNotExist(readErr) {
		ciPassword = randomSecret()
		if err = privateFile(ciFile, []byte("ZOT_REGISTRY="+host+"\nZOT_USERNAME=cuo-ci\nZOT_PASSWORD="+ciPassword+"\n"), ownerUID); err != nil {
			return err
		}
	} else {
		return readErr
	}
	zotDir := filepath.Join(directory, "zot")
	if err = os.MkdirAll(zotDir, 0700); err != nil {
		return err
	}
	if err = os.Chown(zotDir, 10001, 10001); err != nil {
		return err
	}
	htpasswd := ""
	for username, password := range map[string]string{credentials.PullUsername: credentials.PullPassword, credentials.PushUsername: credentials.PushPassword, "cuo-ci": ciPassword} {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		htpasswd += username + ":" + string(hash) + "\n"
	}
	config := map[string]any{
		"distSpecVersion": "1.1.1",
		"storage":         map[string]any{"rootDirectory": "/var/lib/registry", "gc": false, "dedupe": true},
		"http": map[string]any{
			"address": "0.0.0.0", "port": "5000", "compat": []string{"docker2s2"},
			"auth": map[string]any{"htpasswd": map[string]string{"path": "/etc/zot/htpasswd"}, "apikey": true},
			"accessControl": map[string]any{"repositories": map[string]any{"**": map[string]any{
				"policies": []any{
					map[string]any{"users": []string{"cuo-pull"}, "actions": []string{"read"}},
					map[string]any{"users": []string{"cuo-import", "cuo-ci"}, "actions": []string{"read", "create", "update"}},
				},
			}}},
		},
		"log": map[string]any{"level": "warn"},
	}

	configBytes, _ := json.MarshalIndent(config, "", "  ")
	for file, contents := range map[string][]byte{"config.json": append(configBytes, '\n'), "htpasswd": []byte(htpasswd)} {
		name := filepath.Join(zotDir, file)
		info, statErr := os.Lstat(name)
		if statErr == nil {
			if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
				return fmt.Errorf("unsafe existing Zot %s", file)
			}
			continue
		}
		if !os.IsNotExist(statErr) {
			return statErr
		}
		if err = privateFile(name, contents, 10001); err != nil {
			return err
		}
	}
	return nil
}

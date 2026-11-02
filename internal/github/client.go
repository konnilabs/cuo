// Package github implements the installation-scoped GitHub.com integration.
package github

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"cuo.local/cuo/internal/unioci"
)

type Client struct {
	tokenMu           sync.Mutex
	AppID             string
	Key               *rsa.PrivateKey
	HTTP              *http.Client
	BaseURL           string
	token             string
	tokenInstallation string
	expires           time.Time
}
type Repository struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
}
type Installation struct {
	ID      int64 `json:"id"`
	AppID   int64 `json:"app_id"`
	Account struct {
		Login string `json:"login"`
	} `json:"account"`
	SuspendedAt *string `json:"suspended_at"`
}
type Workflow struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	State string `json:"state"`
}
type Run struct {
	ID             int64      `json:"id"`
	WorkflowID     int64      `json:"workflow_id"`
	RunAttempt     int        `json:"run_attempt"`
	RunNumber      int64      `json:"run_number"`
	Event          string     `json:"event"`
	Status         string     `json:"status"`
	Conclusion     string     `json:"conclusion"`
	HeadBranch     string     `json:"head_branch"`
	HeadSHA        string     `json:"head_sha"`
	CreatedAt      string     `json:"created_at"`
	HTMLURL        string     `json:"html_url"`
	HeadRepository Repository `json:"head_repository"`
}
type App struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
}

var number = regexp.MustCompile(`^[0-9]{1,20}$`)
var repo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func New(appID, keyText string) (*Client, error) {
	if !number.MatchString(appID) {
		return nil, errors.New("GitHub-App-ID muss numerisch sein")
	}
	block, _ := pem.Decode([]byte(keyText))
	if block == nil {
		return nil, errors.New("Ungültiger GitHub-App-Schlüssel")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return nil, errors.New("Ungültiger RSA-App-Schlüssel")
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("GitHub-App benötigt einen RSA-Schlüssel")
		}
	}
	if key.N.BitLen() < 2048 {
		return nil, errors.New("GitHub-App-Schlüssel muss mindestens 2048 Bit besitzen")
	}
	guard, err := unioci.New(unioci.Config{Host: "api.github.com", Endpoint: "https://api.github.com", Repositories: []string{"*"}}, unioci.Credentials{}, "")
	if err != nil {
		return nil, err
	}
	return &Client{AppID: appID, Key: key, HTTP: guard.HTTP, BaseURL: "https://api.github.com"}, nil
}
func (c *Client) jwt() (string, error) {
	enc := base64.RawURLEncoding.EncodeToString
	header := enc([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{"iss": c.AppID, "iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(4 * time.Minute).Unix()})
	unsigned := header + "." + enc(claims)
	sum := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.Key, crypto.SHA256, sum[:])
	return unsigned + "." + enc(signature), err
}

// RateLimitError preserves scheduling information without exposing response bodies.
type RateLimitError struct{ RetryAt time.Time }

func (e *RateLimitError) Error() string {
	return "GitHub-Rate-Limit erreicht; Wiederaufnahme ist geplant"
}
func rateLimit(response *http.Response) error {
	if response.StatusCode != 429 && !(response.StatusCode == 403 && (response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "")) {
		return nil
	}
	retry := time.Now().Add(time.Minute)
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
		retry = time.Now().Add(time.Duration(min(seconds, 86400)) * time.Second)
	} else if date, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
		retry = date
	} else if stamp, err := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		retry = time.Unix(stamp, 0)
	}
	if retry.Before(time.Now().Add(time.Second)) {
		retry = time.Now().Add(time.Minute)
	}
	if retry.After(time.Now().Add(24 * time.Hour)) {
		retry = time.Now().Add(24 * time.Hour)
	}
	return &RateLimitError{RetryAt: retry}
}
func (c *Client) request(ctx context.Context, method, path, token string, input, out any) error {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return errors.New("Ungültiger GitHub-API-Pfad")
	}
	var body io.Reader
	if input != nil {
		data, _ := json.Marshal(input)
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	req.Header.Set("User-Agent", "CUO/0.2.0")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := c.HTTP.Do(req)
	if err != nil {
		return errors.New("GitHub-Verbindung fehlgeschlagen")
	}
	defer response.Body.Close()
	if limit := rateLimit(response); limit != nil {
		return limit
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("GitHub API HTTP %d; App-Rechte, Installation und Rate-Limit prüfen", response.StatusCode)
	}
	if out == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 2<<20))
		return err
	}
	return json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(out)
}
func (c *Client) App(ctx context.Context) (App, error) {
	var out App
	jwt, err := c.jwt()
	if err == nil {
		err = c.request(ctx, "GET", "/app", jwt, nil, &out)
	}
	return out, err
}
func (c *Client) Installations(ctx context.Context) ([]Installation, error) {
	jwt, err := c.jwt()
	if err != nil {
		return nil, err
	}
	out := []Installation{}
	for page := 1; page <= 10; page++ {
		var items []Installation
		if err = c.request(ctx, "GET", fmt.Sprintf("/app/installations?per_page=100&page=%d", page), jwt, nil, &items); err != nil {
			return nil, err
		}
		out = append(out, items...)
		if len(items) < 100 {
			return out, nil
		}
	}
	return nil, errors.New("Zu viele GitHub-Installationen")
}
func (c *Client) Installation(ctx context.Context, id string) (Installation, error) {
	var out Installation
	if !number.MatchString(id) {
		return out, errors.New("Ungültige Installation-ID")
	}
	jwt, err := c.jwt()
	if err == nil {
		err = c.request(ctx, "GET", "/app/installations/"+id, jwt, nil, &out)
	}
	if err == nil && (fmt.Sprint(out.AppID) != c.AppID || out.SuspendedAt != nil) {
		err = errors.New("Installation gehört nicht zur aktiven GitHub-App oder ist gesperrt")
	}
	return out, err
}
func (c *Client) Token(ctx context.Context, installation string) (string, error) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	if c.tokenInstallation == installation && time.Until(c.expires) > 2*time.Minute {
		return c.token, nil
	}
	if _, err := c.Installation(ctx, installation); err != nil {
		return "", err
	}
	jwt, err := c.jwt()
	if err != nil {
		return "", err
	}
	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	err = c.request(ctx, "POST", "/app/installations/"+installation+"/access_tokens", jwt, map[string]any{"permissions": map[string]string{"metadata": "read", "actions": "read"}}, &result)
	if err != nil {
		return "", err
	}
	if result.Token == "" || time.Until(result.ExpiresAt) <= 0 {
		return "", errors.New("GitHub lieferte kein gültiges Installationstoken")
	}
	c.token = result.Token
	c.expires = result.ExpiresAt
	c.tokenInstallation = installation
	return c.token, nil
}
func (c *Client) Repositories(ctx context.Context, installation string) ([]Repository, error) {
	token, err := c.Token(ctx, installation)
	if err != nil {
		return nil, err
	}
	out := []Repository{}
	for page := 1; page <= 20; page++ {
		var result struct {
			Repositories []Repository `json:"repositories"`
		}
		if err = c.request(ctx, "GET", fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page), token, nil, &result); err != nil {
			return nil, err
		}
		out = append(out, result.Repositories...)
		if len(result.Repositories) < 100 {
			return out, nil
		}
	}
	return nil, errors.New("Mehr als 2000 freigegebene Repositories")
}
func (c *Client) Workflows(ctx context.Context, installation, repository string) ([]Workflow, error) {
	if !repo.MatchString(repository) {
		return nil, errors.New("Ungültiges Repository")
	}
	token, err := c.Token(ctx, installation)
	if err != nil {
		return nil, err
	}
	out := []Workflow{}
	for page := 1; page <= 10; page++ {
		var result struct {
			Workflows []Workflow `json:"workflows"`
		}
		if err = c.request(ctx, "GET", fmt.Sprintf("/repos/%s/actions/workflows?per_page=100&page=%d", repository, page), token, nil, &result); err != nil {
			return nil, err
		}
		out = append(out, result.Workflows...)
		if len(result.Workflows) < 100 {
			return out, nil
		}
	}
	return nil, errors.New("Zu viele Workflows")
}
func (c *Client) Run(ctx context.Context, installation, repository, id string) (Run, error) {
	var out Run
	if !repo.MatchString(repository) || !number.MatchString(id) {
		return out, errors.New("Ungültiger Workflow-Lauf")
	}
	token, err := c.Token(ctx, installation)
	if err == nil {
		err = c.request(ctx, "GET", "/repos/"+repository+"/actions/runs/"+id, token, nil, &out)
	}
	return out, err
}
func (c *Client) Runs(ctx context.Context, installation, repository, workflow, since string) ([]Run, error) {
	if !repo.MatchString(repository) || !number.MatchString(workflow) {
		return nil, errors.New("Ungültiger Workflow")
	}
	token, err := c.Token(ctx, installation)
	if err != nil {
		return nil, err
	}
	out := []Run{}
	for page := 1; page <= 10; page++ {
		var result struct {
			Runs []Run `json:"workflow_runs"`
		}
		path := fmt.Sprintf("/repos/%s/actions/workflows/%s/runs?per_page=100&page=%d", repository, workflow, page)
		if since != "" {
			path += "&created=" + url.QueryEscape(since)
		}
		if err = c.request(ctx, "GET", path, token, nil, &result); err != nil {
			return nil, err
		}
		out = append(out, result.Runs...)
		if len(result.Runs) < 100 {
			return out, nil
		}
	}
	return nil, errors.New("Workflow-Abgleich benötigt eine engere Zeitgrenze")
}
func (c *Client) ReleaseArtifact(ctx context.Context, installation, repository, runID string) ([]byte, error) {
	if !repo.MatchString(repository) || !number.MatchString(runID) {
		return nil, errors.New("Ungültiger Workflow-Lauf")
	}
	token, err := c.Token(ctx, installation)
	if err != nil {
		return nil, err
	}
	var found int64
	for page := 1; page <= 10; page++ {
		var result struct {
			Artifacts []struct {
				ID      int64  `json:"id"`
				Name    string `json:"name"`
				Expired bool   `json:"expired"`
				Size    int64  `json:"size_in_bytes"`
			} `json:"artifacts"`
		}
		err = c.request(ctx, "GET", fmt.Sprintf("/repos/%s/actions/runs/%s/artifacts?per_page=100&page=%d", repository, runID, page), token, nil, &result)
		if err != nil {
			return nil, err
		}
		for _, artifact := range result.Artifacts {
			if artifact.Name == "unioci-release" && !artifact.Expired {
				if found != 0 {
					return nil, errors.New("Mehrere UniOCI-Release-Artefakte im selben Workflow-Lauf")
				}
				if artifact.Size > 1<<20 {
					return nil, errors.New("Release-Artefakt zu groß")
				}
				found = artifact.ID
			}
		}
		if len(result.Artifacts) < 100 {
			break
		}
	}
	if found == 0 {
		return nil, errors.New("Publish-Workflow enthält kein unioci-release-Artefakt")
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/repos/%s/actions/artifacts/%d/zip", c.BaseURL, repository, found), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "CUO/0.2.0")
	noRedirect := *c.HTTP
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := noRedirect.Do(req)
	if err != nil {
		return nil, errors.New("Artefakt-Download fehlgeschlagen")
	}
	if response.StatusCode == 302 {
		location := response.Header.Get("Location")
		response.Body.Close()
		u, e := url.Parse(location)
		if e != nil || u.Scheme != "https" || u.User != nil || !(strings.HasSuffix(u.Hostname(), ".githubusercontent.com") || strings.HasSuffix(u.Hostname(), ".blob.core.windows.net") || u.Hostname() == "results-receiver.actions.githubusercontent.com") {
			return nil, errors.New("GitHub-Artefakt-Redirect nicht zugelassen")
		}
		guard, e := unioci.New(unioci.Config{Host: "api.github.com", Endpoint: "https://api.github.com", Repositories: []string{"*"}, BlobHosts: []string{u.Host}}, unioci.Credentials{}, "")
		if e != nil {
			return nil, e
		}
		download, _ := http.NewRequestWithContext(ctx, "GET", location, nil)
		response, err = guard.HTTP.Do(download)
		if err != nil {
			return nil, errors.New("GitHub-Artefakt-Download fehlgeschlagen")
		}
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("Artefakt HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, errors.New("Release-Artefakt zu groß")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) != 1 {
		return nil, errors.New("Release-Artefakt muss genau unioci-release.json enthalten")
	}
	file := archive.File[0]
	if file.Name != "unioci-release.json" || !file.Mode().IsRegular() || file.UncompressedSize64 > 65536 {
		return nil, errors.New("Unsicherer Release-Archivinhalt")
	}
	in, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer in.Close()
	data, err = io.ReadAll(io.LimitReader(in, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("Release-Dokument zu groß oder beschädigt")
	}
	return data, nil
}

type ManifestResult struct {
	ID            int64  `json:"id"`
	Slug          string `json:"slug"`
	PEM           string `json:"pem"`
	WebhookSecret string `json:"webhook_secret"`
}

func ExchangeManifest(ctx context.Context, code string) (ManifestResult, error) {
	var result ManifestResult
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`).MatchString(code) {
		return result, errors.New("Ungültiger App-Registrierungscode")
	}
	guard, err := unioci.New(unioci.Config{Host: "api.github.com", Endpoint: "https://api.github.com", Repositories: []string{"*"}}, unioci.Credentials{}, "")
	if err != nil {
		return result, err
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.github.com/app-manifests/"+code+"/conversions", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "CUO/0.2.0")
	response, err := guard.HTTP.Do(req)
	if err != nil {
		return result, errors.New("GitHub-App-Registrierung nicht erreichbar")
	}
	defer response.Body.Close()
	if response.StatusCode != 201 {
		return result, fmt.Errorf("GitHub-App-Registrierung HTTP %d", response.StatusCode)
	}
	if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result) != nil || result.PEM == "" || len(result.WebhookSecret) < 16 {
		return ManifestResult{}, errors.New("Unvollständige App-Registrierung")
	}
	return result, nil
}

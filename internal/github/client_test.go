package github

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstallationTokenScopeExpiryAndRateLimit(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tokens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-GitHub-Api-Version") != "2026-03-10" {
			t.Error("missing API pin")
		}
		switch r.URL.Path {
		case "/app/installations/42":
			w.Write([]byte(`{"id":42,"app_id":1,"suspended_at":null}`))
		case "/app/installations/42/access_tokens":
			tokens++
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			permissions := body["permissions"].(map[string]any)
			if permissions["actions"] != "read" || permissions["metadata"] != "read" {
				t.Error(body)
			}
			json.NewEncoder(w).Encode(map[string]any{"token": "short-lived-installation", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
		case "/installation/repositories":
			if r.Header.Get("Authorization") != "Bearer short-lived-installation" {
				t.Error("wrong token")
			}
			w.Write([]byte(`{"repositories":[{"id":12,"full_name":"universal/app"}]}`))
		case "/app/installations/99":
			w.Write([]byte(`{"id":99,"app_id":2,"suspended_at":null}`))
		default:
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(429)
			w.Write([]byte(`{"message":"never echo secret"}`))
		}
	}))
	defer server.Close()
	c := &Client{AppID: "1", Key: key, HTTP: server.Client(), BaseURL: server.URL}
	for range 2 {
		repos, err := c.Repositories(context.Background(), "42")
		if err != nil || len(repos) != 1 {
			t.Fatal(repos, err)
		}
	}
	if tokens != 1 {
		t.Fatal("installation token cache", tokens)
	}
	if _, err := c.Installation(context.Background(), "99"); err == nil {
		t.Fatal("foreign app accepted")
	}
	_, err := c.App(context.Background())
	var limited *RateLimitError
	if !errors.As(err, &limited) || limited.RetryAt.Before(time.Now().Add(100*time.Second)) || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
}

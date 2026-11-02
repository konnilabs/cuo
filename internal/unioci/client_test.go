package unioci

import (
	"context"
	"encoding/json"
	"encoding/pem"
	digest "github.com/opencontainers/go-digest"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestReferencesAndScopes(t *testing.T) {
	dg := "sha256:" + strings.Repeat("a", 64)
	for _, test := range []struct{ ref, host, repo, selector string }{{"redis:7", "registry-1.docker.io", "library/redis", "7"}, {"localhost:5055/team/app:tag@" + dg, "localhost:5055", "team/app", dg}, {"ghcr.io/team/app@" + dg, "ghcr.io", "team/app", dg}, {"docker.io/redis", "registry-1.docker.io", "library/redis", "latest"}} {
		r, err := ParseReference(test.ref)
		if err != nil || r.Host != test.host || r.Repository != test.repo || r.Selector != test.selector {
			t.Fatal(test, r, err)
		}
	}
	for _, ref := range []string{"https://registry/app", "ghcr.io/../x", "a@sha256:no", "x?token=secret", "a:bad tag"} {
		if _, err := ParseReference(ref); err == nil {
			t.Fatal("accepted", ref)
		}
	}
	c := Config{Repositories: []string{"team/*", "other/exact"}}
	if !c.Allows("team/app") || c.Allows("teammate/app") || c.Allows("other/extra") {
		t.Fatal("scope escaped")
	}
}
func TestPrivateCAAuthPaginationAndManifest(t *testing.T) {
	manifest := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:` + strings.Repeat("b", 64) + `","size":1},"layers":[],"annotations":{"org.opencontainers.image.title":"fixture"}}`)
	dg := digest.FromBytes(manifest).String()
	pages := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "pull" || password != "fixture-private" {
			w.Header().Set("WWW-Authenticate", `Basic realm="registry"`)
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v2/" {
			w.Write([]byte("{}"))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/tags/list") {
			pages++
			if r.URL.Query().Get("last") == "" {
				w.Header().Set("Link", `</v2/team/app/tags/list?last=one&n=100>; rel="next"`)
				w.Write([]byte(`{"name":"team/app","tags":["one"]}`))
			} else {
				w.Write([]byte(`{"name":"team/app","tags":["two"]}`))
			}
			return
		}
		if strings.Contains(r.URL.Path, "/manifests/") {
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			w.Header().Set("Docker-Content-Digest", dg)
			w.Write(manifest)
			return
		}
		w.WriteHeader(404)
	}))
	defer server.Close()
	c := Config{Host: strings.TrimPrefix(server.URL, "https://"), Endpoint: server.URL, Repositories: []string{"team/*"}, PrivateNetwork: true, CAPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))}
	client, err := New(c, Credentials{"pull", "fixture-private"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = client.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	tags, err := client.Tags(context.Background(), "team/app", "")
	if err != nil || len(tags) != 2 || pages != 2 {
		t.Fatal(tags, pages, err)
	}
	artifact, err := client.Resolve(context.Background(), "team/app", "latest", "linux/amd64")
	if err != nil || artifact.Digest != dg || artifact.Annotations["org.opencontainers.image.title"] != "fixture" {
		t.Fatal(artifact, err)
	}
	bad, _ := New(c, Credentials{"pull", "wrong"}, "")
	if err = bad.Probe(context.Background()); err == nil || strings.Contains(err.Error(), "wrong") {
		t.Fatal("credential error", err)
	}
	c.PrivateNetwork = false
	guard, _ := New(c, Credentials{}, "")
	if guard.Probe(context.Background()) == nil {
		t.Fatal("accepted loopback without explicit permission")
	}
	c.PrivateNetwork = true
	c.CAPEM = ""
	guard, _ = New(c, Credentials{}, "")
	if guard.Probe(context.Background()) == nil {
		t.Fatal("accepted unknown CA")
	}
	data, _ := json.Marshal(artifact)
	if strings.Contains(string(data), "fixture-private") {
		t.Fatal("public artifact leaked credential")
	}
}
func TestEndpointAndRedirectGuard(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL+"/stolen", 302) }))
	defer source.Close()
	c := Config{Host: strings.TrimPrefix(source.URL, "http://"), Endpoint: source.URL, PrivateNetwork: true, Repositories: []string{"*"}}
	if _, err := New(c, Credentials{}, ""); err == nil {
		t.Fatal("browser HTTP bypass")
	}
	client, err := New(c, Credentials{"user", "private"}, source.URL)
	if err != nil {
		t.Fatal(err)
	}
	if client.Probe(context.Background()) == nil || hits != 0 {
		t.Fatal("redirect reached unauthorized host", hits)
	}
}

func TestReservedNetworksNeedExplicitPrivateEndpoint(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.1.2.3", "100.64.1.2", "198.18.1.1", "::1", "fd00::42"} {
		if !forbiddenAddress(netip.MustParseAddr(address), false) {
			t.Fatal("non-public endpoint admitted", address)
		}
	}
	for _, address := range []string{"169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1"} {
		if !forbiddenAddress(netip.MustParseAddr(address), true) {
			t.Fatal("metadata/invalid network admitted", address)
		}
	}
	if forbiddenAddress(netip.MustParseAddr("1.1.1.1"), false) || forbiddenAddress(netip.MustParseAddr("10.1.2.3"), true) {
		t.Fatal("valid endpoint blocked")
	}
}

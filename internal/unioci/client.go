// Package unioci implements CUO's provider-neutral OCI boundary over ORAS.
package unioci

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	digest "github.com/opencontainers/go-digest"
	oci "github.com/opencontainers/image-spec/specs-go/v1"
	"oras.land/oras-go/v2"
	"oras.land/oras-go/v2/registry"
	"oras.land/oras-go/v2/registry/remote"
	"oras.land/oras-go/v2/registry/remote/auth"
)

type Config struct {
	Host           string   `json:"host"`
	Endpoint       string   `json:"endpoint"`
	Repositories   []string `json:"repositories"`
	AuthHosts      []string `json:"authHosts"`
	BlobHosts      []string `json:"blobHosts"`
	CAPEM          string   `json:"caPEM"`
	PrivateNetwork bool     `json:"privateNetwork"`
}
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Access is transported only over the internal authenticated channel. It must
// never become a member of a journaled Operation or a persisted public record.
type Access struct {
	Config      Config      `json:"config"`
	Credentials Credentials `json:"credentials"`
	Expires     int64       `json:"expires"`
}
type Reference struct{ Host, Repository, Selector string }
type Artifact struct {
	Reference    string            `json:"reference"`
	Digest       string            `json:"digest"`
	ConfigDigest string            `json:"configDigest"`
	MediaType    string            `json:"mediaType"`
	Size         int64             `json:"size"`
	Platforms    []string          `json:"platforms"`
	Referrers    []oci.Descriptor  `json:"referrers"`
	Annotations  map[string]string `json:"annotations,omitempty"`
}
type Client struct {
	Config   Config
	HTTP     *http.Client
	auth     *auth.Client
	endpoint *url.URL
}

var repoPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)

func ParseReference(value string) (Reference, error) {
	if strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n ?#\\") || strings.Contains(value, "://") || len(value) > 1024 {
		return Reference{}, errors.New("invalid OCI reference")
	}
	parts := strings.SplitN(value, "/", 2)
	host := "registry-1.docker.io"
	repository := value
	if len(parts) == 2 && (strings.ContainsAny(parts[0], ".:") || parts[0] == "localhost") {
		host = parts[0]
		repository = parts[1]
	}
	if host == "docker.io" || host == "index.docker.io" {
		host = "registry-1.docker.io"
	}
	selector := "latest"
	if i := strings.LastIndex(repository, "@"); i >= 0 {
		selector = repository[i+1:]
		repository = repository[:i]
		if err := digest.Digest(selector).Validate(); err != nil || !strings.HasPrefix(selector, "sha256:") {
			return Reference{}, errors.New("invalid OCI digest")
		}
		if i := strings.LastIndex(repository, ":"); i > strings.LastIndex(repository, "/") {
			repository = repository[:i]
		}
	} else if i := strings.LastIndex(repository, ":"); i > strings.LastIndex(repository, "/") {
		selector = repository[i+1:]
		repository = repository[:i]
	}
	if host == "registry-1.docker.io" && !strings.Contains(repository, "/") {
		repository = "library/" + repository
	}
	if !repoPattern.MatchString(repository) || strings.Contains(repository, "..") || selector == "" {
		return Reference{}, errors.New("invalid OCI repository")
	}
	if _, err := registry.ParseReference(host + "/" + repository + ":" + selector); err != nil && !strings.HasPrefix(selector, "sha256:") {
		return Reference{}, errors.New("invalid OCI selector")
	}
	u, err := url.Parse("https://" + host)
	if err != nil || u.Host != host || u.Hostname() == "" || u.User != nil || u.Path != "" {
		return Reference{}, errors.New("invalid registry host")
	}
	return Reference{Host: host, Repository: repository, Selector: selector}, nil
}

func (c Config) Allows(repo string) bool {
	for _, allowed := range c.Repositories {
		if allowed == "*" || allowed == repo || strings.HasSuffix(allowed, "/*") && strings.HasPrefix(repo, strings.TrimSuffix(allowed, "*")) {
			return true
		}
	}
	return false
}

// trustedHTTP is an installation-controlled endpoint, never a browser flag.
func New(c Config, credential Credentials, trustedHTTP string) (*Client, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return nil, errors.New("registry endpoint must be an origin without credentials or path")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || c.Endpoint != trustedHTTP) {
		return nil, errors.New("registry endpoint requires HTTPS; only the installation-owned local Zot endpoint may use isolated HTTP")
	}
	ref, err := ParseReference(c.Host + "/probe:latest")
	if err != nil || ref.Host != c.Host {
		return nil, errors.New("invalid canonical registry host")
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if c.CAPEM != "" && !pool.AppendCertsFromPEM([]byte(c.CAPEM)) {
		return nil, errors.New("invalid registry CA certificate")
	}
	allowed := map[string]bool{u.Host: true}
	authHosts := map[string]bool{u.Host: true}
	for _, h := range c.AuthHosts {
		allowed[h] = true
		authHosts[h] = true
	}
	for _, h := range c.BlobHosts {
		allowed[h] = true
	}
	for h := range allowed {
		v, e := url.Parse("https://" + h)
		if e != nil || v.Host != h || v.Hostname() == "" || v.User != nil || v.Path != "" {
			return nil, errors.New("invalid registry auxiliary host")
		}
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, ResponseHeaderTimeout: 20 * time.Second, MaxIdleConns: 8, IdleConnTimeout: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if e != nil {
			return nil, errors.New("registry DNS lookup failed")
		}
		for _, ip := range ips {
			ip = ip.Unmap()
			if forbiddenAddress(ip, c.PrivateNetwork) {
				return nil, errors.New("registry resolved to a forbidden network")
			}
		}
		for _, ip := range ips {
			conn, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
		}
		return nil, errors.New("registry connection failed")
	}
	guard := roundTripper(func(req *http.Request) (*http.Response, error) {
		if !allowed[req.URL.Host] || req.URL.User != nil || req.URL.Scheme != "https" && !(req.URL.Scheme == u.Scheme && req.URL.Host == u.Host && c.Endpoint == trustedHTTP) {
			return nil, errors.New("registry endpoint or redirect host not authorized")
		}
		if !authHosts[req.URL.Host] {
			req.Header.Del("Authorization")
		}
		return transport.RoundTrip(req)
	})
	httpClient := &http.Client{Timeout: 2 * time.Minute, Transport: guard, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("too many registry redirects")
		}
		if !allowed[req.URL.Host] {
			return errors.New("registry redirect not authorized")
		}
		if req.URL.Host != via[0].URL.Host {
			req.Header.Del("Authorization")
		}
		return nil
	}}
	a := &auth.Client{Client: httpClient, Cache: auth.NewCache(), Credential: func(_ context.Context, host string) (auth.Credential, error) {
		if host != u.Host {
			return auth.EmptyCredential, nil
		}
		return auth.Credential{Username: credential.Username, Password: credential.Password}, nil
	}}
	if c.PrivateNetwork {
		a.BlockedRealmPrefixes = []netip.Prefix{}
	}
	return &Client{Config: c, HTTP: httpClient, auth: a, endpoint: u}, nil
}

func forbiddenAddress(ip netip.Addr, privateAllowed bool) bool {
	ip = ip.Unmap()
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	if privateAllowed {
		return false
	}
	if ip.IsPrivate() || ip.IsLoopback() || !ip.IsGlobalUnicast() {
		return true
	}
	for _, value := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "fec0::/10", "2001:db8::/32"} {
		if netip.MustParsePrefix(value).Contains(ip) {
			return true
		}
	}
	return false
}

type roundTripper func(*http.Request) (*http.Response, error)

func (r roundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return r(req) }

func (c *Client) Repository(name string) (*remote.Repository, error) {
	if !repoPattern.MatchString(name) || !c.Config.Allows(name) {
		return nil, errors.New("repository is outside the connection scope")
	}
	r, err := remote.NewRepository(c.endpoint.Host + "/" + name)
	if err != nil {
		return nil, err
	}
	r.Client = c.auth
	r.PlainHTTP = c.endpoint.Scheme == "http"
	r.TagListPageSize = 100
	r.TagListMaxPages = 20
	r.ReferrerListMaxPages = 10
	r.MaxMetadataBytes = 4 << 20
	return r, nil
}
func (c *Client) Probe(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", c.Config.Endpoint+"/v2/", nil)
	r, err := c.auth.Do(req)
	if err != nil {
		return errors.New("registry probe failed: endpoint, TLS or credentials")
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("registry probe HTTP %d", r.StatusCode)
	}
	return nil
}
func (c *Client) Tags(ctx context.Context, repo, last string) ([]string, error) {
	r, err := c.Repository(repo)
	if err != nil {
		return nil, err
	}
	out := []string{}
	err = r.Tags(ctx, last, func(tags []string) error {
		out = append(out, tags...)
		if len(out) > 2000 {
			return errors.New("tag list exceeds 2000 entries; narrow the repository")
		}
		return nil
	})
	if err != nil {
		return nil, errors.New("registry tag query failed")
	}
	return out, nil
}
func (c *Client) Catalog(ctx context.Context) ([]string, error) {
	r, err := remote.NewRegistry(c.endpoint.Host)
	if err != nil {
		return nil, err
	}
	r.Client = c.auth
	r.PlainHTTP = c.endpoint.Scheme == "http"
	r.RepositoryListPageSize = 100
	r.MaxMetadataBytes = 4 << 20
	out := []string{}
	pages := 0
	err = r.Repositories(ctx, "", func(repos []string) error {
		pages++
		if pages > 20 {
			return errors.New("catalog limit")
		}
		for _, repo := range repos {
			if c.Config.Allows(repo) {
				out = append(out, repo)
			}
		}
		return nil
	})
	if err != nil {
		return nil, errors.New("provider does not expose an accessible repository catalog; configure repositories explicitly")
	}
	return out, nil
}
func readManifest(ctx context.Context, r *remote.Repository, selector string) (oci.Descriptor, []byte, error) {
	d, body, err := r.FetchReference(ctx, selector)
	if err != nil {
		return d, nil, errors.New("registry manifest unavailable or credentials rejected")
	}
	defer body.Close()
	if d.Size < 0 || d.Size > 4<<20 {
		return d, nil, errors.New("manifest exceeds size limit")
	}
	data, err := io.ReadAll(io.LimitReader(body, (4<<20)+1))
	if err != nil || len(data) > 4<<20 || digest.FromBytes(data) != d.Digest {
		return d, nil, errors.New("manifest content digest mismatch")
	}
	return d, data, nil
}
func (c *Client) Resolve(ctx context.Context, repo, selector, platform string) (Artifact, error) {
	r, err := c.Repository(repo)
	if err != nil {
		return Artifact{}, err
	}
	d, data, err := readManifest(ctx, r, selector)
	if err != nil {
		return Artifact{}, err
	}
	out := Artifact{Reference: c.Config.Host + "/" + repo, Digest: d.Digest.String(), MediaType: d.MediaType, Size: d.Size, Platforms: []string{}, Referrers: []oci.Descriptor{}}
	var index oci.Index
	if json.Unmarshal(data, &index) != nil {
		return out, errors.New("invalid OCI manifest")
	}
	out.Annotations = index.Annotations
	if len(index.Manifests) > 0 {
		var selected *oci.Descriptor
		for _, m := range index.Manifests {
			if m.Platform == nil {
				continue
			}
			p := m.Platform.OS + "/" + m.Platform.Architecture
			if m.Platform.Variant != "" {
				p += "/" + m.Platform.Variant
			}
			out.Platforms = append(out.Platforms, p)
			if p == platform {
				v := m
				selected = &v
			}
		}
		if platform == "" {
			return out, nil
		}
		if selected == nil {
			return out, errors.New("no manifest for requested platform")
		}
		d, data, err = readManifest(ctx, r, selected.Digest.String())
		if err != nil || d.Digest != selected.Digest {
			return out, errors.New("platform manifest mismatch")
		}
		out.Digest = d.Digest.String()
		out.MediaType = d.MediaType
		out.Size = d.Size
	}
	var manifest oci.Manifest
	if json.Unmarshal(data, &manifest) != nil {
		return out, errors.New("invalid image manifest")
	}
	if manifest.Annotations != nil {
		out.Annotations = manifest.Annotations
	}
	out.ConfigDigest = manifest.Config.Digest.String()
	if platform != "" && manifest.Config.MediaType != "application/vnd.oci.image.config.v1+json" && manifest.Config.MediaType != "application/vnd.docker.container.image.v1+json" {
		return out, errors.New("artifact is not a runnable container image")
	}
	return out, nil
}
func (c *Client) Referrers(ctx context.Context, repo, dg string) ([]oci.Descriptor, error) {
	r, err := c.Repository(repo)
	if err != nil {
		return nil, err
	}
	d, err := r.Resolve(ctx, dg)
	if err != nil {
		return nil, errors.New("artifact unavailable")
	}
	out := []oci.Descriptor{}
	err = r.Referrers(ctx, d, "", func(items []oci.Descriptor) error {
		out = append(out, items...)
		if len(out) > 1000 {
			return errors.New("too many referrers")
		}
		return nil
	})
	if err != nil {
		return nil, errors.New("referrers unavailable")
	}
	return out, nil
}
func CopyByDigest(ctx context.Context, src *Client, srcRepo, dg string, dst *Client, dstRepo string) error {
	if err := digest.Digest(dg).Validate(); err != nil {
		return errors.New("copy requires an immutable digest")
	}
	s, err := src.Repository(srcRepo)
	if err != nil {
		return err
	}
	d, err := dst.Repository(dstRepo)
	if err != nil {
		return err
	}
	opts := oras.DefaultCopyOptions
	opts.Concurrency = 2
	// One worker, bounded transfers and no local blob staging. Count unique
	// descriptors across the image and its referrers before each transfer.
	var budgetMu sync.Mutex
	seen := map[digest.Digest]bool{}
	var bytes int64
	opts.PreCopy = func(_ context.Context, desc oci.Descriptor) error {
		budgetMu.Lock()
		defer budgetMu.Unlock()
		if seen[desc.Digest] {
			return nil
		}
		if desc.Size < 0 || desc.Size > 2<<30 || bytes+desc.Size > 2<<30 || len(seen) >= 10000 {
			return errors.New("OCI import exceeds 2 GiB / 10000 descriptor budget")
		}
		seen[desc.Digest] = true
		bytes += desc.Size
		return nil
	}
	if _, err = oras.Copy(ctx, s, dg, d, dg, opts); err != nil {
		return errors.New("OCI copy failed; verify source read and destination push permissions")
	}
	refs, err := src.Referrers(ctx, srcRepo, dg)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if _, err = oras.Copy(ctx, s, ref.Digest.String(), d, ref.Digest.String(), opts); err != nil {
			return errors.New("copy of OCI reference artifact failed")
		}
	}
	resolved, err := d.Resolve(ctx, dg)
	if err != nil || resolved.Digest.String() != dg {
		return errors.New("destination digest verification failed")
	}
	return nil
}

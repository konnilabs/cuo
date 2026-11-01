package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var digestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var repoRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*$`)

type Manifest struct {
	MediaType string `json:"mediaType"`
	Config    struct {
		Digest string `json:"digest"`
	} `json:"config"`
	Manifests []struct {
		Digest   string `json:"digest"`
		Platform struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
			Variant      string `json:"variant"`
		} `json:"platform"`
	} `json:"manifests"`
}

func splitRef(ref string) (host, repo, tag string, err error) {
	if strings.ContainsAny(ref, "\r\n ?#\\") {
		err = errors.New("invalid image reference")
		return
	}
	parts := strings.SplitN(ref, "/", 2)
	host = "registry-1.docker.io"
	repo = ref
	if len(parts) > 1 && (strings.ContainsAny(parts[0], ".:") || parts[0] == "localhost") {
		host = parts[0]
		repo = parts[1]
	}
	if host == "docker.io" || host == "index.docker.io" {
		host = "registry-1.docker.io"
	}
	tag = "latest"
	if i := strings.LastIndex(repo, "@"); i >= 0 {
		tag = repo[i+1:]
		repo = repo[:i]
	} else if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
		tag = repo[i+1:]
		repo = repo[:i]
	}
	if host == "registry-1.docker.io" && !strings.Contains(repo, "/") {
		repo = "library/" + repo
	}
	allowed := host == "registry-1.docker.io" || host == "ghcr.io" || host == "quay.io"
	for _, v := range strings.Split(os.Getenv("CUO_REGISTRIES"), ",") {
		allowed = allowed || v != "" && host == v
	}
	if !allowed {
		err = errors.New("registry not allowlisted (CUO_REGISTRIES)")
	}
	if strings.Contains(repo, "..") || !repoRE.MatchString(repo) || tag == "" || len(tag) > 180 {
		err = errors.New("invalid repository or tag")
	}
	return
}
func RegistryManifest(ctx context.Context, ref, platform string) (digest, config string, err error) {
	host, repo, tag, e := splitRef(ref)
	if e != nil {
		return "", "", e
	}
	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	token := ""
	get := func(tag string) (Manifest, string, error) {
		var m Manifest
		endpoint := "https://" + host + "/v2/" + repo + "/manifests/" + url.PathEscape(tag)
		for attempt := 0; attempt < 2; attempt++ {
			req, e := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
			if e != nil {
				return m, "", e
			}
			req.Header.Set("Accept", "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			r, e := client.Do(req)
			if e != nil {
				return m, "", e
			}
			if r.StatusCode == 401 && attempt == 0 {
				challenge := r.Header.Get("WWW-Authenticate")
				r.Body.Close()
				if !strings.HasPrefix(strings.ToLower(challenge), "bearer ") {
					return m, "", errors.New("registry requires supported credentials")
				}
				params := map[string]string{}
				for _, p := range strings.Split(challenge[7:], ",") {
					v := strings.SplitN(strings.TrimSpace(p), "=", 2)
					if len(v) == 2 {
						params[v[0]] = strings.Trim(v[1], `"`)
					}
				}
				realm, e := url.Parse(params["realm"])
				if e != nil || realm.Scheme != "https" {
					return m, "", errors.New("unsafe registry auth realm")
				}
				if !(realm.Host == host || host == "registry-1.docker.io" && realm.Host == "auth.docker.io") {
					return m, "", errors.New("untrusted registry auth host")
				}
				q := realm.Query()
				q.Set("service", params["service"])
				q.Set("scope", "repository:"+repo+":pull")
				realm.RawQuery = q.Encode()
				tr, e := http.NewRequestWithContext(ctx, "GET", realm.String(), nil)
				if e != nil {
					return m, "", e
				}
				response, e := client.Do(tr)
				if e != nil {
					return m, "", e
				}
				var auth struct {
					Token       string `json:"token"`
					AccessToken string `json:"access_token"`
				}
				e = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&auth)
				response.Body.Close()
				if e != nil {
					return m, "", e
				}
				token = auth.Token
				if token == "" {
					token = auth.AccessToken
				}
				continue
			}
			defer r.Body.Close()
			if r.StatusCode != 200 {
				return m, "", fmt.Errorf("registry HTTP %d", r.StatusCode)
			}
			e = json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&m)
			dg := r.Header.Get("Docker-Content-Digest")
			if !digestRE.MatchString(dg) {
				return m, "", errors.New("registry digest missing")
			}
			return m, dg, e
		}
		return m, "", errors.New("registry authentication failed")
	}
	m, digest, e := get(tag)
	if e != nil {
		return "", "", e
	}
	if len(m.Manifests) > 0 {
		parts := strings.Split(platform, "/")
		if len(parts) < 2 {
			return "", "", errors.New("platform required")
		}
		found := ""
		for _, v := range m.Manifests {
			if v.Platform.OS == parts[0] && v.Platform.Architecture == parts[1] && (len(parts) < 3 || v.Platform.Variant == parts[2]) {
				found = v.Digest
				break
			}
		}
		if !digestRE.MatchString(found) {
			return "", "", errors.New("no manifest for host platform")
		}
		m, digest, e = get(found)
		if e != nil {
			return "", "", e
		}
		if digest != found {
			return "", "", errors.New("registry manifest digest changed")
		}
	}
	if !digestRE.MatchString(m.Config.Digest) {
		return "", "", errors.New("manifest config digest missing")
	}
	return digest, m.Config.Digest, nil
}
func pinned(ref, digest string) (string, error) {
	h, r, _, e := splitRef(ref)
	if e != nil {
		return "", e
	}
	if !digestRE.MatchString(digest) {
		return "", errors.New("invalid target digest")
	}
	return h + "/" + r + "@" + digest, nil
}

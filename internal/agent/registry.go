package agent

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
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
		if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
			repo = repo[:i]
		}
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
	return registryManifestAccess(ctx, ref, platform, nil)
}

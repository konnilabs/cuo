package agent

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"cuo.local/cuo/internal/unioci"
)

func registryManifestAccess(ctx context.Context, image, platform string, access *unioci.Access) (string, string, error) {
	ref, err := unioci.ParseReference(image)
	if err != nil {
		return "", "", err
	}
	if access == nil {
		if _, _, _, err = splitRef(image); err != nil {
			return "", "", err
		}
		config := unioci.Config{Host: ref.Host, Endpoint: "https://" + ref.Host, Repositories: []string{ref.Repository}}
		if ref.Host == "registry-1.docker.io" {
			config.AuthHosts = []string{"auth.docker.io"}
		}
		access = &unioci.Access{Config: config}
	} else if access.Config.Host != ref.Host || !access.Config.Allows(ref.Repository) {
		return "", "", errors.New("registry credential scope does not match the requested image")
	}
	client, err := unioci.New(access.Config, access.Credentials, os.Getenv("CUO_ZOT_INTERNAL_URL"))
	if err != nil {
		return "", "", err
	}
	artifact, err := client.Resolve(ctx, ref.Repository, ref.Selector, platform)
	if err != nil {
		return "", "", err
	}
	return artifact.Digest, artifact.ConfigDigest, nil
}
func validAccess(access *unioci.Access, image string) bool {
	if access == nil {
		return true
	}
	if access.Expires < time.Now().Unix() || access.Expires > time.Now().Add(5*time.Minute).Unix() {
		return false
	}
	ref, err := unioci.ParseReference(image)
	if err != nil || access.Config.Host != ref.Host || !access.Config.Allows(ref.Repository) {
		return false
	}
	if strings.HasPrefix(access.Config.Endpoint, "http:") && access.Config.Host != os.Getenv("CUO_ZOT_HOST") {
		return false
	}
	_, err = unioci.New(access.Config, access.Credentials, os.Getenv("CUO_ZOT_INTERNAL_URL"))
	return err == nil
}

func pinned(ref, dg string) (string, error) {
	r, err := unioci.ParseReference(ref)
	if err != nil {
		return "", err
	}
	if !digestRE.MatchString(dg) {
		return "", errors.New("invalid target digest")
	}
	return r.Host + "/" + r.Repository + "@" + dg, nil
}

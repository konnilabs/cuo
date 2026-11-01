package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Docker struct {
	HTTP    *http.Client
	Version string
}

func NewDocker() *Docker {
	socket := os.Getenv("CUO_DOCKER_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	return &Docker{HTTP: &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}, Timeout: 10 * time.Minute}}
}
func (d *Docker) Request(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(marshal(body)))
	}
	req, e := http.NewRequestWithContext(ctx, method, "http://docker"+path, reader)
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	r, e := d.HTTP.Do(req)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(r.Body, 4096))
		return fmt.Errorf("docker %s %s: HTTP %d", method, strings.Split(path, "?")[0], r.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(out)
	}
	_, e = io.Copy(io.Discard, r.Body)
	return e
}
func (d *Docker) Path(path string) string { return d.Version + path }
func (d *Docker) Init(ctx context.Context) error {
	var v struct{ APIVersion string }
	if e := d.Request(ctx, "GET", "/version", nil, &v); e != nil {
		return e
	}
	if v.APIVersion == "" {
		return errors.New("Docker API version missing")
	}
	d.Version = "/v" + v.APIVersion
	return nil
}
func (d *Docker) Inspect(ctx context.Context, id string) (map[string]any, error) {
	m := map[string]any{}
	e := d.Request(ctx, "GET", d.Path("/containers/"+url.PathEscape(id)+"/json"), nil, &m)
	return m, e
}
func obj(m map[string]any, k string) map[string]any {
	v, _ := m[k].(map[string]any)
	if v == nil {
		return map[string]any{}
	}
	return v
}
func str(m map[string]any, k string) string   { s, _ := m[k].(string); return s }
func boolean(m map[string]any, k string) bool { b, _ := m[k].(bool); return b }
func marshal(v any) []byte                    { b, _ := json.Marshal(v); return b }

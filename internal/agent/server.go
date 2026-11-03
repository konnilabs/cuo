package agent

import (
	"context"
	"crypto/subtle"
	"cuo.local/cuo/internal/core"
	"cuo.local/cuo/internal/unioci"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Agent struct {
	Docker   *Docker
	Token    string
	Mu       sync.Mutex
	Dir      string
	Active   map[string]bool
	Projects sync.Map
}
type Operation struct {
	JobID       string                    `json:"jobId"`
	ContainerID string                    `json:"containerId"`
	Source      string                    `json:"sourceDigest"`
	Target      string                    `json:"targetDigest"`
	Image       string                    `json:"image"`
	TargetImage string                    `json:"targetImage,omitempty"`
	Platform    string                    `json:"platform"`
	Permissions core.ExecutionPermissions `json:"permissions,omitempty"`
}
type Frame struct {
	Stage   string `json:"stage"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`
	NewID   string `json:"newId,omitempty"`
}

var idRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var jobRE = regexp.MustCompile(`^[a-f0-9]{32}$`)

func Run() error {
	token := os.Getenv("CUO_AGENT_TOKEN")
	if len(token) < 32 {
		return errors.New("CUO_AGENT_TOKEN must have at least 32 characters")
	}
	dir := os.Getenv("CUO_DATA")
	if dir == "" {
		dir = "/data"
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	a := &Agent{Docker: NewDocker(), Token: token, Dir: dir}
	if e := a.Docker.Init(context.Background()); e != nil {
		return e
	}
	addr := os.Getenv("CUO_LISTEN")
	if addr == "" {
		addr = ":8092"
	}
	return (&http.Server{Addr: addr, Handler: a, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}).ListenAndServe()
}
func (a *Agent) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/health" {
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+a.Token)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/registry-info":
		var containers []map[string]any
		if a.Docker.Request(r.Context(), "GET", a.Docker.Path("/containers/json?all=1"), nil, &containers) != nil {
			http.Error(w, "Docker unavailable", 502)
			return
		}
		volume := ""
		for _, container := range containers {
			labels := obj(container, "Labels")
			if str(labels, "cuo.registry") != "integrated" || str(labels, "cuo.system") != "true" {
				continue
			}
			for _, entry := range asArray(container["Mounts"]) {
				mount, _ := entry.(map[string]any)
				if str(mount, "Destination") == "/var/lib/registry" && str(mount, "Type") == "volume" {
					volume = str(mount, "Name")
				}
			}
		}
		if volume == "" {
			http.Error(w, "Integrated registry volume unavailable", 404)
			return
		}
		var usage map[string]any
		if a.Docker.Request(r.Context(), "GET", a.Docker.Path("/system/df"), nil, &usage) != nil {
			http.Error(w, "Volume usage unavailable", 502)
			return
		}
		for _, entry := range asArray(usage["Volumes"]) {
			v, _ := entry.(map[string]any)
			if str(v, "Name") == volume {
				json.NewEncoder(w).Encode(map[string]any{"volume": volume, "usage": obj(v, "UsageData"), "automaticDeletion": false})
				return
			}
		}
		http.Error(w, "Volume usage unavailable", 404)
	case r.Method == "GET" && r.URL.Path == "/info":
		info := map[string]any{}
		if err := a.Docker.Request(r.Context(), "GET", "/version", nil, &info); err != nil {
			http.Error(w, "Docker unavailable", 502)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"connected": true, "dockerVersion": str(info, "Version"), "apiVersion": str(info, "ApiVersion")})
	case r.Method == "GET" && r.URL.Path == "/inventory":
		v, e := a.Inventory(r.Context())
		if e != nil {
			http.Error(w, "Docker inventory unavailable", 502)
			return
		}
		json.NewEncoder(w).Encode(v)
	case r.Method == "POST" && r.URL.Path == "/scan":
		var input struct {
			core.Container
			Registry *unioci.Access `json:"registry,omitempty"`
		}
		if e := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&input); e != nil || !idRE.MatchString(input.ID) {
			http.Error(w, "invalid container", 400)
			return
		}
		c := input.Container
		inspect, e := a.Docker.Inspect(r.Context(), c.EngineID)
		if e != nil {
			http.Error(w, "container unavailable", 404)
			return
		}
		image := str(obj(inspect, "Config"), "Image")
		if !validAccess(input.Registry, image) {
			http.Error(w, "invalid registry access envelope", 400)
			return
		}
		dg, config, e := registryManifestAccess(r.Context(), image, c.Platform, input.Registry)
		out := core.Candidate{ContainerID: c.ID, Source: str(inspect, "Image"), Target: dg, Ref: image, Platform: c.Platform, Discovered: time.Now().UTC().Format(time.RFC3339)}
		if e != nil {
			out.Error = e.Error()
		} else if config == out.Source {
			out.Target = ""
		}
		json.NewEncoder(w).Encode(out)
	case r.Method == "POST" && r.URL.Path == "/execute":
		var input struct {
			Operation
			Registry *unioci.Access `json:"registry,omitempty"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if e := decoder.Decode(&input); e != nil || !jobRE.MatchString(input.JobID) || !idRE.MatchString(input.ContainerID) || !digestRE.MatchString(input.Target) || !digestRE.MatchString(input.Source) {
			http.Error(w, "invalid operation", 400)
			return
		}
		op := input.Operation
		targetImage := op.Image
		if op.TargetImage != "" {
			targetImage = op.TargetImage
		}
		if !validAccess(input.Registry, targetImage) {
			http.Error(w, "invalid registry access envelope", 400)
			return
		}
		if !a.reserve(op) {
			http.Error(w, "agent busy", 409)
			return
		}
		defer a.release(op)
		a.executeWithRegistry(w, op, input.Registry)
	default:
		http.NotFound(w, r)
	}
}
func (a *Agent) Inventory(ctx context.Context) ([]core.Container, error) {
	var list []map[string]any
	if e := a.Docker.Request(ctx, "GET", a.Docker.Path("/containers/json?all=1"), nil, &list); e != nil {
		return nil, e
	}
	out := []core.Container{}
	for _, v := range list {
		inspect, err := a.Docker.Inspect(ctx, str(v, "Id"))
		if err != nil {
			return nil, err
		}
		config := obj(inspect, "Config")
		labels := obj(config, "Labels")
		name := strings.TrimPrefix(str(inspect, "Name"), "/")
		if names, ok := v["Names"].([]any); name == "" && ok && len(names) > 0 {
			name = strings.TrimPrefix(fmt.Sprint(names[0]), "/")
		}
		c := core.Container{ID: str(v, "Id"), EngineID: str(v, "Id"), HostID: "local", Name: name, Image: str(config, "Image"), ImageID: str(inspect, "Image"), State: str(obj(inspect, "State"), "Status"), Group: str(labels, "com.docker.compose.project"), Compose: str(labels, "com.docker.compose.project") != "", Managed: str(labels, "cuo.managed") == "true", Platform: "linux/amd64"}
		im := map[string]any{}
		if e := a.Docker.Request(ctx, "GET", a.Docker.Path("/images/"+c.ImageID+"/json"), nil, &im); e == nil {
			if digests, ok := im["RepoDigests"].([]any); ok && len(digests) == 0 {
				c.LocalImage = true
			}
			c.Platform = str(im, "Os") + "/" + str(im, "Architecture")
			if variant := str(im, "Variant"); variant != "" {
				c.Platform += "/" + variant
			}
		}
		if c.Group == "" {
			c.Group = "Standalone"
		}
		if regexp.MustCompile(`-cuo-[a-f0-9]{8}$`).MatchString(name) {
			c.Managed = false
			c.Reason = "Aufbewahrter Vorgänger für manuelle Wiederherstellung"
		}
		if str(labels, "cuo.system") == "true" {
			c.Managed = false
			c.Reason = "CUO-Systemdienst"
		}
		if !c.Managed && c.Reason == "" {
			c.Reason = "Updates benötigen das Label cuo.managed=true"
		}
		out = append(out, c)
	}
	return out, nil
}
func (a *Agent) journal(op Operation, f Frame) error {
	tmp := filepath.Join(a.Dir, op.JobID+".tmp")
	b := marshal(map[string]any{"operation": op, "frame": f, "time": time.Now().UTC()})
	if e := os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	file, e := os.OpenFile(tmp, os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	e = file.Sync()
	file.Close()
	if e != nil {
		return e
	}
	if err := os.Rename(tmp, filepath.Join(a.Dir, op.JobID+".json")); err != nil {
		return err
	}
	directory, err := os.Open(a.Dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

package agent

import (
	"bufio"
	"context"
	"cuo.local/cuo/internal/watchtower"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$`)

func (a *Agent) Execute(w http.ResponseWriter, op Operation) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	emit := func(stage, msg string) error {
		f := Frame{Stage: stage, Message: msg}
		if e := a.journal(op, f); e != nil {
			return e
		}
		_ = enc.Encode(f)
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	fail := func(e error, disrupted bool) {
		stage := "failed"
		if disrupted {
			stage = "intervention_required"
		}
		f := Frame{Stage: stage, Message: e.Error(), Error: e.Error()}
		_ = a.journal(op, f)
		_ = enc.Encode(f)
		if flusher != nil {
			flusher.Flush()
		}
	}
	path := filepath.Join(a.Dir, op.JobID+".json")
	if data, e := os.ReadFile(path); e == nil {
		var saved struct {
			Frame Frame `json:"frame"`
		}
		if json.Unmarshal(data, &saved) == nil && saved.Frame.Stage == "succeeded" {
			_ = enc.Encode(saved.Frame)
		} else {
			_ = enc.Encode(Frame{Stage: "intervention_required", Error: "Existing operation journal; automatic re-execution refused", Message: "Inspect persisted agent journal"})
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	if e := emit("preflight", "Prüfe Freigabe, Plattform und Container-Konfiguration"); e != nil {
		fail(e, false)
		return
	}
	current, e := a.Docker.Inspect(ctx, op.ContainerID)
	if e != nil {
		fail(e, false)
		return
	}
	config := obj(current, "Config")
	host := obj(current, "HostConfig")
	labels := obj(config, "Labels")
	// Compose desired-state pins and reconciliation are shared by the project.
	// Serialize its services; unrelated projects and standalone containers can run concurrently.
	if project := str(labels, "com.docker.compose.project"); project != "" {
		unlock, err := a.projectLock(ctx, project)
		if err != nil {
			fail(err, false)
			return
		}
		defer unlock()
	}
	if str(labels, "cuo.managed") != "true" || str(labels, "cuo.system") == "true" {
		fail(errors.New("Container is not explicitly managed by CUO"), false)
		return
	}
	if str(current, "Image") != op.Source || str(config, "Image") != op.Image {
		fail(errors.New("Container changed since scan; scan again"), false)
		return
	}
	if boolean(host, "Privileged") || len(asArray(host["CapAdd"])) > 0 || len(asArray(host["Devices"])) > 0 || str(host, "PidMode") == "host" || str(host, "IpcMode") == "host" || boolean(host, "AutoRemove") || str(host, "NetworkMode") == "host" || str(host, "NetworkMode") == "container:"+op.ContainerID {
		fail(errors.New("Privileged, host-network or auto-remove containers require manual updates"), false)
		return
	}
	mounts, _ := current["Mounts"].([]any)
	for _, m := range mounts {
		mm, _ := m.(map[string]any)
		if controlMount(mm) {
			fail(errors.New("Host control mounts require manual updates"), false)
			return
		}
	}
	if !boolean(obj(current, "State"), "Running") {
		fail(errors.New("Only running containers can be updated"), false)
		return
	}
	oldImage := map[string]any{}
	if e = a.Docker.Request(ctx, "GET", a.Docker.Path("/images/"+op.Source+"/json"), nil, &oldImage); e != nil {
		fail(e, false)
		return
	}
	platform := str(oldImage, "Os") + "/" + str(oldImage, "Architecture")
	if variant := str(oldImage, "Variant"); variant != "" {
		platform += "/" + variant
	}
	if platform != op.Platform {
		fail(errors.New("Platform changed since scan"), false)
		return
	}
	pin, e := pinned(op.Image, op.Target)
	if e != nil {
		fail(e, false)
		return
	}
	if e = emit("pulling", "Lade freigegebenes Image anhand des Plattform-Digests"); e != nil {
		fail(e, false)
		return
	}
	if e = a.pull(ctx, pin, op.Platform); e != nil {
		fail(e, false)
		return
	}
	// The content-addressed target must still match the registry manifest for this platform.
	targetImage := map[string]any{}
	if e = a.Docker.Request(ctx, "GET", a.Docker.Path("/images/"+url.PathEscape(pin)+"/json"), nil, &targetImage); e != nil {
		fail(e, false)
		return
	}
	if str(targetImage, "Os")+"/"+str(targetImage, "Architecture") != str(oldImage, "Os")+"/"+str(oldImage, "Architecture") {
		fail(errors.New("Target platform mismatch"), false)
		return
	}
	latest, e := a.Docker.Inspect(ctx, op.ContainerID)
	if e != nil || str(latest, "Image") != op.Source || string(marshal(obj(latest, "Config"))) != string(marshal(config)) || string(marshal(obj(latest, "HostConfig"))) != string(marshal(host)) || string(marshal(obj(obj(latest, "NetworkSettings"), "Networks"))) != string(marshal(obj(obj(current, "NetworkSettings"), "Networks"))) {
		fail(errors.New("Container changed during pull"), false)
		return
	}
	if e = emit("recreating", "Gleiche Container mit dem freigegebenen Sollzustand ab"); e != nil {
		fail(e, false)
		return
	}
	newID := ""
	if str(labels, "com.docker.compose.project") != "" {
		newID, e = a.reconcileCompose(ctx, current, pin, op)
	} else {
		newID, e = a.recreate(ctx, current, oldImage, pin, op)
	}
	if e != nil {
		fail(e, true)
		return
	}
	if e = emit("verifying", "Prüfe Laufzustand und Docker-Healthcheck"); e != nil {
		fail(e, true)
		return
	}
	if e = a.verify(ctx, newID); e != nil {
		fail(e, true)
		return
	}
	f := Frame{Stage: "succeeded", Message: "Update erfolgreich; Healthcheck bestanden", NewID: newID}
	if e = a.journal(op, f); e != nil {
		fail(e, true)
		return
	}
	_ = enc.Encode(f)
	if flusher != nil {
		flusher.Flush()
	}
}
func (a *Agent) pull(ctx context.Context, pin, platform string) error {
	req, e := http.NewRequestWithContext(ctx, "POST", "http://docker"+a.Docker.Path("/images/create?fromImage="+url.QueryEscape(pin)+"&platform="+url.QueryEscape(platform)), nil)
	if e != nil {
		return e
	}
	r, e := a.Docker.HTTP.Do(req)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode >= 300 {
		return fmt.Errorf("pull HTTP %d", r.StatusCode)
	}
	dec := json.NewDecoder(bufio.NewReader(r.Body))
	for {
		var progress struct {
			Error string `json:"error"`
		}
		e = dec.Decode(&progress)
		if e == io.EOF {
			return nil
		}
		if e != nil {
			return e
		}
		if progress.Error != "" {
			return errors.New("Docker rejected image pull")
		}
	}
}
func (a *Agent) recreate(ctx context.Context, current, oldImage map[string]any, pin string, op Operation) (string, error) {
	name := strings.TrimPrefix(str(current, "Name"), "/")
	if !nameRE.MatchString(name) {
		return "", errors.New("invalid container name")
	}
	host := obj(current, "HostConfig")
	if strings.HasPrefix(str(host, "NetworkMode"), "container:") {
		return "", errors.New("shared network namespace requires manual reconciliation")
	}
	if links, _ := host["Links"].([]any); len(links) > 0 {
		return "", errors.New("legacy links require manual reconciliation")
	}
	// Persist effective host-port allocations, including Docker's random ports.
	// HostConfig retains an empty requested port for random bindings; reusing it
	// would silently move the service endpoint to a different host port.
	bindings := map[string]any{}
	for port, allocated := range obj(obj(current, "NetworkSettings"), "Ports") {
		if len(asArray(allocated)) > 0 {
			bindings[port] = allocated
		}
	}
	if len(bindings) > 0 {
		host["PortBindings"] = bindings
	}
	config := watchtower.Overrides(obj(current, "Config"), obj(oldImage, "Config"), obj(host, "PortBindings"))
	config["Image"] = pin
	// Reattach anonymous volumes by their actual Docker volume name.
	binds, _ := host["Binds"].([]any)
	mountConfig, _ := host["Mounts"].([]any)
	known := map[string]bool{}
	for _, b := range binds {
		p := strings.Split(fmt.Sprint(b), ":")
		if len(p) > 1 {
			known[p[1]] = true
		}
	}
	for _, m := range mountConfig {
		mm, _ := m.(map[string]any)
		known[str(mm, "Target")] = true
	}
	for _, m := range current["Mounts"].([]any) {
		mm, _ := m.(map[string]any)
		if str(mm, "Type") == "volume" && !known[str(mm, "Destination")] {
			mountConfig = append(mountConfig, map[string]any{"Type": "volume", "Source": str(mm, "Name"), "Target": str(mm, "Destination"), "ReadOnly": !boolean(mm, "RW")})
		}
	}
	host["Mounts"] = mountConfig
	endpoints := map[string]any{}
	for network, v := range obj(obj(current, "NetworkSettings"), "Networks") {
		ep, _ := v.(map[string]any)
		aliases := []any{}
		for _, alias := range asArray(ep["Aliases"]) {
			s := fmt.Sprint(alias)
			if s != op.ContainerID && s != op.ContainerID[:12] {
				aliases = append(aliases, s)
			}
		}
		endpoints[network] = map[string]any{"Aliases": aliases, "IPAMConfig": ep["IPAMConfig"]}
	}
	if e := a.Docker.Request(ctx, "POST", a.Docker.Path("/containers/"+op.ContainerID+"/stop?t=30"), nil, nil); e != nil {
		return "", e
	}
	if e := a.Docker.Request(ctx, "POST", a.Docker.Path("/containers/"+op.ContainerID+"/update"), map[string]any{"RestartPolicy": map[string]any{"Name": "no"}}, nil); e != nil {
		return "", e
	}
	if e := a.Docker.Request(ctx, "POST", a.Docker.Path("/containers/"+op.ContainerID+"/rename?name="+url.QueryEscape(name+"-cuo-"+op.JobID[:8])), nil, nil); e != nil {
		return "", e
	}
	config["HostConfig"] = host
	config["NetworkingConfig"] = map[string]any{"EndpointsConfig": endpoints}
	var result struct {
		ID string `json:"Id"`
	}
	if e := a.Docker.Request(ctx, "POST", a.Docker.Path("/containers/create?name="+url.QueryEscape(name)+"&platform="+url.QueryEscape(op.Platform)), config, &result); e != nil {
		return "", e
	}
	return result.ID, a.Docker.Request(ctx, "POST", a.Docker.Path("/containers/"+result.ID+"/start"), nil, nil)
}
func asArray(v any) []any { a, _ := v.([]any); return a }
func (a *Agent) verify(ctx context.Context, id string) error {
	for i := 0; i < 60; i++ {
		inspect, e := a.Docker.Inspect(ctx, id)
		if e != nil {
			return e
		}
		state := obj(inspect, "State")
		if !boolean(state, "Running") {
			return errors.New("Updated container stopped; inspect logs and agent journal")
		}
		status := str(obj(state, "Health"), "Status")
		if status == "unhealthy" {
			return errors.New("Updated container is unhealthy")
		}
		if status == "healthy" || (status == "" && i >= 5) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("Healthcheck deadline exceeded")
}
func (a *Agent) reconcileCompose(ctx context.Context, current map[string]any, pin string, op Operation) (string, error) {
	labels := obj(obj(current, "Config"), "Labels")
	project := str(labels, "com.docker.compose.project")
	service := str(labels, "com.docker.compose.service")
	relative := str(labels, "cuo.compose.file")
	if !nameRE.MatchString(project) || !nameRE.MatchString(service) {
		return "", errors.New("invalid Compose identity")
	}
	if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "..") {
		return "", errors.New("Compose project must be registered using cuo.compose.file relative to /projects")
	}
	source, e := filepath.EvalSymlinks(filepath.Join("/projects", relative))
	if e != nil || !strings.HasPrefix(source, "/projects/") {
		return "", errors.New("Compose source outside registered project directory")
	}
	directory := str(labels, "cuo.compose.host_dir")
	if directory == "" {
		directory = str(labels, "com.docker.compose.project.working_dir")
	}
	if !filepath.IsAbs(directory) {
		return "", errors.New("Compose working directory missing")
	}
	// Resolve trusted source files with Compose before talking to the daemon.
	// Compose evaluates env_file and relative paths in the mounted project directory.
	resolve := exec.CommandContext(ctx, "docker", "compose", "--project-directory", filepath.Dir(source), "--project-name", project, "-f", source, "config", "--format", "json")
	resolve.Env = append(os.Environ(), "COMPOSE_ANSI=never")
	raw, err := resolve.Output()
	if err != nil {
		return "", errors.New("Compose source could not be resolved; check registered files and interpolation")
	}
	desired := map[string]any{}
	if json.Unmarshal(raw, &desired) != nil {
		return "", errors.New("invalid resolved Compose source")
	}
	services := obj(desired, "services")
	if _, ok := services[service]; !ok {
		return "", errors.New("service missing in registered source")
	}
	// Map normalized bind paths back to the source project's actual host directory.
	mounted := filepath.Dir(source)
	var remap func(any)
	remap = func(v any) {
		switch value := v.(type) {
		case map[string]any:
			for key, item := range value {
				if text, ok := item.(string); ok && (key == "source" || key == "file") && (text == mounted || strings.HasPrefix(text, mounted+"/")) {
					value[key] = filepath.Join(directory, strings.TrimPrefix(strings.TrimPrefix(text, mounted), "/"))
				} else {
					remap(item)
				}
			}
		case []any:
			for _, item := range value {
				remap(item)
			}
		}
	}
	remap(desired)
	lockDir := filepath.Join(a.Dir, "compose-locks")
	if err = os.MkdirAll(lockDir, 0700); err != nil {
		return "", err
	}
	lockPath := filepath.Join(lockDir, project+".json")
	// Preserve all previously accepted digest pins while adopting intentional source changes.
	if old, err := os.ReadFile(lockPath); err == nil {
		saved := map[string]any{}
		if json.Unmarshal(old, &saved) != nil {
			return "", errors.New("invalid persisted Compose desired state")
		}
		for name, entry := range obj(saved, "services") {
			if current, ok := services[name].(map[string]any); ok {
				image := str(entry.(map[string]any), "image")
				if strings.Contains(image, "@sha256:") {
					current["image"] = image
				}
			}
		}
	}
	obj(services, service)["image"] = pin
	serviceLabels := obj(obj(services, service), "labels")
	serviceLabels["cuo.compose.host_dir"] = directory
	obj(services, service)["labels"] = serviceLabels
	if err = os.WriteFile(lockPath+".tmp", marshal(desired), 0600); err != nil {
		return "", err
	}
	if err = os.Rename(lockPath+".tmp", lockPath); err != nil {
		return "", err
	}
	args := []string{"compose", "--project-name", project, "-f", lockPath}
	run := func(extra ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "docker", append(append([]string{}, args...), extra...)...)
		cmd.Env = append(os.Environ(), "COMPOSE_ANSI=never")
		b, err := cmd.Output()
		if err != nil {
			return "", errors.New("Compose reconciliation failed; inspect registered project and persisted desired-state lock")
		}
		return strings.TrimSpace(string(b)), nil
	}
	if _, err = run("up", "-d", "--no-deps", "--no-build", "--pull", "never", service); err != nil {
		return "", err
	}
	id, err := run("ps", "-q", service)
	if err != nil || !idRE.MatchString(id) {
		return "", errors.New("Compose service must have exactly one running replica")
	}

	return id, nil
}

func controlMount(m map[string]any) bool {
	destination := str(m, "Destination")
	if strings.Contains(destination, "docker.sock") || destination == "/" || destination == "/proc" || destination == "/sys" {
		return true
	}
	if str(m, "Type") != "bind" {
		return false
	}
	source := str(m, "Source")
	return strings.Contains(source, "docker.sock") || source == "/" || source == "/proc" || strings.HasPrefix(source, "/proc/") || source == "/sys" || strings.HasPrefix(source, "/sys/") || source == "/dev" || strings.HasPrefix(source, "/dev/") || strings.HasPrefix(source, "/var/lib/docker")
}

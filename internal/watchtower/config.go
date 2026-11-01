// SPDX-License-Identifier: Apache-2.0
// Derived from containrrr/watchtower a047c7f9ff11813f930f6998863fa1b8a015985c,
// pkg/container/container.go GetCreateConfig. Modified for CUO: native JSON
// maps, deep copies, conservative healthcheck preservation and no SDK dependency.
package watchtower

import (
	"encoding/json"
	"reflect"
)

func Overrides(current, image map[string]any, published ...map[string]any) map[string]any {
	b, _ := json.Marshal(current)
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	for _, k := range []string{"WorkingDir", "User"} {
		if reflect.DeepEqual(out[k], image[k]) {
			delete(out, k)
		}
	}
	if reflect.DeepEqual(out["Entrypoint"], image["Entrypoint"]) {
		delete(out, "Entrypoint")
		if reflect.DeepEqual(out["Cmd"], image["Cmd"]) {
			delete(out, "Cmd")
		}
	}
	oldEnv, _ := image["Env"].([]any)
	env, _ := out["Env"].([]any)
	keep := []any{}
	for _, v := range env {
		found := false
		for _, d := range oldEnv {
			found = found || reflect.DeepEqual(v, d)
		}
		if !found {
			keep = append(keep, v)
		}
	}
	out["Env"] = keep
	for _, key := range []string{"Labels", "Volumes", "ExposedPorts"} {
		a, _ := out[key].(map[string]any)
		b, _ := image[key].(map[string]any)
		for k, v := range a {
			if reflect.DeepEqual(v, b[k]) {
				delete(a, k)
			}
		}
	}
	ports, _ := out["ExposedPorts"].(map[string]any)
	if ports == nil {
		ports = map[string]any{}
	}
	for _, bindings := range published {
		for port := range bindings {
			ports[port] = map[string]any{}
		}
	}
	if len(ports) > 0 {
		out["ExposedPorts"] = ports
	}
	return out
}

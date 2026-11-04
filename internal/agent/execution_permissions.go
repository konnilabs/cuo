package agent

import (
	"cuo.local/cuo/internal/core"
	"errors"
	"strings"
)

const dockerDefaultCapabilities = "AUDIT_WRITE CHOWN DAC_OVERRIDE FOWNER FSETID KILL MKNOD NET_BIND_SERVICE NET_RAW SETFCAP SETGID SETPCAP SETUID SYS_CHROOT"

func validateExecutionHost(host map[string]any, p core.ExecutionPermissions) error {
	if boolean(host, "Privileged") || len(asArray(host["Devices"])) > 0 || len(asArray(host["DeviceRequests"])) > 0 || str(host, "IpcMode") == "host" || strings.HasPrefix(str(host, "IpcMode"), "container:") || strings.HasPrefix(str(host, "IpcMode"), "service:") || boolean(host, "AutoRemove") || str(host, "NetworkMode") == "host" || strings.HasPrefix(str(host, "NetworkMode"), "container:") || strings.HasPrefix(str(host, "NetworkMode"), "service:") {
		return errors.New("Privileged mode, devices, shared host IPC/network or auto-remove require manual updates")
	}
	if unsafeCapabilities(asArray(host["CapAdd"]), p) {
		return errors.New("Existing extended capabilities require matching container-specific preservation grants; unsupported capabilities require manual updates")
	}
	switch str(host, "PidMode") {
	case "", "private":
	case "host":
		if !p.PreserveHostPID {
			return errors.New("Existing host PID access requires a container-specific preservation grant")
		}
	default:
		return errors.New("Shared PID namespaces require manual updates")
	}
	return nil
}

func normalizedCapability(value string) string {
	return strings.TrimPrefix(strings.ToUpper(value), "CAP_")
}

// Compose may change ordinary desired state, but an update grant must never
// introduce new host access through an edited registered Compose source.
func validateComposePreservation(service, current map[string]any, p core.ExecutionPermissions) error {
	host := obj(current, "HostConfig")
	if service["gpus"] != nil || len(asArray(obj(obj(obj(service, "deploy"), "resources"), "reservations")["devices"])) > 0 {
		return errors.New("Compose device requests require manual updates")
	}
	desired := map[string]any{
		"Privileged": service["privileged"], "Devices": service["devices"],
		"CapAdd": service["cap_add"], "PidMode": service["pid"],
		"IpcMode": service["ipc"], "NetworkMode": service["network_mode"],
	}
	if err := validateExecutionHost(desired, p); err != nil {
		return err
	}
	if str(desired, "PidMode") == "host" && str(host, "PidMode") != "host" {
		return errors.New("Update grants cannot add host PID access through Compose")
	}
	oldCaps := effectiveCapabilities(asArray(host["CapAdd"]), asArray(host["CapDrop"]))
	for name := range effectiveCapabilities(asArray(service["cap_add"]), asArray(service["cap_drop"])) {
		if !oldCaps[name] {
			return errors.New("Update grants cannot add effective capabilities through Compose")
		}
	}
	oldSecurity := map[string]bool{}
	for _, value := range asArray(host["SecurityOpt"]) {
		oldSecurity[strings.Replace(stringValue(value), ":", "=", 1)] = true
	}
	for _, value := range asArray(service["security_opt"]) {
		name := strings.Replace(stringValue(value), ":", "=", 1)
		if !oldSecurity[name] {
			return errors.New("Update grants cannot change security profiles through Compose")
		}
		delete(oldSecurity, name)
	}
	// Docker injects label=disable for host PID; Compose's normalized source
	// need not repeat this implicit option. The PID mode must remain identical.
	if str(host, "PidMode") == "host" && str(desired, "PidMode") == "host" {
		delete(oldSecurity, "label=disable")
	}
	if len(oldSecurity) > 0 {
		return errors.New("Update grants cannot remove security restrictions through Compose")
	}
	for _, value := range asArray(service["volumes"]) {
		mount, ok := value.(map[string]any)
		if !ok || str(mount, "type") != "bind" {
			continue
		}
		candidate := map[string]any{"Type": "bind", "Source": mount["source"], "Destination": mount["target"], "RW": !boolean(mount, "read_only")}
		if !controlMount(candidate, false) {
			continue
		}
		if controlMount(candidate, p.ReadOnlyHostMonitoring) {
			return errors.New("Compose host mount requires a supported monitoring grant")
		}
		found := false
		for _, item := range asArray(current["Mounts"]) {
			existing, _ := item.(map[string]any)
			if str(existing, "Type") == "bind" && str(existing, "Source") == str(candidate, "Source") && str(existing, "Destination") == str(candidate, "Destination") && existing["RW"] == candidate["RW"] {
				found = true
			}
		}
		if !found {
			return errors.New("Update grants cannot add host monitoring mounts through Compose")
		}
	}
	return nil
}

func effectiveCapabilities(add, drop []any) map[string]bool {
	result := map[string]bool{}
	for _, name := range strings.Fields(dockerDefaultCapabilities) {
		result[name] = true
	}
	for _, value := range drop {
		name := normalizedCapability(stringValue(value))
		if name == "ALL" {
			clear(result)
		} else {
			delete(result, name)
		}
	}
	for _, value := range add {
		result[normalizedCapability(stringValue(value))] = true
	}
	return result
}

func stringValue(v any) string { s, _ := v.(string); return s }

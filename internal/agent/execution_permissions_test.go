package agent

import (
	"cuo.local/cuo/internal/core"
	"testing"
)

func monitoringGrants() core.ExecutionPermissions {
	return core.ExecutionPermissions{ReadOnlyHostMonitoring: true, PreserveSysAdmin: true, PreserveSysPtrace: true, PreserveDacReadSearch: true, PreserveHostPID: true}
}

func TestHostPreservationRequiresEverySpecificGrant(t *testing.T) {
	host := map[string]any{"CapAdd": []any{"CAP_SYS_ADMIN", "SYS_PTRACE", "DAC_READ_SEARCH"}, "PidMode": "host"}
	if err := validateExecutionHost(host, monitoringGrants()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"SYS_ADMIN", "SYS_PTRACE", "DAC_READ_SEARCH", "host PID"} {
		t.Run(name, func(t *testing.T) {
			p := monitoringGrants()
			switch name {
			case "SYS_ADMIN":
				p.PreserveSysAdmin = false
			case "SYS_PTRACE":
				p.PreserveSysPtrace = false
			case "DAC_READ_SEARCH":
				p.PreserveDacReadSearch = false
			default:
				p.PreserveHostPID = false
			}
			if validateExecutionHost(host, p) == nil {
				t.Fatal("missing grant accepted")
			}
		})
	}
	for key, value := range map[string]any{"Privileged": true, "Devices": []any{map[string]any{"PathOnHost": "/dev/mem"}}, "DeviceRequests": []any{map[string]any{"Count": -1}}, "IpcMode": "host", "AutoRemove": true, "NetworkMode": "host"} {
		t.Run(key, func(t *testing.T) {
			h := map[string]any{key: value}
			if validateExecutionHost(h, monitoringGrants()) == nil {
				t.Fatal("preservation became a generic bypass")
			}
		})
	}
	for _, capability := range []string{"ALL", "SYS_MODULE", "BPF", "NET_ADMIN", "unknown"} {
		if !unsafeCapabilities([]any{capability}, monitoringGrants()) {
			t.Fatal("unsupported capability accepted", capability)
		}
	}
}

func TestComposeGrantsPreserveButNeverIntroduceHostAccess(t *testing.T) {
	p := monitoringGrants()
	current := map[string]any{"HostConfig": map[string]any{"CapAdd": []any{"SYS_ADMIN", "SYS_PTRACE", "DAC_READ_SEARCH"}, "PidMode": "host", "SecurityOpt": []any{"apparmor=unconfined", "label=disable"}}, "Mounts": []any{map[string]any{"Type": "bind", "Source": "/proc", "Destination": "/host/proc", "RW": false}}}
	service := func() map[string]any {
		return map[string]any{"cap_add": []any{"CAP_SYS_ADMIN", "SYS_PTRACE", "DAC_READ_SEARCH"}, "pid": "host", "security_opt": []any{"apparmor:unconfined"}, "volumes": []any{map[string]any{"type": "bind", "source": "/proc", "target": "/host/proc", "read_only": true}}}
	}
	if err := validateComposePreservation(service(), current, p); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"new-capability", "new-pid", "new-profile", "removed-profile", "removed-no-new-privileges", "removed-cap-drop", "new-default-capability", "new-mount", "writable-mount", "gpu", "gpu-reservation", "shared-network", "shared-ipc"} {
		t.Run(variant, func(t *testing.T) {
			c := map[string]any{"HostConfig": map[string]any{}, "Mounts": current["Mounts"]}
			for k, v := range obj(current, "HostConfig") {
				obj(c, "HostConfig")[k] = v
			}
			s := service()
			switch variant {
			case "removed-no-new-privileges":
				obj(c, "HostConfig")["SecurityOpt"] = []any{"apparmor=unconfined", "label=disable", "no-new-privileges"}
			case "removed-profile":
				s["security_opt"] = []any{}
			case "removed-cap-drop":
				obj(c, "HostConfig")["CapDrop"] = []any{"NET_RAW"}
			case "new-default-capability":
				obj(c, "HostConfig")["CapDrop"] = []any{"ALL"}
				s["cap_drop"] = []any{"ALL"}
				s["cap_add"] = append(asArray(s["cap_add"]), "CHOWN")
			case "gpu":
				s["gpus"] = "all"
			case "gpu-reservation":
				s["deploy"] = map[string]any{"resources": map[string]any{"reservations": map[string]any{"devices": []any{map[string]any{"count": "all"}}}}}
			case "shared-network":
				s["network_mode"] = "service:other"
			case "shared-ipc":
				s["ipc"] = "container:other"
			case "new-capability":
				obj(c, "HostConfig")["CapAdd"] = []any{"SYS_PTRACE"}
			case "new-pid":
				obj(c, "HostConfig")["PidMode"] = ""
			case "new-profile":
				obj(c, "HostConfig")["SecurityOpt"] = []any{}
			case "new-mount":
				asArray(s["volumes"])[0].(map[string]any)["target"] = "/host/new-proc"
			case "writable-mount":
				asArray(s["volumes"])[0].(map[string]any)["read_only"] = false
			}
			if validateComposePreservation(s, c, p) == nil {
				t.Fatal("Compose introduced host access", variant)
			}
		})
	}
}

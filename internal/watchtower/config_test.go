package watchtower

import (
	"reflect"
	"testing"
)

func TestOverridesPreserveUserConfigurationWithoutMutatingInspection(t *testing.T) {
	old := map[string]any{"Env": []any{"BASE=1"}, "Cmd": []any{"start"}, "Labels": map[string]any{"vendor": "x"}}
	current := map[string]any{"Env": []any{"BASE=1", "CUSTOM=yes"}, "Cmd": []any{"start"}, "Labels": map[string]any{"vendor": "x", "cuo.managed": "true"}, "Healthcheck": map[string]any{"Test": []any{"CMD", "true"}}}
	got := Overrides(current, old)
	if !reflect.DeepEqual(got["Env"], []any{"CUSTOM=yes"}) || got["Cmd"] != nil {
		t.Fatal(got)
	}
	if len(current["Env"].([]any)) != 2 || current["Labels"].(map[string]any)["vendor"] != "x" {
		t.Fatal("inspection was mutated")
	}
	if got["Healthcheck"] == nil || got["Labels"].(map[string]any)["cuo.managed"] != "true" {
		t.Fatal("runtime settings lost")
	}
}
func TestCustomEntrypointKeepsItsArgumentsAndPublishedImagePorts(t *testing.T) {
	old := map[string]any{"Entrypoint": []any{"default"}, "Cmd": []any{"serve"}, "ExposedPorts": map[string]any{"8080/tcp": map[string]any{}}}
	current := map[string]any{"Entrypoint": []any{"custom-wrapper"}, "Cmd": []any{"serve"}, "ExposedPorts": map[string]any{"8080/tcp": map[string]any{}}}
	result := Overrides(current, old, map[string]any{"8080/tcp": []any{map[string]any{"HostPort": "18080"}}})
	if !reflect.DeepEqual(result["Cmd"], []any{"serve"}) || result["ExposedPorts"].(map[string]any)["8080/tcp"] == nil {
		t.Fatal("custom entrypoint arguments or published image port lost", result)
	}
}

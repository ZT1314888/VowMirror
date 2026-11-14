package catalog

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestSharedManifestContract(t *testing.T) {
	fixture, err := os.ReadFile("../../../tests/fixtures/wedding-assets-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../../tests/fixtures/wedding-assets-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var scenarios []struct {
		Name        string   `json:"name"`
		Valid       bool     `json:"valid"`
		Reverse     []string `json:"reverse"`
		TextChanges []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"textChanges"`
		Changes []struct {
			Path   string `json:"path"`
			Value  any    `json:"value"`
			Remove bool   `json:"remove"`
		} `json:"changes"`
	}
	if err := json.Unmarshal(data, &scenarios); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			var manifest map[string]any
			if err := json.Unmarshal(fixture, &manifest); err != nil {
				t.Fatal(err)
			}
			for _, name := range scenario.Reverse {
				entries := manifest[name].([]any)
				for left, right := 0, len(entries)-1; left < right; left, right = left+1, right-1 {
					entries[left], entries[right] = entries[right], entries[left]
				}
			}
			for _, change := range scenario.Changes {
				changeContractValue(t, manifest, strings.Split(change.Path, "/"), change.Value, change.Remove)
			}
			encoded, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			for _, change := range scenario.TextChanges {
				if !bytes.Contains(encoded, []byte(change.From)) {
					t.Fatalf("missing text fixture target: %s", change.From)
				}
				encoded = bytes.Replace(encoded, []byte(change.From), []byte(change.To), 1)
			}
			parsed, err := ParseManifest(encoded)
			if (err == nil) != scenario.Valid {
				t.Fatalf("expected valid=%v, got error %v", scenario.Valid, err)
			}
			if scenario.Valid && parsed.Outfits[0].ID != manifest["outfits"].([]any)[0].(map[string]any)["id"] {
				t.Fatal("parser must preserve input order")
			}
		})
	}
}

func changeContractValue(t *testing.T, target any, segments []string, replacement any, remove bool) any {
	t.Helper()
	key := segments[0]
	switch value := target.(type) {
	case map[string]any:
		if len(segments) > 1 {
			value[key] = changeContractValue(t, value[key], segments[1:], replacement, remove)
		} else if remove {
			delete(value, key)
		} else {
			value[key] = replacement
		}
	case []any:
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 || index >= len(value) {
			t.Fatalf("invalid fixture array index %q", key)
		}
		if len(segments) > 1 {
			value[index] = changeContractValue(t, value[index], segments[1:], replacement, remove)
		} else if remove {
			return append(value[:index], value[index+1:]...)
		} else {
			value[index] = replacement
		}
	default:
		t.Fatalf("invalid fixture target at %q", key)
	}
	return target
}

func TestLoadManifest(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"outfits":[{"id":"W001","name":"一","dress":"W001/dress.jpg","menswear":"W001/menswear.jpg","shoes_detail":"W001/shoes_detail.jpg"}],"poses":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(path); err == nil {
		t.Fatal("incomplete manifest must fail")
	}
}

func TestTrimUTF8BOM(t *testing.T) {
	if got := string(trimUTF8BOM([]byte{0xef, 0xbb, 0xbf, 'x'})); got != "x" {
		t.Fatalf("unexpected BOM trim result %q", got)
	}
}

func TestParseManifest(t *testing.T) {
	fixture, err := os.ReadFile("../../../tests/fixtures/wedding-assets-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"valid":           fixture,
		"BOM":             append([]byte{0xef, 0xbb, 0xbf}, fixture...),
		"decimal version": []byte(strings.Replace(string(fixture), `"version": 1`, `"version": 1.0`, 1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseManifest(data); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, text := range []string{"{bad", "[]", "null", string(fixture) + " {}"} {
		if _, err := ParseManifest([]byte(text)); err == nil {
			t.Fatalf("invalid JSON must fail: %.20s", text)
		}
	}
	path := filepath.Join(t.TempDir(), "manifest.json")
	if _, err := LoadManifest(path); err == nil {
		t.Fatal("missing file must fail")
	}
	if err := os.WriteFile(path, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(path); err != nil {
		t.Fatal(err)
	}
}

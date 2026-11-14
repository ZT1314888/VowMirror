package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"backend/internal/catalog"
	"github.com/gogf/gf/v2/frame/g"
)

func inBackendRoot(t *testing.T) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(filepath.Join("..", "..")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Error(err)
		}
	})
	adapter := g.Cfg().GetAdapter()
	t.Cleanup(func() { g.Cfg().SetAdapter(adapter) })
}

func TestCatalogRoutes(t *testing.T) {
	inBackendRoot(t)
	const token = "test-catalog-token-000000000000000000"
	t.Setenv("TRYON_API_KEYS", token)
	fixture, err := os.ReadFile("../tests/fixtures/wedding-assets-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "manifest.json")
	var loads atomic.Int32
	s, err := newServer(context.Background(), "catalog-routes", func() (*catalog.Manifest, error) {
		loads.Add(1)
		return catalog.LoadManifest(path)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	base := "http://127.0.0.1:" + strconv.Itoa(s.GetListenedPort())
	client := &http.Client{Timeout: 2 * time.Second}
	request := func(t *testing.T, route, accessToken string) (int, http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, base+route, nil)
		if err != nil {
			t.Fatal(err)
		}
		if accessToken != "" {
			req.Header.Set("Authorization", "Bearer "+accessToken)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.Header.Get("X-Request-ID") == "" {
			t.Fatal("missing request ID")
		}
		return response.StatusCode, response.Header, body
	}
	for _, accessToken := range []string{"", "incorrect-catalog-token-0000000000000"} {
		status, _, body := request(t, "/catalog/outfits", accessToken)
		if status != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", status, body)
		}
	}
	status, _, _ := request(t, "/health", "")
	if status != http.StatusOK || loads.Load() != 0 {
		t.Fatal("health and rejected authentication must not read the manifest")
	}
	for _, scenario := range []struct {
		name string
		data []byte
	}{
		{"missing", nil},
		{"malformed", []byte(`{"private-marker":`)},
		{"invalid", []byte(`{"version":1,"outfits":[],"poses":[]}`)},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if scenario.data != nil {
				if err := os.WriteFile(path, scenario.data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			status, header, body := request(t, "/catalog/outfits", token)
			if status != http.StatusInternalServerError || header.Get("Cache-Control") != "no-store" {
				t.Fatalf("unexpected unavailable response: %d, %s", status, body)
			}
			var unavailable struct {
				Code    int               `json:"code"`
				Message string            `json:"message"`
				Data    map[string]string `json:"data"`
			}
			if err := json.Unmarshal(body, &unavailable); err != nil {
				t.Fatal(err)
			}
			if unavailable.Code != 50001 || unavailable.Message != "婚礼素材清单不可用" || len(unavailable.Data) != 1 || unavailable.Data["request_id"] != header.Get("X-Request-ID") {
				t.Fatalf("unexpected error body: %s", body)
			}
			if bytes.Contains(body, []byte(path)) || bytes.Contains(body, []byte("private-marker")) {
				t.Fatal("unavailable response leaked manifest contents or filesystem path")
			}
		})
	}
	if err := os.WriteFile(path, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	status, header, body := request(t, "/catalog/outfits", token)
	if status != http.StatusOK || header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected catalog response: %d, %s", status, body)
	}
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(envelope.Data, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fixture, &want); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 || envelope.Message != "" || !reflect.DeepEqual(got, want) {
		t.Fatal("response must contain exactly the manifest metadata")
	}
	if strings.Contains(string(body), token) || loads.Load() != 4 {
		t.Fatal("unexpected credential exposure or manifest load count")
	}
}

func TestServerRequiresValidToken(t *testing.T) {
	inBackendRoot(t)
	for _, token := range []string{"", "short"} {
		t.Setenv("TRYON_API_KEYS", token)
		if _, err := NewServer(context.Background(), "invalid-token"); err == nil {
			t.Fatal("missing or malformed access token must fail startup")
		}
	}
}

func TestFoundationRoutes(t *testing.T) {
	inBackendRoot(t)
	t.Setenv("TRYON_API_KEYS", "test-foundation-token-0000000000000000")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ARK_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "")
	s, err := NewServer(context.Background(), "foundation-routes")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	if s.GetListenedPort() != 8000 {
		t.Fatalf("expected fixed port 8000, got %d", s.GetListenedPort())
	}
	base := "http://127.0.0.1:" + strconv.Itoa(s.GetListenedPort())
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(base + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Code int `json:"code"`
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || body.Code != 0 || body.Data.Status != "ok" {
		t.Fatalf("unexpected health: %+v", body)
	}
	if response.Header.Get("X-Request-ID") == "" {
		t.Fatal("missing request ID")
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/tryon"},
		{http.MethodGet, "/comfyui/health"},
		{http.MethodGet, "/hello"},
		{http.MethodPost, "/tryon/couple"},
	} {
		request, err := http.NewRequest(route.method, base+route.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, readErr := io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if res.StatusCode != 404 {
			t.Fatalf("%s %s should be 404, got %d", route.method, route.path, res.StatusCode)
		}
	}
	request, err := http.NewRequest(http.MethodGet, base+"/catalog/outfits", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("catalog without token should be 401, got %d", res.StatusCode)
	}
}

package cmd

import (
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
	t.Setenv("TRYON_USAGE_DB", filepath.Join(t.TempDir(), "usage.sqlite"))
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
	if err := os.WriteFile(path, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	var loads atomic.Int32
	s, err := newApplication(context.Background(), "catalog-routes", func() (*catalog.Manifest, error) {
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
	status, _, _ := request(t, "/health", "")
	if status != http.StatusOK || loads.Load() != 1 {
		t.Fatal("manifest must load once at startup")
	}
	if err := os.WriteFile(path, []byte("changed after startup"), 0600); err != nil {
		t.Fatal(err)
	}
	wantManifest, err := catalog.ParseManifest(fixture)
	if err != nil {
		t.Fatal(err)
	}
	want := catalog.ExposePublicDirectory(wantManifest)
	for _, accessToken := range []string{"", "incorrect-catalog-token-0000000"} {
		status, header, body := request(t, "/catalog/outfits", accessToken)
		if status != http.StatusOK || header.Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected public catalog response: %d, %s", status, body)
		}
		var envelope struct {
			Code    int                     `json:"code"`
			Message string                  `json:"message"`
			Data    catalog.PublicDirectory `json:"data"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Code != 0 || envelope.Message != "" || !reflect.DeepEqual(envelope.Data, want) {
			t.Fatalf("unexpected public catalog fields: %s", body)
		}
		for _, privateField := range []string{`"path"`, `"poses"`, `"action"`, `"mode"`, `"requirements"`, `"dress"`, `"menswear"`, `"shoes_detail"`} {
			if strings.Contains(string(body), privateField) {
				t.Fatalf("public catalog exposed %s", privateField)
			}
		}
		if strings.Contains(string(body), token) {
			t.Fatal("public catalog exposed a credential")
		}
	}
	if loads.Load() != 1 {
		t.Fatalf("unexpected manifest load count: %d", loads.Load())
	}
}

func TestServerRequiresValidToken(t *testing.T) {
	inBackendRoot(t)
	for _, token := range []string{"", "short"} {
		t.Setenv("TRYON_API_KEYS", token)
		if _, err := newApplication(context.Background(), "invalid-token", testManifest); err == nil {
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
	s, err := newApplication(context.Background(), "foundation-routes", testManifest)
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
}

func testManifest() (*catalog.Manifest, error) {
	return catalog.LoadManifest("../tests/fixtures/wedding-assets-manifest.json")
}

func TestInvalidManifestFailsStartup(t *testing.T) {
	inBackendRoot(t)
	t.Setenv("TRYON_API_KEYS", "synthetic-manifest-token-000000000000")
	for _, data := range []string{"", `{"private-marker":`, `{"version":1,"outfits":[],"poses":[]}`} {
		if _, err := newApplication(context.Background(), "invalid-manifest", func() (*catalog.Manifest, error) {
			return catalog.ParseManifest([]byte(data))
		}); err == nil {
			t.Fatal("invalid startup manifest accepted")
		}
	}
}

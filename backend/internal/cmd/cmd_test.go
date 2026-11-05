package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

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
		{http.MethodGet, "/catalog/outfits"},
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

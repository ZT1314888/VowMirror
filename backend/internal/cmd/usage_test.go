package cmd

import (
	"backend/internal/imagevalidate"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

func usageFor(t *testing.T) *security.UsageLedger {
	t.Helper()
	q, err := security.OpenUsageLedger(filepath.Join(t.TempDir(), "usage.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := q.Close(); err != nil {
			t.Error(err)
		}
	})
	return q
}

type usageHTTP struct {
	base      string
	token     string
	principal string
	body      []byte
	ledger    *security.UsageLedger
	path      string
	mode      atomic.Int32
	calls     atomic.Int32
}

func newUsageHTTP(t *testing.T, dailyLimit int) *usageHTTP {
	t.Helper()
	h := &usageHTTP{token: "synthetic-usage-http-code-000000000000000000", path: filepath.Join(t.TempDir(), "usage.sqlite")}
	var err error
	h.ledger, err = security.OpenUsageLedger(h.path, dailyLimit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.ledger.Close() })
	t.Setenv("TEST_USAGE_TOKEN", h.token)
	store, err := security.NewTokenStore(true, "TEST_USAGE_TOKEN")
	if err != nil {
		t.Fatal(err)
	}
	h.principal, _ = store.ValidateToken(h.token)
	fixture, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := imagevalidate.ValidateBytes(fixture, "image/png", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := png.Encode(&output, image.NewRGBA(image.Rect(0, 0, tryon.OutputWidth, tryon.OutputHeight))); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(output.Bytes())
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.calls.Add(1)
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return
		}
		switch h.mode.Load() {
		case 1:
			w.WriteHeader(502)
		case 2:
			io.WriteString(w, `{"data":[]}`)
		default:
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": encoded}}})
		}
	}))
	t.Cleanup(upstream.Close)
	factory := func() (tryon.ImageGenerator, error) {
		return tryon.NewGenerator(tryon.ModelConfig{Provider: "chuanapi", Model: tryon.GPTImageModel, BaseURL: upstream.URL + "/v1", APIKey: "synthetic-model-key"}, upstream.Client().Transport)
	}
	service, err := tryon.NewCoupleService(factory, apiOutfits{image: img}, security.NewConcurrencyManager(2, 1), h.ledger, twoFaces)
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server("usage-" + strings.ReplaceAll(t.Name(), "/", "-"))
	s.SetPort(0)
	s.SetDumpRouterMap(false)
	s.Group("/tryon", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID, middleware.NewAuthMiddleware(store).Handler)
		group.POST("/authorize", authorizeHandler(h.ledger))
		group.POST("/couple", coupleHandler(service))
	})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	h.base = "http://127.0.0.1:" + strconv.Itoa(s.GetListenedPort())
	h.body, err = json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(fixture), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *usageHTTP) post(t *testing.T, endpoint, token string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.base+"/tryon/"+endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing no-store")
	}
	return response.StatusCode, payload
}

func TestUsageHTTPDirectGenerationFiveSuccessesAndRestart(t *testing.T) {
	h := newUsageHTTP(t, 10)
	for _, route := range []string{"authorize", "couple"} {
		for _, token := range []string{"", "synthetic-invalid-code"} {
			if status, _ := h.post(t, route, token, nil); status != 401 {
				t.Fatalf("%s accepted invalid code: %d", route, status)
			}
		}
	}
	for i := 0; i < 5; i++ {
		status, before := h.post(t, "authorize", h.token, nil)
		if status != 200 || !bytes.Contains(before, []byte(`"remaining":`+strconv.Itoa(5-i))) {
			t.Fatalf("preflight %d: %s", i, before)
		}
		// Direct requests must enforce quota even without a preceding authorize request.
		status, result := h.post(t, "couple", h.token, h.body)
		frames, err := decodeTestSSE(result)
		if status != 200 || err != nil || len(frames) == 0 || frames[len(frames)-1].Event != "result" {
			t.Fatalf("success %d: %s", i, result)
		}
	}
	_, result := h.post(t, "couple", h.token, h.body)
	if !bytes.Contains(result, []byte("SUCCESS_QUOTA_EXCEEDED")) || h.calls.Load() != 5 {
		t.Fatal("sixth direct request reached model or succeeded")
	}
	if status, _ := h.post(t, "authorize", h.token, nil); status != 403 {
		t.Fatal("exhausted code authorized")
	}
	if err := h.ledger.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := security.OpenUsageLedger(h.path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.Check(context.Background(), h.principal); err != security.ErrSuccessQuotaExceeded {
		t.Fatalf("restart lost HTTP success accounting: %v", err)
	}
	data, err := os.ReadFile(h.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range [][]byte{[]byte(h.token), h.body, []byte(encodedMarker(t))} {
		if bytes.Contains(data, secret) {
			t.Fatal("database stored credentials or photo data")
		}
	}
}

func encodedMarker(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(data)
}

func TestUsageHTTPFailuresPreserveSuccessAndDailyAttemptsPersist(t *testing.T) {
	h := newUsageHTTP(t, 2)
	// Invalid images do not reach the send boundary or consume either counter.
	_, invalid := h.post(t, "couple", h.token, []byte(`{"couple_image":"broken","outfit_id":"W001","scene":{"mode":"original"}}`))
	if !bytes.Contains(invalid, []byte("INVALID_IMAGE_BASE64")) || h.calls.Load() != 0 {
		t.Fatal("invalid input reached model")
	}
	for _, mode := range []int32{1, 2} {
		h.mode.Store(mode)
		_, result := h.post(t, "couple", h.token, h.body)
		if !bytes.Contains(result, []byte("event: error")) {
			t.Fatal("invalid model result succeeded")
		}
	}
	_, exhausted := h.post(t, "couple", h.token, h.body)
	if !bytes.Contains(exhausted, []byte("DAILY_QUOTA_EXCEEDED")) || h.calls.Load() != 2 {
		t.Fatal("daily limit failed")
	}
	h.ledger.Close()
	reopened, err := security.OpenUsageLedger(h.path, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if remaining, err := reopened.Check(context.Background(), h.principal); remaining != 5 || err != security.ErrDailyQuotaExceeded {
		t.Fatalf("daily/success persistence: %d %v", remaining, err)
	}
}

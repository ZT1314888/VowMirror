package cmd

import (
	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCoupleStrictJSON(t *testing.T) {
	good := `{"couple_image":"image","outfit_id":"W001","dress_side":"left","scene":{"mode":"original"}}`
	if _, err := decodeCouple(strings.NewReader(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{}`, `null`, `[]`, good + ` {}`, good + ` trailing`,
		strings.Replace(good, `"couple_image"`, `"Couple_Image"`, 1),
		strings.Replace(good, `"couple_image":"image"`, `"couple_image":null`, 1),
		strings.Replace(good, `"outfit_id":"W001"`, `"outfit_id":"W001","outfit_id":"W002"`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"original","image":""}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"original","mode":"upload"}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":null`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"original","model":"private-marker"}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"original","venue_id":""}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"upload","image":"image","venue_id":"V001"}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"venue","image":"","venue_id":"V001"}`, 1),
		strings.Replace(good, `"scene":{"mode":"original"}`, `"scene":{"mode":"venue","venue_id":null}`, 1),
	} {
		if _, err := decodeCouple(strings.NewReader(bad)); err == nil {
			t.Errorf("invalid contract accepted: %s", bad)
		}
	}
	for _, field := range []string{"model", "base_url", "api_key", "dress_path", "garment_image", "left_portrait", "scene_id"} {
		bad := strings.TrimSuffix(good, "}") + `,"` + field + `":"private-marker"}`
		if _, err := decodeCouple(strings.NewReader(bad)); err == nil {
			t.Errorf("forbidden field accepted: %s", field)
		}
	}
}

type apiGenerator struct {
	calls  *atomic.Int32
	output *imagevalidate.ValidatedImage
}

func (g apiGenerator) Model() string { return tryon.GeminiModel }
func (g apiGenerator) Generate(context.Context, tryon.GenerationRequest) (*imagevalidate.ValidatedImage, error) {
	g.calls.Add(1)
	return g.output, nil
}

type apiOutfits struct{ image *imagevalidate.ValidatedImage }

func (r apiOutfits) ReadOutfit(context.Context, string) (catalog.OutfitImages, error) {
	return catalog.OutfitImages{Dress: r.image, Menswear: r.image, Shoes: r.image}, nil
}
func (r apiOutfits) ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	return nil, catalog.ErrUnknownVenue
}

func TestCoupleHTTPBoundary(t *testing.T) {
	const token = "synthetic-api-token-000000000000000000"
	t.Setenv("TEST_COUPLE_TOKEN", token)
	store, err := security.NewTokenStore(true, "TEST_COUPLE_TOKEN")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := imagevalidate.ValidateBytes(data, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var landscape bytes.Buffer
	if err := png.Encode(&landscape, image.NewRGBA(image.Rect(0, 0, 384, 256))); err != nil {
		t.Fatal(err)
	}
	result, err := imagevalidate.ValidateBytes(landscape.Bytes(), "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	service, err := tryon.NewCoupleService(func() (tryon.ImageGenerator, error) { return apiGenerator{calls: &calls, output: result}, nil }, apiOutfits{image: img}, security.NewConcurrencyManager(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server("couple-boundary")
	s.SetPort(0)
	s.SetDumpRouterMap(false)
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID, middleware.NewAuthMiddleware(store).Handler, middleware.NewBodyLimitMiddleware(tryon.MaxBodyBytes).Handler)
		group.POST("/tryon/couple", coupleHandler(service))
	})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	endpoint := "http://127.0.0.1:" + strconv.Itoa(s.GetListenedPort()) + "/tryon/couple"
	client := &http.Client{Timeout: 2 * time.Second}
	good, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", DressSide: "left", Scene: tryon.Scene{Mode: "original"}})
	request := func(body io.Reader, access, media string, length int64) (int, http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequest("POST", endpoint, body)
		if err != nil {
			t.Fatal(err)
		}
		req.ContentLength = length
		req.Header.Set("Content-Type", media)
		req.Header.Set("X-Request-ID", "private-marker")
		if access != "" {
			req.Header.Set("Authorization", "Bearer "+access)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		payload, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Header.Get("X-Request-ID") == "private-marker" || bytes.Contains(payload, []byte("private-marker")) {
			t.Fatal("untrusted correlation marker reflected")
		}
		return resp.StatusCode, resp.Header, payload
	}
	for _, access := range []string{"", "invalid-token"} {
		status, _, _ := request(bytes.NewReader(good), access, "application/json", int64(len(good)))
		if status != 401 {
			t.Fatal("unauthenticated request accepted")
		}
	}
	if status, _, _ := request(bytes.NewReader(good), token, "text/plain", int64(len(good))); status != 415 {
		t.Fatalf("wrong media status %d", status)
	}
	if status, _, _ := request(strings.NewReader(`{"model":"private-marker"}`), token, "application/json", -1); status != 422 {
		t.Fatalf("unknown-field status %d", status)
	}
	huge := `{"couple_image":"` + strings.Repeat("a", int(tryon.MaxBodyBytes)) + `"}`
	for _, length := range []int64{-1, int64(len(huge))} {
		if status, _, _ := request(strings.NewReader(huge), token, "application/json", length); status != 413 {
			t.Fatalf("oversize/chunked status %d", status)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("rejected request invoked model")
	}
	status, header, body := request(bytes.NewReader(good), token, "application/json", int64(len(good)))
	if status != 200 || header.Get("Cache-Control") != "no-store" {
		t.Fatalf("generation failed: %d %s", status, body)
	}
	var response struct {
		Code int                  `json:"code"`
		Data tryon.CoupleResponse `json:"data"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != 0 || response.Data.MIME != "image/png" || response.Data.Model != tryon.GeminiModel || response.Data.RequestID != header.Get("X-Request-ID") || calls.Load() != 1 {
		t.Fatal("invalid response contract")
	}
}

func TestProductionCoupleRouteRejectsUnconfiguredModel(t *testing.T) {
	inBackendRoot(t)
	const token = "synthetic-runtime-token-0000000000000000"
	t.Setenv("TRYON_API_KEYS", token)
	for _, name := range []string{"MODEL_PROVIDER", "MODEL_NAME", "MODEL_API_KEY", "MODEL_BASE_URL"} {
		t.Setenv(name, "")
	}
	s, err := NewServer(context.Background(), "couple-unconfigured")
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
	data, err := os.ReadFile("internal/imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", DressSide: "left", Scene: tryon.Scene{Mode: "original"}})
	client := &http.Client{Timeout: 2 * time.Second}
	// Valid JSON above GoFrame's default 8 MiB must reach the model configuration check.
	for _, padding := range []int{0, 9 << 20} {
		for _, chunked := range []bool{false, true} {
			body := append(bytes.Repeat([]byte(" "), padding), input...)
			req, err := http.NewRequest("POST", "http://127.0.0.1:8000/tryon/couple", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if chunked {
				req.ContentLength = -1
			}
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 503 || !bytes.Contains(payload, []byte("MODEL_CONFIGURATION_INVALID")) {
				t.Fatalf("padding=%d chunked=%v: unexpected config response: %d %s", padding, chunked, response.StatusCode, payload)
			}
		}
	}
}

type synchronizedLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *synchronizedLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.Write(data)
}
func (l *synchronizedLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.buffer.String() }

func TestHTTPCancellationReachesTLSUpstreamAndReleasesSlot(t *testing.T) {
	arrived := make(chan struct{})
	upstreamStopped := make(chan struct{})
	handlerStopped := make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		close(arrived)
		<-r.Context().Done()
		close(upstreamStopped)
	}))
	defer upstream.Close()
	factory := func() (tryon.ImageGenerator, error) {
		return tryon.NewGenerator(tryon.ModelConfig{Provider: "gemini", Model: tryon.GeminiModel, BaseURL: upstream.URL, APIKey: "synthetic-private-marker"}, upstream.Client().Transport)
	}
	data, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := imagevalidate.ValidateBytes(data, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	admission := security.NewConcurrencyManager(1, 1)
	service, err := tryon.NewCoupleService(factory, apiOutfits{image: img}, admission)
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server("couple-http-cancellation")
	s.SetPort(0)
	s.SetDumpRouterMap(false)
	logs := &synchronizedLog{}
	s.Logger().SetWriter(logs)
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID)
		group.POST("/tryon/couple", func(r *ghttp.Request) {
			defer close(handlerStopped)
			r.SetCtxVar(middleware.CtxPrincipalID, "p")
			coupleHandler(service)(r)
		})
	})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	input, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", DressSide: "left", Scene: tryon.Scene{Mode: "original"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:"+strconv.Itoa(s.GetListenedPort())+"/tryon/couple", bytes.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", "synthetic-private-marker")
	client := &http.Client{Timeout: 2 * time.Second}
	done := make(chan error, 1)
	go func() {
		resp, err := client.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
		done <- err
	}()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		t.Fatal("upstream not reached")
	}
	cancel()
	if err := <-done; err == nil {
		t.Error("cancelled request returned success")
	}
	for _, stopped := range []<-chan struct{}{upstreamStopped, handlerStopped} {
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Fatal("cancellation did not propagate")
		}
	}
	release, ok := admission.Acquire("p")
	if !ok {
		t.Fatal("HTTP cancellation leaked slot")
	}
	release()
	if calls.Load() != 1 {
		t.Fatal("unexpected extra upstream attempt")
	}
	for _, marker := range []string{"synthetic-private-marker", base64.StdEncoding.EncodeToString(data)} {
		if strings.Contains(logs.String(), marker) {
			t.Fatal("sensitive request data entered application logs")
		}
	}
}

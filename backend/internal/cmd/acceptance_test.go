package cmd

import (
	"backend/internal/catalog"
	"backend/internal/facedetect"
	"backend/internal/imagevalidate"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

// Exercise the real HTTP handler, service, reader and TLS adapter together.
// The only upstream is a loopback TLS server; all photos are public fixtures.
func TestAcceptanceHTTPErrorsDoNotLeakSensitiveData(t *testing.T) {
	const token = "synthetic-acceptance-access-token-00000000"
	const marker = "synthetic-acceptance-private-marker"
	t.Setenv("TEST_ACCEPTANCE_TOKEN", token)
	store, err := security.NewTokenStore(true, "TEST_ACCEPTANCE_TOKEN")
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
	original, err := os.ReadFile("../facedetect/testdata/two-exif6.jpg")
	if err != nil {
		t.Fatal(err)
	}
	detector, err := facedetect.New()
	if err != nil {
		t.Fatal(err)
	}
	priorLogger := slog.Default()
	diagnosticLogs := &synchronizedLog{}
	slog.SetDefault(slog.New(slog.NewTextHandler(diagnosticLogs, nil)))
	t.Cleanup(func() { slog.SetDefault(priorLogger) })
	for _, scenario := range []struct {
		name, code string
		status     int
		calls      int32
	}{
		{"missing asset", "OUTFIT_UNAVAILABLE", 503, 0},
		{"no faces", "COUPLE_IMAGE_NOT_COUPLE", 422, 0},
		{"detector fault", "FACE_DETECTION_UNAVAILABLE", 503, 0},
		{"upstream", "MODEL_REQUEST_FAILED", 502, 1},
		{"invalid result", "INVALID_MODEL_RESULT", 502, 1},
		{"deadline", "GENERATION_TIMEOUT", 504, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var calls atomic.Int32
			couple := original
			count := detector.Count
			switch scenario.name {
			case "no faces":
				couple = data
			case "detector fault":
				count = func(context.Context, image.Image, []byte) (int, error) { return 0, errors.New(marker) }
			case "deadline":
				// This case times the upstream cancellation, not the detector's CPU work.
				count = twoFaces
			}
			encoded := base64.StdEncoding.EncodeToString(couple)
			scene := tryon.Scene{Mode: "upload", Image: base64.StdEncoding.EncodeToString(data)}
			input, err := json.Marshal(tryon.CoupleRequest{CoupleImage: encoded, OutfitID: "W001", Scene: scene})
			if err != nil {
				t.Fatal(err)
			}
			stopped := make(chan struct{})
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(stopped)
				calls.Add(1)
				if r.Header.Get("Authorization") != "Bearer "+marker || r.URL.RawQuery != "" {
					t.Error("unexpected credential transport")
				}
				if err := r.ParseMultipartForm(4 << 20); err != nil {
					t.Error(err)
					return
				}
				files := r.MultipartForm.File["image[]"]
				if len(files) != 5 {
					t.Errorf("expected five upstream images, got %d", len(files))
					return
				}
				for index, want := range map[int][]byte{0: original, 4: data} {
					f, err := files[index].Open()
					if err != nil {
						t.Error(err)
						return
					}
					got, err := io.ReadAll(f)
					f.Close()
					if err != nil || !bytes.Equal(got, want) {
						t.Errorf("upstream reference %d changed", index)
					}
				}
				switch scenario.name {
				case "deadline":
					<-r.Context().Done()
				case "upstream":
					w.WriteHeader(http.StatusTooManyRequests)
					_, _ = io.WriteString(w, marker)
				default:
					_, _ = io.WriteString(w, `{"data":[],"message":"`+marker+`"}`)
				}
			}))
			defer upstream.Close()
			factory := func() (tryon.ImageGenerator, error) {
				return tryon.NewGenerator(tryon.ModelConfig{Provider: "chuanapi", Model: tryon.GPTImageModel, APIKey: marker, BaseURL: upstream.URL + "/v1"}, upstream.Client().Transport)
			}
			var reader tryon.AssetReader = apiOutfits{image: img}
			if scenario.name == "missing asset" {
				manifest, err := catalog.LoadManifest("../../../tests/fixtures/wedding-assets-manifest.json")
				if err != nil {
					t.Fatal(err)
				}
				snapshot, err := catalog.NewSnapshot(manifest)
				if err != nil {
					t.Fatal(err)
				}
				reader, err = catalog.NewReader(t.TempDir(), snapshot)
				if err != nil {
					t.Fatal(err)
				}
			}
			admission := security.NewConcurrencyManager(1, 1)
			service, err := tryon.NewCoupleService(factory, reader, admission, usageFor(t), count, fixedPosePicker)
			if err != nil {
				t.Fatal(err)
			}
			s := g.Server("acceptance-" + strings.ReplaceAll(scenario.name, " ", "-"))
			s.SetPort(0)
			s.SetDumpRouterMap(false)
			logs := &synchronizedLog{}
			s.Logger().SetWriter(logs)
			s.Group("/", func(group *ghttp.RouterGroup) {
				group.Middleware(middleware.RequestID, middleware.NewAuthMiddleware(store).Handler)
				group.POST("/tryon/couple", func(r *ghttp.Request) {
					if scenario.name == "deadline" {
						// A shorter parent deadline verifies propagation without an 85s unit test.
						ctx, cancel := context.WithTimeout(r.Context(), 200*time.Millisecond)
						defer cancel()
						r.Request = r.Request.WithContext(ctx)
					}
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
			req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(s.GetListenedPort())+"/tryon/couple", bytes.NewReader(input))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-Request-ID", marker)
			response, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			frames, err := decodeTestSSE(body)
			if err != nil || len(frames) == 0 || frames[len(frames)-1].Event != "error" {
				t.Fatalf("expected one terminal SSE error: %v %s", err, body)
			}
			var payload struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
				Data    struct {
					Code       string `json:"error_code"`
					RequestID  string `json:"request_id"`
					HTTPStatus int    `json:"http_status"`
				} `json:"data"`
			}
			if err := json.Unmarshal(frames[len(frames)-1].Data, &payload); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || payload.Data.HTTPStatus != scenario.status || payload.Data.Code != scenario.code || calls.Load() != scenario.calls {
				t.Fatalf("unexpected status/code/attempts: %d %d %s %d", response.StatusCode, payload.Data.HTTPStatus, payload.Data.Code, calls.Load())
			}
			for _, frame := range frames[:len(frames)-1] {
				if frame.Event == "error" || frame.Event == "result" {
					t.Fatal("more than one terminal SSE event")
				}
			}
			switch scenario.name {
			case "no faces":
				if payload.Code != 42210 || payload.Message != "未检测到两张清晰的人脸，请换一张两人面部清楚的合照。" {
					t.Fatalf("wrong face count error: %d %s", payload.Code, payload.Message)
				}
			case "detector fault":
				if payload.Code != 50307 || payload.Message != "暂时无法检查合照，请稍后重试。" {
					t.Fatalf("wrong detector error: %d %s", payload.Code, payload.Message)
				}
			}
			if payload.Data.RequestID == "" || payload.Data.RequestID != response.Header.Get("X-Request-ID") || response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("missing correlation or cache boundary")
			}
			if scenario.calls != 0 {
				select {
				case <-stopped:
				case <-time.After(time.Second):
					t.Fatal("TLS upstream did not stop")
				}
			}
			for _, secret := range []string{token, marker, encoded, upstream.URL} {
				if strings.Contains(string(body)+response.Header.Get("X-Request-ID")+logs.String()+diagnosticLogs.String(), secret) {
					t.Fatal("sensitive data entered HTTP response or application logs")
				}
			}
			for _, field := range []string{"stage_elapsed_ms", "api_http_status", "upstream_http_status", "error_category", "input_bytes", "upstream_request_bytes", "upstream_response_bytes"} {
				if !strings.Contains(diagnosticLogs.String(), field) {
					t.Errorf("structured generation diagnostic is missing %s", field)
				}
			}
			release, ok := admission.Acquire("acceptance-next-request")
			if !ok {
				t.Fatal("failed request leaked global admission slot")
			}
			release()
		})
	}
}

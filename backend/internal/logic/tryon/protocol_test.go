package tryon

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"backend/internal/imagevalidate"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("../../imagevalidate/testdata/checker." + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func landscape(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, OutputWidth, OutputHeight))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func references(t *testing.T, scene bool) []Reference {
	t.Helper()
	refs := []Reference{
		{Role: RoleCouple, Image: validatedFixture(t, "jpg")},
		{Role: RoleDress, Image: validatedFixture(t, "png")},
		{Role: RoleMenswear, Image: validatedFixture(t, "webp")},
		{Role: RoleShoes, Image: validatedFixture(t, "jpg")},
	}
	if scene {
		refs = append(refs, Reference{Role: RoleScene, Image: validatedFixture(t, "png")})
	}
	return refs
}

func validatedFixture(t *testing.T, format string) *imagevalidate.ValidatedImage {
	t.Helper()
	img, err := imagevalidate.ValidateBytes(fixture(t, format), "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	return img
}
func generationInput(t *testing.T, scene bool) GenerationRequest {
	return GenerationRequest{References: references(t, scene), Prompt: "unchanged prompt"}
}
func imageResponse(data []byte) string {
	return `{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(data) + `"}]}`
}
func tlsGenerator(t *testing.T, handler http.HandlerFunc) (*GPTImage, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	gen, err := NewGenerator(ModelConfig{Provider: "chuanapi", Model: GPTImageModel, APIKey: "synthetic-test-key", BaseURL: server.URL + "/v1"}, server.Client().Transport)
	if err != nil {
		t.Fatal(err)
	}
	return gen.(*GPTImage), server
}

type recordedStages struct {
	mu     sync.Mutex
	events []StageObservation
}

func (r *recordedStages) Observe(event StageObservation) {
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
}

func (r *recordedStages) snapshot() []StageObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StageObservation(nil), r.events...)
}

func TestGPTImageTraceUsesRealConnectionEventsAndRequestClock(t *testing.T) {
	response := imageResponse(landscape(t))
	gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("X-Request-ID", "synthetic-early-provider-id")
		_, _ = io.WriteString(w, response)
	})
	gen.config.BaseURL = strings.Replace(gen.config.BaseURL, "127.0.0.1", "localhost", 1)
	transport := gen.client.Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	// Resolve localhost through DNS while verifying the fixture certificate's IP SAN.
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	gen.client.Transport = transport
	t.Cleanup(transport.CloseIdleConnections)
	for index, wantReuse := range []bool{false, true} {
		recorder := &recordedStages{}
		startedAt := time.Now()
		input := generationInput(t, false)
		input.Trace = RequestTrace{RequestID: "synthetic-request", StartedAt: startedAt, Observer: recorder}
		if _, err := gen.Generate(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		events := recorder.snapshot()
		seen := make(map[string]StageObservation, len(events))
		for _, event := range events {
			seen[event.Phase] = event
			if event.DurationMS != nil && event.ElapsedMS < *event.DurationMS {
				t.Fatalf("%s duration is not relative to the request start: %+v", event.Phase, event)
			}
		}
		connection, ok := seen["connection_acquired"]
		if !ok || connection.ConnectionReused == nil || *connection.ConnectionReused != wantReuse {
			t.Fatalf("request %d connection reuse was not observed: %+v", index+1, connection)
		}
		for _, phase := range []string{"assembling_request", "waiting_upstream_response", "request_upload", "first_response_byte", "provider_response_headers", "reading_provider_response", "validating_provider_result"} {
			if _, ok := seen[phase]; !ok {
				t.Errorf("request %d missing observed phase %q", index+1, phase)
			}
		}
		if wantReuse {
			for _, phase := range []string{"dns_lookup", "tcp_connect", "tls_handshake"} {
				if _, ok := seen[phase]; ok {
					t.Errorf("reused connection fabricated an unexecuted %s stage", phase)
				}
			}
		} else {
			for _, phase := range []string{"dns_lookup", "tcp_connect", "tls_handshake"} {
				if _, ok := seen[phase]; !ok {
					t.Errorf("first connection missing real %s", phase)
				}
			}
		}
		if seen["provider_response_headers"].ProviderRequestID != "synthetic-early-provider-id" {
			t.Fatal("validated provider identifier was not observed at headers")
		}
	}
}
func TestGPTImageFourAndFiveRolesWithRealMIME(t *testing.T) {
	for _, scene := range []bool{false, true} {
		t.Run(map[bool]string{false: "four", true: "five"}[scene], func(t *testing.T) {
			input := generationInput(t, scene)
			output := landscape(t)
			var calls atomic.Int32
			gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1/images/edits" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer synthetic-test-key" {
					t.Error("unexpected endpoint or secret transport")
				}
				media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if err != nil || media != "multipart/form-data" {
					t.Error("multipart required")
					return
				}
				reader := multipart.NewReader(r.Body, params["boundary"])
				fields := map[string]string{}
				imageIndex := 0
				for {
					part, err := reader.NextPart()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Error(err)
						return
					}
					data, err := io.ReadAll(part)
					if err != nil {
						t.Error(err)
						return
					}
					if part.FormName() != "image[]" {
						if _, exists := fields[part.FormName()]; exists {
							t.Error("duplicate field")
						}
						fields[part.FormName()] = string(data)
						continue
					}
					if imageIndex >= len(input.References) {
						t.Error("extra image")
						return
					}
					ref := input.References[imageIndex]
					if !bytes.Equal(ref.Image.Bytes(), data) || part.Header.Get("Content-Type") != ref.Image.MIME() || !strings.HasPrefix(part.FileName(), string(ref.Role)+".") {
						t.Errorf("role %d mapping mismatch", imageIndex)
					}
					imageIndex++
				}
				expected := map[string]string{"model": GPTImageModel, "prompt": input.Prompt, "n": "1", "size": OutputSize, "quality": OutputQuality, "output_format": "png"}
				a, _ := json.Marshal(fields)
				b, _ := json.Marshal(expected)
				if !bytes.Equal(a, b) || imageIndex != len(input.References) {
					t.Error("output fields or reference count mismatch")
				}
				w.Header().Set("X-Request-ID", "provider-123")
				_, _ = io.WriteString(w, strings.TrimSuffix(imageResponse(output), "}")+`,"model":"`+GPTImageModel+`-2026-09-08"}`)
			})
			result, err := gen.Generate(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if result.Image.MIME() != "image/png" || !bytes.Equal(result.Image.Bytes(), output) || result.Image.Width() != OutputWidth || result.ProviderRequestID != "provider-123" || result.ProviderModel != GPTImageModel+"-2026-09-08" || calls.Load() != 1 {
				t.Fatal("unexpected result, metadata or calls")
			}
		})
	}
}

func TestFactoryConfigurationAndCapabilities(t *testing.T) {
	if ErrConfiguration.Error() != "模型配置不完整或无效" || ErrUpstream.Error() != "模型服务请求失败" {
		t.Fatal("controlled messages must remain readable")
	}
	good := ModelConfig{Provider: "chuanapi", Model: GPTImageModel, APIKey: "synthetic-test-key", BaseURL: "https://model.example/v1"}
	for _, modify := range []func(*ModelConfig){
		func(c *ModelConfig) { c.Provider = "" }, func(c *ModelConfig) { c.APIKey = "" },
		func(c *ModelConfig) { c.BaseURL = "http://localhost:8000" }, func(c *ModelConfig) { c.BaseURL = "http://model.example" },
		func(c *ModelConfig) { c.BaseURL = "https://user:pass@model.example" }, func(c *ModelConfig) { c.BaseURL = "https://model.example?key=private-marker" },
		func(c *ModelConfig) { c.BaseURL = "https://model.example#private-marker" }, func(c *ModelConfig) { c.APIKey = "x\nprivate-marker" },
	} {
		cfg := good
		modify(&cfg)
		if _, err := NewGenerator(cfg, http.DefaultTransport); !errors.Is(err, ErrConfiguration) {
			t.Fatalf("expected config rejection: %v", err)
		}
	}
	for _, provider := range []string{"gemini", "openai", "doubao"} {
		cfg := good
		cfg.Provider = provider
		if _, err := NewGenerator(cfg, http.DefaultTransport); !errors.Is(err, ErrCapability) {
			t.Fatal("unclosed provider accepted")
		}
	}
	good.Model = "unverified-model"
	if _, err := NewGenerator(good, http.DefaultTransport); !errors.Is(err, ErrCapability) {
		t.Fatal("unverified model accepted")
	}
}

func TestProviderHeadersAreObservedBeforeStatusOrBodyFailures(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusOK} {
		gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("X-Request-ID", "synthetic-provider-error-id")
			w.Header().Set("Content-Length", "100")
			w.WriteHeader(status)
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, "{")
		})
		recorder := &recordedStages{}
		input := generationInput(t, false)
		input.Trace = RequestTrace{RequestID: "synthetic-request", StartedAt: time.Now(), Observer: recorder}
		if _, err := gen.Generate(context.Background(), input); !errors.Is(err, ErrUpstream) {
			t.Fatalf("expected controlled upstream error: %v", err)
		}
		found := false
		for _, event := range recorder.snapshot() {
			if event.Phase == "provider_response_headers" && event.HTTPStatus == status && event.ProviderRequestID == "synthetic-provider-error-id" {
				found = true
			}
		}
		if !found {
			t.Fatal("provider status/identifier lost before body failure")
		}
	}
}

func TestGPTImageRejectsInvalidReferencesBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	var attempts atomic.Int32
	gen, _ := tlsGenerator(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	for _, modify := range []func(*GenerationRequest){
		func(r *GenerationRequest) { r.References = r.References[:3] },
		func(r *GenerationRequest) { r.References[0], r.References[1] = r.References[1], r.References[0] },
		func(r *GenerationRequest) { r.References[0].Image = &imagevalidate.ValidatedImage{} },
		func(r *GenerationRequest) { r.References[0].Image = nil },
		func(r *GenerationRequest) { r.References[4].Role = RoleCouple },
		func(r *GenerationRequest) { r.References[4].Image = nil },
		func(r *GenerationRequest) { r.References[2].Image = &imagevalidate.ValidatedImage{} },
		func(r *GenerationRequest) { r.Prompt = "" },
		func(r *GenerationRequest) { r.Prompt = strings.Repeat("x", MaxProviderRequestBytes) },
		func(r *GenerationRequest) { r.References = append(r.References, r.References[0]) },
	} {
		input := generationInput(t, true)
		input.BeforeSend = func(context.Context) error { attempts.Add(1); return nil }
		modify(&input)
		if _, err := gen.Generate(context.Background(), input); !errors.Is(err, ErrReferences) {
			t.Fatalf("invalid reference accepted: %v", err)
		}
	}
	if calls.Load() != 0 || attempts.Load() != 0 {
		t.Fatal("invalid input reached network")
	}
}

func TestGPTImageAccountingRefusalPreventsTransport(t *testing.T) {
	var calls atomic.Int32
	gen, _ := tlsGenerator(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	input := generationInput(t, false)
	refused := errors.New("usage database unavailable")
	input.BeforeSend = func(context.Context) error { return refused }
	if _, err := gen.Generate(context.Background(), input); !errors.Is(err, refused) {
		t.Fatalf("accounting error lost: %v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("refused accounting still reached transport")
	}
}

func TestGPTImageControlledErrorsAndSingleAttempt(t *testing.T) {
	valid := imageResponse(landscape(t))
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"upstream", 429, `private-marker`, ErrUpstream},
		{"raw error", 200, `{"error":{"message":"private-marker"}}`, ErrResult},
		{"bad json", 200, `private-marker`, ErrResult},
		{"empty", 200, `{"data":[]}`, ErrResult},
		{"URL only", 200, `{"data":[{"url":"https://private-marker"}]}`, ErrResult},
		{"inline and URL", 200, strings.Replace(valid, `"b64_json":`, `"url":"https://private-marker","b64_json":`, 1), ErrResult},
		{"bad base64", 200, `{"data":[{"b64_json":"!!"}]}`, ErrResult},
		{"JPEG bytes", 200, imageResponse(fixture(t, "jpg")), ErrResult},
		{"truncated", 200, imageResponse(landscape(t)[:40]), ErrResult},
		{"wrong dimensions", 200, imageResponse(fixture(t, "png")), ErrResult},
		{"multiple images", 200, `{"data":[{"b64_json":"AA=="},{"b64_json":"AA=="}]}`, ErrResult},
		{"oversize response", 200, strings.Repeat("x", int(MaxResponseBytes+1)), ErrUpstream},
		{"other model", 200, strings.TrimSuffix(valid, "}") + `,"model":"other-model"}`, ErrResult},
		{"invalid snapshot", 200, strings.TrimSuffix(valid, "}") + `,"model":"` + GPTImageModel + `-invalid"}`, ErrResult},
		{"unsafe metadata", 200, strings.TrimSuffix(valid, "}") + `,"request_id":"https://private-marker"}`, ErrResult},
		{"reflected key", 200, strings.TrimSuffix(valid, "}") + `,"request_id":"synthetic-test-key"}`, ErrResult},
		{"wrong quality", 200, strings.TrimSuffix(valid, "}") + `,"quality":"low"}`, ErrResult},
		{"wrong size", 200, strings.TrimSuffix(valid, "}") + `,"size":"1024x1024"}`, ErrResult},
		{"wrong format", 200, strings.TrimSuffix(valid, "}") + `,"output_format":"jpeg"}`, ErrResult},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			_, err := gen.Generate(context.Background(), generationInput(t, false))
			if !errors.Is(err, tc.want) || strings.Contains(err.Error(), "private-marker") || calls.Load() != 1 {
				t.Fatalf("unsafe error or attempts: %v / %d", err, calls.Load())
			}
		})
	}
}
func TestGPTImageOptionalAndConflictingMetadata(t *testing.T) {
	for _, tc := range []struct {
		model, bodyID, headerID string
		valid                   bool
	}{
		{"", "", "", true}, {GPTImageModel, "body-id", "", true}, {GPTImageModel, "same-id", "same-id", true}, {"", "a", "b", false}, {"", "", "unsafe id", false},
	} {
		gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Request-ID", tc.headerID)
			payload := map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(landscape(t))}}, "model": tc.model, "request_id": tc.bodyID}
			_ = json.NewEncoder(w).Encode(payload)
		})
		result, err := gen.Generate(context.Background(), generationInput(t, false))
		if tc.valid != (err == nil) {
			t.Fatalf("metadata validity mismatch: %v", err)
		}
		if tc.valid && (result.ProviderModel != tc.model || result.ProviderRequestID != tc.bodyID && result.ProviderRequestID != tc.headerID) {
			t.Fatal("metadata invented or lost")
		}
	}
}

func TestGPTImageRedirectIsRejected(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	if _, err := gen.Generate(context.Background(), generationInput(t, false)); !errors.Is(err, ErrUpstream) || redirected.Load() != 0 {
		t.Fatal("redirect followed")
	}
}

func TestGPTImageCancellationAndDeadline(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "deadline", true: "cancel"}[cancelled], func(t *testing.T) {
			arrived := make(chan struct{})
			stopped := make(chan struct{})
			gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				close(arrived)
				<-r.Context().Done()
				close(stopped)
			})
			input := generationInput(t, false)
			duration := 300 * time.Millisecond
			if cancelled {
				duration = 3 * time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), duration)
			defer cancel()
			if cancelled {
				go func() { <-arrived; cancel() }()
			}
			_, err := gen.Generate(ctx, input)
			if err == nil || ctx.Err() == nil {
				t.Fatal("cancellation ignored")
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("upstream context not cancelled")
			}
		})
	}
}

var _ ImageGenerator = (*GPTImage)(nil)

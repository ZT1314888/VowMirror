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
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 384, 256))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func references(t *testing.T, scene bool) []Reference {
	t.Helper()
	refs := []Reference{
		{Role: RoleCouple, Data: fixture(t, "jpg"), MIME: "image/jpeg"},
		{Role: RoleDress, Data: fixture(t, "png"), MIME: "image/png"},
		{Role: RoleMenswear, Data: fixture(t, "webp"), MIME: "image/webp"},
		{Role: RoleShoes, Data: fixture(t, "jpg"), MIME: "image/jpeg"},
	}
	if scene {
		refs = append(refs, Reference{Role: RoleScene, Data: fixture(t, "png"), MIME: "image/png"})
	}
	return refs
}
func generationInput(t *testing.T, scene bool) GenerationRequest {
	return GenerationRequest{References: references(t, scene), Prompt: "unchanged prompt", Output: OutputSpec{AspectRatio: "3:2", ImageSize: "1K"}}
}
func geminiResponse(data []byte, mime string) string {
	return `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"inlineData":{"mimeType":"` + mime + `","data":"` + base64.StdEncoding.EncodeToString(data) + `"}}]}}]}`
}
func tlsGenerator(t *testing.T, handler http.HandlerFunc) (*Gemini, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	gen, err := NewGenerator(ModelConfig{Provider: "gemini", Model: GeminiModel, APIKey: "synthetic-test-key", BaseURL: server.URL + "/v1beta"}, server.Client().Transport)
	if err != nil {
		t.Fatal(err)
	}
	g := gen.(*Gemini)
	return g, server
}

func TestGeminiFourAndFiveRolesWithRealMIME(t *testing.T) {
	for _, scene := range []bool{false, true} {
		t.Run(map[bool]string{false: "four", true: "five"}[scene], func(t *testing.T) {
			input := generationInput(t, scene)
			output := landscape(t)
			var calls atomic.Int32
			gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.Path != "/v1beta/models/"+GeminiModel+":generateContent" || r.URL.RawQuery != "" || r.Header.Get("x-goog-api-key") != "synthetic-test-key" {
					t.Error("unexpected endpoint or secret transport")
				}
				var body geminiRequest
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if len(body.Contents) != 1 || body.Contents[0].Role != "user" {
					t.Error("invalid content")
					return
				}
				parts := body.Contents[0].Parts
				if len(parts) != 1+2*len(input.References) || parts[0].Text != input.Prompt {
					t.Error("dropped references or replaced prompt")
					return
				}
				for i, ref := range input.References {
					label, inline := parts[1+2*i], parts[2+2*i].InlineData
					if label.Text != "Reference role: "+string(ref.Role) || inline == nil || inline.MIME != ref.MIME || inline.Data != base64.StdEncoding.EncodeToString(ref.Data) {
						t.Errorf("role %d mapping mismatch", i)
					}
				}
				cfg := body.GenerationConfig
				if cfg.CandidateCount != 1 || len(cfg.ResponseModalities) != 1 || cfg.ResponseModalities[0] != "IMAGE" || cfg.ImageConfig != input.Output {
					t.Error("output contract mismatch")
				}
				_, _ = io.WriteString(w, geminiResponse(output, "image/png"))
			})
			result, err := gen.Generate(context.Background(), input)
			if err != nil || result.MIME != "image/png" || !bytes.Equal(result.Data, output) || result.Width != 384 || calls.Load() != 1 {
				t.Fatalf("unexpected result/calls: %v %d", err, calls.Load())
			}
		})
	}
}

func TestFactoryConfigurationAndCapabilities(t *testing.T) {
	if ErrConfiguration.Error() != "模型配置不完整或无效" || ErrUpstream.Error() != "模型服务请求失败" {
		t.Fatal("controlled messages must remain readable")
	}
	good := ModelConfig{Provider: "gemini", Model: GeminiModel, APIKey: "synthetic-test-key", BaseURL: "https://model.example/v1beta"}
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
	for _, provider := range []string{"openai", "doubao"} {
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

func TestGeminiRejectsInvalidReferencesBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	gen, _ := tlsGenerator(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	for _, modify := range []func(*GenerationRequest){
		func(r *GenerationRequest) { r.References = r.References[:3] },
		func(r *GenerationRequest) { r.References[0], r.References[1] = r.References[1], r.References[0] },
		func(r *GenerationRequest) { r.References[0].MIME = "image/png" },
		func(r *GenerationRequest) { r.References[0].MIME = "" },
		func(r *GenerationRequest) { r.References[2].Data = []byte("corrupt") },
		func(r *GenerationRequest) { r.Output.AspectRatio = "2:3" },
		func(r *GenerationRequest) { r.Prompt = strings.Repeat("x", MaxProviderRequestBytes) },
		func(r *GenerationRequest) { r.References = append(r.References, r.References[0]) },
	} {
		input := generationInput(t, true)
		modify(&input)
		if _, err := gen.Generate(context.Background(), input); !errors.Is(err, ErrReferences) {
			t.Fatalf("invalid reference accepted: %v", err)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached network")
	}
}

func TestGeminiControlledErrorsAndSingleAttempt(t *testing.T) {
	valid := geminiResponse(landscape(t), "image/png")
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"upstream", 429, `private-marker`, ErrUpstream},
		{"raw error", 200, `{"error":{"message":"private-marker"}}`, ErrResult},
		{"bad json", 200, `private-marker`, ErrResult},
		{"no image", 200, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"private-marker"}]}}]}`, ErrResult},
		{"url only", 200, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"fileData":{"fileUri":"http://private-marker"}}]}}]}`, ErrResult},
		{"mime mismatch", 200, geminiResponse(landscape(t), "image/jpeg"), ErrResult},
		{"truncated", 200, geminiResponse(landscape(t)[:40], "image/png"), ErrResult},
		{"portrait", 200, geminiResponse(fixture(t, "png"), "image/png"), ErrResult},
		{"multiple images", 200, strings.Replace(valid, `}]}}]}`, `,`+`{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}}]}`, 1), ErrResult},
		{"oversize response", 200, strings.Repeat("x", int(MaxResponseBytes+1)), ErrUpstream},
		{"unfinished", 200, strings.Replace(valid, "STOP", "MAX_TOKENS", 1), ErrResult},
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

func TestGeminiRedirectIsRejected(t *testing.T) {
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

func TestGeminiCancellationAndDeadline(t *testing.T) {
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
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if cancelled {
				go func() { <-arrived; cancel() }()
			}
			_, err := gen.Generate(ctx, generationInput(t, false))
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

var _ ImageGenerator = (*Gemini)(nil)

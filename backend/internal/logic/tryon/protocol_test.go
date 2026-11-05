package tryon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestRetainedImageProtocolsMakeOneRequest(t *testing.T) {
	for _, provider := range []string{"openai", "doubao", "gemini"} {
		t.Run(provider, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost {
					t.Errorf("unexpected method: %s", r.Method)
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/json")
				if provider == "gemini" {
					if r.URL.Path != "/models/test-model:generateContent" {
						t.Errorf("unexpected path: %s", r.URL.Path)
					}
					if r.Header.Get("x-goog-api-key") != "synthetic-test-key" {
						t.Error("missing key header")
					}
					_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"inlineData":{"data":"aW1hZ2U="}}]}}]}`))
					return
				}
				if r.URL.Path != "/images/generations" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer synthetic-test-key" {
					t.Error("missing key header")
				}
				var images []string
				if err := json.Unmarshal(body["image"], &images); err != nil {
					t.Error(err)
				}
				if len(images) != 2 {
					t.Errorf("expected inherited two-image request, got %d", len(images))
				}
				var prompt string
				if err := json.Unmarshal(body["prompt"], &prompt); err != nil {
					t.Error(err)
				}
				if prompt != "unchanged prompt" {
					t.Errorf("prompt replaced: %q", prompt)
				}
				_, _ = w.Write([]byte(`{"data":[{"b64_json":"aW1hZ2U="}]}`))
			}))
			defer server.Close()
			generator, err := NewGenerator(&ModelConfig{Name: "gpt-image-test", Provider: provider, APIKey: "synthetic-test-key", BaseURL: server.URL, Model: "test-model"})
			if err != nil {
				t.Fatal(err)
			}
			image, err := generator.Generate(context.Background(), "cGVyc29u", "Z2FybWVudA==", "unchanged prompt", "1536x1024")
			if err != nil {
				t.Fatal(err)
			}
			if image != "aW1hZ2U=" || calls.Load() != 1 {
				t.Fatalf("unexpected image or billed-call count: %q / %d", image, calls.Load())
			}
		})
	}
}

func TestModelClientDoesNotFollowRedirects(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	response, err := newModelHTTPClient().Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 307 || targetCalls.Load() != 0 {
		t.Fatal("model client followed redirect")
	}
}

func TestModelFactoryRejectsMissingConfiguration(t *testing.T) {
	if _, err := NewGenerator(nil); err == nil {
		t.Fatal("missing config accepted")
	}
	for _, provider := range []string{"openai", "doubao", "gemini"} {
		if _, err := NewGenerator(&ModelConfig{Provider: provider, BaseURL: "https://model.example", Model: "test-model"}); err == nil {
			t.Fatal("missing key accepted")
		}
	}
	if _, err := NewGenerator(&ModelConfig{Provider: "openai", APIKey: "synthetic-test-key", BaseURL: "http://model.example", Model: "test-model"}); err == nil {
		t.Fatal("remote HTTP accepted")
	}
}

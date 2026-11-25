package cmd

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
)

func TestHealthChecksStatusAndPayloadWithoutFollowingRedirects(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		body   string
		valid  bool
	}{
		{"healthy", http.StatusOK, `{"code":0,"data":{"status":"ok"}}`, true},
		{"bad status", http.StatusServiceUnavailable, `{"code":0,"data":{"status":"ok"}}`, false},
		{"bad payload", http.StatusOK, `{"code":0,"data":{"status":"down"}}`, false},
		{"bad json", http.StatusOK, `{`, false},
		{"redirect", http.StatusFound, "", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", ServerAddress)
			if err != nil {
				t.Fatal(err)
			}
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/health" {
					t.Error("health check followed a redirect")
				}
				w.Header().Set("Location", "/private")
				w.WriteHeader(scenario.status)
				io.WriteString(w, scenario.body)
			})}
			defer server.Close()
			go server.Serve(listener)
			if err := Health(context.Background()); (err == nil) != scenario.valid {
				t.Fatalf("health result: %v", err)
			}
		})
	}
}

package cmd

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"backend/internal/catalog"
	"github.com/gogf/gf/v2/frame/g"
)

func TestServerHeaderLimit(t *testing.T) {
	inBackendRoot(t)
	t.Setenv("TRYON_API_KEYS", "synthetic-header-limit-token-00000000")
	s, err := newServer(context.Background(), "header-limit", func() (*catalog.Manifest, error) {
		t.Fatal("health must not load assets")
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// newServer loads the sole startup template through LoadConfig. Assert the
	// explicit field before HTTP behavior so GoFrame's default cannot hide deletion.
	headerLimit, err := g.Cfg().Get(context.Background(), "server.maxHeaderBytes")
	if err != nil {
		t.Fatal(err)
	}
	if headerLimit.IsNil() || headerLimit.Int() != 10240 {
		t.Fatalf("%s must explicitly set server.maxHeaderBytes = 10240; got %v", ConfigTemplate, headerLimit.Val())
	}
	s.SetPort(0)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Shutdown() })
	for _, scenario := range []struct {
		name   string
		size   int
		status int
	}{
		{"ordinary", 1024, http.StatusOK},
		// net/http allows parser read-ahead beyond MaxHeaderBytes; exceed both.
		{"oversized", 16 * 1024, http.StatusRequestHeaderFieldsTooLarge},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", s.GetListenedAddress(), 2*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
				t.Fatal(err)
			}
			_, err = fmt.Fprintf(conn, "GET /health HTTP/1.1\r\nHost: localhost\r\nX-Test: %s\r\nConnection: close\r\n\r\n", strings.Repeat("a", scenario.size))
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != scenario.status {
				t.Fatalf("status = %d, want %d", response.StatusCode, scenario.status)
			}
		})
	}
}

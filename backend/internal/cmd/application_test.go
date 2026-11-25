package cmd

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"backend/internal/imagevalidate"
	"backend/internal/logic/tryon"
	"backend/internal/security"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type closeObserver struct {
	io.Closer
	closed func()
}

func (c closeObserver) Close() error {
	err := c.Closer.Close()
	c.closed()
	return err
}

type signalGenerator struct {
	commands *bufio.Scanner
	output   *imagevalidate.ValidatedImage
}

func (g signalGenerator) Model() string { return tryon.GPTImageModel }
func (g signalGenerator) Generate(ctx context.Context, request tryon.GenerationRequest) (*tryon.GenerationResult, error) {
	if err := request.BeforeSend(ctx); err != nil {
		return nil, err
	}
	fmt.Println("TEST_MODEL_BLOCKED")
	if !g.commands.Scan() || g.commands.Text() != "model" {
		return nil, fmt.Errorf("missing model release")
	}
	return &tryon.GenerationResult{Image: g.output}, nil
}

type signalUsage struct {
	*security.UsageLedger
	commands *bufio.Scanner
}

func (q signalUsage) RecordSuccess(ctx context.Context, principal string) *security.APIError {
	fmt.Println("TEST_ACCOUNTING_BLOCKED")
	if !q.commands.Scan() || q.commands.Text() != "accounting" {
		return security.ErrUsageUnavailable
	}
	return q.UsageLedger.RecordSuccess(ctx, principal)
}

// Executed only as a subprocess so SIGTERM exercises GoFrame's real signal path.
func TestApplicationSIGTERMHelper(t *testing.T) {
	if os.Getenv("VOWMIRROR_SIGTERM_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	path := os.Getenv("VOWMIRROR_SIGTERM_DB")
	inBackendRoot(t)
	if err := LoadConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	ledger, err := security.OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	commands := bufio.NewScanner(os.Stdin)
	fixture, err := os.ReadFile("internal/imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := imagevalidate.ValidateBytes(fixture, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, tryon.OutputWidth, tryon.OutputHeight))); err != nil {
		t.Fatal(err)
	}
	output, err := imagevalidate.ValidateBytes(encoded.Bytes(), "image/png", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	service, err := tryon.NewCoupleService(func() (tryon.ImageGenerator, error) {
		return signalGenerator{commands: commands, output: output}, nil
	}, apiOutfits{image: img}, security.NewConcurrencyManager(1, 1), signalUsage{ledger, commands}, twoFaces, fixedPosePicker)
	if err != nil {
		t.Fatal(err)
	}
	server := g.Server("sigterm-runtime")
	if err := server.SetConfigWithMap(g.Map{"GracefulShutdownTimeout": gracefulShutdownSeconds}); err != nil {
		t.Fatal(err)
	}
	server.SetDumpRouterMap(false)
	server.Group("/", func(group *ghttp.RouterGroup) {
		group.GET("/health", func(r *ghttp.Request) {
			r.Response.WriteJson(g.Map{"code": 0, "data": g.Map{"status": "ok"}})
		})
		group.POST("/generate", func(r *ghttp.Request) {
			var input tryon.CoupleRequest
			if json.NewDecoder(r.Request.Body).Decode(&input) != nil {
				t.Error("invalid helper request")
				return
			}
			response, apiError := service.Generate(r.Context(), "synthetic-principal", tryon.RequestTrace{}, input)
			if apiError != nil {
				r.Response.WriteHeader(apiError.HTTPStatus)
				r.Response.Write(apiError.ErrorCode)
				return
			}
			r.Response.WriteJson(response)
		})
	})
	transport, err := newModelTransport()
	if err != nil {
		t.Fatal(err)
	}
	app := trackServer(server, closeObserver{ledger, func() { fmt.Println("TEST_LEDGER_CLOSED") }}, transport)
	if err := app.Run(); err != nil {
		t.Fatal(err)
	}
	fmt.Println("TEST_RUNTIME_EXITED")
}

func TestApplicationSIGTERMDrainsGenerationAndAccountingBeforeClose(t *testing.T) {
	if os.Getenv("VOWMIRROR_SIGTERM_HELPER") == "1" {
		t.Skip("parent only")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	child := exec.Command(executable, "-test.run=^TestApplicationSIGTERMHelper$", "-test.timeout=15s")
	child.Env = append(os.Environ(), "VOWMIRROR_SIGTERM_HELPER=1", "VOWMIRROR_SIGTERM_DB="+path)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &synchronizedLog{}
	child.Stderr = stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stdin.Close(); _ = child.Process.Kill() })
	stages := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "TEST_") {
				stages <- scanner.Text()
			}
		}
		close(stages)
	}()
	finished := make(chan error, 1)
	go func() { finished <- child.Wait() }()
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, err := client.Get("http://127.0.0.1:8000/health")
		if err == nil {
			response.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("helper did not listen: %s", stderr.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	fixture, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(fixture), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		response, err := client.Post("http://127.0.0.1:8000/generate", "application/json", bytes.NewReader(body))
		if err != nil {
			result <- err
			return
		}
		defer response.Body.Close()
		var output tryon.CoupleResponse
		err = json.NewDecoder(response.Body).Decode(&output)
		if err == nil && (response.StatusCode != http.StatusOK || output.Width != tryon.OutputWidth) {
			err = fmt.Errorf("unexpected generation result: %d", response.StatusCode)
		}
		result <- err
	}()
	expectStage := func(want string) {
		t.Helper()
		select {
		case stage := <-stages:
			if stage != want {
				t.Fatalf("stage = %q, want %q", stage, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %s", want)
		}
	}
	expectStage("TEST_MODEL_BLOCKED")
	if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:8000", 50*time.Millisecond)
		if err != nil {
			break
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("SIGTERM did not stop accepting connections")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := io.WriteString(stdin, "model\n"); err != nil {
		t.Fatal(err)
	}
	expectStage("TEST_ACCOUNTING_BLOCKED")
	select {
	case stage := <-stages:
		t.Fatalf("resource closed before accounting: %s", stage)
	case err := <-finished:
		t.Fatalf("process exited before accounting: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := io.WriteString(stdin, "accounting\n"); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	expectStage("TEST_LEDGER_CLOSED")
	expectStage("TEST_RUNTIME_EXITED")
	if err := <-finished; err != nil {
		t.Fatalf("helper shutdown failed: %v %s", err, stderr.String())
	}
	ledger, err := security.OpenUsageLedger(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	remaining, apiError := ledger.Check(context.Background(), "synthetic-principal")
	if remaining != 4 || apiError != security.ErrDailyQuotaExceeded {
		t.Fatalf("restart lost success/attempt counters: remaining=%d err=%v", remaining, apiError)
	}
}

func TestRunBindFailureClosesResources(t *testing.T) {
	listener, err := net.Listen("tcp", ServerAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ledger, err := security.OpenUsageLedger(filepath.Join(t.TempDir(), "usage.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	closed := 0
	transport, err := newModelTransport()
	if err != nil {
		t.Fatal(err)
	}
	app := trackServer(g.Server("bind-error"), closeObserver{ledger, func() { closed++ }}, transport)
	if err := app.Run(); err == nil || closed != 1 {
		t.Fatalf("failed startup did not close resources once: %v / %d", err, closed)
	}
}

func TestModelTransportClonesDefaults(t *testing.T) {
	transport, err := newModelTransport()
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	defaults := http.DefaultTransport.(*http.Transport)
	if transport == defaults || transport.MaxIdleConnsPerHost != 4 || transport.ForceAttemptHTTP2 != defaults.ForceAttemptHTTP2 || defaults.MaxIdleConnsPerHost == 4 {
		t.Fatal("model transport changed the shared default or lost its settings")
	}
}

func TestModelTransportReusesTLSConnection(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "ok")
	}))
	defer server.Close()
	transport, err := newModelTransport()
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	transport.TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	client := &http.Client{Transport: transport}
	var reused []bool
	for range 2 {
		request, err := http.NewRequest(http.MethodPost, server.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), &httptrace.ClientTrace{
			GotConn: func(info httptrace.GotConnInfo) { reused = append(reused, info.Reused) },
		}))
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
	}
	if len(reused) != 2 || reused[0] || !reused[1] {
		t.Fatalf("unexpected TLS connection reuse: %v", reused)
	}
}

func TestModelFactoryFreezesGeneratorOrInitializationError(t *testing.T) {
	transport, err := newModelTransport()
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	t.Setenv("MODEL_PROVIDER", "chuanapi")
	t.Setenv("MODEL_NAME", tryon.GPTImageModel)
	t.Setenv("MODEL_BASE_URL", "https://model.example/v1")
	t.Setenv("MODEL_API_KEY", "")
	unconfigured := modelFactoryFromEnvironment(transport)
	t.Setenv("MODEL_API_KEY", "synthetic-model-key")
	configured := modelFactoryFromEnvironment(transport)
	first, err := configured()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODEL_API_KEY", "")
	second, err := configured()
	if err != nil || first == nil || first != second {
		t.Fatal("model was reconstructed after startup")
	}
	if generator, err := unconfigured(); generator != nil || !errors.Is(err, tryon.ErrConfiguration) {
		t.Fatal("startup configuration error was not retained")
	}
}

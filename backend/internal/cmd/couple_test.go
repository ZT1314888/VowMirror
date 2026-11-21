package cmd

import (
	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	good := `{"couple_image":"image","outfit_id":"W001","scene":{"mode":"original"}}`
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
	for _, field := range []string{"model", "base_url", "api_key", "dress_path", "garment_image", "dress_side", "left_portrait", "scene_id"} {
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

func (g apiGenerator) Model() string { return tryon.GPTImageModel }
func (g apiGenerator) Generate(ctx context.Context, request tryon.GenerationRequest) (*tryon.GenerationResult, error) {
	if err := request.BeforeSend(ctx); err != nil {
		return nil, err
	}
	g.calls.Add(1)
	return &tryon.GenerationResult{Image: g.output, ProviderModel: tryon.GPTImageModel, ProviderRequestID: "synthetic-upstream-id"}, nil
}

type apiOutfits struct{ image *imagevalidate.ValidatedImage }

func (r apiOutfits) ReadOutfit(context.Context, string) (catalog.OutfitImages, error) {
	return catalog.OutfitImages{Dress: r.image, Menswear: r.image, Shoes: r.image}, nil
}
func (r apiOutfits) ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	return nil, catalog.ErrUnknownVenue
}

type testSSEFrame struct {
	Event string
	Data  json.RawMessage
}

func decodeTestSSE(data []byte) ([]testSSEFrame, error) {
	frames := make([]testSSEFrame, 0)
	for _, raw := range bytes.Split(data, []byte("\n\n")) {
		if len(raw) == 0 {
			continue
		}
		frame := testSSEFrame{}
		var payload strings.Builder
		for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r", ""), "\n") {
			field, value, found := strings.Cut(line, ":")
			if !found {
				continue
			}
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "event":
				frame.Event = value
			case "data":
				if payload.Len() > 0 {
					payload.WriteByte('\n')
				}
				payload.WriteString(value)
			}
		}
		if payload.Len() == 0 {
			return nil, io.ErrUnexpectedEOF
		}
		frame.Data = json.RawMessage(payload.String())
		if !json.Valid(frame.Data) {
			return nil, errors.New("invalid SSE JSON")
		}
		frames = append(frames, frame)
	}
	return frames, nil
}

func readTestSSEFrame(reader *bufio.Reader) (testSSEFrame, error) {
	frame := testSSEFrame{}
	var payload strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return testSSEFrame{}, err
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			break
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			frame.Event = value
		case "data":
			if payload.Len() > 0 {
				payload.WriteByte('\n')
			}
			payload.WriteString(value)
		}
	}
	if payload.Len() == 0 || !json.Valid([]byte(payload.String())) {
		return testSSEFrame{}, errors.New("invalid SSE frame")
	}
	frame.Data = json.RawMessage(payload.String())
	return frame, nil
}

type blockingAPIGenerator struct {
	started chan struct{}
	stopped chan struct{}
}

func (g blockingAPIGenerator) Model() string { return tryon.GPTImageModel }
func (g blockingAPIGenerator) Generate(ctx context.Context, request tryon.GenerationRequest) (*tryon.GenerationResult, error) {
	if err := request.BeforeSend(ctx); err != nil {
		return nil, err
	}
	close(g.started)
	<-ctx.Done()
	close(g.stopped)
	return nil, ctx.Err()
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
	if err := png.Encode(&landscape, image.NewRGBA(image.Rect(0, 0, tryon.OutputWidth, tryon.OutputHeight))); err != nil {
		t.Fatal(err)
	}
	result, err := imagevalidate.ValidateBytes(landscape.Bytes(), "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	service, err := tryon.NewCoupleService(func() (tryon.ImageGenerator, error) { return apiGenerator{calls: &calls, output: result}, nil }, apiOutfits{image: img}, security.NewConcurrencyManager(1, 1), usageFor(t))
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
	good, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
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
	if status != 200 || header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("generation failed: %d %s", status, body)
	}
	frames, err := decodeTestSSE(body)
	if err != nil {
		t.Fatal(err)
	}
	terminalCount := 0
	for _, frame := range frames {
		if frame.Event == "result" || frame.Event == "error" {
			terminalCount++
		}
	}
	if terminalCount != 1 || frames[len(frames)-1].Event != "result" {
		t.Fatal("SSE must end with exactly one result terminal")
	}
	var response struct {
		Code int                  `json:"code"`
		Data tryon.CoupleResponse `json:"data"`
	}
	if err := json.Unmarshal(frames[len(frames)-1].Data, &response); err != nil {
		t.Fatal(err)
	}
	if response.Code != 0 || response.Data.MIME != "image/png" || response.Data.Model != tryon.GPTImageModel || response.Data.RequestID != header.Get("X-Request-ID") || response.Data.ProviderModel != tryon.GPTImageModel || response.Data.ProviderRequestID != "synthetic-upstream-id" || calls.Load() != 1 {
		t.Fatal("invalid response contract")
	}
}

func TestSSEHeartbeatsKeepStreamWithoutClaimingProgressAndDisconnectCancelsUpstream(t *testing.T) {
	data, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	img, err := imagevalidate.ValidateBytes(data, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	generator := blockingAPIGenerator{started: make(chan struct{}), stopped: make(chan struct{})}
	handlerStopped := make(chan struct{})
	admission := security.NewConcurrencyManager(1, 1)
	service, err := tryon.NewCoupleService(func() (tryon.ImageGenerator, error) { return generator, nil }, apiOutfits{image: img}, admission, usageFor(t))
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server("couple-sse-heartbeat")
	s.SetPort(0)
	s.SetDumpRouterMap(false)
	s.Group("/", func(group *ghttp.RouterGroup) {
		group.Middleware(middleware.RequestID, middleware.NewBodyLimitMiddleware(tryon.MaxBodyBytes).Handler)
		group.POST("/tryon/couple", func(r *ghttp.Request) {
			defer close(handlerStopped)
			r.SetCtxVar(middleware.CtxPrincipalID, "heartbeat-test-principal")
			coupleHandlerWithHeartbeat(service, 20*time.Millisecond)(r)
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
	input, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(s.GetListenedPort())+"/tryon/couple", bytes.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 2 * time.Second}).Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") || response.Header.Get("Cache-Control") != "no-store" {
		cancel()
		response.Body.Close()
		t.Fatalf("stream did not start correctly: %d %v", response.StatusCode, response.Header)
	}
	reader := bufio.NewReader(response.Body)
	heartbeats := 0
	for heartbeats < 2 {
		frame, err := readTestSSEFrame(reader)
		if err != nil {
			cancel()
			response.Body.Close()
			t.Fatal(err)
		}
		if frame.Event == "result" || frame.Event == "error" {
			cancel()
			response.Body.Close()
			t.Fatal("blocked generation unexpectedly produced a terminal event")
		}
		if frame.Event == "heartbeat" {
			heartbeats++
			var payload map[string]any
			if err := json.Unmarshal(frame.Data, &payload); err != nil {
				t.Fatal(err)
			}
			if _, ok := payload["phase"]; ok {
				t.Fatal("heartbeat must not claim a generation phase")
			}
		}
	}
	select {
	case <-generator.started:
	case <-time.After(time.Second):
		cancel()
		response.Body.Close()
		t.Fatal("generation did not start")
	}
	cancel()
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-generator.stopped:
	case <-time.After(time.Second):
		t.Fatal("client disconnect did not cancel upstream work")
	}
	select {
	case <-handlerStopped:
	case <-time.After(time.Second):
		t.Fatal("request handler did not finish after cancellation")
	}
	release, ok := admission.Acquire("heartbeat-test-principal")
	if !ok {
		t.Fatal("finished handler leaked the concurrency slot")
	}
	release()
}

func TestProductionCoupleRouteRejectsUnconfiguredModel(t *testing.T) {
	inBackendRoot(t)
	const token = "synthetic-runtime-token-0000000000000000"
	t.Setenv("TRYON_API_KEYS", token+"-0-false,"+token+"-0-true,"+token+"-9437184-false,"+token+"-9437184-true")
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
	input, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
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
			req.Header.Set("Authorization", "Bearer "+token+"-"+strconv.Itoa(padding)+"-"+strconv.FormatBool(chunked))
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
			frames, frameErr := decodeTestSSE(payload)
			if response.StatusCode != 200 || frameErr != nil || len(frames) == 0 || frames[len(frames)-1].Event != "error" || !bytes.Contains(frames[len(frames)-1].Data, []byte("MODEL_CONFIGURATION_INVALID")) {
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
		return tryon.NewGenerator(tryon.ModelConfig{Provider: "chuanapi", Model: tryon.GPTImageModel, BaseURL: upstream.URL + "/v1", APIKey: "synthetic-private-marker"}, upstream.Client().Transport)
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
	service, err := tryon.NewCoupleService(factory, apiOutfits{image: img}, admission, usageFor(t))
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
	input, _ := json.Marshal(tryon.CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(data), OutfitID: "W001", Scene: tryon.Scene{Mode: "original"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:"+strconv.Itoa(s.GetListenedPort())+"/tryon/couple", bytes.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", "synthetic-private-marker")
	client := &http.Client{Timeout: 2 * time.Second}
	type responseResult struct {
		response *http.Response
		err      error
	}
	done := make(chan responseResult, 1)
	go func() {
		response, err := client.Do(req)
		done <- responseResult{response: response, err: err}
	}()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		t.Fatal("upstream not reached")
	}
	var response responseResult
	select {
	case response = <-done:
	case <-time.After(time.Second):
		t.Fatal("SSE response headers were not flushed")
	}
	if response.err != nil || response.response == nil || response.response.StatusCode != http.StatusOK || !strings.HasPrefix(response.response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected an established event stream: %+v", response)
	}
	cancel()
	if err := response.response.Body.Close(); err != nil {
		t.Error(err)
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

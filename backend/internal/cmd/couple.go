package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"backend/internal/catalog"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"github.com/gogf/gf/v2/net/ghttp"
)

func modelFromEnvironment() (tryon.ImageGenerator, error) {
	return tryon.NewGenerator(tryon.ModelConfig{Provider: os.Getenv("MODEL_PROVIDER"), Model: os.Getenv("MODEL_NAME"), BaseURL: os.Getenv("MODEL_BASE_URL"), APIKey: os.Getenv("MODEL_API_KEY")}, http.DefaultTransport)
}

func generationService(loadManifest func() (*catalog.Manifest, error), securityService *security.Service) (*tryon.CoupleService, error) {
	return tryon.NewCoupleService(modelFromEnvironment, &catalog.Reader{Directory: "/assets/wedding", LoadManifest: loadManifest}, securityService.ConcurrencyManager, securityService.Usage)
}

type countedReader struct {
	reader io.Reader
	bytes  int64
}

func (r *countedReader) Read(buffer []byte) (int, error) {
	n, err := r.reader.Read(buffer)
	r.bytes += int64(n)
	return n, err
}

func readCoupleRequest(r *ghttp.Request, diagnostics *generationDiagnostics, trace tryon.RequestTrace) (tryon.CoupleRequest, *security.APIError) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return tryon.CoupleRequest{}, security.NewAPIError(415, 41501, "JSON_REQUIRED", "请求必须使用 application/json")
	}
	body := &countedReader{reader: r.Request.Body}
	readStarted := time.Now()
	input, err := decodeCouple(body)
	diagnostics.inputBytes = body.bytes
	trace.Record("reading_input", readStarted)
	if err == nil {
		return input, nil
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return input, security.ErrRequestTooLarge
	}
	return input, security.NewAPIError(422, 42200, "INVALID_REQUEST", "请求字段或 JSON 格式无效")
}

func openGenerationStream(r *ghttp.Request) (*sseEventWriter, *security.APIError) {
	writer := r.Response.RawWriter()
	if _, ok := writer.(http.Flusher); !ok {
		return nil, security.NewAPIError(500, 50001, "STREAM_UNAVAILABLE", "生成事件流不可用")
	}
	r.Response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	r.Response.Header().Set("X-Accel-Buffering", "no")
	r.Response.WriteHeader(http.StatusOK)
	return &sseEventWriter{writer: writer, flush: http.NewResponseController(writer).Flush}, nil
}

func coupleHandler(service *tryon.CoupleService) func(*ghttp.Request) {
	return coupleHandlerWithHeartbeat(service, heartbeatInterval)
}

func coupleHandlerWithHeartbeat(service *tryon.CoupleService, interval time.Duration) func(*ghttp.Request) {
	return func(r *ghttp.Request) {
		startedAt := time.Now()
		requestID := middleware.GetRequestID(r)
		diagnostics := &generationDiagnostics{startedAt: startedAt}
		defer diagnostics.log(requestID)
		r.Response.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithDeadline(r.Context(), startedAt.Add(tryon.RequestTimeout))
		defer cancel()

		events := make(chan tryon.StageObservation, 64)
		trace := tryon.RequestTrace{RequestID: requestID, StartedAt: startedAt, Observer: tryon.StageObserverFunc(func(event tryon.StageObservation) {
			diagnostics.observe(event)
			select {
			case events <- event:
			case <-ctx.Done():
			}
		})}
		input, apiError := readCoupleRequest(r, diagnostics, trace)
		if apiError != nil {
			diagnostics.apiHTTPStatus = apiError.HTTPStatus
			diagnostics.errorCategory = apiError.ErrorCode
			middleware.WriteAPIError(r, apiError)
			return
		}
		writer, apiError := openGenerationStream(r)
		if apiError != nil {
			diagnostics.apiHTTPStatus = apiError.HTTPStatus
			diagnostics.errorCategory = apiError.ErrorCode
			middleware.WriteAPIError(r, apiError)
			return
		}
		outcome := make(chan generationOutcome, 1)
		stream := generationStream{writer: writer, trace: trace, diagnostics: diagnostics, events: events, outcome: outcome}
		if err := stream.drainStages(); err != nil {
			diagnostics.errorCategory = "stream_write_failure"
			return
		}
		principal := r.GetCtxVar(middleware.CtxPrincipalID).String()
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			response, apiError := service.Generate(ctx, principal, trace, input)
			outcome <- generationOutcome{response: response, apiError: apiError}
		}()
		defer func() { cancel(); <-finished }()
		if err := stream.run(r.Request.Context(), interval); err != nil {
			diagnostics.errorCategory = "stream_write_failure"
		}
	}
}

func decodeCouple(body io.Reader) (tryon.CoupleRequest, error) {
	fields, err := strictObject(json.NewDecoder(body), "couple_image", "outfit_id", "scene")
	if err != nil {
		return tryon.CoupleRequest{}, err
	}
	var input tryon.CoupleRequest
	for key, target := range map[string]*string{"couple_image": &input.CoupleImage, "outfit_id": &input.OutfitID} {
		if len(fields[key]) == 0 || string(fields[key]) == "null" {
			return input, errors.New("missing string")
		}
		if err := json.Unmarshal(fields[key], target); err != nil {
			return input, err
		}
	}
	scene, err := strictObject(json.NewDecoder(strings.NewReader(string(fields["scene"]))), "mode", "image", "venue_id")
	if err != nil {
		return input, err
	}
	if len(scene["mode"]) == 0 || string(scene["mode"]) == "null" || string(scene["image"]) == "null" {
		return input, errors.New("invalid scene")
	}
	if err := json.Unmarshal(scene["mode"], &input.Scene.Mode); err != nil {
		return input, err
	}
	if len(scene["image"]) != 0 {
		if err := json.Unmarshal(scene["image"], &input.Scene.Image); err != nil {
			return input, err
		}
		if input.Scene.Mode != "upload" {
			return input, errors.New("original scene cannot contain image")
		}
	}
	if len(scene["venue_id"]) != 0 {
		if input.Scene.Mode != "venue" || string(scene["venue_id"]) == "null" {
			return input, errors.New("venue_id requires venue mode")
		}
		if err := json.Unmarshal(scene["venue_id"], &input.Scene.VenueID); err != nil {
			return input, err
		}
	}
	return input, nil
}

// Reject duplicate and case-variant keys rather than relying on Go's permissive field matching.
func strictObject(decoder *json.Decoder, allowed ...string) (map[string]json.RawMessage, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if token != json.Delim('{') {
		return nil, errors.New("expected object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected field")
		}
		known := false
		for _, name := range allowed {
			if key == name {
				known = true
				break
			}
		}
		if !known || fields[key] != nil {
			return nil, errors.New("unknown or duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("trailing JSON")
	}
	return fields, nil
}

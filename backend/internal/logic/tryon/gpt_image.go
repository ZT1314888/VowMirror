package tryon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const multipartFixedOverhead = 4 << 10

type GPTImage struct {
	config ModelConfig
	client *http.Client
}

func (g *GPTImage) Model() string { return g.config.Model }

func (g *GPTImage) Generate(ctx context.Context, input GenerationRequest) (*GenerationResult, error) {
	assemblyStarted := time.Now()
	input.Trace.Mark(StageObservation{Phase: "assembling_request"})
	if err := validateReferences(input.References); err != nil {
		input.Trace.RecordObservation(StageObservation{Phase: "assembling_request", ErrorCategory: "invalid_references"}, assemblyStarted)
		return nil, err
	}
	if input.Prompt == "" || utf8.RuneCountInString(input.Prompt) > 32000 {
		input.Trace.RecordObservation(StageObservation{Phase: "assembling_request", ErrorCategory: "invalid_prompt"}, assemblyStarted)
		return nil, ErrReferences
	}
	body, contentType, err := g.editForm(input)
	if err != nil {
		input.Trace.RecordObservation(StageObservation{Phase: "assembling_request", ErrorCategory: "request_assembly"}, assemblyStarted)
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(g.config.BaseURL, "/")+"/images/edits", bytes.NewReader(body))
	if err != nil {
		input.Trace.RecordObservation(StageObservation{Phase: "assembling_request", ErrorCategory: "request_assembly", RequestBytes: int64(len(body))}, assemblyStarted)
		return nil, ErrConfiguration
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+g.config.APIKey)
	input.Trace.RecordObservation(StageObservation{Phase: "assembling_request", RequestBytes: int64(len(body))}, assemblyStarted)
	started := time.Now()
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), modelClientTrace(input.Trace, started)))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if input.BeforeSend != nil {
		if err := input.BeforeSend(ctx); err != nil {
			return nil, err
		}
	}
	resp, err := g.client.Do(req)
	if err != nil {
		category := "transport_failure"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			category = "timeout"
		} else if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
			category = "cancelled"
		}
		input.Trace.RecordObservation(StageObservation{Phase: "upstream_request_failed", RequestBytes: int64(len(body)), ErrorCategory: category}, started)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrUpstream
	}
	defer resp.Body.Close()
	headerRequestID := resp.Header.Get("X-Request-ID")
	validHeader := validProviderIdentifier(headerRequestID, g.config.APIKey)
	statusCategory := ""
	if resp.StatusCode != http.StatusOK {
		statusCategory = "provider_status"
	}
	if !validHeader {
		statusCategory = "invalid_provider_metadata"
		headerRequestID = ""
	}
	input.Trace.RecordObservation(StageObservation{Phase: "provider_response_headers", ProviderRequestID: headerRequestID, HTTPStatus: resp.StatusCode, RequestBytes: int64(len(body)), ErrorCategory: statusCategory}, started)
	if !validHeader {
		return nil, ErrResult
	}
	if statusCategory != "" {
		return nil, ErrUpstream
	}
	readStarted := time.Now()
	input.Trace.Mark(StageObservation{Phase: "reading_provider_response"})
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	readCategory := ""
	if err != nil || int64(len(data)) > MaxResponseBytes {
		readCategory = "response_read_failure"
	}
	input.Trace.RecordObservation(StageObservation{Phase: "reading_provider_response", HTTPStatus: resp.StatusCode, RequestBytes: int64(len(body)), ResponseBytes: int64(len(data)), ErrorCategory: readCategory}, readStarted)
	if readCategory != "" {
		return nil, ErrUpstream
	}
	validationStarted := time.Now()
	input.Trace.Mark(StageObservation{Phase: "validating_provider_result"})
	result, err := g.parseResult(data, headerRequestID)
	validationCategory := ""
	if err != nil {
		validationCategory = "invalid_provider_result"
	}
	input.Trace.RecordObservation(StageObservation{Phase: "validating_provider_result", HTTPStatus: resp.StatusCode, RequestBytes: int64(len(body)), ResponseBytes: int64(len(data)), ErrorCategory: validationCategory}, validationStarted)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return result, nil
}

func (g *GPTImage) editForm(input GenerationRequest) ([]byte, string, error) {
	var body bytes.Buffer
	var imageBytes int64
	for _, ref := range input.References {
		imageBytes += int64(ref.Image.Size())
	}
	capacity := imageBytes + int64(len(input.Prompt)) + multipartFixedOverhead
	if capacity > MaxProviderRequestBytes {
		return nil, "", ErrReferences
	}
	body.Grow(int(capacity))
	writer := multipart.NewWriter(&body)
	for _, field := range [][2]string{{"model", g.Model()}, {"prompt", input.Prompt}, {"n", "1"}, {"size", OutputSize}, {"quality", OutputQuality}, {"output_format", "png"}} {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			return nil, "", ErrReferences
		}
	}
	extensions := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
	for _, ref := range input.References {
		mimeType := ref.Image.MIME()
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="image[]"; filename="`+string(ref.Role)+"."+extensions[mimeType]+`"`)
		header.Set("Content-Type", mimeType)
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, "", ErrReferences
		}
		if _, err := ref.Image.WriteTo(part); err != nil {
			return nil, "", ErrReferences
		}
	}
	if writer.Close() != nil || body.Len() > MaxProviderRequestBytes {
		return nil, "", ErrReferences
	}
	return body.Bytes(), writer.FormDataContentType(), nil
}

var metadataIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validProviderIdentifier(value, apiKey string) bool {
	if value == "" {
		return true
	}
	lower := strings.ToLower(value)
	return metadataIdentifier.MatchString(value) && net.ParseIP(value) == nil &&
		(apiKey == "" || !strings.Contains(value, apiKey)) && !strings.Contains(lower, "sk-") &&
		!strings.Contains(lower, "aiza") && !strings.Contains(lower, "bearer")
}

// A dated snapshot of the requested model is allowed; another model never is.
func matchesModel(requested, reported string) bool {
	if reported == "" || reported == requested {
		return true
	}
	date := strings.TrimPrefix(reported, requested+"-")
	if date == reported {
		return false
	}
	_, err := time.Parse("2006-01-02", date)
	return err == nil
}

func (g *GPTImage) parseResult(data []byte, headerRequestID string) (*GenerationResult, error) {
	var body struct {
		Data []struct {
			Base64 string `json:"b64_json"`
			URL    string `json:"url"`
		} `json:"data"`
		Model        string          `json:"model"`
		RequestID    string          `json:"request_id"`
		OutputFormat string          `json:"output_format"`
		Size         string          `json:"size"`
		Quality      string          `json:"quality"`
		Error        json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &body) != nil || len(body.Error) != 0 || len(body.Data) != 1 || body.Data[0].URL != "" || body.Data[0].Base64 == "" {
		return nil, ErrResult
	}
	if (body.OutputFormat != "" && body.OutputFormat != "png") || (body.Size != "" && body.Size != OutputSize) || (body.Quality != "" && body.Quality != OutputQuality) || !matchesModel(g.Model(), body.Model) {
		return nil, ErrResult
	}
	for _, value := range []string{body.Model, body.RequestID, headerRequestID} {
		if !validProviderIdentifier(value, g.config.APIKey) {
			return nil, ErrResult
		}
	}
	if headerRequestID != "" && body.RequestID != "" && headerRequestID != body.RequestID {
		return nil, ErrResult
	}
	requestID := headerRequestID
	if requestID == "" {
		requestID = body.RequestID
	}
	image, err := ValidateResultBase64(body.Data[0].Base64)
	if err != nil {
		return nil, err
	}
	return &GenerationResult{Image: image, ProviderModel: body.Model, ProviderRequestID: requestID}, nil
}

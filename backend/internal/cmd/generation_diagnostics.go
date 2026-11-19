package cmd

import (
	"backend/internal/logic/tryon"
	"log/slog"
	"sync"
	"time"
)

// This is the complete diagnostic allowlist. No transport errors, addresses,
// credentials, input images or provider bodies are accepted by this collector.
type generationDiagnostics struct {
	mu                    sync.Mutex
	startedAt             time.Time
	stageElapsedMS        map[string]int64
	stageDurationMS       map[string]int64
	lastStage             string
	connectionReused      *bool
	providerRequestID     string
	upstreamHTTPStatus    int
	upstreamErrorCategory string
	apiHTTPStatus         int
	errorCategory         string
	inputBytes            int64
	upstreamRequestBytes  int64
	upstreamResponseBytes int64
}

func (d *generationDiagnostics) observe(event tryon.StageObservation) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stageElapsedMS == nil {
		d.stageElapsedMS = make(map[string]int64)
		d.stageDurationMS = make(map[string]int64)
	}
	d.stageElapsedMS[event.Phase] = event.ElapsedMS
	if event.DurationMS != nil {
		d.stageDurationMS[event.Phase] = *event.DurationMS
	}
	if event.Phase != "upstream_request_failed" {
		d.lastStage = event.Phase
	}
	if event.ConnectionReused != nil {
		d.connectionReused = event.ConnectionReused
	}
	if event.ProviderRequestID != "" {
		d.providerRequestID = event.ProviderRequestID
	}
	if event.HTTPStatus != 0 {
		d.upstreamHTTPStatus = event.HTTPStatus
	}
	if event.RequestBytes != 0 {
		d.upstreamRequestBytes = event.RequestBytes
	}
	if event.ResponseBytes != 0 {
		d.upstreamResponseBytes = event.ResponseBytes
	}
	if event.ErrorCategory != "" {
		d.upstreamErrorCategory = event.ErrorCategory
	}
}

func (d *generationDiagnostics) log(requestID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var reused any
	if d.connectionReused != nil {
		reused = *d.connectionReused
	}
	slog.Info("generation request finished",
		"request_id", requestID,
		"provider_request_id", d.providerRequestID,
		"stage_elapsed_ms", d.stageElapsedMS,
		"stage_duration_ms", d.stageDurationMS,
		"last_stage", d.lastStage,
		"connection_reused", reused,
		"api_http_status", d.apiHTTPStatus,
		"upstream_http_status", d.upstreamHTTPStatus,
		"error_category", d.errorCategory,
		"upstream_error_category", d.upstreamErrorCategory,
		"input_bytes", d.inputBytes,
		"upstream_request_bytes", d.upstreamRequestBytes,
		"upstream_response_bytes", d.upstreamResponseBytes,
		"elapsed_ms", time.Since(d.startedAt).Milliseconds())
}

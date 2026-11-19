package cmd

import (
	"backend/internal/logic/tryon"
	"backend/internal/security"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

const heartbeatInterval = 10 * time.Second
const maxSSEEventBytes = 12 << 20
const maxSSEStreamBytes = 13 << 20

var errSSELimitExceeded = errors.New("SSE response size limit exceeded")
var errSSETerminalSent = errors.New("SSE terminal event already sent")

type sseEventWriter struct {
	writer   io.Writer
	flush    func() error
	written  int64
	terminal bool
}

func (w *sseEventWriter) Write(event string, payload any) error {
	if w.terminal {
		return errSSETerminalSent
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame := "event: " + event + "\ndata: " + string(encoded) + "\n\n"
	if len(frame) > maxSSEEventBytes || w.written+int64(len(frame)) > maxSSEStreamBytes {
		return errSSELimitExceeded
	}
	written, err := io.WriteString(w.writer, frame)
	if err != nil {
		return err
	}
	if written != len(frame) {
		return io.ErrShortWrite
	}
	w.written += int64(written)
	if err := w.flush(); err != nil {
		return err
	}
	w.terminal = event == "result" || event == "error"
	return nil
}

type generationOutcome struct {
	response *tryon.CoupleResponse
	apiError *security.APIError
}

type statusEvent struct {
	RequestID         string `json:"request_id"`
	Phase             string `json:"phase"`
	ElapsedMS         int64  `json:"elapsed_ms"`
	DurationMS        *int64 `json:"duration_ms,omitempty"`
	HTTPStatus        int    `json:"http_status,omitempty"`
	ProviderRequestID string `json:"provider_request_id,omitempty"`
	ConnectionReused  *bool  `json:"connection_reused,omitempty"`
}

type heartbeatEvent struct {
	RequestID string `json:"request_id"`
	ElapsedMS int64  `json:"elapsed_ms"`
}

type generationStream struct {
	writer      *sseEventWriter
	trace       tryon.RequestTrace
	diagnostics *generationDiagnostics
	events      <-chan tryon.StageObservation
	outcome     <-chan generationOutcome
}

func (s generationStream) status(event tryon.StageObservation) error {
	return s.writer.Write("status", statusEvent{
		RequestID: s.trace.RequestID, Phase: event.Phase, ElapsedMS: event.ElapsedMS,
		DurationMS: event.DurationMS, HTTPStatus: event.HTTPStatus,
		ProviderRequestID: event.ProviderRequestID, ConnectionReused: event.ConnectionReused})
}

func (s generationStream) drainStages() error {
	for {
		select {
		case event := <-s.events:
			if err := s.status(event); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

func (s generationStream) terminal(result generationOutcome) error {
	if result.apiError != nil {
		return s.failure(result.apiError)
	}
	if result.response == nil {
		return s.failure(security.NewAPIError(502, 50201, "MODEL_REQUEST_FAILED", tryon.ErrUpstream.Error()))
	}
	s.diagnostics.apiHTTPStatus = http.StatusOK
	err := s.writer.Write("result", map[string]any{"code": 0, "message": "", "data": result.response})
	if errors.Is(err, errSSELimitExceeded) {
		return s.failure(security.NewAPIError(502, 50202, "INVALID_MODEL_RESULT", tryon.ErrResult.Error()))
	}
	return err
}

func (s generationStream) failure(apiError *security.APIError) error {
	s.diagnostics.apiHTTPStatus = apiError.HTTPStatus
	s.diagnostics.errorCategory = apiError.ErrorCode
	return s.writer.Write("error", map[string]any{
		"code": apiError.BizCode, "message": apiError.Message,
		"data": map[string]any{"error_code": apiError.ErrorCode, "request_id": s.trace.RequestID, "http_status": apiError.HTTPStatus}})
}

// Only the request handler calls these write methods. Transport callbacks only
// enqueue observations; cancellation waits for the generator to release its slot.
func (s generationStream) run(clientCtx context.Context, interval time.Duration) error {
	heartbeats := time.NewTicker(interval)
	defer heartbeats.Stop()
	clientDisconnected := clientCtx.Done()
	for {
		select {
		case event := <-s.events:
			if err := s.status(event); err != nil {
				return err
			}
		case <-heartbeats.C:
			if err := s.writer.Write("heartbeat", heartbeatEvent{RequestID: s.trace.RequestID, ElapsedMS: time.Since(s.trace.StartedAt).Milliseconds()}); err != nil {
				return err
			}
		case result := <-s.outcome:
			if err := s.drainStages(); err != nil {
				return err
			}
			return s.terminal(result)
		case <-clientDisconnected:
			if errors.Is(clientCtx.Err(), context.DeadlineExceeded) {
				clientDisconnected = nil
				continue
			}
			s.diagnostics.errorCategory = "client_cancelled"
			return nil
		}
	}
}

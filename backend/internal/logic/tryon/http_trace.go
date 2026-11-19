package tryon

import (
	"crypto/tls"
	"net/http/httptrace"
	"sync"
	"time"
)

// Addresses only distinguish parallel connection attempts in memory; they never
// enter the observer, SSE events or diagnostics.
type connectionTiming struct {
	mu     sync.Mutex
	starts map[string]time.Time
	trace  RequestTrace
}

func (t *connectionTiming) start(phase, key string) {
	t.mu.Lock()
	t.starts[key] = time.Now()
	t.mu.Unlock()
	t.trace.Mark(StageObservation{Phase: phase})
}

func (t *connectionTiming) take(key string) time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	started := t.starts[key]
	delete(t.starts, key)
	return started
}

func (t *connectionTiming) finish(phase, key, category string, err error) {
	started := t.take(key)
	if started.IsZero() {
		return
	}
	if err == nil {
		category = ""
	}
	t.trace.RecordObservation(StageObservation{Phase: phase, ErrorCategory: category}, started)
}

func modelClientTrace(trace RequestTrace, requestStarted time.Time) *httptrace.ClientTrace {
	timing := &connectionTiming{trace: trace, starts: make(map[string]time.Time)}
	return &httptrace.ClientTrace{
		GetConn: func(string) { timing.start("connection_acquisition", "connection") },
		GotConn: func(info httptrace.GotConnInfo) {
			reused := info.Reused
			trace.RecordObservation(StageObservation{Phase: "connection_acquired", ConnectionReused: &reused}, timing.take("connection"))
		},
		DNSStart:     func(httptrace.DNSStartInfo) { timing.start("dns_lookup", "dns") },
		DNSDone:      func(info httptrace.DNSDoneInfo) { timing.finish("dns_lookup", "dns", "dns_failure", info.Err) },
		ConnectStart: func(network, address string) { timing.start("tcp_connect", network+address) },
		ConnectDone: func(network, address string, err error) {
			timing.finish("tcp_connect", network+address, "tcp_failure", err)
		},
		TLSHandshakeStart: func() { timing.start("tls_handshake", "tls") },
		TLSHandshakeDone:  func(_ tls.ConnectionState, err error) { timing.finish("tls_handshake", "tls", "tls_failure", err) },
		WroteHeaders:      func() { timing.start("request_upload", "upload") },
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			timing.finish("request_upload", "upload", "upload_failure", info.Err)
			if info.Err == nil {
				trace.Mark(StageObservation{Phase: "waiting_upstream_response"})
			}
		},
		GotFirstResponseByte: func() { trace.Record("first_response_byte", requestStarted) },
	}
}

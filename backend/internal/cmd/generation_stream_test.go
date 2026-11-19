package cmd

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

type failingStreamWriter struct {
	err   error
	short bool
}

func (w failingStreamWriter) Write(data []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	if w.short {
		return len(data) - 1, nil
	}
	return len(data), nil
}

func TestSSEWriterChecksWriteShortWriteAndFlushErrors(t *testing.T) {
	writeError := errors.New("synthetic write failure")
	flushError := errors.New("synthetic flush failure")
	for _, scenario := range []struct {
		name   string
		writer io.Writer
		flush  func() error
		want   error
	}{
		{"write", failingStreamWriter{err: writeError}, func() error { return nil }, writeError},
		{"short write", failingStreamWriter{short: true}, func() error { return nil }, io.ErrShortWrite},
		{"flush", &bytes.Buffer{}, func() error { return flushError }, flushError},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			writer := sseEventWriter{writer: scenario.writer, flush: scenario.flush}
			if err := writer.Write("status", map[string]string{"phase": "synthetic"}); !errors.Is(err, scenario.want) {
				t.Fatalf("lost stream failure: %v", err)
			}
		})
	}
}

func TestSSEWriterLimitsBeforeWriteAndRejectsEventsAfterTerminal(t *testing.T) {
	var output bytes.Buffer
	writer := sseEventWriter{writer: &output, flush: func() error { return nil }}
	if err := writer.Write("result", strings.Repeat("x", maxSSEEventBytes)); !errors.Is(err, errSSELimitExceeded) || output.Len() != 0 {
		t.Fatal("oversize frame was partially written")
	}
	if err := writer.Write("error", map[string]int{"code": 502}); err != nil {
		t.Fatal(err)
	}
	written := output.Len()
	if err := writer.Write("result", map[string]int{"code": 0}); !errors.Is(err, errSSETerminalSent) || output.Len() != written {
		t.Fatal("duplicate terminal changed stream")
	}
	limited := sseEventWriter{writer: &bytes.Buffer{}, flush: func() error { return nil }, written: maxSSEStreamBytes - 1}
	if err := limited.Write("status", map[string]int{"elapsed_ms": 1}); !errors.Is(err, errSSELimitExceeded) {
		t.Fatal("cumulative limit not enforced")
	}
}

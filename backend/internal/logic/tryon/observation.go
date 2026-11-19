package tryon

import "time"

type StageObservation struct {
	Phase             string
	ElapsedMS         int64
	DurationMS        *int64
	HTTPStatus        int
	ProviderRequestID string
	RequestBytes      int64
	ResponseBytes     int64
	ErrorCategory     string
	ConnectionReused  *bool
}

type StageObserver interface {
	Observe(StageObservation)
}

type StageObserverFunc func(StageObservation)

func (f StageObserverFunc) Observe(event StageObservation) { f(event) }

type RequestTrace struct {
	RequestID string
	StartedAt time.Time
	Observer  StageObserver
}

func (t RequestTrace) Mark(event StageObservation) {
	if t.Observer == nil {
		return
	}
	if t.StartedAt.IsZero() {
		t.StartedAt = time.Now()
	}
	event.ElapsedMS = time.Since(t.StartedAt).Milliseconds()
	t.Observer.Observe(event)
}

func (t RequestTrace) Record(phase string, stageStarted time.Time) {
	t.RecordObservation(StageObservation{Phase: phase}, stageStarted)
}

func (t RequestTrace) RecordObservation(event StageObservation, stageStarted time.Time) {
	if t.Observer == nil {
		return
	}
	if t.StartedAt.IsZero() {
		t.StartedAt = stageStarted
	}
	now := time.Now()
	event.ElapsedMS = now.Sub(t.StartedAt).Milliseconds()
	if !stageStarted.IsZero() {
		duration := now.Sub(stageStarted).Milliseconds()
		event.DurationMS = &duration
	}
	t.Observer.Observe(event)
}

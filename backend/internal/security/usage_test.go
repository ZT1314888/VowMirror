package security

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUsagePersistsAndLimitsSuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	ctx := context.Background()
	q, err := OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < SuccessLimit; i++ {
		remaining, err := q.Check(ctx, "hash")
		if err != nil || remaining != SuccessLimit-i {
			t.Fatalf("remaining %d: %v", remaining, err)
		}
		if err := q.RecordAttempt(ctx, "hash"); err != nil {
			t.Fatal(err)
		}
		if err := q.RecordSuccess(ctx, "hash"); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if _, err := q.Check(ctx, "hash"); err != ErrSuccessQuotaExceeded {
		t.Fatalf("restart lost success count: %v", err)
	}
	if err := q.RecordAttempt(ctx, "hash"); err != ErrSuccessQuotaExceeded {
		t.Fatalf("sixth attempt: %v", err)
	}
	if n, err := q.Check(ctx, "other"); err != nil || n != SuccessLimit {
		t.Fatalf("principal isolation: %d %v", n, err)
	}
}

func TestUsageDailyAttemptsUTCAndStorageFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	ctx := context.Background()
	q, err := OpenUsageLedger(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, 1, 1, 23, 59, 0, 0, time.UTC)
	q.now = func() time.Time { return clock }
	for i := 0; i < 2; i++ {
		if err := q.RecordAttempt(ctx, "hash"); err != nil {
			t.Fatal(err)
		}
	}
	if remaining, err := q.Check(ctx, "hash"); err != ErrDailyQuotaExceeded || remaining != SuccessLimit {
		t.Fatalf("attempt failures must not deduct successes: %d %v", remaining, err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = OpenUsageLedger(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	q.now = func() time.Time { return clock }
	if err := q.RecordAttempt(ctx, "hash"); err != ErrDailyQuotaExceeded {
		t.Fatalf("restart lost attempts: %v", err)
	}
	clock = clock.Add(2 * time.Minute).In(time.FixedZone("UTC+8", 8*60*60))
	if err := q.RecordAttempt(ctx, "hash"); err != nil {
		t.Fatalf("UTC day rollover: %v", err)
	}
	if err := q.RecordSuccess(ctx, "hash"); err != nil {
		t.Fatal(err)
	}
	if remaining, err := q.Check(ctx, "hash"); err != nil || remaining != 4 {
		t.Fatalf("rollover success count: %d %v", remaining, err)
	}
	q.Close()
	if _, err := q.Check(ctx, "hash"); err != ErrUsageUnavailable {
		t.Fatalf("closed database: %v", err)
	}
	if err := q.RecordAttempt(ctx, "hash"); err != ErrUsageUnavailable {
		t.Fatalf("closed attempt: %v", err)
	}
	if err := q.RecordSuccess(ctx, "hash"); err != ErrUsageUnavailable {
		t.Fatalf("closed success: %v", err)
	}
}

func TestUsageAttemptAtomicAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	q, err := OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	second, err := OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ledger := []*UsageLedger{q, second}[i%2]
			err := ledger.RecordAttempt(context.Background(), "hash")
			if err == nil {
				allowed.Add(1)
			} else if err != ErrDailyQuotaExceeded {
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if allowed.Load() != 10 {
		t.Fatalf("concurrent attempts: %d", allowed.Load())
	}
}

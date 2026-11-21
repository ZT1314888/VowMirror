package tryon

import (
	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
	"context"
	"path/filepath"
	"testing"
)

func usageFor(t *testing.T) *security.UsageLedger {
	t.Helper()
	q, err := security.OpenUsageLedger(filepath.Join(t.TempDir(), "usage.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := q.Close(); err != nil {
			t.Error(err)
		}
	})
	return q
}

type commitCancelsUsage struct {
	*security.UsageLedger
	cancel context.CancelFunc
}

func (q commitCancelsUsage) RecordSuccess(ctx context.Context, principal string) *security.APIError {
	if err := q.UsageLedger.RecordSuccess(ctx, principal); err != nil {
		return err
	}
	q.cancel()
	return nil
}

func TestSuccessCommitIsFinalBeforeClientDisconnect(t *testing.T) {
	q := usageFor(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	gen := testGenerator{run: func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error) {
		return validResult(t), nil
	}}
	reader := testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) { return outfitImages(t), nil }}
	service, err := NewCoupleService(func() (ImageGenerator, error) { return gen, nil }, reader, security.NewConcurrencyManager(1, 1), commitCancelsUsage{q, cancel})
	if err != nil {
		t.Fatal(err)
	}
	response, apiError := service.Generate(ctx, "hash", RequestTrace{RequestID: "committed"}, coupleInput(t))
	if apiError != nil || response == nil || ctx.Err() == nil {
		t.Fatalf("post-commit cancellation changed outcome: %v", apiError)
	}
	if remaining, err := q.Check(context.Background(), "hash"); err != nil || remaining != 4 {
		t.Fatalf("committed quota: %d %v", remaining, err)
	}
}

func TestStorageFailureCannotReturnGenerationSuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.sqlite")
	q, err := security.OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	gen := testGenerator{run: func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error) {
		return validResult(t), nil
	}}
	reader := testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) { return outfitImages(t), nil }}
	service, err := NewCoupleService(func() (ImageGenerator, error) { return gen, nil }, reader, security.NewConcurrencyManager(1, 1), q)
	if err != nil {
		t.Fatal(err)
	}
	trace := RequestTrace{Observer: StageObserverFunc(func(event StageObservation) {
		if event.Phase == "validating_result" && event.DurationMS == nil {
			if err := q.Close(); err != nil {
				t.Error(err)
			}
		}
	})}
	response, apiError := service.Generate(context.Background(), "hash", trace, coupleInput(t))
	if response != nil || apiError != security.ErrUsageUnavailable {
		t.Fatalf("storage failure returned success: %v", apiError)
	}
	reopened, err := security.OpenUsageLedger(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if remaining, err := reopened.Check(context.Background(), "hash"); err != nil || remaining != 5 {
		t.Fatalf("failed commit consumed success: %d %v", remaining, err)
	}
}

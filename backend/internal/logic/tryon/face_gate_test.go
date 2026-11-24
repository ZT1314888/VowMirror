package tryon

import (
	"bytes"
	"context"
	"errors"
	"image"
	"testing"

	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
)

type unexpectedAssetReads struct{ t *testing.T }

func (r unexpectedAssetReads) ReadOutfit(context.Context, string) (catalog.OutfitImages, error) {
	r.t.Error("read outfit before face gate passed")
	return catalog.OutfitImages{}, errors.New("unexpected outfit read")
}

func (r unexpectedAssetReads) ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	r.t.Error("read venue before face gate passed")
	return nil, errors.New("unexpected venue read")
}

func (r unexpectedAssetReads) ReadPose(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	r.t.Error("read pose before face gate passed")
	return nil, errors.New("unexpected pose read")
}

type gateUsage struct{ checks, attempts, successes int }

func (u *gateUsage) Check(context.Context, string) (int, *security.APIError) {
	u.checks++
	return 5, nil
}
func (u *gateUsage) RecordAttempt(context.Context, string) *security.APIError {
	u.attempts++
	return nil
}
func (u *gateUsage) RecordSuccess(context.Context, string) *security.APIError {
	u.successes++
	return nil
}

func TestFaceGateStopsBeforeAssetsAndAccounting(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		count      int
		failure    error
		cancel     bool
	}{
		{name: "zero", code: "COUPLE_IMAGE_NOT_COUPLE"},
		{name: "one", code: "COUPLE_IMAGE_NOT_COUPLE", count: 1},
		{name: "failure", code: "FACE_DETECTION_UNAVAILABLE", failure: errors.New("internal detector detail")},
		{name: "cancel", code: "GENERATION_CANCELLED", count: 2, cancel: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			usage := new(gateUsage)
			admission := security.NewConcurrencyManager(1, 1)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			original := fixture(t, "jpg")
			calls := 0
			countFaces := func(callCtx context.Context, pixels image.Image, data []byte) (int, error) {
				calls++
				if usage.checks != 1 || pixels == nil || !bytes.Equal(data, original) {
					t.Fatal("detector needs validated pixels and original bytes after quota check")
				}
				if scenario.cancel {
					cancel()
					return 0, callCtx.Err()
				}
				return scenario.count, scenario.failure
			}
			service, err := NewCoupleService(func() (ImageGenerator, error) {
				t.Error("initialized generator before face gate passed")
				return nil, errors.New("unexpected generator")
			}, unexpectedAssetReads{t}, admission, usage, countFaces, func(context.Context) (catalog.Pose, error) {
				t.Error("selected pose before face gate passed")
				return catalog.Pose{}, catalog.ErrPoseUnavailable
			})
			if err != nil {
				t.Fatal(err)
			}
			input := coupleInput(t)
			input.Scene = Scene{Mode: "venue", VenueID: "V001"}
			result, apiErr := service.Generate(ctx, "principal", RequestTrace{}, input)
			if result != nil || apiErr == nil || apiErr.ErrorCode != scenario.code || calls != 1 {
				t.Fatalf("wrong gate outcome: error=%v calls=%d", apiErr, calls)
			}
			if usage.attempts != 0 || usage.successes != 0 {
				t.Fatal("recorded usage for a rejected photo")
			}
			release, ok := admission.Acquire("principal")
			if !ok {
				t.Fatal("face gate leaked the global or per-principal slot")
			}
			release()
		})
	}
}

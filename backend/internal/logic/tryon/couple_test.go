package tryon

import (
	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFixedVenueUsesSameFiveImageContract(t *testing.T) {
	manifest, err := catalog.LoadManifest("../../../../tests/fixtures/wedding-assets-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	manifest.Venues = []catalog.Venue{{ID: "V001", Name: "Synthetic venue", Path: "venues/V001/scene.webp"}}
	root := t.TempDir()
	outfit := manifest.Outfits[0]
	for _, entry := range []struct{ path, format string }{{outfit.Dress, "png"}, {outfit.Menswear, "jpg"}, {outfit.ShoesDetail, "png"}, {manifest.Venues[0].Path, "webp"}} {
		target := filepath.Join(root, entry.path)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, fixture(t, entry.format), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reader := &catalog.Reader{Directory: root, LoadManifest: func() (*catalog.Manifest, error) { return manifest, nil }}
	calls := 0
	gen := testGenerator{run: func(_ context.Context, input GenerationRequest) (*imagevalidate.ValidatedImage, error) {
		calls++
		if len(input.References) != 5 || input.References[4].Role != RoleScene || input.References[4].MIME != "image/webp" || !bytes.Equal(input.References[4].Data, fixture(t, "webp")) {
			t.Fatal("fixed scene reference changed")
		}
		if !strings.Contains(input.Prompt, "reference 5 only for the venue") {
			t.Fatal("fixed scene prompt missing")
		}
		return validResult(t), nil
	}}
	service := serviceFor(t, gen, reader, security.NewConcurrencyManager(1, 1))
	input := coupleInput(t)
	input.Scene = Scene{Mode: "venue", VenueID: "V001"}
	if _, err := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, input); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		scene Scene
		code  string
	}{
		{Scene{Mode: "venue", VenueID: "../V001"}, "UNKNOWN_VENUE"},
		{Scene{Mode: "venue", VenueID: "V999"}, "UNKNOWN_VENUE"},
		{Scene{Mode: "venue"}, "INVALID_REQUEST"},
		{Scene{Mode: "venue", VenueID: "V001", Image: "image"}, "INVALID_REQUEST"},
		{Scene{Mode: "upload", VenueID: "V001", Image: "image"}, "INVALID_REQUEST"},
		{Scene{Mode: "original", VenueID: "V001"}, "INVALID_REQUEST"},
	} {
		input.Scene = scenario.scene
		if _, err := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, input); err == nil || err.ErrorCode != scenario.code {
			t.Fatalf("scene %+v: %v", scenario.scene, err)
		}
	}
	input.Scene = Scene{Mode: "venue", VenueID: "V001"}
	if err := os.WriteFile(filepath.Join(root, manifest.Venues[0].Path), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, input); err == nil || err.ErrorCode != "VENUE_UNAVAILABLE" {
		t.Fatalf("corrupt venue: %v", err)
	}
	if calls != 1 {
		t.Fatal("invalid scenes reached generator")
	}
}

type testGenerator struct {
	run func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error)
}

func (g testGenerator) Generate(ctx context.Context, r GenerationRequest) (*GenerationResult, error) {
	if r.BeforeSend != nil {
		if err := r.BeforeSend(ctx); err != nil {
			return nil, err
		}
	}
	image, err := g.run(ctx, r)
	return &GenerationResult{Image: image}, err
}
func (g testGenerator) Model() string { return GPTImageModel }

type testOutfits struct {
	run func(context.Context, string) (catalog.OutfitImages, error)
}

func (r testOutfits) ReadOutfit(ctx context.Context, id string) (catalog.OutfitImages, error) {
	return r.run(ctx, id)
}
func (r testOutfits) ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	return nil, catalog.ErrUnknownVenue
}
func outfitImages(t *testing.T) catalog.OutfitImages {
	refs := references(t, false)
	imgs := make([]*imagevalidate.ValidatedImage, 3)
	for i, ref := range refs[1:] {
		img, err := imagevalidate.ValidateBytes(ref.Data, ref.MIME, imagevalidate.DefaultImageLimits())
		if err != nil {
			t.Fatal(err)
		}
		imgs[i] = img
	}
	return catalog.OutfitImages{Dress: imgs[0], Menswear: imgs[1], Shoes: imgs[2]}
}
func coupleInput(t *testing.T) CoupleRequest {
	return CoupleRequest{CoupleImage: base64.StdEncoding.EncodeToString(fixture(t, "jpg")), OutfitID: "W001", Scene: Scene{Mode: "original"}}
}

func TestCouplePromptLetsModelDecideDressWearer(t *testing.T) {
	pose, _ := fixedPosePicker(context.Background())
	prompt := couplePrompt(references(t, false), pose)
	for _, phrase := range []string{
		"Preserve both identities",
		"freely move, turn, and re-pose",
		"Decide from reference 1 which person should wear the wedding dress",
		"judging only by what the photo shows",
		"wedding dress from reference 2",
		"other person must wear only the menswear",
		"Do not mix garments",
	} {
		if !strings.Contains(prompt, phrase) {
			t.Errorf("prompt missing rule %q", phrase)
		}
	}
	for _, banned := range []string{"original left/right positions", "do not swap or move the people across sides", "Assign clothing by the selected side", "regardless of gender", "viewer's left", "viewer's right", "may intentionally put a man", "Do not infer clothing from gender"} {
		if strings.Contains(prompt, banned) {
			t.Errorf("prompt retains side-assignment rule %q", banned)
		}
	}
}

func twoFaces(context.Context, image.Image, []byte) (int, error) { return 2, nil }

func serviceFor(t *testing.T, generator ImageGenerator, reader AssetReader, admission Admission) *CoupleService {
	t.Helper()
	service, err := NewCoupleService(func() (ImageGenerator, error) { return generator, nil }, reader, admission, usageFor(t), twoFaces, fixedPosePicker)
	if err != nil {
		t.Fatal(err)
	}
	return service
}
func validResult(t *testing.T) *imagevalidate.ValidatedImage {
	t.Helper()
	result, err := ValidateResult(base64.StdEncoding.EncodeToString(landscape(t)))
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestCoupleServiceContract(t *testing.T) {
	for _, scene := range []bool{false, true} {
		var calls atomic.Int32
		reader := testOutfits{run: func(ctx context.Context, id string) (catalog.OutfitImages, error) {
			if id != "W001" {
				t.Error("wrong outfit")
			}
			return outfitImages(t), nil
		}}
		generator := testGenerator{run: func(ctx context.Context, r GenerationRequest) (*imagevalidate.ValidatedImage, error) {
			calls.Add(1)
			want := 4
			if scene {
				want = 5
			}
			if len(r.References) != want || r.References[0].MIME != "image/jpeg" || r.References[2].MIME != "image/webp" {
				t.Error("invalid generation contract")
			}
			for _, phrase := range []string{"Decide from reference 1 which person should wear the wedding dress", "identities", "faces", "natural proportions", "head to toe", "without cropping", "mix garments", "shoes_detail"} {
				if !strings.Contains(r.Prompt, phrase) {
					t.Errorf("missing prompt rule %s", phrase)
				}
			}
			if scene != strings.Contains(r.Prompt, "reference 5") {
				t.Error("scene prompt mismatch")
			}
			if scene {
				for _, phrase := range []string{"only for the venue", "architecture, stage and decorations", "without replacing the people"} {
					if !strings.Contains(r.Prompt, phrase) {
						t.Errorf("missing scene rule %s", phrase)
					}
				}
			} else if !strings.Contains(r.Prompt, "Preserve the original background from reference 1") {
				t.Error("original background rule missing")
			}
			if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > RequestTimeout {
				t.Error("missing deadline")
			}
			return validResult(t), nil
		}}
		service := serviceFor(t, generator, reader, security.NewConcurrencyManager(1, 1))
		input := coupleInput(t)
		if scene {
			input.Scene = Scene{Mode: "upload", Image: base64.StdEncoding.EncodeToString(fixture(t, "png"))}
		}
		response, err := service.Generate(context.Background(), "principal", RequestTrace{RequestID: "request-id"}, input)
		if err != nil || response.Model != GPTImageModel || response.MIME != "image/png" || response.RequestID != "request-id" || response.Width != OutputWidth || calls.Load() != 1 {
			t.Fatalf("invalid result: %v / %d", err, calls.Load())
		}
	}
}
func TestCoupleInvalidInputsNeverInvokeGenerator(t *testing.T) {
	var calls atomic.Int32
	generator := testGenerator{run: func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error) {
		calls.Add(1)
		return validResult(t), nil
	}}
	reader := testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) { return outfitImages(t), nil }}
	admission := security.NewConcurrencyManager(1, 1)
	service := serviceFor(t, generator, reader, admission)
	for _, modify := range []func(*CoupleRequest){
		func(r *CoupleRequest) { r.CoupleImage = "" }, func(r *CoupleRequest) { r.OutfitID = "" },
		func(r *CoupleRequest) { r.Scene = Scene{Mode: "venue"} }, func(r *CoupleRequest) { r.Scene.Image = "private-marker" },
		func(r *CoupleRequest) { r.Scene.Mode = "upload" }, func(r *CoupleRequest) { r.CoupleImage = "data:image/png;base64," + r.CoupleImage },
	} {
		input := coupleInput(t)
		modify(&input)
		if _, err := service.Generate(context.Background(), "principal", RequestTrace{RequestID: "id"}, input); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid inputs invoked generator")
	}
	service.newGenerator = func() (ImageGenerator, error) { return nil, errors.New("private-marker") }
	if _, err := service.Generate(context.Background(), "principal", RequestTrace{RequestID: "id"}, coupleInput(t)); err == nil || err.ErrorCode != "MODEL_CONFIGURATION_INVALID" || strings.Contains(err.Error(), "private-marker") {
		t.Fatal("unsafe config error")
	}
	release, ok := admission.Acquire("principal")
	if !ok {
		t.Fatal("configuration failure leaked concurrency")
	}
	release()
}

// Signal a deadline at a known execution boundary without racing setup or IO.
type triggeredDeadlineContext struct {
	context.Context
	done chan struct{}
}

func (c *triggeredDeadlineContext) Done() <-chan struct{} { return c.done }
func (c *triggeredDeadlineContext) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

func TestCoupleFailureAlwaysReleasesAdmission(t *testing.T) {
	for _, scenario := range []string{"upstream", "result", "asset", "unknown", "nil asset", "timeout", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			admission := security.NewConcurrencyManager(1, 1)
			ctx, cancel := context.WithCancel(context.Background())
			var deadline *triggeredDeadlineContext
			if scenario == "timeout" {
				deadline = &triggeredDeadlineContext{Context: context.Background(), done: make(chan struct{})}
				ctx = deadline
			}
			defer cancel()
			generator := testGenerator{run: func(ctx context.Context, r GenerationRequest) (*imagevalidate.ValidatedImage, error) {
				switch scenario {
				case "upstream":
					return nil, errors.New("private-marker")
				case "result":
					return &imagevalidate.ValidatedImage{MIME: "image/png", Data: []byte("private-marker")}, nil
				case "timeout":
					// testGenerator invokes BeforeSend before entering this callback.
					close(deadline.done)
					<-ctx.Done()
					return nil, ctx.Err()
				case "cancel":
					cancel()
					return validResult(t), nil
				}
				return validResult(t), nil
			}}
			reader := testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) {
				if scenario == "asset" {
					return catalog.OutfitImages{}, errors.New("private-marker")
				}
				if scenario == "unknown" {
					return catalog.OutfitImages{}, catalog.ErrUnknownOutfit
				}
				if scenario == "nil asset" {
					return catalog.OutfitImages{}, nil
				}
				return outfitImages(t), nil
			}}
			ledger, ledgerErr := security.OpenUsageLedger(filepath.Join(t.TempDir(), "failure.sqlite"), 1)
			if ledgerErr != nil {
				t.Fatal(ledgerErr)
			}
			defer ledger.Close()
			service, serviceErr := NewCoupleService(func() (ImageGenerator, error) { return generator, nil }, reader, admission, ledger, twoFaces, fixedPosePicker)
			if serviceErr != nil {
				t.Fatal(serviceErr)
			}
			want := map[string]string{"upstream": "MODEL_REQUEST_FAILED", "result": "INVALID_MODEL_RESULT", "asset": "OUTFIT_UNAVAILABLE", "unknown": "UNKNOWN_OUTFIT", "nil asset": "OUTFIT_UNAVAILABLE", "timeout": "GENERATION_TIMEOUT", "cancel": "GENERATION_CANCELLED"}[scenario]
			if _, err := service.Generate(ctx, "p", RequestTrace{RequestID: "id"}, coupleInput(t)); err == nil || err.ErrorCode != want || strings.Contains(err.Error(), "private-marker") {
				t.Fatalf("expected %s, got %v", want, err)
			}
			remaining, quotaError := ledger.Check(context.Background(), "p")
			sent := scenario == "upstream" || scenario == "result" || scenario == "timeout" || scenario == "cancel"
			if remaining != 5 || (sent && quotaError != security.ErrDailyQuotaExceeded) || (!sent && quotaError != nil) {
				t.Fatalf("failure accounting: remaining=%d, error=%v", remaining, quotaError)
			}
			release, ok := admission.Acquire("p")
			if !ok {
				t.Fatal("concurrency leaked")
			}
			release()
		})
	}
}
func TestCoupleConcurrentAttemptIsRejected(t *testing.T) {
	admission := security.NewConcurrencyManager(1, 1)
	entered := make(chan struct{})
	resume := make(chan struct{})
	done := make(chan *security.APIError, 1)
	output := validResult(t)
	images := outfitImages(t)
	var reads atomic.Int32
	service := serviceFor(t, testGenerator{run: func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error) {
		close(entered)
		<-resume
		return output, nil
	}}, testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) {
		reads.Add(1)
		return images, nil
	}}, admission)
	input := coupleInput(t)
	go func() {
		_, err := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, input)
		done <- err
	}()
	<-entered
	rejected := coupleInput(t)
	rejected.CoupleImage = "not-base64"
	rejected.Scene = Scene{Mode: "upload", Image: "not-base64"}
	_, err := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, rejected)
	readCount := reads.Load()
	close(resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err == nil || err.ErrorCode != "CONCURRENCY_LIMITED" {
		t.Fatalf("busy attempt must be rejected before image decoding, got %v", err)
	}
	if readCount != 1 {
		t.Fatalf("busy attempt read outfit assets: %d reads", readCount)
	}
	release, ok := admission.Acquire("p")
	if !ok {
		t.Fatal("success leaked concurrency")
	}
	release()
}
func TestReferenceTotalLimit(t *testing.T) {
	refs := references(t, true)
	// Each remains a complete valid image below 8 MiB; all five exceed 14 MiB.
	for i := range refs {
		refs[i].Data = append(append([]byte{}, refs[i].Data...), make([]byte, 5<<20)...)
	}
	if err := validateReferences(refs); !errors.Is(err, ErrReferences) {
		t.Fatal("combined references accepted")
	}
}

func TestBusyRequestsDoNotAllocateImagePixels(t *testing.T) {
	// A small compressed PNG whose full pixel buffer is 80 MB.
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 4000, 5000))); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(buffer.Bytes())
	if image, err := imagevalidate.ValidateImage(encoded, imagevalidate.DefaultImageLimits()); err != nil || image.Width != 4000 || image.Height != 5000 {
		t.Fatalf("pixel-allocation fixture must be a valid 20 MP image: %v", err)
	}
	input := CoupleRequest{CoupleImage: encoded, OutfitID: "W001", Scene: Scene{Mode: "upload", Image: encoded}}
	for _, scenario := range []struct {
		name, occupiedBy string
		globalLimit      int
	}{
		{"per principal", "p", 2},
		{"global", "other", 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			admission := security.NewConcurrencyManager(scenario.globalLimit, 1)
			release, ok := admission.Acquire(scenario.occupiedBy)
			if !ok {
				t.Fatal("cannot occupy concurrency slot")
			}
			defer release()
			service, err := NewCoupleService(func() (ImageGenerator, error) {
				t.Fatal("busy request initialized the model")
				return nil, nil
			}, testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) {
				t.Fatal("busy request read outfit assets")
				return catalog.OutfitImages{}, nil
			}}, admission, usageFor(t), twoFaces, fixedPosePicker)
			if err != nil {
				t.Fatal(err)
			}
			runtime.GC()
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			_, apiErr := service.Generate(context.Background(), "p", RequestTrace{RequestID: "id"}, input)
			runtime.ReadMemStats(&after)
			if apiErr == nil || apiErr.ErrorCode != "CONCURRENCY_LIMITED" {
				t.Fatalf("expected concurrency rejection, got %v", apiErr)
			}
			// Allow small runtime allocations, but never a decoded pixel buffer.
			const maxRejectedAllocation = 8 << 20
			allocated := after.TotalAlloc - before.TotalAlloc
			if allocated >= maxRejectedAllocation {
				t.Fatalf("busy request allocated %d bytes before rejection", allocated)
			}
			t.Logf("busy request allocated %d bytes; no pixel decoding", allocated)
		})
	}
}

func fixedPosePicker(context.Context) (catalog.Pose, error) {
	return catalog.Pose{ID: "P001", Mode: catalog.PoseText, Action: "Synthetic two-person side-by-side action."}, nil
}
func (r testOutfits) ReadPose(context.Context, string) (*imagevalidate.ValidatedImage, error) {
	return nil, catalog.ErrPoseUnavailable
}

package tryon

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
)

type poseAssets struct {
	testOutfits
	poseReads int
	poseImage *imagevalidate.ValidatedImage
	poseError error
	poseID    string
}

func (r *poseAssets) ReadPose(_ context.Context, id string) (*imagevalidate.ValidatedImage, error) {
	r.poseReads++
	r.poseID = id
	return r.poseImage, r.poseError
}

func loadProjectManifest(t *testing.T) *catalog.Manifest {
	t.Helper()
	m, err := catalog.LoadManifest("../../../../assets/wedding/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPoseCatalogDescriptionsReachPromptWithoutCrossPoseRules(t *testing.T) {
	m := loadProjectManifest(t)
	for _, pose := range m.Poses {
		refs := references(t, false)
		if pose.Mode == catalog.PoseLineartText {
			refs = append(refs, Reference{Role: RolePose, Image: validatedFixture(t, "png")})
		}
		prompt := couplePrompt(refs, pose)
		if !strings.Contains(prompt, pose.Action) {
			t.Fatalf("%s action missing", pose.ID)
		}
		if strings.Contains(prompt, "line drawing") != (pose.Mode == catalog.PoseLineartText) {
			t.Fatalf("%s mode mismatch", pose.ID)
		}
		if strings.Contains(prompt, "original left/right positions") {
			t.Fatal("old position lock remains")
		}
	}
}

func TestRandomPoseServiceSendsExactFourFiveAndSixImageMultipart(t *testing.T) {
	m := loadProjectManifest(t)
	output := imageResponse(landscape(t))
	for _, scene := range []bool{false, true} {
		for _, pose := range []catalog.Pose{m.Poses[0], m.Poses[6]} {
			t.Run(pose.ID+map[bool]string{false: "-original", true: "-scene"}[scene], func(t *testing.T) {
				reads, network := 0, 0
				poseImage, err := imagevalidate.ValidateBytes(fixture(t, "png"), "image/png", imagevalidate.DefaultImageLimits())
				if err != nil {
					t.Fatal(err)
				}
				assets := &poseAssets{testOutfits: testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) { return outfitImages(t), nil }}, poseImage: poseImage}
				gen, _ := tlsGenerator(t, func(w http.ResponseWriter, r *http.Request) {
					network++
					if err := r.ParseMultipartForm(MaxProviderRequestBytes); err != nil {
						t.Error(err)
						return
					}
					defer r.MultipartForm.RemoveAll()
					files := r.MultipartForm.File["image[]"]
					roles := []string{"couple", "dress", "menswear", "shoes_detail"}
					if scene {
						roles = append(roles, "scene")
					}
					if pose.Mode == catalog.PoseLineartText {
						roles = append(roles, "pose")
					}
					if len(files) != len(roles) {
						t.Errorf("wrong image count %d", len(files))
						return
					}
					for i, file := range files {
						if !strings.HasPrefix(file.Filename, roles[i]+".") {
							t.Errorf("wrong role %s", file.Filename)
						}
						if roles[i] == "pose" {
							assertMultipartPose(t, file, poseImage.Bytes())
						}
					}
					prompt := r.FormValue("prompt")
					if !strings.Contains(prompt, pose.Action) {
						t.Error("action not sent")
					}
					if pose.Mode == catalog.PoseLineartText {
						want := "reference 5 only as a specification"
						if scene {
							want = "reference 6 only as a specification"
						}
						if !strings.Contains(prompt, want) {
							t.Error("wrong pose index")
						}
					}
					if scene && !strings.Contains(prompt, "reference 5 only for the venue") {
						t.Error("wrong venue index")
					}
					_, _ = io.WriteString(w, output)
				})
				picker := func(context.Context) (catalog.Pose, error) { reads++; return pose, nil }
				service, err := NewCoupleService(func() (ImageGenerator, error) { return gen, nil }, assets, security.NewConcurrencyManager(1, 1), usageFor(t), twoFaces, picker)
				if err != nil {
					t.Fatal(err)
				}
				input := coupleInput(t)
				if scene {
					input.Scene = Scene{Mode: "upload", Image: input.CoupleImage}
				}
				if _, err := service.Generate(context.Background(), "p", RequestTrace{}, input); err != nil {
					t.Fatal(err)
				}
				wantReads := 0
				if pose.Mode == catalog.PoseLineartText {
					wantReads = 1
				}
				if reads != 1 || network != 1 || assets.poseReads != wantReads {
					t.Fatalf("selection/network/pose reads: %d/%d/%d", reads, network, assets.poseReads)
				}
				if wantReads == 1 && assets.poseID != pose.ID {
					t.Fatal("wrong pose file selected")
				}
			})
		}
	}
}

func assertMultipartPose(t *testing.T, file *multipart.FileHeader, want []byte) {
	t.Helper()
	f, err := file.Open()
	if err != nil {
		t.Error(err)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil || string(data) != string(want) {
		t.Error("line drawing bytes changed")
	}
}

type poseUsage struct{ attempts int }

func (*poseUsage) Check(context.Context, string) (int, *security.APIError) { return 1, nil }
func (q *poseUsage) RecordAttempt(context.Context, string) *security.APIError {
	q.attempts++
	return nil
}
func (*poseUsage) RecordSuccess(context.Context, string) *security.APIError { return nil }

func TestPosePreparationFailureNeverCallsModelOrConsumesAttempt(t *testing.T) {
	for _, scenario := range []string{"selector", "missing", "corrupt", "invalid_mode"} {
		t.Run(scenario, func(t *testing.T) {
			pose := loadProjectManifest(t).Poses[6]
			assets := &poseAssets{testOutfits: testOutfits{run: func(context.Context, string) (catalog.OutfitImages, error) { return outfitImages(t), nil }}}
			picker := func(context.Context) (catalog.Pose, error) { return pose, nil }
			switch scenario {
			case "selector":
				picker = func(context.Context) (catalog.Pose, error) {
					return catalog.Pose{}, errors.New("synthetic selector failure")
				}
			case "missing":
				assets.poseError = catalog.ErrPoseUnavailable
			case "corrupt":
				assets.poseImage = &imagevalidate.ValidatedImage{}
			case "invalid_mode":
				pose.Mode = "invalid"
			}
			calls := 0
			gen := testGenerator{run: func(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error) {
				calls++
				return validResult(t), nil
			}}
			q := &poseUsage{}
			admission := security.NewConcurrencyManager(1, 1)
			service, err := NewCoupleService(func() (ImageGenerator, error) { return gen, nil }, assets, admission, q, twoFaces, picker)
			if err != nil {
				t.Fatal(err)
			}
			_, apiErr := service.Generate(context.Background(), "p", RequestTrace{}, coupleInput(t))
			wantCode := "POSE_UNAVAILABLE"
			if scenario == "corrupt" {
				wantCode = "REFERENCE_IMAGES_INVALID"
			}
			if apiErr == nil || apiErr.ErrorCode != wantCode || calls != 0 || q.attempts != 0 {
				t.Fatalf("err=%v calls=%d attempts=%d", apiErr, calls, q.attempts)
			}
			if scenario != "corrupt" && (apiErr.BizCode != 50306 || apiErr.HTTPStatus != 503) {
				t.Fatalf("pose preparation must use its own error code: %v", apiErr)
			}
			release, ok := admission.Acquire("p")
			if !ok {
				t.Fatal("pose preparation leaked admission")
			}
			release()
		})
	}
}

func TestPoseReferenceOrderRejectsDuplicatesAndReversal(t *testing.T) {
	pose := Reference{Role: RolePose, Image: validatedFixture(t, "png")}
	base := references(t, false)
	scene := references(t, true)[4]
	for _, tail := range [][]Reference{{pose, pose}, {scene, scene}, {pose, scene}, {pose, scene, pose}} {
		refs := append(append([]Reference{}, base...), tail...)
		if !errors.Is(validateReferences(refs), ErrReferences) {
			t.Fatalf("invalid order accepted: %v", tail)
		}
	}
}

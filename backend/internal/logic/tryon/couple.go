package tryon

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
)

type CoupleRequest struct {
	CoupleImage string `json:"couple_image"`
	OutfitID    string `json:"outfit_id"`
	Scene       Scene  `json:"scene"`
}

type Scene struct {
	Mode    string `json:"mode"`
	Image   string `json:"image,omitempty"`
	VenueID string `json:"venue_id,omitempty"`
}

type CoupleResponse struct {
	Image             string `json:"image"`
	MIME              string `json:"mime_type"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	Model             string `json:"model"`
	RequestID         string `json:"request_id"`
	ProviderModel     string `json:"provider_model,omitempty"`
	ProviderRequestID string `json:"provider_request_id,omitempty"`
}

type OutfitReader interface {
	ReadOutfit(context.Context, string) (catalog.OutfitImages, error)
	ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error)
}
type Admission interface{ Acquire(string) (func(), bool) }
type GeneratorFactory func() (ImageGenerator, error)

type Usage interface {
	Check(context.Context, string) (int, *security.APIError)
	RecordAttempt(context.Context, string) *security.APIError
	RecordSuccess(context.Context, string) *security.APIError
}

type CoupleService struct {
	newGenerator GeneratorFactory
	outfits      OutfitReader
	admission    Admission
	usage        Usage
}

func NewCoupleService(factory GeneratorFactory, outfits OutfitReader, admission Admission, usage Usage) (*CoupleService, error) {
	if factory == nil || outfits == nil || admission == nil || usage == nil {
		return nil, errors.New("缺少婚礼生成依赖")
	}
	return &CoupleService{newGenerator: factory, outfits: outfits, admission: admission, usage: usage}, nil
}

func (s *CoupleService) Generate(ctx context.Context, principal string, trace RequestTrace, input CoupleRequest) (*CoupleResponse, *security.APIError) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	validationStarted := time.Now()
	if input.OutfitID == "" {
		trace.Record("validating_request", validationStarted)
		return nil, invalidRequest()
	}
	if !validScene(input.Scene) {
		trace.Record("validating_request", validationStarted)
		return nil, invalidRequest()
	}
	if principal == "" {
		trace.Record("validating_request", validationStarted)
		return nil, security.ErrAuthRequired
	}
	trace.Record("validating_request", validationStarted)
	release, ok := s.admission.Acquire(principal)
	if !ok {
		return nil, security.ErrConcurrencyLimited
	}
	defer release()
	_, quotaError := s.usage.Check(ctx, principal)
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if quotaError != nil {
		return nil, quotaError
	}
	imageValidationStarted := time.Now()
	trace.Mark(StageObservation{Phase: "validating_images"})
	couple, err := imagevalidate.ValidateImage(input.CoupleImage, imagevalidate.DefaultImageLimits())
	if err != nil {
		trace.Record("validating_images", imageValidationStarted)
		return nil, imageError(err)
	}
	refs := []Reference{{Role: RoleCouple, Data: couple.Data, MIME: couple.MIME}}
	var scene *imagevalidate.ValidatedImage
	if input.Scene.Mode == "upload" {
		scene, err = imagevalidate.ValidateImage(input.Scene.Image, imagevalidate.DefaultImageLimits())
		if err != nil {
			trace.Record("validating_images", imageValidationStarted)
			return nil, imageError(err)
		}
	}
	trace.Record("validating_images", imageValidationStarted)
	assetsStarted := time.Now()
	trace.Mark(StageObservation{Phase: "preparing_assets"})
	if input.Scene.Mode == "venue" {
		scene, err = s.outfits.ReadVenue(ctx, input.Scene.VenueID)
		if ctx.Err() != nil {
			trace.Record("preparing_assets", assetsStarted)
			return nil, contextError(ctx)
		}
		if errors.Is(err, catalog.ErrUnknownVenue) {
			trace.Record("preparing_assets", assetsStarted)
			return nil, security.NewAPIError(422, 42208, "UNKNOWN_VENUE", "未知场馆编号")
		}
		if err != nil || scene == nil {
			trace.Record("preparing_assets", assetsStarted)
			return nil, security.NewAPIError(503, 50304, "VENUE_UNAVAILABLE", "场馆素材缺失或无效")
		}
	}
	generator, err := s.newGenerator()
	if err != nil {
		trace.Record("preparing_assets", assetsStarted)
		if errors.Is(err, ErrCapability) {
			return nil, security.NewAPIError(503, 50302, "MODEL_CAPABILITY_UNSUPPORTED", ErrCapability.Error())
		}
		return nil, security.NewAPIError(503, 50301, "MODEL_CONFIGURATION_INVALID", ErrConfiguration.Error())
	}
	outfit, err := s.outfits.ReadOutfit(ctx, input.OutfitID)
	if err != nil {
		trace.Record("preparing_assets", assetsStarted)
		if ctx.Err() != nil {
			return nil, contextError(ctx)
		}
		if errors.Is(err, catalog.ErrUnknownOutfit) {
			return nil, security.NewAPIError(422, 42206, "UNKNOWN_OUTFIT", "未知套装编号")
		}
		return nil, security.NewAPIError(503, 50303, "OUTFIT_UNAVAILABLE", "套装素材缺失或无效")
	}
	for index, img := range []*imagevalidate.ValidatedImage{outfit.Dress, outfit.Menswear, outfit.Shoes} {
		if img == nil {
			trace.Record("preparing_assets", assetsStarted)
			return nil, security.NewAPIError(503, 50303, "OUTFIT_UNAVAILABLE", "套装素材缺失或无效")
		}
		refs = append(refs, Reference{Role: []Role{RoleDress, RoleMenswear, RoleShoes}[index], Data: img.Data, MIME: img.MIME})
	}
	if scene != nil {
		refs = append(refs, Reference{Role: RoleScene, Data: scene.Data, MIME: scene.MIME})
	}
	if err := validateReferences(refs); err != nil {
		trace.Record("preparing_assets", assetsStarted)
		return nil, security.NewAPIError(422, 42207, "REFERENCE_IMAGES_INVALID", ErrReferences.Error())
	}
	trace.Record("preparing_assets", assetsStarted)
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	submitted := false
	result, err := generator.Generate(ctx, GenerationRequest{References: refs, Prompt: couplePrompt(scene != nil), Trace: trace, BeforeSend: func(sendCtx context.Context) error {
		if submitted {
			return errors.New("模型请求不得重复发送")
		}
		if apiError := s.usage.RecordAttempt(sendCtx, principal); apiError != nil {
			return apiError
		}
		submitted = true
		return nil
	}})
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if err != nil || result == nil || result.Image == nil {
		var apiError *security.APIError
		if errors.As(err, &apiError) {
			return nil, apiError
		}
		return nil, generationError(err)
	}
	if !submitted {
		return nil, generationError(ErrUpstream)
	}
	// Validate at the service boundary as well: injected generators cannot bypass the result contract.
	resultValidationStarted := time.Now()
	trace.Mark(StageObservation{Phase: "validating_result"})
	image, err := ValidateResult("data:" + result.Image.MIME + ";base64," + base64.StdEncoding.EncodeToString(result.Image.Data))
	trace.Record("validating_result", resultValidationStarted)
	if err != nil || !matchesModel(generator.Model(), result.ProviderModel) || !validProviderIdentifier(result.ProviderRequestID, "") {
		return nil, generationError(ErrResult)
	}
	response := &CoupleResponse{Image: base64.StdEncoding.EncodeToString(image.Data), MIME: image.MIME, Width: image.Width, Height: image.Height, Model: generator.Model(), RequestID: trace.RequestID, ProviderModel: result.ProviderModel, ProviderRequestID: result.ProviderRequestID}
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if apiError := s.usage.RecordSuccess(ctx, principal); apiError != nil {
		if ctx.Err() != nil {
			return nil, contextError(ctx)
		}
		return nil, apiError
	}
	return response, nil
}

func validScene(scene Scene) bool {
	switch scene.Mode {
	case "original":
		return scene.Image == "" && scene.VenueID == ""
	case "upload":
		return scene.Image != "" && scene.VenueID == ""
	case "venue":
		return scene.Image == "" && scene.VenueID != ""
	default:
		return false
	}
}

func couplePrompt(scene bool) string {
	background := "Preserve the original background from reference 1."
	if scene {
		background = "Use reference 5 only for the venue; preserve its architecture, stage and decorations without replacing the people."
	}
	return fmt.Sprintf("Create exactly one landscape full-body wedding photograph of the same two people from reference 1 (couple). Preserve both identities, faces, natural proportions, and original left/right positions; do not swap or move the people across sides. Decide from reference 1 which person should wear the wedding dress, judging only by what the photo shows. That person must wear only the wedding dress from reference 2 (dress). The other person must wear only the menswear, including shoes, from reference 3 (menswear), with shoe details from reference 4 (shoes_detail). Do not mix garments. Show both people from head to toe, including complete shoes, without cropping. %s", background)
}

func invalidRequest() *security.APIError {
	return security.NewAPIError(422, 42200, "INVALID_REQUEST", "请提供合照、套装及互斥场地模式")
}
func imageError(err error) *security.APIError {
	var apiError *security.APIError
	if errors.As(err, &apiError) {
		return apiError
	}
	return invalidRequest()
}
func contextError(ctx context.Context) *security.APIError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return security.NewAPIError(504, 50401, "GENERATION_TIMEOUT", "生成超时，请手动重试")
	}
	return security.NewAPIError(408, 40801, "GENERATION_CANCELLED", "生成已取消")
}
func generationError(err error) *security.APIError {
	if errors.Is(err, ErrResult) {
		return security.NewAPIError(502, 50202, "INVALID_MODEL_RESULT", ErrResult.Error())
	}
	return security.NewAPIError(502, 50201, "MODEL_REQUEST_FAILED", ErrUpstream.Error())
}

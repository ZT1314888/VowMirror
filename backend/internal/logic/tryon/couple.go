package tryon

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	"backend/internal/catalog"
	"backend/internal/imagevalidate"
	"backend/internal/security"
)

type CoupleRequest struct {
	CoupleImage string `json:"couple_image"`
	OutfitID    string `json:"outfit_id"`
	DressSide   string `json:"dress_side"`
	Scene       Scene  `json:"scene"`
}

type Scene struct {
	Mode    string `json:"mode"`
	Image   string `json:"image,omitempty"`
	VenueID string `json:"venue_id,omitempty"`
}

type CoupleResponse struct {
	Image     string `json:"image"`
	MIME      string `json:"mime_type"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Model     string `json:"model"`
	RequestID string `json:"request_id"`
}

type OutfitReader interface {
	ReadOutfit(context.Context, string) (catalog.OutfitImages, error)
	ReadVenue(context.Context, string) (*imagevalidate.ValidatedImage, error)
}
type Admission interface{ Acquire(string) (func(), bool) }
type GeneratorFactory func() (ImageGenerator, error)

type CoupleService struct {
	newGenerator GeneratorFactory
	outfits      OutfitReader
	admission    Admission
}

func NewCoupleService(factory GeneratorFactory, outfits OutfitReader, admission Admission) (*CoupleService, error) {
	if factory == nil || outfits == nil || admission == nil {
		return nil, errors.New("缺少婚礼生成依赖")
	}
	return &CoupleService{newGenerator: factory, outfits: outfits, admission: admission}, nil
}

func (s *CoupleService) Generate(ctx context.Context, principal, requestID string, input CoupleRequest) (*CoupleResponse, *security.APIError) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if input.OutfitID == "" || (input.DressSide != "left" && input.DressSide != "right") {
		return nil, invalidRequest()
	}
	if !validScene(input.Scene) {
		return nil, invalidRequest()
	}
	if principal == "" {
		return nil, security.ErrAuthRequired
	}
	release, ok := s.admission.Acquire(principal)
	if !ok {
		return nil, security.ErrConcurrencyLimited
	}
	defer release()
	couple, err := imagevalidate.ValidateImage(input.CoupleImage, imagevalidate.DefaultImageLimits())
	if err != nil {
		return nil, imageError(err)
	}
	refs := []Reference{{Role: RoleCouple, Data: couple.Data, MIME: couple.MIME}}
	var scene *imagevalidate.ValidatedImage
	if input.Scene.Mode == "upload" {
		scene, err = imagevalidate.ValidateImage(input.Scene.Image, imagevalidate.DefaultImageLimits())
		if err != nil {
			return nil, imageError(err)
		}
	}
	if input.Scene.Mode == "venue" {
		scene, err = s.outfits.ReadVenue(ctx, input.Scene.VenueID)
		if ctx.Err() != nil {
			return nil, contextError(ctx)
		}
		if errors.Is(err, catalog.ErrUnknownVenue) {
			return nil, security.NewAPIError(422, 42208, "UNKNOWN_VENUE", "未知场馆编号")
		}
		if err != nil || scene == nil {
			return nil, security.NewAPIError(503, 50304, "VENUE_UNAVAILABLE", "场馆素材缺失或无效")
		}
	}
	generator, err := s.newGenerator()
	if err != nil {
		if errors.Is(err, ErrCapability) {
			return nil, security.NewAPIError(503, 50302, "MODEL_CAPABILITY_UNSUPPORTED", ErrCapability.Error())
		}
		return nil, security.NewAPIError(503, 50301, "MODEL_CONFIGURATION_INVALID", ErrConfiguration.Error())
	}
	outfit, err := s.outfits.ReadOutfit(ctx, input.OutfitID)
	if err != nil {
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
			return nil, security.NewAPIError(503, 50303, "OUTFIT_UNAVAILABLE", "套装素材缺失或无效")
		}
		refs = append(refs, Reference{Role: []Role{RoleDress, RoleMenswear, RoleShoes}[index], Data: img.Data, MIME: img.MIME})
	}
	if scene != nil {
		refs = append(refs, Reference{Role: RoleScene, Data: scene.Data, MIME: scene.MIME})
	}
	if err := validateReferences(refs); err != nil {
		return nil, security.NewAPIError(422, 42207, "REFERENCE_IMAGES_INVALID", ErrReferences.Error())
	}
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	result, err := generator.Generate(ctx, GenerationRequest{References: refs, Prompt: couplePrompt(input.DressSide, scene != nil), Output: OutputSpec{AspectRatio: "3:2", ImageSize: "1K"}})
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	if err != nil || result == nil {
		return nil, generationError(err)
	}
	// Validate at the service boundary as well: injected generators cannot bypass the result contract.
	result, err = ValidateResult("data:" + result.MIME + ";base64," + base64.StdEncoding.EncodeToString(result.Data))
	if err != nil {
		return nil, generationError(err)
	}
	response := &CoupleResponse{Image: base64.StdEncoding.EncodeToString(result.Data), MIME: result.MIME, Width: result.Width, Height: result.Height, Model: generator.Model(), RequestID: requestID}
	if ctx.Err() != nil {
		return nil, contextError(ctx)
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

func couplePrompt(side string, scene bool) string {
	background := "Preserve the original background from reference 1."
	if scene {
		background = "Use reference 5 only for the venue; preserve its architecture, stage and decorations without replacing the people."
	}
	return fmt.Sprintf("Create exactly one landscape full-body wedding photograph of the same two people from reference 1 (couple). Preserve both identities, faces and natural proportions. The person on the viewer's %s wears only the wedding dress from reference 2 (dress); the other person wears only the menswear including shoes from reference 3 (menswear), with shoe details from reference 4 (shoes_detail). Do not mix outfits or swap identities. Show both people from head to toe, including complete shoes, without cropping. %s", side, background)
}

func invalidRequest() *security.APIError {
	return security.NewAPIError(422, 42200, "INVALID_REQUEST", "请提供合照、套装、婚纱画面左右及互斥场地模式")
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

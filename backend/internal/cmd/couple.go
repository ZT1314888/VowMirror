package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"backend/internal/catalog"
	"backend/internal/logic/tryon"
	"backend/internal/middleware"
	"backend/internal/security"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

func modelFromEnvironment() (tryon.ImageGenerator, error) {
	return tryon.NewGenerator(tryon.ModelConfig{Provider: os.Getenv("MODEL_PROVIDER"), Model: os.Getenv("MODEL_NAME"), BaseURL: os.Getenv("MODEL_BASE_URL"), APIKey: os.Getenv("MODEL_API_KEY")}, http.DefaultTransport)
}

func generationService(loadManifest func() (*catalog.Manifest, error), securityService *security.Service) (*tryon.CoupleService, error) {
	return tryon.NewCoupleService(modelFromEnvironment, &catalog.Reader{Directory: "/assets/wedding", LoadManifest: loadManifest}, securityService.ConcurrencyManager)
}

func coupleHandler(service *tryon.CoupleService) func(*ghttp.Request) {
	return func(r *ghttp.Request) {
		r.Response.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), tryon.RequestTimeout)
		defer cancel()
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			middleware.WriteAPIError(r, security.NewAPIError(415, 41501, "JSON_REQUIRED", "请求必须使用 application/json"))
			return
		}
		input, err := decodeCouple(r.Request.Body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				middleware.WriteAPIError(r, security.ErrRequestTooLarge)
				return
			}
			middleware.WriteAPIError(r, security.NewAPIError(422, 42200, "INVALID_REQUEST", "请求字段或 JSON 格式无效"))
			return
		}
		response, apiErr := service.Generate(ctx, r.GetCtxVar(middleware.CtxPrincipalID).String(), middleware.GetRequestID(r), input)
		if apiErr != nil {
			middleware.WriteAPIError(r, apiErr)
			return
		}
		r.Response.WriteJson(g.Map{"code": 0, "message": "", "data": response})
	}
}

func decodeCouple(body io.Reader) (tryon.CoupleRequest, error) {
	fields, err := strictObject(json.NewDecoder(body), "couple_image", "outfit_id", "dress_side", "scene")
	if err != nil {
		return tryon.CoupleRequest{}, err
	}
	var input tryon.CoupleRequest
	for key, target := range map[string]*string{"couple_image": &input.CoupleImage, "outfit_id": &input.OutfitID, "dress_side": &input.DressSide} {
		if len(fields[key]) == 0 || string(fields[key]) == "null" {
			return input, errors.New("missing string")
		}
		if err := json.Unmarshal(fields[key], target); err != nil {
			return input, err
		}
	}
	scene, err := strictObject(json.NewDecoder(strings.NewReader(string(fields["scene"]))), "mode", "image")
	if err != nil {
		return input, err
	}
	if len(scene["mode"]) == 0 || string(scene["mode"]) == "null" || string(scene["image"]) == "null" {
		return input, errors.New("invalid scene")
	}
	if err := json.Unmarshal(scene["mode"], &input.Scene.Mode); err != nil {
		return input, err
	}
	if len(scene["image"]) != 0 {
		if err := json.Unmarshal(scene["image"], &input.Scene.Image); err != nil {
			return input, err
		}
		if input.Scene.Mode == "original" {
			return input, errors.New("original scene cannot contain image")
		}
	}
	return input, nil
}

// Reject duplicate and case-variant keys rather than relying on Go's permissive field matching.
func strictObject(decoder *json.Decoder, allowed ...string) (map[string]json.RawMessage, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if token != json.Delim('{') {
		return nil, errors.New("expected object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected field")
		}
		known := false
		for _, name := range allowed {
			if key == name {
				known = true
				break
			}
		}
		if !known || fields[key] != nil {
			return nil, errors.New("unknown or duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("trailing JSON")
	}
	return fields, nil
}

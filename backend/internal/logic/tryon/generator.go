package tryon

import (
	"backend/internal/imagevalidate"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	GeminiModel          = "gemini-3.1-flash-image"
	RequestTimeout       = 55 * time.Second
	MaxBodyBytes   int64 = 24 << 20
	// Leave room for Base64 and JSON within Gemini's 20 MB inline request limit.
	MaxReferenceBytes       int64 = 14 << 20
	MaxProviderRequestBytes       = 20_000_000
	MaxResponseBytes        int64 = 12 << 20
)

var (
	ErrConfiguration = errors.New("模型配置不完整或无效")
	ErrCapability    = errors.New("此协议或型号尚未闭合婚礼多图能力")
	ErrUpstream      = errors.New("模型服务请求失败")
	ErrResult        = errors.New("模型未返回一张有效横版图片")
	ErrReferences    = errors.New("参考图角色、格式或总量无效")
)

type Role string

const (
	RoleCouple   Role = "couple"
	RoleDress    Role = "dress"
	RoleMenswear Role = "menswear"
	RoleShoes    Role = "shoes_detail"
	RoleScene    Role = "scene"
)

type Reference struct {
	Role Role
	Data []byte
	MIME string
}
type GenerationRequest struct {
	References []Reference
	Prompt     string
	Output     OutputSpec
}
type OutputSpec struct {
	AspectRatio string `json:"aspectRatio"`
	ImageSize   string `json:"imageSize"`
}
type ImageGenerator interface {
	Generate(context.Context, GenerationRequest) (*imagevalidate.ValidatedImage, error)
	Model() string
}
type ModelConfig struct {
	Provider string
	APIKey   string
	BaseURL  string
	Model    string
}

func NewGenerator(cfg ModelConfig, transport http.RoundTripper) (ImageGenerator, error) {
	if cfg.Provider == "openai" || cfg.Provider == "doubao" {
		return nil, ErrCapability
	}
	if transport == nil || cfg.Provider != "gemini" || strings.TrimSpace(cfg.APIKey) == "" || cfg.APIKey != strings.TrimSpace(cfg.APIKey) || strings.ContainsAny(cfg.APIKey, "\r\n") {
		return nil, ErrConfiguration
	}
	if cfg.Model != GeminiModel {
		return nil, ErrCapability
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, ErrConfiguration
	}
	return &Gemini{config: cfg, client: newModelHTTPClient(transport)}, nil
}

func newModelHTTPClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Transport: transport, Timeout: RequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func validateReferences(refs []Reference) error {
	roles := []Role{RoleCouple, RoleDress, RoleMenswear, RoleShoes, RoleScene}
	if len(refs) < 4 || len(refs) > len(roles) {
		return ErrReferences
	}
	var total int64
	for index, ref := range refs {
		if ref.Role != roles[index] || ref.MIME == "" {
			return ErrReferences
		}
		if _, err := imagevalidate.ValidateBytes(ref.Data, ref.MIME, imagevalidate.DefaultImageLimits()); err != nil {
			return ErrReferences
		}
		total += int64(len(ref.Data))
	}
	if total > MaxReferenceBytes {
		return ErrReferences
	}
	return nil
}

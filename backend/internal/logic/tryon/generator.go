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
	GPTImageModel            = "gpt-image-2.5-flare"
	OutputWidth              = 1536
	OutputHeight             = 1024
	OutputSize               = "1536x1024"
	OutputQuality            = "medium"
	RequestTimeout           = 85 * time.Second
	StreamWriteTimeout       = 95 * time.Second
	MaxBodyBytes       int64 = 24 << 20
	// Local memory budgets, independent of the provider's larger input limits.
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
	RolePose     Role = "pose"
)

type Reference struct {
	Role Role
	Data []byte
	MIME string
}
type GenerationRequest struct {
	References []Reference
	Prompt     string
	Trace      RequestTrace
	BeforeSend func(context.Context) error
}
type GenerationResult struct {
	Image             *imagevalidate.ValidatedImage
	ProviderModel     string
	ProviderRequestID string
}
type ImageGenerator interface {
	Generate(context.Context, GenerationRequest) (*GenerationResult, error)
	Model() string
}
type ModelConfig struct {
	Provider string
	APIKey   string
	BaseURL  string
	Model    string
}

func NewGenerator(cfg ModelConfig, transport http.RoundTripper) (ImageGenerator, error) {
	if cfg.Provider != "" && cfg.Provider != "chuanapi" {
		return nil, ErrCapability
	}
	if transport == nil || cfg.Provider == "" || strings.TrimSpace(cfg.APIKey) == "" || strings.ContainsAny(cfg.APIKey, " \t\r\n") {
		return nil, ErrConfiguration
	}
	if cfg.Model != GPTImageModel {
		return nil, ErrCapability
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || strings.TrimRight(u.Path, "/") != "/v1" {
		return nil, ErrConfiguration
	}
	return &GPTImage{config: cfg, client: newModelHTTPClient(transport)}, nil
}

func newModelHTTPClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Transport: transport, Timeout: RequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func validateReferences(refs []Reference) error {
	roles := []Role{RoleCouple, RoleDress, RoleMenswear, RoleShoes}
	if len(refs) < len(roles) || len(refs) > 6 {
		return ErrReferences
	}
	if len(refs) > 4 && refs[4].Role == RoleScene {
		roles = append(roles, RoleScene)
	}
	if len(refs) > len(roles) {
		roles = append(roles, RolePose)
	}
	if len(refs) != len(roles) {
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

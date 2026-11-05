package tryon

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ImageGenerator is the inherited protocol interface, not bound to any route.
// Phase 3 will replace the two strings with role-bearing references and MIME.
type ImageGenerator interface {
	Generate(ctx context.Context, personB64, garmentB64, prompt, size string) (string, error)
	Name() string
}

// ModelConfig must be supplied explicitly by the server.
type ModelConfig struct {
	Name     string
	Provider string
	APIKey   string
	BaseURL  string
	Model    string
}

func NewGenerator(cfg *ModelConfig) (ImageGenerator, error) {
	if cfg == nil || strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.Model) == "" {
		return nil, fmt.Errorf("模型配置必须包含 API Key 和模型名")
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("模型服务地址无效")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, fmt.Errorf("远程模型服务必须使用 HTTPS")
	}
	switch cfg.Provider {
	case "openai":
		return NewOpenAIImages(cfg), nil
	case "doubao":
		return NewDoubao(cfg), nil
	case "gemini":
		return NewGemini(cfg), nil
	default:
		return nil, fmt.Errorf("不支持的模型协议；仅保留 openai、doubao、gemini")
	}
}

func newModelHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

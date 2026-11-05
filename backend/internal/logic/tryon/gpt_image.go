package tryon

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenAIImages OpenAI Images API 兼容适配器。
// 保留现有图像协议；不代表已验证官方编辑或婚礼多图支持。
type OpenAIImages struct {
	apiKey  string
	baseURL string
	model   string
	name    string
	client  *http.Client
}

// NewOpenAIImages 从配置创建适配器
func NewOpenAIImages(cfg *ModelConfig) *OpenAIImages {
	return &OpenAIImages{
		apiKey:  cfg.APIKey,
		baseURL: strings.TrimRight(cfg.BaseURL, "/"),
		model:   cfg.Model,
		name:    cfg.Name,
		client:  newModelHTTPClient(),
	}
}

func (o *OpenAIImages) Name() string { return o.name }

// gptImageRequest retains the inherited prompt + image array protocol.
// Official provider compatibility is not yet verified.
type gptImageRequest struct {
	Model   string   `json:"model"`
	Prompt  string   `json:"prompt,omitempty"`
	Image   []string `json:"image,omitempty"`
	Size    string   `json:"size,omitempty"`
	Quality string   `json:"quality,omitempty"`
	N       int      `json:"n,omitempty"`
}

// gptImageResponse OpenAI Images API 响应
type gptImageResponse struct {
	Data  []gptImageData `json:"data"`
	Error *gptAPIError   `json:"error,omitempty"`
}

type gptImageData struct {
	B64JSON string `json:"b64_json"`
	URL     string `json:"url"`
}

type gptAPIError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

func (o *OpenAIImages) Generate(ctx context.Context, personB64, garmentB64, prompt, size string) (string, error) {
	if o.apiKey == "" {
		return "", fmt.Errorf("模型 %s 未配置 API Key", o.name)
	}

	reqBody := gptImageRequest{
		Model:  o.model,
		Prompt: prompt,
		Image: []string{
			"data:image/png;base64," + ensureBase64(personB64),
			"data:image/png;base64," + ensureBase64(garmentB64),
		},
		Size:    normalizeOpenAISize(size),
		Quality: "high",
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", o.baseURL+"/images/generations", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("模型服务请求创建失败")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+o.apiKey)

	resp, err := o.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法连接模型服务")
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("图像 API 错误 (status %d): %s", resp.StatusCode, truncate(string(respBody), 500))
	}

	var result gptImageResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", err
	}
	if result.Error != nil {
		return "", fmt.Errorf("图像 API 错误: %s", result.Error.Message)
	}
	if len(result.Data) == 0 {
		return "", fmt.Errorf("图像 API 未返回图片")
	}
	// 优先 b64_json，其次 url（部分服务商返回 URL）
	if result.Data[0].B64JSON != "" {
		return result.Data[0].B64JSON, nil
	}
	if result.Data[0].URL != "" {
		return o.downloadImage(ctx, result.Data[0].URL)
	}
	return "", fmt.Errorf("图像 API 返回格式无法解析")
}

// downloadImage 下载 URL 图片并转 base64（部分服务商只返回 URL）
func (o *OpenAIImages) downloadImage(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", fmt.Errorf("结果图片地址无效")
	}
	resp, err := o.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法下载模型结果图片")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ensureBase64 兼容：如果传入的是 data URL，去掉前缀
func ensureBase64(s string) string {
	if len(s) > 22 && s[:5] == "data:" {
		if idx := bytes.IndexByte([]byte(s), ','); idx >= 0 {
			return s[idx+1:]
		}
	}
	return s
}

// truncate 截断字符串，避免错误信息过长
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// normalizeOpenAISize 归一化尺寸。换装默认竖版 1024x1536（2:3）。
// GPT-Image 支持 1024x1024 / 1536x1024 / 1024x1536 / auto。
func normalizeOpenAISize(size string) string {
	switch size {
	case "1024x1024", "1536x1024", "1024x1536", "auto":
		return size
	case "", "1024x1792", "1792x1024":
		return "1024x1536"
	default:
		return "1024x1536"
	}
}

// encodeB64 字节转标准 base64
func encodeB64(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

package tryon

import (
	"backend/internal/imagevalidate"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

type Gemini struct {
	config ModelConfig
	client *http.Client
}

func (g *Gemini) Model() string { return g.config.Model }

type geminiRequest struct {
	Contents         []geminiContent `json:"contents"`
	GenerationConfig geminiGenConfig `json:"generationConfig"`
}
type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}
type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inlineData,omitempty"`
}
type geminiInlineData struct {
	MIME string `json:"mimeType"`
	Data string `json:"data"`
}
type geminiGenConfig struct {
	ResponseModalities []string   `json:"responseModalities"`
	CandidateCount     int        `json:"candidateCount"`
	ImageConfig        OutputSpec `json:"imageConfig"`
}

func (g *Gemini) Generate(ctx context.Context, input GenerationRequest) (*imagevalidate.ValidatedImage, error) {
	if err := validateReferences(input.References); err != nil {
		return nil, err
	}
	if input.Prompt == "" || input.Output != (OutputSpec{AspectRatio: "3:2", ImageSize: "1K"}) {
		return nil, ErrReferences
	}
	parts := []geminiPart{{Text: input.Prompt}}
	for _, ref := range input.References {
		parts = append(parts, geminiPart{Text: "Reference role: " + string(ref.Role)}, geminiPart{InlineData: &geminiInlineData{MIME: ref.MIME, Data: base64.StdEncoding.EncodeToString(ref.Data)}})
	}
	body, err := json.Marshal(geminiRequest{
		Contents:         []geminiContent{{Role: "user", Parts: parts}},
		GenerationConfig: geminiGenConfig{ResponseModalities: []string{"IMAGE"}, CandidateCount: 1, ImageConfig: input.Output},
	})
	if err != nil || len(body) > MaxProviderRequestBytes {
		return nil, ErrReferences
	}
	endpoint := strings.TrimRight(g.config.BaseURL, "/") + "/models/" + g.config.Model + ":generateContent"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, ErrConfiguration
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.config.APIKey)
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, ErrUpstream
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, ErrUpstream
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil || int64(len(data)) > MaxResponseBytes {
		return nil, ErrUpstream
	}
	var result struct {
		Candidates []struct {
			Content      geminiContent `json:"content"`
			FinishReason string        `json:"finishReason"`
		} `json:"candidates"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.Error) != 0 || len(result.Candidates) != 1 || result.Candidates[0].FinishReason != "STOP" {
		return nil, ErrResult
	}
	var output *imagevalidate.ValidatedImage
	for _, part := range result.Candidates[0].Content.Parts {
		if part.InlineData == nil {
			continue
		}
		if output != nil || part.InlineData.MIME == "" {
			return nil, ErrResult
		}
		output, err = ValidateResult("data:" + part.InlineData.MIME + ";base64," + part.InlineData.Data)
		if err != nil {
			return nil, err
		}
	}
	if output == nil {
		return nil, ErrResult
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return output, nil
}

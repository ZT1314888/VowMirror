package imagevalidate

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"strings"

	_ "golang.org/x/image/webp"

	"backend/internal/security"
)

type ValidatedImage struct {
	Data   []byte
	MIME   string
	Width  int
	Height int
	SHA256 string
}

func ValidateImage(input string, limits ImageLimits) (*ValidatedImage, error) {
	img, _, err := DecodeImage(input, limits)
	return img, err
}

// DecodeImage exposes the already validated pixels only to callers which need them.
func DecodeImage(input string, limits ImageLimits) (*ValidatedImage, image.Image, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return nil, nil, security.ErrInvalidImageBase64
	}

	declaredMIME, rawB64, err := ParseDataURL(trimmed)
	if err != nil {
		return nil, nil, err
	}
	if rawB64 == "" {
		return nil, nil, security.ErrInvalidImageBase64
	}

	// 1. 预检查 Base64 编码字符串长度
	if limits.MaxEncodedImageBytes > 0 && int64(len(rawB64)) > limits.MaxEncodedImageBytes {
		return nil, nil, security.ErrImageFileTooLarge
	}

	// 2. 根据字符串长度预估解码大小（防止超大 Base64 占满内存）
	estimatedDecodedSize := int64(len(rawB64)) * 3 / 4
	if limits.MaxDecodedImageBytes > 0 && estimatedDecodedSize > limits.MaxDecodedImageBytes+1024 {
		return nil, nil, security.ErrImageFileTooLarge
	}

	// 3. 解码 Base64
	data, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(rawB64)
		if err != nil {
			return nil, nil, security.ErrInvalidImageBase64
		}
	}

	return decodeBytes(data, declaredMIME, limits)
}

// ValidateBytes is the shared boundary for uploads, fixed assets and results.
func ValidateBytes(data []byte, declaredMIME string, limits ImageLimits) (*ValidatedImage, error) {
	img, _, err := decodeBytes(data, declaredMIME, limits)
	return img, err
}

func decodeBytes(data []byte, declaredMIME string, limits ImageLimits) (*ValidatedImage, image.Image, error) {
	// Bound allocation before decoding the complete image.
	if limits.MaxDecodedImageBytes > 0 && int64(len(data)) > limits.MaxDecodedImageBytes {
		return nil, nil, security.ErrImageFileTooLarge
	}

	// 5. 校验真实 MIME 类型（http.DetectContentType）
	realMIME := http.DetectContentType(data)
	isAllowed := false
	for _, allowed := range limits.AllowedMimeTypes {
		if strings.EqualFold(realMIME, allowed) {
			isAllowed = true
			break
		}
	}
	if !isAllowed {
		return nil, nil, security.ErrUnsupportedImageType
	}

	// 若 Data URL 声明了 MIME，必须与真实内容严格一致
	if declaredMIME != "" && !strings.EqualFold(declaredMIME, realMIME) {
		return nil, nil, security.ErrUnsupportedImageType
	}

	// 6. 使用 image.DecodeConfig 校验图片头有效性并提取宽高
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, nil, security.ErrUnsupportedImageType
	}

	// 7. 宽高范围校验
	if cfg.Width < limits.MinWidth || cfg.Width > limits.MaxWidth ||
		cfg.Height < limits.MinHeight || cfg.Height > limits.MaxHeight {
		return nil, nil, security.ErrImageDimensionsInvalid
	}

	// 8. 总像素校验（防止乘法整数溢出）
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, nil, security.ErrImageDimensionsInvalid
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if limits.MaxPixels > 0 && pixels > limits.MaxPixels {
		return nil, nil, security.ErrImagePixelLimitExceeded
	}

	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil || decoded.Bounds().Dx() != cfg.Width || decoded.Bounds().Dy() != cfg.Height {
		return nil, nil, security.ErrUnsupportedImageType
	}

	// 9. 计算 SHA-256 摘要前缀（用于脱敏追踪与缓存标识）
	sum := sha256.Sum256(data)
	sha256Prefix := hex.EncodeToString(sum[:8])

	return &ValidatedImage{
		Data:   data,
		MIME:   realMIME,
		Width:  cfg.Width,
		Height: cfg.Height,
		SHA256: sha256Prefix,
	}, decoded, nil
}

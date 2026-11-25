package imagevalidate

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"

	_ "golang.org/x/image/webp"

	"backend/internal/security"
)

type ValidatedImage struct {
	data   []byte
	mime   string
	width  int
	height int
	sha256 string
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
	return decodeBase64(rawB64, declaredMIME, limits)
}

func ValidateBase64(input, declaredMIME string, limits ImageLimits) (*ValidatedImage, error) {
	validated, _, err := decodeBase64(input, declaredMIME, limits)
	return validated, err
}

func decodeBase64(rawB64, declaredMIME string, limits ImageLimits) (*ValidatedImage, image.Image, error) {
	if strings.TrimSpace(rawB64) == "" {
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
	if limits.MaxDecodedImageBytes > 0 && int64(len(data)) > limits.MaxDecodedImageBytes {
		return nil, security.ErrImageFileTooLarge
	}
	img, _, err := decodeBytes(bytes.Clone(data), declaredMIME, limits)
	return img, err
}

func (v *ValidatedImage) Bytes() []byte {
	if v == nil {
		return nil
	}
	return bytes.Clone(v.data)
}

func (v *ValidatedImage) WriteTo(writer io.Writer) (int64, error) {
	if v == nil || writer == nil {
		return 0, errors.New("validated image and writer are required")
	}
	// Hide bytes.Reader.WriteTo so an arbitrary writer never receives internal bytes.
	return io.Copy(writer, struct{ io.Reader }{bytes.NewReader(v.data)})
}

func (v *ValidatedImage) Base64() string {
	if v == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(v.data)
}

func (v *ValidatedImage) MIME() string {
	if v == nil {
		return ""
	}
	return v.mime
}

func (v *ValidatedImage) Width() int {
	if v == nil {
		return 0
	}
	return v.width
}

func (v *ValidatedImage) Height() int {
	if v == nil {
		return 0
	}
	return v.height
}

func (v *ValidatedImage) Size() int {
	if v == nil {
		return 0
	}
	return len(v.data)
}

func (v *ValidatedImage) SHA256() string {
	if v == nil {
		return ""
	}
	return v.sha256
}

func CheckImage(v *ValidatedImage, limits ImageLimits) error {
	if v == nil {
		return security.ErrInvalidImageBase64
	}
	if limits.MaxDecodedImageBytes > 0 && int64(len(v.data)) > limits.MaxDecodedImageBytes {
		return security.ErrImageFileTooLarge
	}
	if !allowedMIME(v.mime, limits.AllowedMimeTypes) {
		return security.ErrUnsupportedImageType
	}
	if v.width < limits.MinWidth || v.width > limits.MaxWidth || v.height < limits.MinHeight || v.height > limits.MaxHeight || v.width <= 0 || v.height <= 0 {
		return security.ErrImageDimensionsInvalid
	}
	if limits.MaxPixels > 0 && int64(v.width)*int64(v.height) > limits.MaxPixels {
		return security.ErrImagePixelLimitExceeded
	}
	return nil
}

func decodeBytes(data []byte, declaredMIME string, limits ImageLimits) (*ValidatedImage, image.Image, error) {
	// Bound allocation before decoding the complete image.
	if limits.MaxDecodedImageBytes > 0 && int64(len(data)) > limits.MaxDecodedImageBytes {
		return nil, nil, security.ErrImageFileTooLarge
	}

	// 5. 校验真实 MIME 类型（http.DetectContentType）
	realMIME := http.DetectContentType(data)
	if !allowedMIME(realMIME, limits.AllowedMimeTypes) {
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

	metadata := &ValidatedImage{data: data, mime: realMIME, width: cfg.Width, height: cfg.Height}
	if err := CheckImage(metadata, limits); err != nil {
		return nil, nil, err
	}

	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil || decoded.Bounds().Dx() != cfg.Width || decoded.Bounds().Dy() != cfg.Height {
		return nil, nil, security.ErrUnsupportedImageType
	}

	// 9. 计算 SHA-256 摘要前缀（用于脱敏追踪与缓存标识）
	sum := sha256.Sum256(data)
	sha256Prefix := hex.EncodeToString(sum[:8])

	return &ValidatedImage{data: data, mime: realMIME, width: cfg.Width, height: cfg.Height, sha256: sha256Prefix}, decoded, nil
}

func allowedMIME(mime string, allowed []string) bool {
	for _, candidate := range allowed {
		if strings.EqualFold(mime, candidate) {
			return true
		}
	}
	return false
}

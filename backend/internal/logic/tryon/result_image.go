package tryon

import "backend/internal/imagevalidate"

func ValidateResult(value string) (*imagevalidate.ValidatedImage, error) {
	output, err := imagevalidate.ValidateImage(value, imagevalidate.DefaultImageLimits())
	if err != nil || output.MIME != "image/png" || output.Width != OutputWidth || output.Height != OutputHeight {
		return nil, ErrResult
	}
	return output, nil
}

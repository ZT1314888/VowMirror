package tryon

import "backend/internal/imagevalidate"

func ValidateResult(value string) (*imagevalidate.ValidatedImage, error) {
	output, err := imagevalidate.ValidateImage(value, imagevalidate.DefaultImageLimits())
	if err != nil || output.Width <= output.Height {
		return nil, ErrResult
	}
	return output, nil
}

package tryon

import "backend/internal/imagevalidate"

func ValidateResult(value string) (*imagevalidate.ValidatedImage, error) {
	output, err := imagevalidate.ValidateImage(value, imagevalidate.DefaultImageLimits())
	if err != nil || ValidateResultImage(output) != nil {
		return nil, ErrResult
	}
	return output, nil
}

func ValidateResultBase64(value string) (*imagevalidate.ValidatedImage, error) {
	output, err := imagevalidate.ValidateBase64(value, "image/png", imagevalidate.DefaultImageLimits())
	if err != nil || ValidateResultImage(output) != nil {
		return nil, ErrResult
	}
	return output, nil
}

func ValidateResultImage(output *imagevalidate.ValidatedImage) error {
	if imagevalidate.CheckImage(output, imagevalidate.DefaultImageLimits()) != nil || output.MIME() != "image/png" || output.Width() != OutputWidth || output.Height() != OutputHeight {
		return ErrResult
	}
	return nil
}

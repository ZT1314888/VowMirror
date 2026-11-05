package imagevalidate

type ImageLimits struct {
	MaxRequestBodyBytes     int64    `json:"maxRequestBodyBytes"`
	MaxEncodedImageBytes    int64    `json:"maxEncodedImageBytes"`
	MaxDecodedImageBytes    int64    `json:"maxDecodedImageBytes"`
	MaxCombinedDecodedBytes int64    `json:"maxCombinedDecodedBytes"`
	MinWidth                int      `json:"minWidth"`
	MinHeight               int      `json:"minHeight"`
	MaxWidth                int      `json:"maxWidth"`
	MaxHeight               int      `json:"maxHeight"`
	MaxPixels               int64    `json:"maxPixels"`
	AllowedMimeTypes        []string `json:"allowedMimeTypes"`
}

func DefaultImageLimits() ImageLimits {
	return ImageLimits{
		MaxRequestBodyBytes:     25165824, // 24 MiB
		MaxEncodedImageBytes:    12582912, // 12 MiB
		MaxDecodedImageBytes:    8388608,  // 8 MiB
		MaxCombinedDecodedBytes: 16777216, // 16 MiB
		MinWidth:                256,
		MinHeight:               256,
		MaxWidth:                8192,
		MaxHeight:               8192,
		MaxPixels:               20000000, // 2000万像素
		AllowedMimeTypes: []string{
			"image/jpeg",
			"image/png",
			"image/webp",
		},
	}
}

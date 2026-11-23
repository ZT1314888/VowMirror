package facedetect

import (
	"context"
	"image"

	"golang.org/x/image/draw"
)

func detectionCopy(ctx context.Context, src image.Image, orientation int) (*image.Gray, error) {
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if longest := max(w, h); longest > maxEdge {
		w, h = max(1, (w*maxEdge+longest/2)/longest), max(1, (h*maxEdge+longest/2)/longest)
	}
	gray := image.NewGray(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(gray, gray.Bounds(), src, bounds, draw.Src, nil)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if orientation == 1 {
		return gray, nil
	}
	ow, oh := w, h
	if orientation >= 5 {
		ow, oh = h, w
	}
	upright := image.NewGray(image.Rect(0, 0, ow, oh))
	for y := 0; y < oh; y++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for x := 0; x < ow; x++ {
			sx, sy := sourcePoint(x, y, w, h, orientation)
			upright.Pix[y*upright.Stride+x] = gray.Pix[sy*gray.Stride+sx]
		}
	}
	return upright, nil
}

// Map an upright display coordinate back to the EXIF raster.
func sourcePoint(x, y, w, h, orientation int) (int, int) {
	switch orientation {
	case 2:
		return w - 1 - x, y
	case 3:
		return w - 1 - x, h - 1 - y
	case 4:
		return x, h - 1 - y
	case 5:
		return y, x
	case 6:
		return y, h - 1 - x
	case 7:
		return w - 1 - y, h - 1 - x
	case 8:
		return w - 1 - y, x
	default:
		return x, y
	}
}

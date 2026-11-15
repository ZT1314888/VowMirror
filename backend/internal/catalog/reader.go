package catalog

import (
	"context"
	"errors"
	"io"
	"os"

	"backend/internal/imagevalidate"
)

var ErrUnknownOutfit = errors.New("未知套装编号")
var ErrAssetUnavailable = errors.New("套装素材缺失或无效")

type OutfitImages struct {
	Dress    *imagevalidate.ValidatedImage
	Menswear *imagevalidate.ValidatedImage
	Shoes    *imagevalidate.ValidatedImage
}

type Reader struct {
	Directory    string
	LoadManifest func() (*Manifest, error)
}

func (r *Reader) ReadOutfit(ctx context.Context, id string) (OutfitImages, error) {
	manifest, err := r.LoadManifest()
	if err != nil {
		return OutfitImages{}, ErrAssetUnavailable
	}
	for _, outfit := range manifest.Outfits {
		if outfit.ID != id {
			continue
		}
		root, err := os.OpenRoot(r.Directory)
		if err != nil {
			return OutfitImages{}, ErrAssetUnavailable
		}
		defer root.Close()
		images := make([]*imagevalidate.ValidatedImage, 0, 3)
		for _, name := range []string{outfit.Dress, outfit.Menswear, outfit.ShoesDetail} {
			if ctx.Err() != nil {
				return OutfitImages{}, ctx.Err()
			}
			img, err := readImage(root, name)
			if err != nil {
				return OutfitImages{}, ErrAssetUnavailable
			}
			images = append(images, img)
		}
		return OutfitImages{Dress: images[0], Menswear: images[1], Shoes: images[2]}, nil
	}
	return OutfitImages{}, ErrUnknownOutfit
}

func readImage(root *os.Root, name string) (*imagevalidate.ValidatedImage, error) {
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrAssetUnavailable
	}
	limits := imagevalidate.DefaultImageLimits()
	data, err := io.ReadAll(io.LimitReader(file, limits.MaxDecodedImageBytes+1))
	if err != nil {
		return nil, err
	}
	return imagevalidate.ValidateBytes(data, "", limits)
}

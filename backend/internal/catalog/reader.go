package catalog

import (
	"container/list"
	"context"
	"errors"
	"io"
	"os"
	"sync"

	"backend/internal/imagevalidate"
)

const maxCachedAssetBytes int64 = 64 << 20

var ErrUnknownOutfit = errors.New("未知套装编号")
var ErrAssetUnavailable = errors.New("套装素材缺失或无效")
var ErrUnknownVenue = errors.New("未知场馆编号")
var ErrVenueUnavailable = errors.New("场馆素材缺失或无效")

type OutfitImages struct {
	Dress    *imagevalidate.ValidatedImage
	Menswear *imagevalidate.ValidatedImage
	Shoes    *imagevalidate.ValidatedImage
}

type Reader struct {
	directory  string
	snapshot   *Snapshot
	loadAsset  func(context.Context, string) (*imagevalidate.ValidatedImage, error)
	mu         sync.Mutex
	images     map[string]*assetResult
	cache      *list.List
	cacheSize  int64
	cacheLimit int64
}

type assetResult struct {
	name       string
	done       chan struct{}
	image      *imagevalidate.ValidatedImage
	err        error
	cacheEntry *list.Element
}

func NewReader(directory string, snapshot *Snapshot) (*Reader, error) {
	if directory == "" || snapshot == nil {
		return nil, ErrAssetUnavailable
	}
	return newReader(directory, snapshot, func(ctx context.Context, name string) (*imagevalidate.ValidatedImage, error) {
		return readImage(ctx, directory, name)
	}), nil
}

func newReader(directory string, snapshot *Snapshot, loadAsset func(context.Context, string) (*imagevalidate.ValidatedImage, error)) *Reader {
	return &Reader{
		directory:  directory,
		snapshot:   snapshot,
		loadAsset:  loadAsset,
		images:     make(map[string]*assetResult),
		cache:      list.New(),
		cacheLimit: maxCachedAssetBytes,
	}
}

func (r *Reader) ReadVenue(ctx context.Context, id string) (*imagevalidate.ValidatedImage, error) {
	venue, ok := r.snapshot.Venue(id)
	if !ok {
		return nil, ErrUnknownVenue
	}
	img, err := r.read(ctx, venue.Path, "")
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, ErrVenueUnavailable
	}
	return img, nil
}

func (r *Reader) ReadOutfit(ctx context.Context, id string) (OutfitImages, error) {
	outfit, ok := r.snapshot.Outfit(id)
	if !ok {
		return OutfitImages{}, ErrUnknownOutfit
	}
	images := make([]*imagevalidate.ValidatedImage, 0, 3)
	for _, name := range []string{outfit.Dress, outfit.Menswear, outfit.ShoesDetail} {
		if ctx.Err() != nil {
			return OutfitImages{}, ctx.Err()
		}
		img, err := r.read(ctx, name, "")
		if err != nil {
			if ctx.Err() != nil {
				return OutfitImages{}, ctx.Err()
			}
			return OutfitImages{}, ErrAssetUnavailable
		}
		images = append(images, img)
	}
	return OutfitImages{Dress: images[0], Menswear: images[1], Shoes: images[2]}, nil
}

func (r *Reader) read(ctx context.Context, name, requiredMIME string) (*imagevalidate.ValidatedImage, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	r.mu.Lock()
	if result, ok := r.images[name]; ok {
		if result.cacheEntry != nil {
			r.cache.MoveToFront(result.cacheEntry)
		}
		r.mu.Unlock()
		return waitForAsset(ctx, result, requiredMIME)
	}
	result := &assetResult{name: name, done: make(chan struct{})}
	r.images[name] = result
	r.mu.Unlock()

	img, err := r.loadAsset(context.WithoutCancel(ctx), name)
	if err == nil {
		err = imagevalidate.CheckImage(img, imagevalidate.DefaultImageLimits())
	}
	r.mu.Lock()
	if err != nil {
		if r.images[name] == result {
			delete(r.images, name)
		}
	} else {
		result.image = img
		result.cacheEntry = r.cache.PushFront(result)
		r.cacheSize += int64(img.Size())
		r.evictCachedAssets()
	}
	result.err = err
	close(result.done)
	r.mu.Unlock()
	return waitForAsset(ctx, result, requiredMIME)
}

func (r *Reader) evictCachedAssets() {
	for r.cacheSize > r.cacheLimit {
		entry := r.cache.Back()
		if entry == nil {
			return
		}
		result := entry.Value.(*assetResult)
		r.cache.Remove(entry)
		result.cacheEntry = nil
		r.cacheSize -= int64(result.image.Size())
		if r.images[result.name] == result {
			delete(r.images, result.name)
		}
	}
}

func waitForAsset(ctx context.Context, result *assetResult, requiredMIME string) (*imagevalidate.ValidatedImage, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-result.done:
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if result.err != nil {
			return nil, result.err
		}
		if requiredMIME != "" && result.image.MIME() != requiredMIME {
			return nil, ErrAssetUnavailable
		}
		return result.image, nil
	}
}

func readImage(ctx context.Context, directory, name string) (*imagevalidate.ValidatedImage, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
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
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return imagevalidate.ValidateBytes(data, "", limits)
}

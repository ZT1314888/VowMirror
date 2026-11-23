// Package facedetect counts frontal faces without retaining photos or detections.
package facedetect

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"image"
	"sort"

	pigo "github.com/esimov/pigo/core"
)

//go:embed facefinder
var cascade []byte

const (
	cascadeSHA256 = "d8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd"
	maxEdge       = 2048
	minFace       = 24
	shiftFactor   = 0.1
	scaleFactor   = 1.1
	clusterIoU    = 0.2
	// Cluster scores sum overlapping windows. Weak isolated matches are common
	// on clothing and backgrounds and must not make a one-face upload pass.
	minConfidence = 20.0
)

type Detector struct {
	classifier *pigo.Pigo
}

func New() (*Detector, error) {
	return load(cascade)
}

func load(packet []byte) (*Detector, error) {
	// The upstream unpacker assumes a well-formed packet. Verify before parsing.
	sum := sha256.Sum256(packet)
	if hex.EncodeToString(sum[:]) != cascadeSHA256 {
		return nil, errors.New("facefinder checksum mismatch")
	}
	classifier, err := pigo.NewPigo().Unpack(packet)
	if err != nil {
		return nil, err
	}
	return &Detector{classifier: classifier}, nil
}

func (d *Detector) Count(ctx context.Context, pixels image.Image, original []byte) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if pixels == nil || pixels.Bounds().Empty() {
		return 0, errors.New("missing decoded pixels")
	}
	orientation, err := jpegOrientation(original)
	if err != nil {
		return 0, err
	}
	gray, err := detectionCopy(ctx, pixels, orientation)
	if err != nil {
		return 0, err
	}
	params := pigo.CascadeParams{
		ShiftFactor: shiftFactor, ScaleFactor: scaleFactor,
		ImageParams: pigo.ImageParams{Rows: gray.Rect.Dy(), Cols: gray.Rect.Dx(), Dim: gray.Stride, Pixels: gray.Pix},
	}
	var candidates []pigo.Detection
	// Run each scale synchronously so cancellation stops work without orphaned workers.
	for scale := minFace; scale <= min(params.Rows, params.Cols); scale = int(float64(scale) * scaleFactor) {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		params.MinSize, params.MaxSize = scale, scale
		candidates = append(candidates, d.classifier.RunCascade(params, 0)...)
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	clusters := d.classifier.ClusterDetections(candidates, clusterIoU)
	return countDistinct(clusters), ctx.Err()
}

func countDistinct(clusters []pigo.Detection) int {
	// Pigo can reuse assigned windows while averaging another cluster. Suppress
	// a weaker cluster when most of its smaller square is already represented.
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Q > clusters[j].Q })
	kept := clusters[:0]
	for _, candidate := range clusters {
		if candidate.Q < minConfidence {
			break
		}
		if !overlapsKept(candidate, kept) {
			kept = append(kept, candidate)
		}
	}
	return len(kept)
}

func overlapsKept(candidate pigo.Detection, kept []pigo.Detection) bool {
	box := func(d pigo.Detection) image.Rectangle {
		x, y := d.Col-d.Scale/2, d.Row-d.Scale/2
		return image.Rect(x, y, x+d.Scale, y+d.Scale)
	}
	a := box(candidate)
	for _, face := range kept {
		b := box(face)
		intersection := a.Intersect(b)
		shorter := min(candidate.Scale, face.Scale)
		if 2*intersection.Dx()*intersection.Dy() > shorter*shorter {
			return true
		}
	}
	return false
}

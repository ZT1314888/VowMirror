package catalog

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"math/big"

	"backend/internal/imagevalidate"
)

var ErrPoseUnavailable = errors.New("姿势清单、随机源或线稿不可用")

type PoseSelector struct {
	LoadManifest func() (*Manifest, error)
	Random       io.Reader
}

func (s *PoseSelector) Select(ctx context.Context) (Pose, error) {
	if ctx.Err() != nil {
		return Pose{}, ctx.Err()
	}
	if s.LoadManifest == nil || s.Random == nil {
		return Pose{}, ErrPoseUnavailable
	}
	manifest, err := s.LoadManifest()
	if err != nil || manifest == nil {
		return Pose{}, ErrPoseUnavailable
	}
	if err := manifest.Validate(); err != nil {
		return Pose{}, ErrPoseUnavailable
	}
	index, err := rand.Int(s.Random, big.NewInt(int64(len(manifest.Poses))))
	if err != nil {
		return Pose{}, ErrPoseUnavailable
	}
	if ctx.Err() != nil {
		return Pose{}, ctx.Err()
	}
	return manifest.Poses[index.Int64()], nil
}

func (r *Reader) ReadPose(ctx context.Context, id string) (*imagevalidate.ValidatedImage, error) {
	manifest, err := r.LoadManifest()
	if err != nil || manifest == nil {
		return nil, ErrPoseUnavailable
	}
	for _, pose := range manifest.Poses {
		if pose.ID != id {
			continue
		}
		img, err := r.read(ctx, pose.Path)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil || img == nil || img.MIME != "image/png" {
			return nil, ErrPoseUnavailable
		}
		return img, nil
	}
	return nil, ErrPoseUnavailable
}

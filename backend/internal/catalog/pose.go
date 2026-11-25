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
	Snapshot *Snapshot
	Random   io.Reader
}

func (s *PoseSelector) Select(ctx context.Context) (Pose, error) {
	if ctx.Err() != nil {
		return Pose{}, ctx.Err()
	}
	if s.Snapshot == nil || s.Random == nil || s.Snapshot.PoseCount() == 0 {
		return Pose{}, ErrPoseUnavailable
	}
	index, err := rand.Int(s.Random, big.NewInt(int64(s.Snapshot.PoseCount())))
	if err != nil {
		return Pose{}, ErrPoseUnavailable
	}
	if ctx.Err() != nil {
		return Pose{}, ctx.Err()
	}
	pose, ok := s.Snapshot.PoseAt(int(index.Int64()))
	if !ok {
		return Pose{}, ErrPoseUnavailable
	}
	return pose, nil
}

func (r *Reader) ReadPose(ctx context.Context, id string) (*imagevalidate.ValidatedImage, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	pose, ok := r.snapshot.Pose(id)
	if !ok {
		return nil, ErrPoseUnavailable
	}
	img, err := r.read(ctx, pose.Path, "image/png")
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, ErrPoseUnavailable
	}
	return img, nil
}

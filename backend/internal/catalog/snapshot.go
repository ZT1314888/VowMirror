package catalog

import (
	"errors"
	"slices"
)

type Snapshot struct {
	outfits map[string]Outfit
	venues  map[string]Venue
	poses   []Pose
	public  PublicDirectory
}

func NewSnapshot(manifest *Manifest) (*Snapshot, error) {
	if manifest == nil {
		return nil, errors.New("婚礼素材清单不可用")
	}
	copy := Manifest{
		Version: manifest.Version,
		Outfits: slices.Clone(manifest.Outfits),
		Poses:   slices.Clone(manifest.Poses),
		Venues:  slices.Clone(manifest.Venues),
	}
	if err := copy.Validate(); err != nil {
		return nil, err
	}
	snapshot := &Snapshot{
		outfits: make(map[string]Outfit, len(copy.Outfits)),
		venues:  make(map[string]Venue, len(copy.Venues)),
		poses:   copy.Poses,
		public:  ExposePublicDirectory(&copy),
	}
	for _, outfit := range copy.Outfits {
		snapshot.outfits[outfit.ID] = outfit
	}
	for _, venue := range copy.Venues {
		snapshot.venues[venue.ID] = venue
	}
	return snapshot, nil
}

func (s *Snapshot) Outfit(id string) (Outfit, bool) {
	if s == nil {
		return Outfit{}, false
	}
	outfit, ok := s.outfits[id]
	return outfit, ok
}

func (s *Snapshot) Venue(id string) (Venue, bool) {
	if s == nil {
		return Venue{}, false
	}
	venue, ok := s.venues[id]
	return venue, ok
}

func (s *Snapshot) PoseCount() int {
	if s == nil {
		return 0
	}
	return len(s.poses)
}

func (s *Snapshot) PoseAt(index int) (Pose, bool) {
	if s == nil || index < 0 || index >= len(s.poses) {
		return Pose{}, false
	}
	return s.poses[index], true
}

func (s *Snapshot) Pose(id string) (Pose, bool) {
	if s == nil {
		return Pose{}, false
	}
	for _, pose := range s.poses {
		if pose.ID == id {
			return pose, true
		}
	}
	return Pose{}, false
}

func (s *Snapshot) PublicDirectory() PublicDirectory {
	if s == nil {
		return PublicDirectory{}
	}
	return PublicDirectory{
		Version: s.public.Version,
		Outfits: append([]DirectoryEntry{}, s.public.Outfits...),
		Venues:  append([]DirectoryEntry{}, s.public.Venues...),
	}
}

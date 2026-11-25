package catalog

import "testing"

func TestSnapshotDoesNotExposeMutableManifestCollections(t *testing.T) {
	manifest := projectPoses(t)
	snapshot, err := NewSnapshot(manifest)
	if err != nil {
		t.Fatal(err)
	}
	outfit := manifest.Outfits[0]
	pose := manifest.Poses[0]
	manifest.Outfits[0].Dress = "../outside.png"
	manifest.Poses[0].Action = "changed"
	public := snapshot.PublicDirectory()
	public.Outfits[0].Name = "changed"
	gotOutfit, ok := snapshot.Outfit(outfit.ID)
	if !ok || gotOutfit != outfit {
		t.Fatal("caller mutation changed snapshot outfit")
	}
	gotPose, ok := snapshot.Pose(pose.ID)
	if !ok || gotPose != pose || snapshot.PublicDirectory().Outfits[0].Name == "changed" {
		t.Fatal("caller mutation changed snapshot pose or public directory")
	}
	if snapshot.PublicDirectory().Venues == nil {
		t.Fatal("empty venues must serialize as an array")
	}
}

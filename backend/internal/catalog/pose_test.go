package catalog

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func projectPoses(t *testing.T) *Manifest {
	t.Helper()
	m, err := LoadManifest("../../../assets/wedding/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPoseSelectionCoversAll28Entries(t *testing.T) {
	m := projectPoses(t)
	mixed := []string{}
	for _, p := range m.Poses {
		if p.Mode == PoseLineartText {
			mixed = append(mixed, p.ID)
		}
		if p.ID == "P020" || p.ID == "P027" {
			t.Fatalf("deleted pose remains: %s", p.ID)
		}
	}
	if !reflect.DeepEqual(mixed, []string{"P003", "P007", "P008", "P013", "P023", "P028"}) {
		t.Fatalf("classification changed: %v", mixed)
	}
	for _, reversed := range []bool{false, true} {
		if reversed {
			for i, j := 0, len(m.Poses)-1; i < j; i, j = i+1, j-1 {
				m.Poses[i], m.Poses[j] = m.Poses[j], m.Poses[i]
			}
		}
		seen := map[string]bool{}
		for index := 0; index < 28; index++ {
			s := &PoseSelector{LoadManifest: func() (*Manifest, error) { return m, nil }, Random: bytes.NewReader([]byte{byte(index)})}
			p, err := s.Select(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if seen[p.ID] || p.ID == "P020" || p.ID == "P027" {
				t.Fatalf("invalid candidate %s", p.ID)
			}
			seen[p.ID] = true
		}
		if len(seen) != 28 {
			t.Fatal("not all candidates reachable")
		}
	}
}

func TestPoseSelectionFailsExplicitlyWithoutFallback(t *testing.T) {
	for _, scenario := range []string{"load", "nil", "invalid", "empty_pool", "random"} {
		t.Run(scenario, func(t *testing.T) {
			m := projectPoses(t)
			load := func() (*Manifest, error) { return m, nil }
			switch scenario {
			case "load":
				load = func() (*Manifest, error) { return nil, errors.New("synthetic load failure") }
			case "nil":
				load = func() (*Manifest, error) { return nil, nil }
			case "invalid":
				m.Poses[0].Action = ""
			case "empty_pool":
				m.Poses = nil
			}
			randomBytes := []byte{0}
			if scenario == "random" {
				randomBytes = nil
			}
			s := &PoseSelector{LoadManifest: load, Random: bytes.NewReader(randomBytes)}
			if _, err := s.Select(context.Background()); !errors.Is(err, ErrPoseUnavailable) {
				t.Fatalf("missing explicit error: %v", err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&PoseSelector{}).Select(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestReadPoseUsesControlledDecodedPNGAndRejectsMissingOrEscapingFiles(t *testing.T) {
	m := projectPoses(t)
	root := t.TempDir()
	r := &Reader{Directory: root, LoadManifest: func() (*Manifest, error) { return m, nil }}
	if _, err := r.ReadPose(context.Background(), "../P007"); !errors.Is(err, ErrPoseUnavailable) {
		t.Fatal(err)
	}
	target := filepath.Join(root, "poses/P007.png")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadPose(context.Background(), "P007"); !errors.Is(err, ErrPoseUnavailable) {
		t.Fatal(err)
	}
	for _, format := range []string{"png", "jpg"} {
		data, err := os.ReadFile("../imagevalidate/testdata/checker." + format)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0600); err != nil {
			t.Fatal(err)
		}
		img, err := r.ReadPose(context.Background(), "P007")
		if format == "png" && (err != nil || img == nil || !bytes.Equal(img.Data, data)) {
			t.Fatal("valid line drawing rejected", err)
		}
		if format == "jpg" && !errors.Is(err, ErrPoseUnavailable) {
			t.Fatal("mislabeled line drawing accepted")
		}
	}
	if err := os.WriteFile(target, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadPose(context.Background(), "P007"); !errors.Is(err, ErrPoseUnavailable) {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("private marker"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, target); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReadPose(context.Background(), "P007"); !errors.Is(err, ErrPoseUnavailable) {
		t.Fatal("symlink escape accepted")
	}
}

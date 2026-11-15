package catalog

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func readerFixture(t *testing.T) (*Reader, Outfit, []byte) {
	t.Helper()
	manifest, err := LoadManifest("../../../tests/fixtures/wedding-assets-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	fixture, err := os.ReadFile("../imagevalidate/testdata/checker.png")
	if err != nil {
		t.Fatal(err)
	}
	outfit := manifest.Outfits[0]
	for _, name := range []string{outfit.Dress, outfit.Menswear, outfit.ShoesDetail} {
		full := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, fixture, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return &Reader{Directory: root, LoadManifest: func() (*Manifest, error) { return manifest, nil }}, outfit, fixture
}
func TestReaderOnlyResolvesFixedIDs(t *testing.T) {
	reader, outfit, fixture := readerFixture(t)
	result, err := reader.ReadOutfit(context.Background(), outfit.ID)
	if err != nil || result.Dress.MIME != "image/png" || len(result.Shoes.Data) != len(fixture) {
		t.Fatalf("fixed outfit failed: %v", err)
	}
	for _, id := range []string{"W999", "../W001", outfit.Dress, "https://private-marker/image.png", ""} {
		if _, err := reader.ReadOutfit(context.Background(), id); !errors.Is(err, ErrUnknownOutfit) {
			t.Fatalf("invalid ID accepted: %s: %v", id, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := reader.ReadOutfit(ctx, outfit.ID); !errors.Is(err, context.Canceled) {
		t.Fatal("cancel ignored")
	}
}
func TestReaderRejectsMissingCorruptOversizeAndSymlinkEscape(t *testing.T) {
	for _, scenario := range []string{"missing", "truncated", "oversize", "symlink", "directory"} {
		t.Run(scenario, func(t *testing.T) {
			reader, outfit, fixture := readerFixture(t)
			target := filepath.Join(reader.Directory, filepath.FromSlash(outfit.ShoesDetail))
			if err := os.Remove(target); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "truncated":
				if err := os.WriteFile(target, fixture[:40], 0600); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				file, err := os.Create(target)
				if err != nil {
					t.Fatal(err)
				}
				if err := file.Truncate((8 << 20) + 1); err != nil {
					t.Fatal(err)
				}
				file.Close()
			case "symlink":
				outside := filepath.Join(t.TempDir(), "outside.png")
				if err := os.WriteFile(outside, fixture, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, target); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := reader.ReadOutfit(context.Background(), outfit.ID); !errors.Is(err, ErrAssetUnavailable) {
				t.Fatalf("invalid asset accepted: %v", err)
			}
		})
	}
}

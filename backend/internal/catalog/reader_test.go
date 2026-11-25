package catalog

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"backend/internal/imagevalidate"
)

func TestVenueReaderFixedIDsAndInvalidFiles(t *testing.T) {
	for _, scenario := range []string{"valid", "empty catalog", "missing", "truncated", "directory", "symlink"} {
		t.Run(scenario, func(t *testing.T) {
			reader, _, fixture := readerFixture(t)
			manifest, err := LoadManifest("../../../tests/fixtures/wedding-assets-manifest.json")
			if err != nil {
				t.Fatal(err)
			}
			manifest.Venues = []Venue{{ID: "V001", Name: "Synthetic venue", Path: "venues/V001/scene.png"}}
			if scenario == "empty catalog" {
				manifest.Venues = []Venue{}
			}
			reader = readerFromManifest(t, reader.directory, manifest)
			full := filepath.Join(reader.directory, "venues", "V001", "scene.png")
			if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "valid":
				if err := os.WriteFile(full, fixture, 0600); err != nil {
					t.Fatal(err)
				}
			case "truncated":
				if err := os.WriteFile(full, fixture[:40], 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(full, 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				outside := filepath.Join(t.TempDir(), "outside.png")
				if err := os.WriteFile(outside, fixture, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, full); err != nil {
					t.Fatal(err)
				}
			}
			img, err := reader.ReadVenue(context.Background(), "V001")
			if scenario == "valid" {
				if err != nil || img.MIME() != "image/png" || !bytes.Equal(img.Bytes(), fixture) {
					t.Fatalf("venue changed: %v", err)
				}
			} else if scenario == "empty catalog" {
				if !errors.Is(err, ErrUnknownVenue) {
					t.Fatalf("empty catalog: %v", err)
				}
			} else if !errors.Is(err, ErrVenueUnavailable) {
				t.Fatalf("invalid venue accepted: %v", err)
			}
			for _, id := range []string{"../V001", "venues/V001/scene.png", "https://invalid/scene.png", "V999"} {
				if _, err := reader.ReadVenue(context.Background(), id); !errors.Is(err, ErrUnknownVenue) {
					t.Fatalf("invalid ID %s: %v", id, err)
				}
			}
		})
	}
}

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
	return readerFromManifest(t, root, manifest), outfit, fixture
}

func readerFromManifest(t *testing.T, directory string, manifest *Manifest) *Reader {
	t.Helper()
	snapshot, err := NewSnapshot(manifest)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(directory, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return reader
}
func TestReaderOnlyResolvesFixedIDs(t *testing.T) {
	reader, outfit, fixture := readerFixture(t)
	result, err := reader.ReadOutfit(context.Background(), outfit.ID)
	if err != nil || result.Dress.MIME() != "image/png" || result.Shoes.Size() != len(fixture) {
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
			target := filepath.Join(reader.directory, filepath.FromSlash(outfit.ShoesDetail))
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

func TestReaderCoalescesConcurrentReadsAndCachesOnlySuccess(t *testing.T) {
	reader, outfit, fixture := readerFixture(t)
	image, err := imagevalidate.ValidateBytes(fixture, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	reader.loadAsset = func(context.Context, string) (*imagevalidate.ValidatedImage, error) {
		reads.Add(1)
		close(started)
		<-release
		return image, nil
	}
	const callers = 16
	var group sync.WaitGroup
	results := make(chan *imagevalidate.ValidatedImage, callers)
	for range callers {
		group.Add(1)
		go func() {
			defer group.Done()
			img, err := reader.read(context.Background(), outfit.Dress, "")
			if err != nil {
				t.Error(err)
			}
			results <- img
		}()
	}
	<-started
	close(release)
	group.Wait()
	close(results)
	if reads.Load() != 1 {
		t.Fatalf("concurrent first read loaded %d times", reads.Load())
	}
	for img := range results {
		if img != image {
			t.Fatal("cache did not share immutable image")
		}
	}

	var retries atomic.Int32
	reader.loadAsset = func(context.Context, string) (*imagevalidate.ValidatedImage, error) {
		if retries.Add(1) == 1 {
			return nil, ErrAssetUnavailable
		}
		return image, nil
	}
	if _, err := reader.read(context.Background(), "retry-after-failure", ""); !errors.Is(err, ErrAssetUnavailable) {
		t.Fatal("first failure was not explicit", err)
	}
	if img, err := reader.read(context.Background(), "retry-after-failure", ""); err != nil || img != image || retries.Load() != 2 {
		t.Fatal("failed image was cached", err)
	}
	if _, err := reader.read(context.Background(), outfit.Dress, "image/jpeg"); !errors.Is(err, ErrAssetUnavailable) {
		t.Fatal("cached image bypassed the required MIME check", err)
	}
}

type observedDoneContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *observedDoneContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestCanceledAssetLoaderDoesNotFailConcurrentWaiter(t *testing.T) {
	reader, _, fixture := readerFixture(t)
	image, err := imagevalidate.ValidateBytes(fixture, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	reader.loadAsset = func(ctx context.Context, _ string) (*imagevalidate.ValidatedImage, error) {
		close(started)
		<-release
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return image, nil
	}

	ownerCtx, cancelOwner := context.WithCancel(context.Background())
	defer cancelOwner()
	ownerDone := make(chan error, 1)
	go func() {
		_, err := reader.read(ownerCtx, "shared", "")
		ownerDone <- err
	}()
	<-started

	waiting := make(chan struct{})
	waiterCtx := &observedDoneContext{Context: context.Background(), waiting: waiting}
	waiterDone := make(chan error, 1)
	go func() {
		got, err := reader.read(waiterCtx, "shared", "")
		if err == nil && got != image {
			err = errors.New("waiter received a different image")
		}
		waiterDone <- err
	}()
	<-waiting
	cancelOwner()
	close(release)

	if err := <-ownerDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled owner result: %v", err)
	}
	if err := <-waiterDone; err != nil {
		t.Fatalf("unrelated waiter inherited owner cancellation: %v", err)
	}
}

func TestReaderBoundsAssetCacheWithLRUEviction(t *testing.T) {
	reader, _, fixture := readerFixture(t)
	image, err := imagevalidate.ValidateBytes(fixture, "", imagevalidate.DefaultImageLimits())
	if err != nil {
		t.Fatal(err)
	}
	reader.cacheLimit = int64(image.Size() * 2)
	var reads atomic.Int32
	reader.loadAsset = func(context.Context, string) (*imagevalidate.ValidatedImage, error) {
		reads.Add(1)
		return image, nil
	}
	for _, name := range []string{"first", "second"} {
		if _, err := reader.read(context.Background(), name, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reader.read(context.Background(), "first", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.read(context.Background(), "third", ""); err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 3 || reader.cacheSize != int64(image.Size()*2) || len(reader.images) != 2 {
		t.Fatalf("cache exceeded its byte bound or failed to evict: reads=%d size=%d entries=%d", reads.Load(), reader.cacheSize, len(reader.images))
	}
	if _, err := reader.read(context.Background(), "first", ""); err != nil || reads.Load() != 3 {
		t.Fatalf("recently used asset was evicted: reads=%d err=%v", reads.Load(), err)
	}
	if _, err := reader.read(context.Background(), "second", ""); err != nil || reads.Load() != 4 {
		t.Fatalf("least recently used asset was not reloaded: reads=%d err=%v", reads.Load(), err)
	}
}

package facedetect

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"testing"
)

func TestCountsRealImages(t *testing.T) {
	detector, err := New()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		file string
		want int
	}{
		{"../imagevalidate/testdata/checker.png", 0},
		{"testdata/one.jpg", 1},
		{"testdata/two.jpg", 2},
		{"testdata/three.jpg", 3},
		{"testdata/two-exif6.jpg", 2},
	} {
		t.Run(tc.file, func(t *testing.T) {
			data, err := os.ReadFile(tc.file)
			if err != nil {
				t.Fatal(err)
			}
			pixels, _, err := image.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			count, err := detector.Count(context.Background(), pixels, data)
			if err != nil || count != tc.want {
				t.Fatalf("count = %d, err = %v, want %d", count, err, tc.want)
			}
		})
	}
}

func TestDetectionCopyOrientation(t *testing.T) {
	src := image.NewGray(image.Rect(0, 0, 3, 2))
	copy(src.Pix, []byte{1, 2, 3, 4, 5, 6})
	for i, want := range [][]byte{
		{1, 2, 3, 4, 5, 6}, {3, 2, 1, 6, 5, 4}, {6, 5, 4, 3, 2, 1}, {4, 5, 6, 1, 2, 3},
		{1, 4, 2, 5, 3, 6}, {4, 1, 5, 2, 6, 3}, {6, 3, 5, 2, 4, 1}, {3, 6, 2, 5, 1, 4},
	} {
		upright, err := detectionCopy(context.Background(), src, i+1)
		if err != nil || !bytes.Equal(upright.Pix, want) {
			t.Fatalf("orientation %d: got %v, %v; want %v", i+1, upright, err, want)
		}
	}
}

func TestBoundsAndCancellation(t *testing.T) {
	src := image.NewGray(image.Rect(10, 20, 4106, 1044))
	resized, err := detectionCopy(context.Background(), src, 6)
	if err != nil || resized.Rect.Size() != (image.Point{X: 512, Y: 2048}) {
		t.Fatalf("rotated 4096x1024 image: %v, %v", resized.Rect, err)
	}
	d, err := New()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if count, err := d.Count(ctx, src, nil); count != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: count %d, err %v", count, err)
	}
}

func TestInvalidCascadeRejected(t *testing.T) {
	if _, err := load([]byte("bad")); err == nil {
		t.Fatal("accepted truncated cascade")
	}
}

func TestCorruptExifRejected(t *testing.T) {
	if _, err := jpegOrientation([]byte("\xff\xd8\xff\xe1\x00\x10Exif\x00\x00II\x2a\x00\xff\xff\xff\xff")); !errors.Is(err, errOrientation) {
		t.Fatalf("expected error for invalid IFD offset: %v", err)
	}
}

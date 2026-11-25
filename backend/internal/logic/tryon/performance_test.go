package tryon

import (
	"os"
	"path/filepath"
	"testing"

	"backend/internal/imagevalidate"
)

func BenchmarkValidateReferences(b *testing.B) {
	files := []struct {
		role Role
		name string
		mime string
	}{
		{RoleCouple, "jpg", "image/jpeg"},
		{RoleDress, "png", "image/png"},
		{RoleMenswear, "webp", "image/webp"},
		{RoleShoes, "jpg", "image/jpeg"},
	}
	refs := make([]Reference, 0, len(files))
	var total int64
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join("..", "..", "imagevalidate", "testdata", "checker."+file.name))
		if err != nil {
			b.Fatal(err)
		}
		img, err := imagevalidate.ValidateBytes(data, file.mime, imagevalidate.DefaultImageLimits())
		if err != nil {
			b.Fatal(err)
		}
		refs = append(refs, Reference{Role: file.role, Image: img})
		total += int64(len(data))
	}
	b.SetBytes(total)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if err := validateReferences(refs); err != nil {
			b.Fatal(err)
		}
	}
}

package tryon

import (
	"encoding/base64"
	"testing"
)

func TestResultRequiresCompleteLandscapeImage(t *testing.T) {
	good := landscape(t)
	if _, err := ValidateResult("data:image/png;base64," + base64.StdEncoding.EncodeToString(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "!!", base64.StdEncoding.EncodeToString(good[:40]), "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(good), base64.StdEncoding.EncodeToString(fixture(t, "webp"))} {
		if _, err := ValidateResult(bad); err == nil {
			t.Fatal("invalid result accepted")
		}
	}
}

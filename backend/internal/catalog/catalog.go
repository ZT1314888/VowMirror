package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"
)

const outfitCount = 30
const poseCount = 30

var schemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

type Manifest struct {
	Version int      `json:"version"`
	Outfits []Outfit `json:"outfits"`
	Poses   []Pose   `json:"poses"`
}

type Outfit struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Dress       string `json:"dress"`
	Menswear    string `json:"menswear"`
	ShoesDetail string `json:"shoes_detail"`
}

type Pose struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

func LoadManifest(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取婚礼素材清单失败: %w", err)
	}
	return ParseManifest(data)
}

func ParseManifest(data []byte) (*Manifest, error) {
	fields, err := objectFields(trimUTF8BOM(data), "version", "outfits", "poses")
	if err != nil {
		return nil, fmt.Errorf("解析婚礼素材清单失败: %w", err)
	}
	// JSON numbers such as 1.0 have the same meaning as 1 in the Node validator.
	var version float64
	if err := json.Unmarshal(fields["version"], &version); err != nil {
		return nil, fmt.Errorf("解析婚礼素材清单失败: %w", err)
	}
	if version != 1 {
		return nil, fmt.Errorf("婚礼素材清单版本无效")
	}
	outfits, err := parseObjects[Outfit](fields["outfits"], "id", "name", "dress", "menswear", "shoes_detail")
	if err != nil {
		return nil, fmt.Errorf("解析服装清单失败: %w", err)
	}
	poses, err := parseObjects[Pose](fields["poses"], "id", "name", "path", "status")
	if err != nil {
		return nil, fmt.Errorf("解析姿势清单失败: %w", err)
	}
	manifest := Manifest{Version: 1, Outfits: outfits, Poses: poses}
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	return &manifest, nil
}

// Exact field names matter: encoding/json otherwise accepts case variants.
func objectFields(data []byte, allowed ...string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, fmt.Errorf("清单及条目必须为对象")
	}
	for key := range fields {
		known := false
		for _, name := range allowed {
			if key == name {
				known = true
				break
			}
		}
		if !known {
			return nil, fmt.Errorf("未知字段 %s", key)
		}
	}
	return fields, nil
}

func parseObjects[T any](data []byte, keys ...string) ([]T, error) {
	var entries []json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	if entries == nil {
		return nil, fmt.Errorf("清单集合必须是数组")
	}
	objects := make([]T, len(entries))
	for index, entry := range entries {
		fields, err := objectFields(entry, keys...)
		if err != nil {
			return nil, err
		}
		// Resolve duplicate keys before decoding: JSON.parse uses the last value,
		// whereas Go would retain an earlier string when the last value is null.
		normalized, err := json.Marshal(fields)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(normalized, &objects[index]); err != nil {
			return nil, err
		}
	}
	return objects, nil
}

func (m *Manifest) Validate() error {
	if m.Version != 1 {
		return fmt.Errorf("婚礼素材清单版本无效")
	}
	if len(m.Outfits) != outfitCount {
		return fmt.Errorf("婚礼素材清单必须包含 30 套服装")
	}
	if len(m.Poses) != poseCount {
		return fmt.Errorf("婚礼素材清单必须包含 30 个姿势")
	}
	outfitIDs := expectedIDs("W", outfitCount)
	seenPaths := make(map[string]bool)
	for _, outfit := range m.Outfits {
		if !outfitIDs[outfit.ID] || isBlank(outfit.Name) {
			return fmt.Errorf("婚礼素材清单服装项 %s 无效或重复", outfit.ID)
		}
		delete(outfitIDs, outfit.ID)
		for _, assetPath := range []string{outfit.Dress, outfit.Menswear, outfit.ShoesDetail} {
			if !validOutfitPath(outfit.ID, assetPath) || seenPaths[assetPath] {
				return fmt.Errorf("婚礼素材清单服装路径 %s 无效或重复", assetPath)
			}
			seenPaths[assetPath] = true
		}
	}
	poseIDs := expectedIDs("P", poseCount)
	for _, pose := range m.Poses {
		if !poseIDs[pose.ID] || isBlank(pose.Name) || pose.Path != "poses/"+pose.ID+".png" || pose.Status != "unverified" {
			return fmt.Errorf("婚礼素材清单姿势项 %s 无效或重复", pose.ID)
		}
		delete(poseIDs, pose.ID)
	}
	return nil
}

func expectedIDs(prefix string, count int) map[string]bool {
	ids := make(map[string]bool, count)
	for index := 1; index <= count; index++ {
		ids[fmt.Sprintf("%s%03d", prefix, index)] = true
	}
	return ids
}

func validOutfitPath(id, value string) bool {
	if isBlank(value) || strings.Contains(value, `\`) || strings.HasPrefix(value, "/") || schemePattern.MatchString(value) || strings.Contains(value, "://") {
		return false
	}
	segments := strings.Split(value, "/")
	if len(segments) < 2 || segments[0] != id {
		return false
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	switch strings.ToLower(path.Ext(value)) {
	case ".png", ".jpg", ".jpeg", ".webp":
		return true
	default:
		return false
	}
}

func isBlank(value string) bool {
	// Match ECMAScript String.trim, including BOM but excluding U+0085.
	const whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
	return strings.Trim(value, whitespace) == ""
}

func trimUTF8BOM(data []byte) []byte {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return data[3:]
	}
	return data
}

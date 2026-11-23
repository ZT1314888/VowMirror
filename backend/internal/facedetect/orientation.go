package facedetect

import (
	"bytes"
	"encoding/binary"
	"errors"
)

var errOrientation = errors.New("invalid JPEG EXIF orientation metadata")

// Only metadata before the first scan can describe the main JPEG image. Do not
// search compressed pixels, thumbnail IFDs or arbitrary APP1 (e.g. XMP) payloads.
func jpegOrientation(data []byte) (int, error) {
	if !bytes.HasPrefix(data, []byte{0xff, 0xd8}) {
		return 1, nil
	}
	for pos := 2; pos < len(data); {
		for pos < len(data) && data[pos] == 0xff {
			pos++
		}
		if pos == len(data) {
			break
		}
		marker := data[pos]
		pos++
		switch {
		case marker == 0xda || marker == 0xd9:
			return 1, nil
		case marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7):
			continue
		}
		if len(data)-pos < 2 {
			return 0, errOrientation
		}
		length := int(binary.BigEndian.Uint16(data[pos:]))
		if length < 2 || length > len(data)-pos {
			return 0, errOrientation
		}
		segment := data[pos+2 : pos+length]
		if marker == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
			return tiffOrientation(segment[6:])
		}
		pos += length
	}
	return 1, nil
}

func tiffOrientation(tiff []byte) (int, error) {
	if len(tiff) < 8 {
		return 0, errOrientation
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, errOrientation
	}
	offset := order.Uint32(tiff[4:8])
	if order.Uint16(tiff[2:4]) != 42 || offset < 8 || offset > uint32(len(tiff)-2) {
		return 0, errOrientation
	}
	n := int(order.Uint16(tiff[offset:]))
	entries := tiff[offset+2:]
	if n > len(entries)/12 {
		return 0, errOrientation
	}
	for i := 0; i < n; i++ {
		entry := entries[12*i : 12*(i+1)]
		if order.Uint16(entry) != 0x0112 {
			continue
		}
		value := int(order.Uint16(entry[8:10]))
		if order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 || value < 1 || value > 8 {
			return 0, errOrientation
		}
		return value, nil
	}
	return 1, nil
}

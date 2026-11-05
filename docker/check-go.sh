#!/bin/sh
set -eu

# Dependency and compilation preparation occurs before the test deadline.
go mod download
go build ./...
timeout -s TERM -k 2s 58s go test -count=1 -timeout=55s ./...
formatting=$(gofmt -l .)
if [ -n "$formatting" ]; then
    printf 'Go formatting required:\n%s\n' "$formatting" >&2
    exit 1
fi
go vet ./...
go build -o /tmp/vowmirror .

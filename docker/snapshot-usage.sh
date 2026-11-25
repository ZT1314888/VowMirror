#!/bin/sh
set -eu
umask 077

source=${1:-/usage/usage.sqlite}
if [ ! -d "$(dirname "$source")" ]; then
    echo 'Usage volume is unavailable.' >&2
    exit 1
fi
if [ ! -e "$source" ]; then
    echo 'Usage database has not been initialized; skipping backup.' >&2
    exit 3
fi
if [ ! -s "$source" ] || [ ! -r "$source" ]; then
    echo 'Usage database must be nonempty and readable.' >&2
    exit 1
fi

# Compose mounts /tmp as tmpfs. The online backup API includes committed WAL data.
temporary=$(mktemp -d)
snapshot=$temporary/usage.sqlite
cleanup() {
    rm -f -- "$snapshot" "$snapshot-wal" "$snapshot-shm" "$snapshot-journal"
    rmdir -- "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
sqlite3 -readonly "$source" '.timeout 5000' ".backup '$snapshot'"
# The backup inherits WAL mode; normalize the copy so the stream is one complete file.
sqlite3 "$snapshot" 'PRAGMA journal_mode = DELETE;' >/dev/null
test "$(sqlite3 -readonly "$snapshot" 'PRAGMA integrity_check;')" = ok
cat "$snapshot"

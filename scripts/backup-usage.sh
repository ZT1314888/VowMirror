#!/usr/bin/env bash
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
recipients=${VOWMIRROR_BACKUP_RECIPIENTS:-/etc/vowmirror/backup.age.pub}
directory=${VOWMIRROR_BACKUP_DIR:-/var/backups/vowmirror}
for command in docker age flock; do
    command -v "$command" >/dev/null || { echo "Missing backup dependency: $command" >&2; exit 1; }
done
test -s "$recipients" || { echo 'Backup age recipients file is missing or empty.' >&2; exit 1; }
docker version --format '{{.Server.Version}}' >/dev/null
mkdir -p -- "$directory"
directory=$(cd -- "$directory" && pwd)
exec 9>"$directory/.backup.lock"
flock -n 9 || { echo 'Another usage backup is running.' >&2; exit 1; }

temporary=$(mktemp -d "$directory/.usage-backup.XXXXXXXX")
encrypted=$temporary/usage.sqlite.age
cleanup() {
    rm -f -- "$encrypted"
    rmdir -- "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# pipefail and PIPESTATUS keep Docker/SQLite failures distinct from an empty first run.
# Only ciphertext reaches the host; the helper removes its plaintext from tmpfs.
cd -- "$root"
# Build output must never be mixed into the binary snapshot stream.
docker compose -f compose.yaml build tools-backup >&2
if docker compose -f compose.yaml run --rm --no-deps -T tools-backup \
    | age -R "$recipients" -o "$encrypted"; then
    destination=$directory/usage-$(date -u +%Y%m%d-%H%M%S)-${temporary##*.}.sqlite.age
    chmod 600 "$encrypted"
    mv -- "$encrypted" "$destination"
    find "$directory" -maxdepth 1 -type f -name 'usage-*.sqlite.age' -mtime +29 -delete
    echo "Encrypted usage backup created: ${destination##*/}"
else
    statuses=("${PIPESTATUS[@]}")
    if [[ ${statuses[0]} -eq 3 && ${statuses[1]} -eq 0 ]]; then
        echo 'Usage database has not been initialized; no backup created.'
        exit 0
    fi
    echo "Usage backup failed (snapshot=${statuses[0]}, encryption=${statuses[1]})." >&2
    exit 1
fi

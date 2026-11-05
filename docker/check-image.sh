#!/bin/sh
set -eu

root="$1"
test -d "$root"
test -s /run/boundary.env
marker=$(sed -n 's/^TRYON_API_KEYS=//p' /run/boundary.env)
test -n "$marker"
forbidden=$(find "$root" -type f \( -name '.env' -o -name 'config.yaml' -o -name '*.log' -o -name '*.exe' -o -name 'data.js' \))
if [ -n "$forbidden" ]; then
    printf 'Forbidden image files:\n%s\n' "$forbidden" >&2
    exit 1
fi
if grep -rlF "$marker" "$root"; then
    echo 'Runtime credential entered image contents' >&2
    exit 1
else
    status=$?
    if [ "$status" -ne 1 ]; then exit "$status"; fi
fi
echo "Image source/runtime boundary passed: $root"

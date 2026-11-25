#!/bin/sh
set -eu
case "$1" in
    tls-empty)
        echo stale > /etc/nginx/ssl-listen.conf
        /docker-entrypoint.d/40-enable-ssl.sh
        test ! -s /etc/nginx/ssl-listen.conf
        nginx -t
        ;;
    tls-partial)
        /docker-entrypoint.d/40-enable-ssl.sh
        ;;
    tls-invalid)
        /docker-entrypoint.d/40-enable-ssl.sh
        nginx -t
        ;;
    tls-valid)
        /docker-entrypoint.d/40-enable-ssl.sh
        /docker-entrypoint.d/40-enable-ssl.sh
        test "$(grep -c 'listen 8443' /etc/nginx/ssl-listen.conf)" = 1
        nginx -t
        ;;
    snapshot|snapshot-closed)
        if [ "$1" = snapshot-closed ]; then
            test ! -e /usage/usage.sqlite-wal
            test ! -e /usage/usage.sqlite-shm
        fi
        snapshot-usage > /tmp/restored.sqlite
        result=$(sqlite3 -readonly /tmp/restored.sqlite "SELECT successes FROM usage WHERE principal_hash='synthetic-backup-principal';")
        test "$result" = 3
        test "$(find /tmp -mindepth 1 -maxdepth 1 -type d | wc -l)" = 0
        echo 'Read-only SQLite connection WAL snapshot: PASS'
        ;;
    *) echo 'Unknown production container test.' >&2; exit 1 ;;
esac

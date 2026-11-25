#!/bin/sh
set -eu

certificate=/etc/nginx/ssl/origin.crt
key=/etc/nginx/ssl/origin.key
configuration=/etc/nginx/ssl-listen.conf

if [ ! -e "$certificate" ] && [ ! -e "$key" ]; then
    : > "$configuration"
    echo 'Origin TLS disabled: no certificate or key mounted.'
    exit 0
fi
if [ ! -s "$certificate" ] || [ ! -s "$key" ]; then
    echo 'Origin TLS requires both nonempty origin.crt and origin.key.' >&2
    exit 1
fi

cat > "$configuration" <<'TLS'
listen 8443 ssl;
http2 on;
ssl_certificate /etc/nginx/ssl/origin.crt;
ssl_certificate_key /etc/nginx/ssl/origin.key;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_session_cache shared:origin_tls:1m;
ssl_session_timeout 10m;
ssl_session_tickets off;
TLS
echo 'Origin TLS enabled on port 8443.'

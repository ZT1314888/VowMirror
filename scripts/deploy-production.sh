#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for command in docker age flock curl python3; do
    command -v "$command" >/dev/null || { echo "Missing deployment dependency: $command" >&2; exit 1; }
done
test -s .env || { echo 'Production .env is required.' >&2; exit 1; }
for file in origin.crt origin.key origin-ca.pem; do
    test -s "/etc/ssl/vowmirror/$file" || { echo "Missing production TLS file: $file" >&2; exit 1; }
done
docker version --format '{{.Server.Version}}' >/dev/null
# Parse in memory so resolved runtime secrets never enter logs or temporary files.
docker compose -f compose.yaml config --format json | python3 -c '
import json, sys
web = json.load(sys.stdin)["services"]["web"]
ports = web.get("ports", [])
volumes = web.get("volumes", [])
if not any(p.get("target") == 8443 and str(p.get("published")) == "443" and p.get("host_ip") == "0.0.0.0" for p in ports):
    sys.exit("Production HTTPS must publish 0.0.0.0:443 -> 8443")
if not any(v.get("target") == "/etc/nginx/ssl" and v.get("source") == "/etc/ssl/vowmirror" and v.get("read_only") for v in volumes):
    sys.exit("Production TLS must mount /etc/ssl/vowmirror read-only")
'
bash scripts/backup-usage.sh
docker compose -f compose.yaml up -d --build --wait --wait-timeout 180 web backend
curl --fail --silent --show-error --max-time 10 --noproxy '*' \
    --proto '=https' --cacert /etc/ssl/vowmirror/origin-ca.pem \
    --write-out '\n%{http_code}' \
    --resolve vowmirror.ggff.net:443:127.0.0.1 https://vowmirror.ggff.net/api/health \
    | python3 -c '
import json, sys
payload, status = sys.stdin.read().rsplit("\n", 1)
if status != "200":
    sys.exit("Production health must return HTTP 200")
body = json.loads(payload)
if body.get("code") != 0 or body.get("data", {}).get("status") != "ok":
    sys.exit("Production health response is invalid")
'
echo 'Production HTTPS deployment health check passed.'

#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:?Usage: stack-smoke.sh <base-url>}"

curl -fsS "$BASE_URL/api/health" >/dev/null
curl -fsS "$BASE_URL/api/public" >/dev/null
curl -fsS -o /dev/null -w '%{http_code}' "$BASE_URL/manage.html" | grep -q '^200$'

echo "smoke_ok=$BASE_URL"

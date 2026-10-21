#!/usr/bin/env bash
# Make ThinkAloud reachable from anywhere (HTTPS, needed for microphone access)
# using two Cloudflare quick tunnels: one for the platform, one for the app host.
# Usage: npm run share
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cloudflared >/dev/null || { echo "cloudflared is required: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"; exit 1; }
set -a; [ -f .env ] && . ./.env; set +a
PORT=${PORT:-4000}; APP_HOST_PORT=${APP_HOST_PORT:-4001}
LOGDIR=$(mktemp -d)
echo "Building web + probe…"; npm run build >/dev/null

tunnel() { # $1 port, $2 log
  cloudflared tunnel --no-autoupdate --url "http://localhost:$1" >"$2" 2>&1 &
  for _ in $(seq 1 60); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$2" | head -1 || true)
    [ -n "$url" ] && { echo "$url"; return; }
    sleep 1
  done
  echo "tunnel failed, see $2" >&2; exit 1
}
PUB=$(tunnel "$PORT" "$LOGDIR/pub.log")
APPS=$(tunnel "$APP_HOST_PORT" "$LOGDIR/apps.log")
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo
echo "  Platform:  $PUB"
echo "  App host:  $APPS"
echo "  Share study links from the Recruit tab — they now use the public URL."
echo
# Quick tunnels have no wildcard DNS, so the app host uses path routing.
PUBLIC_URL="$PUB" APP_HOST_URL="$APPS" APP_HOST_ROUTING=path NODE_ENV=production \
  npx tsx --env-file-if-exists=.env server/src/index.ts

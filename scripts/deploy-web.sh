#!/usr/bin/env bash
# Build the web app and deploy it to Firebase Hosting (site/project from firebase.json/.firebaserc).
# /config.json (where the API is) comes from data/deploy/config.json, kept current by thinkaloud-sync.
#   bash scripts/deploy-web.sh               # build + full deploy
#   bash scripts/deploy-web.sh --no-build    # deploy the existing web/dist
#   bash scripts/deploy-web.sh --config      # republish only /config.json
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  --config) exec node scripts/deploy/firebase-hosting.mjs config ;;
  --no-build) ;;
  *) echo "Building web + probe…"; npm run build >/dev/null ;;
esac
node scripts/deploy/firebase-hosting.mjs deploy

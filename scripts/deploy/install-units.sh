#!/usr/bin/env bash
# Install the ThinkAloud systemd *user* units into ~/.config/systemd/user (paths filled in).
# Does not start anything. See docs/DEPLOY.md for the cutover and day-to-day commands.
#   bash scripts/deploy/install-units.sh            # install / update the unit files
#   bash scripts/deploy/install-units.sh --enable   # also enable them at boot (needs linger)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${NODE:-$(command -v node)}
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared)}
GCLOUD=${GCLOUD:-$(command -v gcloud || echo "$HOME/google-cloud-sdk/bin/gcloud")}
[ -x "$NODE" ] || { echo "node not found"; exit 1; }
[ -x "$CLOUDFLARED" ] || { echo "cloudflared not found"; exit 1; }
[ -x "$GCLOUD" ] || echo "warning: gcloud not found at $GCLOUD (needed to publish config.json)"
DEST=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$DEST" "$REPO/data/deploy"
for f in "$REPO"/deploy/systemd/*.service; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@NODE@|$NODE|g" -e "s|@NODE_DIR@|$(dirname "$NODE")|g" \
      -e "s|@CLOUDFLARED@|$CLOUDFLARED|g" -e "s|@GCLOUD_DIR@|$(dirname "$GCLOUD")|g" "$f" > "$DEST/$(basename "$f")"
  echo "installed $DEST/$(basename "$f")"
done
systemctl --user daemon-reload
if [ "${1:-}" = "--enable" ]; then
  systemctl --user enable thinkaloud.service thinkaloud-tunnel-api.service thinkaloud-tunnel-apps.service thinkaloud-sync.service
  loginctl show-user "$USER" -p Linger | grep -q yes || echo "note: run 'sudo loginctl enable-linger $USER' so the units start at boot without a login"
fi

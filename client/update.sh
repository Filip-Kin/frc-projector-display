#!/bin/bash
# update.sh — served from display.filipkin.com/update.sh
# Downloaded fresh on each boot by check-update.sh, then executed.
# Checks version and downloads client.tar.gz if a newer version is available.

SERVER_URL="${SERVER_URL:-https://display.filipkin.com}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frc-projector-display/client}"

LOCAL_VERSION=$(node -e "try{process.stdout.write(require('${INSTALL_DIR}/package.json').version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null || echo "0.0.0")

REMOTE_JSON=$(curl -sf --max-time 10 "${SERVER_URL}/version.json" 2>/dev/null || echo "")
if [ -z "$REMOTE_JSON" ]; then
  echo "[update] server unreachable — starting with v${LOCAL_VERSION}"
  exit 0
fi

REMOTE_VERSION=$(echo "$REMOTE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")
if [ -z "$REMOTE_VERSION" ]; then
  echo "[update] could not parse version — starting with v${LOCAL_VERSION}"
  exit 0
fi

if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  echo "[update] up to date (v${LOCAL_VERSION})"
  exit 0
fi

echo "[update] updating v${LOCAL_VERSION} -> v${REMOTE_VERSION}"
TMP=$(mktemp -d)
if curl -sf --max-time 120 "${SERVER_URL}/client.tar.gz" | tar -xz -C "$TMP"; then
  cp -a "$TMP/." "${INSTALL_DIR}/"
  cd "${INSTALL_DIR}" && npm install --production --silent 2>/dev/null
  echo "[update] done — v${REMOTE_VERSION}"
else
  echo "[update] download failed — keeping v${LOCAL_VERSION}"
fi
rm -rf "$TMP"

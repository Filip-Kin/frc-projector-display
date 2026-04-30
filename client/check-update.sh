#!/bin/bash
# Runs as ExecStartPre on every boot.
# Checks version.json against local version; downloads client.tar.gz only if newer.
# Always exits 0 so the daemon starts even if the server is unreachable.

SERVER_URL="${SERVER_URL:-https://display.filipkin.com}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frc-projector-display/client}"

LOCAL=$(node -e "try{process.stdout.write(require('${INSTALL_DIR}/package.json').version)}catch{process.stdout.write('0.0.0')}" 2>/dev/null || echo "0.0.0")
REMOTE=$(curl -sf --max-time 10 "${SERVER_URL}/version.json" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")

if [ -z "$REMOTE" ]; then
  echo "[update] server unreachable — starting v${LOCAL}"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] v${LOCAL} up to date"
  exit 0
fi

echo "[update] ${LOCAL} → ${REMOTE}"
TMP=$(mktemp -d)
if curl -sf --max-time 120 "${SERVER_URL}/client.tar.gz" | tar -xz -C "$TMP"; then
  cp -a "$TMP/." "${INSTALL_DIR}/"
  cd "${INSTALL_DIR}" && bun install --production 2>/dev/null
  echo "[update] done — v${REMOTE}"
else
  echo "[update] download failed — keeping v${LOCAL}"
fi
rm -rf "$TMP"
exit 0

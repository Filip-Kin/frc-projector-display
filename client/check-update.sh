#!/bin/bash
# check-update.sh — installed once on the device, runs as ExecStartPre.
# Downloads the latest update.sh from the server and executes it.
# Always exits 0 so the daemon starts even if the server is unreachable.

TMP=$(mktemp)
SERVER="${SERVER_URL:-https://display.filipkin.com}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frc-projector-display/client}"

if curl -fsSL --max-time 15 "${SERVER}/update.sh" -o "$TMP" 2>/dev/null; then
  SERVER_URL="$SERVER" INSTALL_DIR="$INSTALL_DIR" bash "$TMP"
else
  echo "[update] could not reach ${SERVER} — skipping update"
fi

rm -f "$TMP"
exit 0

#!/bin/bash
# Runs as ExecStartPre on every boot.
# Checks version.json against local version; downloads client.tar.gz only if newer.
# Always exits 0 so the daemon starts even if the server is unreachable.

SERVER_URL="${SERVER_URL:-https://display.filipkin.com}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frc-projector-display/client}"

LOCAL=$(python3 -c "import json; print(json.load(open('${INSTALL_DIR}/package.json')).get('version','0.0.0'))" 2>/dev/null || echo "0.0.0")
REMOTE=$(curl -sf --max-time 10 "${SERVER_URL}/version.json" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")

# Re-run the installer when the bundled install.sh carries a newer
# INSTALL_REV than the one that last ran on this box. A client update only
# swaps ${INSTALL_DIR}; helper scripts in /usr/local/bin, systemd units and
# system settings come from install.sh, so without this they never change on
# an installed box. Needs the server (the installer downloads from it).
apply_installer() {
  WANT=$(sed -n 's/^INSTALL_REV=\([0-9]*\).*/\1/p' "${INSTALL_DIR}/install.sh" 2>/dev/null | head -1)
  HAVE=$(cat /etc/frc-display/install-rev 2>/dev/null)
  WANT=${WANT:-0}; HAVE=${HAVE:-0}
  [ "$WANT" -gt "$HAVE" ] || return 0
  # The daemon's post-provisioning check sets this: the installer restarts
  # NetworkManager, which would drop the wifi link that was just set up.
  # The next boot's check applies it instead.
  [ -n "$FRC_SKIP_INSTALLER" ] && { echo "[update] installer rev ${WANT} pending"; return 0; }
  echo "[update] installer rev ${HAVE} → ${WANT}; re-applying install.sh"
  timeout 600 sudo -n /usr/local/bin/frc-install > /tmp/frc-install.log 2>&1
  RC=$?
  if [ "$RC" -eq 0 ]; then echo "[update] installer rev ${WANT} applied"
  else echo "[update] installer failed (rc=${RC}); log in /tmp/frc-install.log"; fi
}

if [ -z "$REMOTE" ]; then
  echo "[update] server unreachable — starting v${LOCAL}"
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] v${LOCAL} up to date"
  apply_installer
  exit 0
fi

echo "[update] ${LOCAL} → ${REMOTE}"
TMP=$(mktemp -d)
if curl -sf --max-time 120 "${SERVER_URL}/client.tar.gz" | tar -xz -C "$TMP"; then
  cp -a "$TMP/." "${INSTALL_DIR}/"
  cd "${INSTALL_DIR}" && bun install --production >/dev/null 2>&1
  echo "[update] done — v${REMOTE}"
  apply_installer
else
  echo "[update] download failed — keeping v${LOCAL}"
fi
rm -rf "$TMP"
exit 0

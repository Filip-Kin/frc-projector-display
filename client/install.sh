#!/bin/bash
# install.sh — one-command thin client setup for frc-projector-display
# Run as root: curl -fsSL https://raw.githubusercontent.com/Filip-Kin/frc-projector-display/main/client/install.sh | bash
# Or: sudo bash client/install.sh

set -e

REPO_URL="https://github.com/Filip-Kin/frc-projector-display.git"
INSTALL_DIR="/opt/frc-projector-display"
SERVICE_USER="filip"
SERVER_URL="${SERVER_URL:-wss://display.filipkin.com}"

echo "=== FRC Projector Display — Thin Client Setup ==="

# ── Node.js 20 ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* ]]; then
  echo "[1] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1] Node.js $(node --version) already installed"
fi

# ── System packages ───────────────────────────────────────────────────────────
echo "[2] Installing system packages..."
apt-get install -y \
  xorg openbox lightdm lightdm-gtk-greeter \
  chromium x11vnc qrencode \
  ffmpeg git curl

# ── LightDM autologin ─────────────────────────────────────────────────────────
echo "[3] Configuring LightDM autologin..."
cat > /etc/lightdm/lightdm.conf << 'EOF'
[Seat:*]
autologin-user=filip
autologin-user-timeout=0
greeter-session=lightdm-gtk-greeter
EOF

# ── Openbox autostart ─────────────────────────────────────────────────────────
echo "[4] Configuring Openbox..."
AUTOSTART_DIR="/home/${SERVICE_USER}/.config/openbox"
mkdir -p "$AUTOSTART_DIR"
cat > "${AUTOSTART_DIR}/autostart" << 'EOF'
# Disable screensaver and DPMS
xset s off &
xset -dpms &
xset s noblank &

# Launch Chromium in kiosk mode with CDP enabled
chromium --kiosk --no-sandbox --disable-infobars \
  --disable-translate --disable-features=TranslateUI \
  --no-first-run --disable-default-apps \
  --remote-debugging-port=9222 \
  http://localhost:3000/ &
EOF
chown -R "${SERVICE_USER}:${SERVICE_USER}" "/home/${SERVICE_USER}/.config"

# ── Clone / update repo ────────────────────────────────────────────────────────
echo "[5] Cloning repository..."
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "$INSTALL_DIR" pull
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ── Install npm deps ───────────────────────────────────────────────────────────
echo "[6] Installing npm dependencies..."
npm install --production --prefix "${INSTALL_DIR}/client"

# ── ndi-list-sources script ────────────────────────────────────────────────────
echo "[7] Installing ndi-list-sources script..."
cat > /usr/local/bin/ndi-list-sources << 'NDISCRIPT'
#!/bin/bash
# Enumerate NDI sources using NDI SDK tools.
# Outputs JSON array of source name strings.
# Returns [] if NDI SDK is not installed.

if command -v ndi-directory-service &>/dev/null; then
  # NDI SDK installed — use discovery tool
  timeout 3 ndi-directory-service list 2>/dev/null \
    | grep -oP '(?<=Source: ).*' \
    | python3 -c "import sys,json; lines=[l.strip() for l in sys.stdin if l.strip()]; print(json.dumps(lines))"
else
  echo "[]"
fi
NDISCRIPT
chmod +x /usr/local/bin/ndi-list-sources

# ── Systemd service ────────────────────────────────────────────────────────────
echo "[8] Installing systemd service..."
cat > /etc/systemd/system/display-daemon.service << EOF
[Unit]
Description=FRC Projector Display Daemon
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/client
Environment=SERVER_URL=${SERVER_URL}
Environment=DISPLAY=:0
ExecStart=/usr/bin/node ${INSTALL_DIR}/client/src/daemon.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=graphical.target
EOF

systemctl daemon-reload
systemctl enable display-daemon.service

# ── Graphical target ───────────────────────────────────────────────────────────
echo "[9] Setting graphical boot target..."
systemctl set-default graphical.target

echo ""
echo "=== Install complete! ==="
echo "Reboot to start the display system: reboot"
echo ""
echo "After reboot:"
echo "  - Chromium will auto-launch in kiosk mode"
echo "  - The display daemon starts automatically"
echo "  - A QR code will appear on screen"
echo "  - Scan it with your phone to connect"

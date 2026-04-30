#!/bin/bash
# FRC Projector Display — Thin Client Setup
# Usage:  curl -fsSL https://display.filipkin.com/install.sh | sudo bash
# Or:     sudo bash install.sh
# Env vars (optional):
#   SERVER_URL   — control server base URL  (default: https://display.filipkin.com)
#   SERVICE_USER — local user to run kiosk  (default: display, created if missing)
#   INSTALL_DIR  — install path             (default: /opt/frc-projector-display/client)

set -e

SERVER_URL="${SERVER_URL:-https://display.filipkin.com}"
SERVICE_USER="${SERVICE_USER:-display}"
INSTALL_DIR="${INSTALL_DIR:-/opt/frc-projector-display/client}"

if [ "$EUID" -ne 0 ]; then echo "Run as root (sudo bash install.sh)"; exit 1; fi

echo "=== FRC Projector Display — Thin Client Setup ==="
echo "  Server:  $SERVER_URL"
echo "  User:    $SERVICE_USER"
echo "  Install: $INSTALL_DIR"
echo ""

# ── Detect package manager ────────────────────────────────────────────────────
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
elif command -v pacman &>/dev/null; then
  PKG_MGR="pacman"
else
  echo "ERROR: No supported package manager found (apt/dnf/pacman)"; exit 1
fi
echo "[1] Package manager: $PKG_MGR"

# ── Node.js 20 ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version 2>/dev/null)" != v20* ]]; then
  echo "[2] Installing Node.js 20..."
  case $PKG_MGR in
    apt)
      apt-get update -qq
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
      apt-get install -y nodejs >/dev/null ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
      dnf install -y nodejs >/dev/null ;;
    pacman)
      pacman -Sy --noconfirm nodejs npm >/dev/null ;;
  esac
else
  echo "[2] Node.js $(node --version) already installed"
fi

# ── System packages ───────────────────────────────────────────────────────────
echo "[3] Installing system packages..."
case $PKG_MGR in
  apt)
    apt-get install -y \
      xorg openbox lightdm lightdm-gtk-greeter \
      chromium x11vnc unclutter \
      ffmpeg curl tar python3 >/dev/null ;;
  dnf)
    dnf install -y \
      xorg-x11-server-Xorg openbox lightdm lightdm-gtk-greeter \
      chromium x11vnc unclutter \
      ffmpeg curl tar python3 >/dev/null ;;
  pacman)
    pacman -S --noconfirm \
      xorg-server openbox lightdm lightdm-gtk-greeter \
      chromium x11vnc unclutter \
      ffmpeg curl tar python >/dev/null ;;
esac

# Detect chromium binary name
CHROMIUM_BIN=$(command -v chromium || command -v chromium-browser || echo "chromium")

# ── Service user ──────────────────────────────────────────────────────────────
echo "[4] Configuring user '$SERVICE_USER'..."
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G audio,video "$SERVICE_USER"
  echo "    Created user $SERVICE_USER"
fi
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)

# ── LightDM autologin ─────────────────────────────────────────────────────────
echo "[5] Configuring LightDM autologin..."
cat > /etc/lightdm/lightdm.conf << EOF
[Seat:*]
autologin-user=${SERVICE_USER}
autologin-user-timeout=0
greeter-session=lightdm-gtk-greeter
EOF

# ── Openbox autostart ─────────────────────────────────────────────────────────
echo "[6] Configuring Openbox..."
AUTOSTART_DIR="${USER_HOME}/.config/openbox"
mkdir -p "$AUTOSTART_DIR"
cat > "${AUTOSTART_DIR}/autostart" << EOF
xset s off &
xset -dpms &
xset s noblank &
unclutter -idle 1 -root &
${CHROMIUM_BIN} --kiosk --no-sandbox --disable-infobars \\
  --disable-translate --disable-features=TranslateUI \\
  --no-first-run --disable-default-apps \\
  --autoplay-policy=no-user-gesture-required \\
  --remote-debugging-port=9222 \\
  http://localhost:3000/ &
EOF
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${USER_HOME}/.config"

# ── Download client from server ────────────────────────────────────────────────
echo "[7] Downloading client from ${SERVER_URL}..."
mkdir -p "$INSTALL_DIR"
curl -fsSL --max-time 120 "${SERVER_URL}/client.tar.gz" | tar -xz -C "$INSTALL_DIR"
cd "$INSTALL_DIR" && npm install --production --silent 2>/dev/null

# ── ndi-list-sources stub ─────────────────────────────────────────────────────
echo "[8] Installing ndi-list-sources stub..."
cat > /usr/local/bin/ndi-list-sources << 'NDISCRIPT'
#!/bin/bash
if command -v ndi-directory-service &>/dev/null; then
  timeout 3 ndi-directory-service list 2>/dev/null \
    | grep -oP '(?<=Source: ).*' \
    | python3 -c "import sys,json; lines=[l.strip() for l in sys.stdin if l.strip()]; print(json.dumps(lines))"
else
  echo "[]"
fi
NDISCRIPT
chmod +x /usr/local/bin/ndi-list-sources

# ── Systemd service ────────────────────────────────────────────────────────────
echo "[9] Installing systemd service..."
# Get UID for XDG_RUNTIME_DIR
SERVICE_UID=$(id -u "$SERVICE_USER")
cat > /etc/systemd/system/display-daemon.service << EOF
[Unit]
Description=FRC Projector Display Daemon
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=SERVER_URL=${SERVER_URL}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/${SERVICE_UID}
Environment=PULSE_SERVER=unix:/run/user/${SERVICE_UID}/pulse/native
ExecStartPre=/bin/bash ${INSTALL_DIR}/check-update.sh
ExecStart=/usr/bin/node ${INSTALL_DIR}/src/daemon.js
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
echo "[10] Setting graphical boot target..."
systemctl set-default graphical.target

echo ""
echo "=== Install complete! ==="
echo "  Reboot to start: reboot"
echo "  Or start now:    systemctl restart lightdm && systemctl restart display-daemon"
echo "  Logs:            journalctl -u display-daemon -f"
echo ""

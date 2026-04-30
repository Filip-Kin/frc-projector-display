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
      ffmpeg curl tar python3 \
      network-manager dnsmasq iptables \
      avahi-utils >/dev/null ;;
  dnf)
    dnf install -y \
      xorg-x11-server-Xorg openbox lightdm lightdm-gtk-greeter \
      chromium x11vnc unclutter \
      ffmpeg curl tar python3 \
      NetworkManager dnsmasq iptables >/dev/null ;;
  pacman)
    pacman -S --noconfirm \
      xorg-server openbox lightdm lightdm-gtk-greeter \
      chromium x11vnc unclutter \
      ffmpeg curl tar python \
      networkmanager dnsmasq iptables >/dev/null ;;
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

# ── NetworkManager + captive portal DNS ──────────────────────────────────────
echo "[8] Configuring NetworkManager..."
systemctl enable NetworkManager 2>/dev/null || true
systemctl start NetworkManager 2>/dev/null || true
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/captive.conf << 'NMCONF'
# Redirect all DNS to the AP IP when in shared (hotspot) mode — triggers
# iOS/Android captive portal detection popup automatically.
address=/#/192.168.4.1
NMCONF

# ── Root helper scripts ────────────────────────────────────────────────────────
echo "[9] Installing WiFi helper scripts..."

cat > /usr/local/bin/frc-ap-start << 'SCRIPT'
#!/bin/bash
# frc-ap-start {pin} {iface} — create open WiFi AP for provisioning
PIN="$1"; IFACE="$2"
nmcli con delete "frc-provision" 2>/dev/null || true
nmcli con add type wifi ifname "$IFACE" con-name "frc-provision" \
  ssid "FRC-Display-${PIN}" \
  802-11-wireless.mode ap \
  802-11-wireless-security.key-mgmt none \
  ipv4.method shared \
  ipv4.addresses "192.168.4.1/24"
nmcli con up "frc-provision"
# Redirect port 80 → 3000 for captive portal
iptables -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-ap-start

cat > /usr/local/bin/frc-ap-stop << 'SCRIPT'
#!/bin/bash
# frc-ap-stop {iface} — tear down WiFi AP
IFACE="$1"
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80 -j REDIRECT --to-port 3000 2>/dev/null || true
nmcli con down "frc-provision" 2>/dev/null || true
nmcli con delete "frc-provision" 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-ap-stop

cat > /usr/local/bin/frc-wifi-connect << 'SCRIPT'
#!/bin/bash
# frc-wifi-connect {ssid} {password} — connect to WiFi (empty password = open network)
SSID="$1"; PASS="$2"
nmcli device wifi rescan 2>/dev/null || true
if [ -z "$PASS" ]; then
  nmcli device wifi connect "$SSID"
else
  nmcli device wifi connect "$SSID" password "$PASS"
fi
SCRIPT
chmod 755 /usr/local/bin/frc-wifi-connect

cat > /usr/local/bin/frc-install << SCRIPT
#!/bin/bash
# frc-install — re-apply install.sh after an update
SERVER_URL="\${SERVER_URL:-${SERVER_URL}}"
curl -fsSL "\${SERVER_URL}/install.sh" | SERVICE_USER="${SERVICE_USER}" INSTALL_DIR="${INSTALL_DIR}" bash
SCRIPT
chmod 755 /usr/local/bin/frc-install

# ── Sudoers for WiFi helpers ───────────────────────────────────────────────────
echo "[10] Configuring sudoers..."
cat > /etc/sudoers.d/frc-display << SUDOCONF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/frc-ap-start, /usr/local/bin/frc-ap-stop, /usr/local/bin/frc-wifi-connect, /usr/local/bin/frc-install, /bin/systemctl restart lightdm
SUDOCONF
chmod 440 /etc/sudoers.d/frc-display

# ── NDI source discovery ───────────────────────────────────────────────────────
echo "[11] Installing NDI tools..."

# ndi-list-sources: uses avahi mDNS (no SDK needed) + falls back to NDI SDK tools
cat > /usr/local/bin/ndi-list-sources << 'NDISCRIPT'
#!/bin/bash
# Try avahi mDNS discovery first (works without NDI SDK)
if command -v avahi-browse &>/dev/null; then
  SOURCES=$(timeout 3 avahi-browse -t -r -p _ndi._tcp 2>/dev/null \
    | awk -F';' '/^=/ {gsub(/"/, "", $5); if ($5 != "") print $5}' \
    | sort -u)
  if [ -n "$SOURCES" ]; then
    python3 -c "import sys,json; lines=[l.strip() for l in sys.stdin if l.strip()]; print(json.dumps(lines))" <<< "$SOURCES"
    exit 0
  fi
fi
# Fall back to NDI SDK tools if installed
if command -v ndi-directory-service &>/dev/null; then
  timeout 3 ndi-directory-service list 2>/dev/null \
    | grep -oP '(?<=Source: ).*' \
    | python3 -c "import sys,json; lines=[l.strip() for l in sys.stdin if l.strip()]; print(json.dumps(lines))"
  exit 0
fi
echo "[]"
NDISCRIPT
chmod +x /usr/local/bin/ndi-list-sources

# Optional: install NDI SDK for ffplay NDI playback support
# Usage: NDI_SDK_URL=https://... bash install.sh
#     or NDI_SDK_PATH=/path/to/ndi-sdk.tar.gz bash install.sh
# SDK download (free account required): https://ndi.tv/sdk/
if [ -n "${NDI_SDK_URL:-}" ] || [ -n "${NDI_SDK_PATH:-}" ]; then
  echo "  [NDI] Installing NDI SDK for playback..."
  TMP_NDI=$(mktemp -d)
  if [ -n "${NDI_SDK_PATH:-}" ] && [ -f "$NDI_SDK_PATH" ]; then
    cp "$NDI_SDK_PATH" "$TMP_NDI/ndi.tar.gz"
  else
    curl -fsSL "$NDI_SDK_URL" -o "$TMP_NDI/ndi.tar.gz"
  fi
  tar -xzf "$TMP_NDI/ndi.tar.gz" -C "$TMP_NDI" 2>/dev/null || true
  INSTALLER=$(find "$TMP_NDI" -name "Install_NDI_SDK*.sh" 2>/dev/null | head -1)
  if [ -n "$INSTALLER" ]; then
    chmod +x "$INSTALLER"
    ACCEPT=yes bash "$INSTALLER" 2>/dev/null || true
    echo "  [NDI] SDK installed — ffplay NDI support requires recompiling ffmpeg with --enable-libndi_newtek"
  fi
  rm -rf "$TMP_NDI"
else
  echo "  [NDI] Skipping SDK (set NDI_SDK_URL=<url> or NDI_SDK_PATH=<path> to install)"
  echo "        NDI source discovery via avahi works without the SDK"
fi

# ── Systemd service ────────────────────────────────────────────────────────────
echo "[12] Installing systemd service..."
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
echo "[13] Setting graphical boot target..."
systemctl set-default graphical.target

# ── Power button → immediate shutdown ─────────────────────────────────────────
echo "[14] Configuring power button..."
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/power-button.conf << 'EOF'
[Login]
HandlePowerKey=poweroff
EOF
systemctl restart systemd-logind 2>/dev/null || true

echo ""
echo "=== Install complete! ==="
echo "  Reboot to start: reboot"
echo "  Or start now:    systemctl restart lightdm && systemctl restart display-daemon"
echo "  Logs:            journalctl -u display-daemon -f"
echo ""

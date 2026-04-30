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

# ── Bun (JavaScript/TypeScript runtime) ───────────────────────────────────────
export PATH="/usr/local/bin:$PATH"
if ! command -v bun &>/dev/null; then
  echo "[2] Installing Bun..."
  # Ensure unzip is present (Bun installer requires it)
  case $PKG_MGR in
    apt)    apt-get install -y unzip >/dev/null ;;
    dnf)    dnf install -y unzip >/dev/null ;;
    pacman) pacman -S --noconfirm unzip >/dev/null ;;
  esac
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
else
  echo "[2] Bun $(bun --version) already installed"
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
      avahi-utils \
      pipewire pipewire-pulse wireplumber pulseaudio-utils >/dev/null ;;
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
cd "$INSTALL_DIR" && bun install --production 2>/dev/null
# Ensure service user owns the install dir so check-update.sh can write to it
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

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

cat > /usr/local/bin/frc-eth-static << 'SCRIPT'
#!/bin/bash
# frc-eth-static {iface} {ip} {prefix} {gateway}
# Sets a static IP on ethernet using nmcli, replacing any existing connection.
IFACE="$1"; IP="$2"; PREFIX="${3:-24}"; GW="${4:-}"
nmcli con delete "frc-eth-static" 2>/dev/null || true
ARGS=(con add type ethernet ifname "$IFACE" con-name "frc-eth-static" \
  ipv4.method manual ipv4.addresses "${IP}/${PREFIX}")
[ -n "$GW" ] && ARGS+=(ipv4.gateway "$GW")
nmcli "${ARGS[@]}"
nmcli con up "frc-eth-static"
SCRIPT
chmod 755 /usr/local/bin/frc-eth-static

cat > /usr/local/bin/frc-eth-dhcp << 'SCRIPT'
#!/bin/bash
# frc-eth-dhcp {iface} — remove static config and re-enable DHCP
IFACE="$1"
nmcli con delete "frc-eth-static" 2>/dev/null || true
nmcli dev connect "$IFACE" 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-eth-dhcp

# ── Sudoers for WiFi + ethernet helpers ───────────────────────────────────────
echo "[10] Configuring sudoers..."
cat > /etc/sudoers.d/frc-display << SUDOCONF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/frc-ap-start, /usr/local/bin/frc-ap-stop, /usr/local/bin/frc-wifi-connect, /usr/local/bin/frc-install, /usr/local/bin/frc-eth-static, /usr/local/bin/frc-eth-dhcp, /bin/systemctl restart lightdm
SUDOCONF
chmod 440 /etc/sudoers.d/frc-display

# ── NDI source discovery ───────────────────────────────────────────────────────
echo "[11] Installing NDI tools..."

# ndi-list-sources: uses avahi mDNS (no SDK needed) + falls back to NDI SDK tools
cat > /usr/local/bin/ndi-list-sources << 'NDISCRIPT'
#!/bin/bash
python3 << 'PYEOF'
import json, re, subprocess

def avahi(svc):
    try:
        r = subprocess.run(['avahi-browse', '-t', '-r', '-p', svc],
                           capture_output=True, text=True, timeout=3)
        return r.stdout.split('\n')
    except:
        return []

def unescape(s):
    # avahi -p uses decimal escapes: \032 = chr(32) = space, etc.
    return re.sub(r'\\(\d+)', lambda m: chr(int(m.group(1))), s).strip('"')

# NDI sources (plain strings — ndi-play-wrapper takes the source name directly)
ndi, seen = [], set()
for line in avahi('_ndi._tcp'):
    p = line.split(';')
    if len(p) >= 5 and p[0] == '=':
        name = unescape(p[4])
        if name and name not in seen:
            seen.add(name); ndi.append(name)

# OMT sources ({label, value} objects — omt-play-wrapper strips omt:// prefix)
omt, seen = [], set()
for line in avahi('_omt._tcp'):
    p = line.split(';')
    if len(p) >= 9 and p[0] == '=':
        name = unescape(p[4])
        addr, port = p[7], p[8].strip()
        key = f"{addr}:{port}"
        if key and key not in seen:
            seen.add(key)
            omt.append({"label": f"OMT: {name}", "value": f"omt://{addr}:{port}"})

print(json.dumps(ndi + omt))
PYEOF
NDISCRIPT
chmod +x /usr/local/bin/ndi-list-sources

# Install ndi-play binary + libndi.so from GCS (no account needed, fully automated)
NDI_TOOLS_ARCH="x86_64"
case "$(uname -m)" in
  aarch64|arm64) NDI_TOOLS_ARCH="aarch64" ;;
  armv7*|armhf)  NDI_TOOLS_ARCH="armhf" ;;
esac
NDI_TOOLS_URL="https://storage.googleapis.com/frc-display-assets/ndi-tools-linux-${NDI_TOOLS_ARCH}.tar.gz"

echo "  [NDI] Installing ndi-play from ${NDI_TOOLS_URL}..."
TMP_NDI=$(mktemp -d)
if curl -fsSL --max-time 60 "$NDI_TOOLS_URL" | tar -xz -C "$TMP_NDI" 2>/dev/null; then
  install -m 755 "$TMP_NDI/ndi-play"         /usr/local/bin/ndi-play
  install -m 755 "$TMP_NDI/ndi-play-wrapper" /usr/local/bin/ndi-play-wrapper
  install -m 644 "$TMP_NDI/libndi.so.6"      /usr/local/lib/libndi.so.6
  ln -sf /usr/local/lib/libndi.so.6 /usr/local/lib/libndi.so
  ldconfig
  echo "  [NDI] ndi-play installed successfully"
else
  echo "  [NDI] Warning: could not download ndi-play (NDI playback unavailable)"
fi
rm -rf "$TMP_NDI"

# ── OMT tools ─────────────────────────────────────────────────────────────────
echo "  [OMT] Installing OMT tools..."
NDI_TOOLS_ARCH="x86_64"
case "$(uname -m)" in aarch64|arm64) NDI_TOOLS_ARCH="aarch64" ;; armv7*|armhf) NDI_TOOLS_ARCH="armhf" ;; esac
OMT_TOOLS_URL="https://storage.googleapis.com/frc-display-assets/omt-tools-linux-${NDI_TOOLS_ARCH}.tar.gz"
TMP_OMT=$(mktemp -d)
if curl -fsSL --max-time 60 "$OMT_TOOLS_URL" | tar -xz -C "$TMP_OMT" 2>/dev/null; then
  install -m 755 "$TMP_OMT/ffplay-omt"        /usr/local/bin/ffplay-omt
  install -m 755 "$TMP_OMT/omt-play-wrapper"  /usr/local/bin/omt-play-wrapper
  install -m 644 "$TMP_OMT/libomt.so"         /usr/local/lib/libomt.so
  install -m 644 "$TMP_OMT/libvmx.so"         /usr/local/lib/libvmx.so
  ldconfig
  echo "  [OMT] installed"
else
  echo "  [OMT] Warning: could not download OMT tools (OMT playback unavailable)"
fi
rm -rf "$TMP_OMT"

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
ExecStart=/usr/local/bin/bun run ${INSTALL_DIR}/src/daemon.ts
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

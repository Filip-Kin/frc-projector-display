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
      bluez bluez-tools \
      pipewire pipewire-pulse wireplumber pulseaudio-utils \
      libasound2-plugins >/dev/null
    # Route all ALSA apps (including Chromium's audio service) through PipeWire
    cat > /etc/asound.conf << 'ASOUNDEOF'
pcm.default pulse
ctl.default pulse
ASOUNDEOF
    apt-get install -y openssl >/dev/null
    ;;
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
# Bluetooth group is needed for some BlueZ HCI ops; the dbus policy below grants
# the actual GATT/advertisement permissions the Improv BLE server requires.
usermod -aG bluetooth "$SERVICE_USER" 2>/dev/null || true
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
systemctl --user start pipewire wireplumber pipewire-pulse 2>/dev/null &
${CHROMIUM_BIN} --kiosk --no-sandbox --disable-infobars \\
  --disable-translate --disable-features=TranslateUI \\
  --no-first-run --disable-default-apps \\
  --autoplay-policy=no-user-gesture-required \\
  --remote-debugging-port=9222 \\
  about:blank &
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

# Make the kernel skip default routes whose interface has lost carrier.
# Without this, an unplugged ethernet's "linkdown" route still beats wifi
# in the routing decision (lower metric), and all outbound TCP gets sent
# into the dead interface and silently dropped. Symptom: wifi associates,
# gets an IP, gateway pings work, but no public-internet traffic flows.
cat > /etc/sysctl.d/99-frc-linkdown.conf << 'SYSCTL'
net.ipv4.conf.all.ignore_routes_with_linkdown=1
net.ipv4.conf.default.ignore_routes_with_linkdown=1
net.ipv6.conf.all.ignore_routes_with_linkdown=1
net.ipv6.conf.default.ignore_routes_with_linkdown=1
SYSCTL
sysctl --system >/dev/null 2>&1 || true

# Tell NM to leave /etc/resolv.conf alone, and disable NM's internal
# connectivity check (which probes nmcheck.gnome.org -- frequently blocked
# by Pi-hole and other ad-blockers, causing nmcli con up to spend 15+s
# waiting for its own probe to time out before declaring the connection
# activated).
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/no-dns.conf << 'NMDNS'
[main]
dns=none
rc-manager=unmanaged

[connectivity]
enabled=false
NMDNS

# Static fallback DNS so the daemon can always reach the control server
# regardless of which network connection (or AP mode) is active.
# We make the file IMMUTABLE because Debian's dhcpcd hooks (or any other
# installed network plumbing -- resolvconf, systemd-resolved, etc.) will
# happily overwrite it with the network's local DNS the next time DHCP
# fires, which on a Pi-holed LAN means we can't resolve display.filipkin.com
# from a wifi network that can't route to the Pi-hole.
chattr -i /etc/resolv.conf 2>/dev/null || true
cat > /etc/resolv.conf << 'RESOLVCONF'
# Static; managed by FRC Projector Display install.sh
nameserver 1.1.1.1
nameserver 8.8.8.8
RESOLVCONF
chattr +i /etc/resolv.conf 2>/dev/null || true
# Stop dhcpcd if it's been pulled in as a transitive dep (some Debian
# installer profiles include it even though NM handles DHCP).
systemctl disable --now dhcpcd 2>/dev/null || true
systemctl restart NetworkManager 2>/dev/null || true
# Disable system dnsmasq — it grabs port 53 and prevents NM's built-in dnsmasq
# from running for the WiFi AP, leaving phones stuck on "obtaining IP address"
systemctl disable --now dnsmasq 2>/dev/null || true
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/captive.conf << 'NMCONF'
# Redirect all DNS to the AP IP when in shared (hotspot) mode — triggers
# iOS/Android captive portal detection popup automatically.
address=/#/192.168.4.1

# RFC 8910 — Captive Portal API URL via DHCP option 114.
# Modern Android (11+) and iOS (14+) use this to manage the portal session
# without aggressive timeouts that close the popup mid-configuration.
dhcp-option=114,"http://192.168.4.1/captive-portal-api"
NMCONF

# ── BlueZ dbus policy — let the service user register GATT apps + BLE adverts ─
# Stock /usr/share/dbus-1/system.d/bluetooth.conf only grants root the right to
# implement the GattCharacteristic1 / LEAdvertisement1 interfaces. Without this
# extra policy file, dbus-next calls to RegisterApplication / RegisterAdvertisement
# fail with org.freedesktop.DBus.Error.AccessDenied.
echo "[8a] Installing BlueZ dbus policy for ${SERVICE_USER}..."
cat > /etc/dbus-1/system.d/frc-display-bluetooth.conf << POLICYEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE busconfig PUBLIC
 "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="${SERVICE_USER}">
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.bluez.GattService1"/>
    <allow send_interface="org.bluez.LEAdvertisement1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
POLICYEOF
systemctl reload dbus 2>/dev/null || systemctl restart dbus 2>/dev/null || true

# ── Self-signed TLS cert for AP-mode HTTPS server ─────────────────────────────
# Android probes https://www.google.com/generate_204 in parallel with HTTP.
# Without a TLS listener on :443, the probe gets TCP RST/timeout and Android
# decides "limited connectivity" → auto-disconnects. Self-signed cert won't
# pass Android's chain validation either, but presenting *any* cert at the
# TLS handshake gives Android a slightly different signal that some versions
# tolerate longer.
echo "[8b] Generating self-signed TLS cert..."
mkdir -p /etc/frc-display
if [ ! -f /etc/frc-display/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/frc-display/key.pem \
    -out    /etc/frc-display/cert.pem \
    -days 3650 \
    -subj "/CN=frc-display" \
    -addext "subjectAltName=IP:192.168.4.1,DNS:connectivitycheck.gstatic.com,DNS:www.google.com,DNS:play.googleapis.com,DNS:clients3.google.com,DNS:captive.apple.com" \
    >/dev/null 2>&1
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" /etc/frc-display
chmod 600 /etc/frc-display/key.pem
chmod 644 /etc/frc-display/cert.pem

# ── Root helper scripts ────────────────────────────────────────────────────────
echo "[9] Installing WiFi helper scripts..."

cat > /usr/local/bin/frc-ap-start << 'SCRIPT'
#!/bin/bash
# frc-ap-start {pin} {iface} — create open WiFi AP for provisioning
PIN="$1"; IFACE="$2"
SSID="FRC-Display-${PIN}"

# Clean any leftover AP profile
nmcli con delete "frc-provision" 2>/dev/null || true

# Make sure interface isn't connected to something else (e.g. saved wifi)
nmcli device disconnect "$IFACE" 2>/dev/null || true
sleep 0.3

# Create AP with autoconnect=no — prevents 'add' from auto-activating before
# our explicit 'up' below (the auto-then-up race breaks Realtek cards)
nmcli con add type wifi ifname "$IFACE" con-name "frc-provision" \
  autoconnect no \
  ssid "$SSID" \
  802-11-wireless.mode ap \
  802-11-wireless.band bg \
  802-11-wireless.powersave disable \
  ipv4.method shared \
  ipv4.addresses "192.168.4.1/24"

# Now explicitly bring it up — single activation, no race
nmcli con up "frc-provision"

# Captive portal: redirect ports 80→3000 (HTTP) and 443→4443 (HTTPS)
iptables -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 80  -j REDIRECT --to-port 3000 2>/dev/null || true
iptables -t nat -A PREROUTING -i "$IFACE" -p tcp --dport 443 -j REDIRECT --to-port 4443 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-ap-start

cat > /usr/local/bin/frc-ap-stop << 'SCRIPT'
#!/bin/bash
# frc-ap-stop {iface} — tear down WiFi AP
IFACE="$1"
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 80  -j REDIRECT --to-port 3000 2>/dev/null || true
iptables -t nat -D PREROUTING -i "$IFACE" -p tcp --dport 443 -j REDIRECT --to-port 4443 2>/dev/null || true
nmcli con down "frc-provision" 2>/dev/null || true
nmcli con delete "frc-provision" 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-ap-stop

cat > /usr/local/bin/frc-wifi-connect << 'SCRIPT'
#!/bin/bash
# frc-wifi-connect {ssid} {password}
# Heavy logging: every previous failure was hard to diagnose because the
# script was opaque. Each step is timestamped and prefixed [frc-wifi].
SSID="$1"; PASS="$2"
log() { echo "[frc-wifi $(date +%T.%3N)] $*"; }

IFACE=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi" {print $1; exit}')
[ -z "$IFACE" ] && { log "ERR no wifi interface"; exit 1; }
log "iface=$IFACE ssid=\"$SSID\" pass_len=${#PASS}"

log "purging stale wifi profiles before adding new one"
nmcli -t -f NAME,TYPE con show | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r N; do
  log "  deleting profile: $N"
  nmcli con delete "$N" 2>&1 | sed 's/^/  /'
done

log "nmcli device wifi rescan"
nmcli device wifi rescan 2>&1 | sed 's/^/  /' || true

if [ -z "$PASS" ]; then
  log "nmcli con add (open network)"
  nmcli con add type wifi ifname "$IFACE" con-name "$SSID" ssid "$SSID" \
    802-11-wireless.powersave 2 2>&1 | sed 's/^/  /'
else
  log "nmcli con add (WPA-PSK)"
  nmcli con add type wifi ifname "$IFACE" con-name "$SSID" ssid "$SSID" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
    802-11-wireless.powersave 2 2>&1 | sed 's/^/  /'
fi

log "nmcli con up"
T0=$(date +%s%N)
nmcli con up "$SSID" 2>&1 | sed 's/^/  /'
RC=${PIPESTATUS[0]}
T1=$(date +%s%N)
log "nmcli con up took $(( (T1-T0)/1000000 ))ms rc=$RC"
if [ "$RC" -ne 0 ]; then
  log "post-mortem: link state"
  ip -br addr show "$IFACE" 2>&1 | sed 's/^/  /'
  log "post-mortem: nm device status"
  nmcli -t device show "$IFACE" 2>&1 | grep -E 'GENERAL|IP4|STATE' | sed 's/^/  /'
  exit "$RC"
fi

log "post-up state:"
ip -br addr show "$IFACE" 2>&1 | sed 's/^/  /'
ip route show dev "$IFACE" 2>&1 | sed 's/^/  /'

# Probe a PUBLIC IP, not the gateway. On rtl8723be the radio can ARP and
# reply to gateway pings within 1s while still queueing forward-routed
# packets for 25-35s. We need to wait until externally-routed traffic
# actually flows, otherwise the daemon's checkInternet to display.filipkin.com
# fails and the user sees provisioning fail despite a "successful" associate.
log "probing external connectivity (1.1.1.1)"
for i in $(seq 1 40); do
  if ping -I "$IFACE" -c 1 -W 1 1.1.1.1 >/dev/null 2>&1; then
    log "OK external traffic flowing after ${i}s"
    exit 0
  fi
  log "  probe $i/40 failed"
  sleep 1
done
log "ERR associated but external ping never replied"
log "final route table:"
ip route 2>&1 | sed 's/^/  /'
log "neighbours:"
ip neigh show dev "$IFACE" 2>&1 | sed 's/^/  /'
exit 1
SCRIPT
chmod 755 /usr/local/bin/frc-wifi-connect

cat > /usr/local/bin/frc-install << SCRIPT
#!/bin/bash
# frc-install — re-apply install.sh after an update
SERVER_URL="\${SERVER_URL:-${SERVER_URL}}"
curl -fsSL "\${SERVER_URL}/install.sh" | SERVICE_USER="${SERVICE_USER}" INSTALL_DIR="${INSTALL_DIR}" bash
SCRIPT
chmod 755 /usr/local/bin/frc-install

cat > /usr/local/bin/frc-wifi-up << 'SCRIPT'
#!/bin/bash
# frc-wifi-up {connection-name}
# Brings up a saved wifi connection. Used by the daemon at startup to poke
# NM after its autoconnect has given up.
NAME="$1"
[ -z "$NAME" ] && { echo "[frc-wifi-up] needs connection name" >&2; exit 2; }
nmcli con up "$NAME"
SCRIPT
chmod 755 /usr/local/bin/frc-wifi-up

cat > /usr/local/bin/frc-handoff << 'SCRIPT'
#!/bin/bash
# frc-handoff {ssid} {password}
# Atomic AP-down + wifi-up + verify. Replaces the daemon's split execFile
# calls; folding both stages into a single subprocess eliminated wifi
# reliability issues we could not reproduce manually.
set -u
SSID="$1"; PASS="${2:-}"
IFACE=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi" {print $1; exit}')
[ -z "$IFACE" ] && { echo "[handoff] ERR no wifi interface"; exit 1; }
log() { echo "[handoff $(date +%T.%3N)] $*"; }

log "iface=$IFACE ssid=\"$SSID\""
log "stage 1: AP teardown"
/usr/local/bin/frc-ap-stop "$IFACE" 2>&1 | sed 's/^/  /'

log "stage 2: wifi connect"
/usr/local/bin/frc-wifi-connect "$SSID" "$PASS"
exit $?
SCRIPT
chmod 755 /usr/local/bin/frc-handoff

cat > /usr/local/bin/frc-usb-mount << 'SCRIPT'
#!/bin/bash
# frc-usb-mount {device} {mountpoint} — mount a USB block device read-only
DEV="$1"; MNT="$2"
[ -z "$DEV" ] || [ -z "$MNT" ] && { echo "Usage: frc-usb-mount <device> <mountpoint>"; exit 2; }
[ -b "$DEV" ] || { echo "$DEV is not a block device"; exit 2; }
case "$MNT" in /run/frc-display-usb/*) : ;; *) echo "Mount point must be under /run/frc-display-usb/"; exit 2 ;; esac
mkdir -p "$MNT"
mount -o ro,nosuid,nodev,noexec "$DEV" "$MNT"
SCRIPT
chmod 755 /usr/local/bin/frc-usb-mount

cat > /usr/local/bin/frc-usb-unmount << 'SCRIPT'
#!/bin/bash
# frc-usb-unmount {mountpoint}
MNT="$1"
[ -z "$MNT" ] && { echo "Usage: frc-usb-unmount <mountpoint>"; exit 2; }
case "$MNT" in /run/frc-display-usb/*) : ;; *) echo "Refusing to unmount outside /run/frc-display-usb/"; exit 2 ;; esac
umount "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null || true
rmdir "$MNT" 2>/dev/null || true
SCRIPT
chmod 755 /usr/local/bin/frc-usb-unmount

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
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/frc-ap-start, /usr/local/bin/frc-ap-stop, /usr/local/bin/frc-wifi-connect, /usr/local/bin/frc-wifi-up, /usr/local/bin/frc-handoff, /usr/local/bin/frc-install, /usr/local/bin/frc-eth-static, /usr/local/bin/frc-eth-dhcp, /usr/local/bin/frc-usb-mount, /usr/local/bin/frc-usb-unmount, /bin/systemctl restart lightdm
SUDOCONF
chmod 440 /etc/sudoers.d/frc-display

# ── NDI source discovery ───────────────────────────────────────────────────────
echo "[11] Installing NDI tools..."

# ndi-list-sources: uses avahi mDNS (no SDK needed) + falls back to NDI SDK tools
cat > /usr/local/bin/ndi-list-sources << 'NDISCRIPT'
#!/bin/bash
python3 /usr/local/bin/ndi-sources.py
NDISCRIPT
chmod +x /usr/local/bin/ndi-list-sources

# Install ndi-play binary + libndi.so from GCS (no account needed, fully automated)
NDI_TOOLS_ARCH="x86_64"
case "$(uname -m)" in
  aarch64|arm64) NDI_TOOLS_ARCH="aarch64" ;;
  armv7*|armhf)  NDI_TOOLS_ARCH="armhf" ;;
esac
NDI_TOOLS_URL="https://storage.googleapis.com/frc-display-assets/ndi-tools-linux-${NDI_TOOLS_ARCH}.tar.gz"

# Write ndi-sources.py (avahi discovery, human-readable output parser)
cat > /usr/local/bin/ndi-sources.py << 'PYSCRIPT'
#!/usr/bin/env python3
import json, re, subprocess

def avahi_browse(svc):
    try:
        r = subprocess.run(['avahi-browse', '-t', '-r', svc],
                           capture_output=True, text=True, timeout=5)
    except Exception:
        return []
    results = []
    current_name = None; addr = None
    for line in r.stdout.split('\n'):
        m = re.match(r'^=\s+\S+\s+\S+\s+(.+?)\s{2,}' + re.escape(svc), line)
        if m:
            current_name = m.group(1).strip(); addr = None; continue
        if current_name:
            am = re.match(r'\s+address\s*=\s*\[(.+?)\]', line)
            pm = re.match(r'\s+port\s*=\s*\[(\d+)\]', line)
            if am: addr = am.group(1)
            if pm and addr: results.append((current_name, addr, pm.group(1))); current_name = None
    return results

sources = []
seen = set()

for name, _a, _p in avahi_browse('_ndi._tcp'):
    if name not in seen:
        seen.add(name)
        sources.append({'label': f'NDI: {name}', 'value': name})

for name, addr, port in avahi_browse('_omt._tcp'):
    key = f'{addr}:{port}'
    if key not in seen:
        seen.add(key)
        sources.append({'label': f'OMT: {name}', 'value': f'omt://{addr}:{port}'})

print(json.dumps(sources))
PYSCRIPT
chmod +x /usr/local/bin/ndi-sources.py

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

# ── User linger (starts PipeWire/user services at boot without a login) ───────
echo "[14b] Enabling user linger for ${SERVICE_USER}..."
loginctl enable-linger "${SERVICE_USER}" 2>/dev/null || true

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

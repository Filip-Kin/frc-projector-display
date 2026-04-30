# FRC Projector Display — Setup Runbook

This document is an exhaustive, LLM-reproducible runbook for provisioning the entire FRC projector display system from scratch.

---

## Overview

The system consists of two components:

| Component | Description | Location |
|-----------|-------------|----------|
| **Control Server** | Node.js WebSocket hub + mobile control UI | Coolify at `display.filipkin.com` |
| **Thin Client** | Lenovo ThinkCentre (192.168.1.17), Debian 13, Chromium kiosk + daemon | Local LAN |

**Communication flow:**
```
Phone → wss://display.filipkin.com/ws/control?pin=XXXXXX
                     ↕ server bridges
Thin client → wss://display.filipkin.com/ws/device
```

---

## Prerequisites

- GitHub repo: `Filip-Kin/frc-projector-display` (already created)
- Coolify panel: `https://panel.filipkin.com`
- Coolify API key: stored in memory
- Cloudflare API token: stored in memory
- Physical access to the thin client (192.168.1.17) to set up SSH keys on first boot

---

## Part 1: Thin Client — Debian 11 → 13 Upgrade

SSH into the thin client (or use keyboard/monitor if SSH isn't yet configured):

```bash
ssh filip@192.168.1.17
```

### 1.1 Stop OctoPrint services

```bash
sudo systemctl stop octoprint mjpg-streamer 2>/dev/null || true
sudo systemctl disable octoprint mjpg-streamer 2>/dev/null || true
sudo rm -f /etc/systemd/system/octoprint.service /etc/systemd/system/mjpg-streamer.service
sudo systemctl daemon-reload
```

Remove OctoPrint files:
```bash
rm -rf ~/OctoPrint ~/mjpg-streamer
```

### 1.2 Upgrade Debian 11 → 12 (Bookworm)

```bash
sudo apt update && sudo apt upgrade -y
sudo sed -i 's/bullseye/bookworm/g' /etc/apt/sources.list
sudo apt update && sudo apt full-upgrade -y
sudo apt autoremove -y
```

### 1.3 Upgrade Debian 12 → 13 (Trixie)

```bash
sudo sed -i 's/bookworm/trixie/g' /etc/apt/sources.list
# Remove any bookworm-specific repos that don't have trixie equivalents:
sudo sed -i '/security\.debian\.org.*bookworm/d' /etc/apt/sources.list
sudo sed -i '/updates\.debian\.org.*bookworm/d' /etc/apt/sources.list
sudo apt update && sudo apt full-upgrade -y
sudo apt autoremove -y && sudo reboot
```

### 1.4 Post-reboot: Verify

```bash
cat /etc/os-release
# Should show: VERSION_CODENAME=trixie
```

### 1.5 Set hostname

```bash
sudo hostnamectl set-hostname filip-display-1
sudo sed -i 's/127.0.1.1.*/127.0.1.1\tfilip-display-1/' /etc/hosts
```

### 1.6 Set NIC to DHCP

Edit `/etc/network/interfaces`:
```
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
```

Replace `eth0` with the actual NIC name (`ip link` to check).

---

## Part 2: Thin Client — Software Setup

Run the one-command installer (as root):

```bash
curl -fsSL https://display.filipkin.com/install.sh | sudo bash
```

This installs:
- Node.js 20
- Xorg, Openbox, LightDM
- Chromium (with `--remote-debugging-port=9222`)
- x11vnc
- ffmpeg (for NDI playback via ffplay)
- Clones the repo to `/opt/frc-projector-display`
- Creates `/etc/systemd/system/display-daemon.service`
- Sets graphical boot target

### 2.1 Manual install (if one-liner fails)

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# System packages
sudo apt-get install -y xorg openbox lightdm lightdm-gtk-greeter chromium x11vnc ffmpeg git curl

# LightDM autologin
sudo tee /etc/lightdm/lightdm.conf << 'EOF'
[Seat:*]
autologin-user=filip
autologin-user-timeout=0
greeter-session=lightdm-gtk-greeter
EOF

# Openbox autostart
mkdir -p ~/.config/openbox
tee ~/.config/openbox/autostart << 'EOF'
xset s off &
xset -dpms &
xset s noblank &
chromium --kiosk --no-sandbox --disable-infobars \
  --disable-translate --disable-features=TranslateUI \
  --no-first-run --disable-default-apps \
  --remote-debugging-port=9222 \
  http://localhost:3000/ &
EOF

# Clone repo
sudo git clone https://github.com/Filip-Kin/frc-projector-display.git /opt/frc-projector-display
sudo npm install --production --prefix /opt/frc-projector-display/client

# Systemd service
sudo tee /etc/systemd/system/display-daemon.service << 'EOF'
[Unit]
Description=FRC Projector Display Daemon
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=filip
WorkingDirectory=/opt/frc-projector-display/client
Environment=SERVER_URL=wss://display.filipkin.com
Environment=DISPLAY=:0
ExecStart=/usr/bin/node /opt/frc-projector-display/client/src/daemon.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable display-daemon.service
sudo systemctl set-default graphical.target
sudo reboot
```

---

## Part 3: NDI SDK Setup (Optional)

NDI requires a free account at [ndi.tv](https://ndi.tv) to download the SDK.

1. Register and download the NDI SDK for Linux from: https://ndi.tv/sdk/
2. Install the runtime package:
   ```bash
   sudo dpkg -i ndi-sdk-*.deb
   # or follow the installer script provided
   ```
3. Verify ffmpeg has NDI support:
   ```bash
   ffplay -f libndi_newtek -list_devices true -i dummy 2>&1
   ```
   If the `-f libndi_newtek` device is not listed, you need to compile ffmpeg with NDI support.

4. Test NDI playback manually:
   ```bash
   ffplay -f libndi_newtek -i "SOURCE_NAME (host)" -fs
   ```

The `ndi-list-sources` script at `/usr/local/bin/ndi-list-sources` will be called by the daemon every 30 seconds. If NDI is not installed, it returns `[]` (empty list) and NDI mode will show no sources.

---

## Part 4: Control Server — Coolify Deployment

### 4.1 DNS Record

Add an A record in Cloudflare:
- Name: `display`
- Type: A
- Value: `157.245.119.56` (Coolify cloud server IP)
- Proxy: DNS-only (grey cloud) or proxied — either works

```bash
curl -X POST 'https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records' \
  -H 'Authorization: Bearer CLOUDFLARE_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"display","content":"157.245.119.56","ttl":1,"proxied":false}'
```

### 4.2 Create Coolify Application

1. Log in to https://panel.filipkin.com
2. Create a new application:
   - Source: GitHub → `Filip-Kin/frc-projector-display`
   - Build pack: **Dockerfile**
   - Dockerfile path: `server/Dockerfile`
   - Base directory: `/` (root of repo)
   - Domain: `display.filipkin.com`
   - Port: `3000`
   - Environment variables:
     - `PORT=3000`
     - `NODE_ENV=production`
3. Enable "Auto-deploy on push"
4. Click Deploy

Alternatively, via Coolify API:
```bash
curl -X POST 'https://panel.filipkin.com/api/v1/applications' \
  -H 'Authorization: Bearer COOLIFY_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "frc-display-server",
    "git_repository": "https://github.com/Filip-Kin/frc-projector-display",
    "git_branch": "main",
    "dockerfile_location": "server/Dockerfile",
    "domains": "display.filipkin.com",
    "ports_exposes": "3000"
  }'
```

---

## Part 5: Verify End-to-End

1. **Thin client boots** → LightDM auto-logs in as `filip` → Openbox starts → Chromium opens in kiosk mode at `localhost:3000`
2. **Daemon starts** → generates PIN → shows QR code on screen
3. **Scan QR** → phone opens `display.filipkin.com/control?pin=XXXXXX`
4. **Control UI** → status shows "Connected"
5. **Test FIM Queuing** → enter a test key → thin client switches to FIM queuing URL
6. **Test NDI** → if NDI source on network → NDI mode launches ffplay fullscreen
7. **Test VNC** → Web VNC mode → noVNC page opens on phone → cursor control works
8. **PIN changes on reboot** → reboot thin client → PIN changes → scan new QR

### Useful commands on thin client

```bash
# View daemon logs
journalctl -u display-daemon.service -f

# Restart daemon
sudo systemctl restart display-daemon.service

# Check Chromium CDP is listening
curl http://localhost:9222/json

# Manually test NDI source list
ndi-list-sources

# Check Openbox is running
ps aux | grep openbox
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| QR code not showing | `journalctl -u display-daemon` — is daemon running? Is port 3000 in use? |
| Control UI can't connect | Is `display.filipkin.com` resolving? Is server deployed on Coolify? |
| CDP navigate not working | `curl localhost:9222/json` — is Chromium running with `--remote-debugging-port=9222`? |
| NDI mode no sources | Run `ndi-list-sources` — is NDI SDK installed? Is NDI source on same network? |
| VNC black screen | Is x11vnc running? `ps aux | grep x11vnc` |
| VNC no connection | Check tunnel: server logs should show `vnc-upstream connected` |

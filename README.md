# frc-projector-display

Phone-controlled projector display system for FRC competitions.

A thin client runs a kiosk display (Chromium + ffplay), controlled remotely via a phone-accessible web interface served from `display.filipkin.com`. Connection is established via QR code displayed on screen.

The server self-hosts the client installer and update bundle — no GitHub access required on the target device.

## Repo layout

```
server/    Node.js WebSocket hub + mobile control UI (deploys to display.filipkin.com)
client/    Node.js daemon + local web server (runs on thin client)
docs/      SETUP.md — full provisioning runbook
```

## Display modes

| Mode | Description |
|------|-------------|
| Home / QR | Default screen; shows PIN + QR code |
| NDI Monitor | ffplay fullscreen from NDI source |
| FIM Queuing | fim-queueing.web.app |
| Nexus Queuing | frc.nexus pit display |
| YouTube Live | YouTube in kiosk mode |
| Custom URL | Any URL |
| Web VNC | noVNC via WebSocket tunnel |

## Setup

See [docs/SETUP.md](docs/SETUP.md) for the full provisioning runbook.

Quick start on thin client:
```bash
curl -fsSL https://display.filipkin.com/install.sh | sudo bash
```

Optional env vars:
```bash
SERVER_URL=https://display.filipkin.com   # default
SERVICE_USER=display                       # local kiosk user (created if missing)
INSTALL_DIR=/opt/frc-projector-display/client
```

Auto-update: on every boot the daemon checks `display.filipkin.com/version.json` and pulls a new build if the version changed. Deploy a new version by bumping `client/package.json` and pushing — all devices update on next reboot.

## WiFi / Bluetooth chip compatibility

Provisioning leans hard on the wireless hardware in two ways, so chip choice matters:

1. **Soft AP + STA handover (WiFi).** `frc-ap-start` brings the same `wlan0` up as a 2.4 GHz AP (`802-11-wireless.mode ap`, `ipv4.method shared`), and `frc-handoff` flips it back to client mode. That nl80211 master-mode path plus the rapid AP↔client switch is where cheap chips break (stale scans, activation races).
2. **BLE provisioning (Bluetooth).** The Improv flow registers a GATT peripheral and LE advertisement via BlueZ (≥ 5.50), so the BT controller's firmware must do LE advertising and peripheral GATT reliably.

You want a combo where the WiFi driver is in-kernel `mac80211` (not an out-of-tree Realtek DKMS blob) **and** the BT side has solid BlueZ support.

### Recommended

| Chip | Driver | Notes |
|------|--------|-------|
| Intel AX210 / AX200 / 9260 / 8265 | `iwlwifi` + Intel BT | Top pick. Rock-solid AP mode and STA/AP switching, best BLE-peripheral stack on Linux. One M.2/PCIe card does both. |
| MediaTek MT7921 / MT7922 | `mt76` + `btusb` | Modern, fully in-kernel, good AP support, combo BT just works. Best alternative to Intel. |
| Atheros ath9k (AR9485, QCA9565) / ath9k_htc USB (AR9271) | `ath9k` | Gold standard for AP-mode reliability. Mostly 2.4 GHz-only, no onboard BT (pair with a separate BT dongle). |
| Raspberry Pi onboard (CYW43455, Pi 4/5) | `brcmfmac` | AP mode and BLE both work out of the box. Convenient if the thin client is a Pi. |

For a mini-PC thin client, an **Intel AX200/AX210 M.2 card** is the clear winner.

### Avoid

- **Realtek out-of-tree drivers, especially `rtl8723be`** (plus `rtl8723de`, `rtl8821ce`, `rtl8822be/ce`). Flaky AP mode, stale scan cache, broken STA/AP handover, and bad combo-BT BLE advertising. The client code carries explicit workarounds for `rtl8723be`.
- **Realtek USB dongles**: `rtl8188eu`, `rtl8192eu`, `88x2bu`/`8821au` (morrownr/aircrack DKMS). Hit-or-miss AP mode, out-of-tree modules that break on kernel bumps.
- **Broadcom on x86 with the proprietary `wl`/`broadcom-sta` driver**: no usable AP mode under nl80211.

### Tip

The fragile operation is single-interface STA↔AP flipping. If you have a spare USB port, a second radio dedicated to the AP (e.g. an `ath9k_htc` AR9271 just for `frc-provision`, with onboard Intel staying as client) sidesteps the handover race entirely.

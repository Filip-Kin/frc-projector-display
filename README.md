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

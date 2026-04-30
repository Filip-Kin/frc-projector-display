# frc-projector-display

Phone-controlled projector display system for FRC competitions.

A Lenovo ThinkCentre thin client runs a kiosk display (Chromium + ffplay), controlled remotely via a phone-accessible web interface served from `display.filipkin.com`. Connection is established via QR code displayed on screen.

## Repo layout

```
server/    Node.js WebSocket hub + mobile control UI (deploys to display.filipkin.com)
client/    Node.js daemon + local web server (runs on thin client at 192.168.1.17)
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
curl -fsSL https://raw.githubusercontent.com/Filip-Kin/frc-projector-display/main/client/install.sh | sudo bash
```

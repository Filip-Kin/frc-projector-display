#!/bin/bash
# frc-firstboot — runs the FRC Display install.sh on first boot, then disables itself.
# Installed by preseed late_command to /usr/local/sbin/frc-firstboot.
set -e

LOG=/var/log/frc-firstboot.log
exec > >(tee -a "$LOG") 2>&1

echo "[$(date)] frc-firstboot starting"

if [ -f /var/lib/frc-firstboot.done ]; then
  echo "  already complete, exiting"
  exit 0
fi

# Wait for outbound connectivity to the control server. systemd's
# network-online.target only guarantees a default route, not actual reachability.
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 -o /dev/null https://display.filipkin.com/install.sh; then
    echo "  network reachable"
    break
  fi
  echo "  waiting for network ($i/30)..."
  sleep 2
done

curl -fsSL https://display.filipkin.com/install.sh | bash

# Drop the LAN-only apt proxy now that the heavy install is done — kiosks
# typically run off-LAN at events and would otherwise fail any future apt run.
rm -f /etc/apt/apt.conf.d/02-frc-proxy

touch /var/lib/frc-firstboot.done
systemctl disable frc-firstboot.service

echo "[$(date)] frc-firstboot complete, rebooting in 3s"
sleep 3
systemctl reboot

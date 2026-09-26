import { exec, execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { state } from './state.js';

export interface EthernetStatus {
  iface: string;
  ip: string | null;
  isLinkLocal: boolean;
  hasRoutableIp: boolean;
}

export function getEthernetInterface(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("nmcli -t -f DEVICE,TYPE device status 2>/dev/null | grep ':ethernet' | head -1 | cut -d: -f1",
      (err, stdout) => resolve(stdout.trim() || null));
  });
}

export function getEthernetStatus(iface: string): Promise<EthernetStatus> {
  return new Promise((resolve) => {
    exec(`ip -4 addr show ${iface} 2>/dev/null`, (_err, stdout) => {
      const match = stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
      const ip = match?.[1] ?? null;
      const isLinkLocal = ip?.startsWith('169.254') ?? false;
      resolve({ iface, ip, isLinkLocal, hasRoutableIp: !!ip && !isLinkLocal });
    });
  });
}

// Apply a random static IP in 192.168.25.150–250 via helper script
export async function applyFieldStaticIp(iface: string): Promise<string> {
  const lastOctet = 150 + Math.floor(Math.random() * 101);
  const ip = `192.168.25.${lastOctet}`;
  await new Promise<void>((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-eth-static', iface, ip, '24', '192.168.25.1'],
      { timeout: 10000 }, (err, _o, stderr) => {
        if (err) { console.error('[net] static IP failed:', stderr); reject(err); }
        else resolve();
      });
  });
  return ip;
}

// Set ethernet to DHCP
export function applyDhcp(iface: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('sudo', ['/usr/local/bin/frc-eth-dhcp', iface], { timeout: 10000 }, () => resolve());
  });
}

// Snapshot of "what should the QR screen show under the QR code" — the
// active connection's iface, primary IPv4, and (if wifi) the SSID.
export interface ActiveNetSummary {
  ip: string | null;
  ethernet: string | null;
  wifi: string | null;
}
export function getActiveNetSummary(): Promise<ActiveNetSummary> {
  return new Promise((resolve) => {
    exec('nmcli -t -f NAME,DEVICE,TYPE,STATE c show --active 2>/dev/null', (_e, stdout) => {
      const rows = (stdout || '').split('\n').map(l => l.split(':'))
        .filter(c => c[3] === 'activated' && c[1] && c[1] !== 'lo');
      const wifi = rows.find(c => c[2] === '802-11-wireless');
      const eth  = rows.find(c => c[2] === '802-3-ethernet');
      const pick = wifi ?? eth;
      if (!pick) { resolve({ ip: null, ethernet: null, wifi: null }); return; }
      const dev = pick[1];
      exec(`ip -4 addr show ${dev} 2>/dev/null`, (_e2, out2) => {
        const ip = out2.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
        resolve({
          ip,
          ethernet: eth ? eth[1] : null,
          wifi: wifi ? pick[0] : null,
        });
      });
    });
  });
}

// Set a user-specified static IP (from setup page)
export function applyCustomStaticIp(iface: string, ip: string, prefix: string, gateway: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-eth-static', iface, ip, prefix, gateway],
      { timeout: 10000 }, (err, _o, stderr) => {
        if (err) { console.error('[net] custom static failed:', stderr); reject(err); }
        else resolve();
      });
  });
}

// Every usable IPv4 address on a real interface: carrier up, not loopback,
// not link-local, not the setup hotspot. A non-empty list means the box sits
// on some network a controller could reach, even with no internet.
export function getLocalAddresses(): Promise<{ iface: string; ip: string }[]> {
  const excludeIface = state.apMode ? state.apIface : null;
  return new Promise((resolve) => {
    exec('ip -4 -o addr show scope global 2>/dev/null', (_e, stdout) => {
      const out: { iface: string; ip: string }[] = [];
      for (const line of (stdout || '').split('\n')) {
        const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (!m) continue;
        const [, iface, ip] = m;
        if (iface === 'lo' || iface === excludeIface || ip.startsWith('169.254.')) continue;
        // Physical NICs only (skips docker bridges, veths, tailscale).
        if (!existsSync(`/sys/class/net/${iface}/device`)) continue;
        let carrier = false;
        try { carrier = readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1'; } catch {}
        if (carrier) out.push({ iface, ip });
      }
      resolve(out);
    });
  });
}

export async function hasLocalLink(): Promise<boolean> {
  return (await getLocalAddresses()).length > 0;
}

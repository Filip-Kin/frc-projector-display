import { exec, execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { state } from './state.js';
import { checkInternet } from './wifi.js';

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
// includeLinkLocal: also list 169.254.x (for display: a laptop on a direct
// cable reaches the box there), never counted as a usable network.
export function getLocalAddresses(includeLinkLocal = false): Promise<{ iface: string; ip: string }[]> {
  const excludeIface = state.apMode ? state.apIface : null;
  return new Promise((resolve) => {
    exec('ip -4 -o addr show 2>/dev/null', (_e, stdout) => {
      const out: { iface: string; ip: string }[] = [];
      for (const line of (stdout || '').split('\n')) {
        const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (!m) continue;
        const [, iface, ip] = m;
        if (iface === 'lo' || iface === excludeIface || (!includeLinkLocal && ip.startsWith('169.254.'))) continue;
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

// What the controller's Network panel shows: each physical NIC with carrier
// and its address (Wi-Fi with its SSID), which one holds the default route,
// and whether the server answers.
export interface NetworkSnapshot {
  interfaces: { iface: string; kind: 'wired' | 'wifi'; ip: string; ssid: string | null }[];
  defaultIface: string | null;
  internet: boolean;
  primary: 'wired' | 'wifi';
  wifiOn: boolean;
  // frc-net is installed (installer rev 9); without it the box cannot change either setting.
  manageable: boolean;
}

const FRC_NET = '/usr/local/bin/frc-net';
const ROUTE_CONF = '/etc/NetworkManager/conf.d/frc-route.conf';

// Which link carries traffic when both are up, from the file frc-net writes. No file (installer
// before rev 9) means NetworkManager's own order, where Wi-Fi wins.
function readPrimary(): 'wired' | 'wifi' {
  try { return /route-metric=50\b/.test(readFileSync(ROUTE_CONF, 'utf8')) ? 'wifi' : 'wired'; }
  catch { return 'wifi'; }
}

export function wifiRadioOn(): Promise<boolean> {
  return new Promise(r => exec('nmcli radio wifi 2>/dev/null', (_e, out) => r((out || '').trim() !== 'disabled')));
}

function frcNet(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', [FRC_NET, ...args], { timeout: 20000 }, (err, _o, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim())); else resolve();
    });
  });
}

export async function setPrimaryRoute(route: 'wired' | 'wifi'): Promise<void> {
  await frcNet(['route', route]);
}

export async function setWifiRadio(on: boolean): Promise<void> {
  await frcNet(['wifi', on ? 'on' : 'off']);
}
export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
  const sh = (cmd: string) => new Promise<string>(r => exec(cmd, (_e, out) => r(out || '')));
  const [addrs, ssidOut, routeOut, net, wifiOn] = await Promise.all([
    getLocalAddresses(true),
    sh("nmcli -t -f ACTIVE,SSID dev wifi 2>/dev/null | grep '^yes:' | head -1"),
    sh('ip route show default 2>/dev/null'),
    checkInternet(),
    wifiRadioOn(),
  ]);
  const ssid = ssidOut.trim().replace(/^yes:/, '').replace(/\\:/g, ':') || null;
  return {
    interfaces: addrs.map(a => {
      const wifi = existsSync(`/sys/class/net/${a.iface}/wireless`);
      return { iface: a.iface, kind: wifi ? 'wifi' : 'wired', ip: a.ip, ssid: wifi ? ssid : null };
    }),
    defaultIface: routeOut.match(/\bdev (\S+)/)?.[1] ?? null,
    internet: net.online,
    primary: readPrimary(),
    wifiOn,
    manageable: existsSync(FRC_NET),
  };
}

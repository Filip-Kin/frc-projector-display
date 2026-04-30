import { exec, execFile } from 'child_process';

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

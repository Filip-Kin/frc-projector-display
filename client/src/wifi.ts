import { exec, execFile } from 'child_process';

export interface WifiNetwork { ssid: string; signal: number; secured: boolean; }
export interface InternetResult { online: boolean; portalUrl: string | null; }

export function getWifiInterface(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("nmcli -t -f DEVICE,TYPE device status 2>/dev/null | grep ':wifi' | head -1 | cut -d: -f1",
      (err, stdout) => resolve(stdout.trim() || null));
  });
}

export function hasDefaultRoute(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('ip route show default', (err, stdout) => resolve(!err && stdout.trim().length > 0));
  });
}

export function startAp(pin: string, iface: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-ap-start', pin, iface], { timeout: 15000 },
      (err, _out, stderr) => { if (err) { console.error('[ap] start:', stderr); reject(err); } else resolve(); });
  });
}

export function stopAp(iface: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('sudo', ['/usr/local/bin/frc-ap-stop', iface], { timeout: 10000 }, () => resolve());
  });
}

export function connectWifi(ssid: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-wifi-connect', ssid, password || ''],
      { timeout: 30000 }, (err, _o, stderr) => { if (err) { console.error('[wifi]', stderr); reject(err); } else resolve(); });
  });
}

export async function scanWifi(): Promise<WifiNetwork[]> {
  // Force a fresh rescan and wait for it to complete — rtl8723be otherwise
  // returns stale or partial cache especially right after AP mode switches.
  await new Promise<void>(r => exec('nmcli device wifi rescan 2>/dev/null', () => r()));
  await new Promise(r => setTimeout(r, 2500));
  return new Promise((resolve) => {
    exec('nmcli -t -f SSID,SIGNAL,SECURITY dev wifi list 2>/dev/null', (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      const networks: WifiNetwork[] = [];
      const seen = new Set<string>();
      for (const line of stdout.trim().split('\n')) {
        const parts = line.split(/(?<!\\):/);
        if (parts.length < 3) continue;
        const security = parts.pop()!.replace(/\\:/g, ':').trim();
        const signal = parseInt(parts.pop()!) || 0;
        const ssid = parts.join(':').replace(/\\:/g, ':').trim();
        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);
        networks.push({ ssid, signal, secured: security !== '--' && security !== '' });
      }
      networks.sort((a, b) => b.signal - a.signal);
      resolve(networks);
    });
  });
}

export function checkInternet(): Promise<InternetResult> {
  return new Promise((resolve) => {
    exec('curl -sLI --max-time 8 http://connectivitycheck.gstatic.com/generate_204 2>/dev/null', (err, stdout) => {
      if (err || !stdout) { resolve({ online: false, portalUrl: null }); return; }
      const statuses = [...stdout.matchAll(/HTTP\/\S+\s+(\d+)/g)];
      const last = statuses.length ? parseInt(statuses[statuses.length - 1][1]) : 0;
      if (last === 204) { resolve({ online: true, portalUrl: null }); return; }
      const loc = stdout.match(/[Ll]ocation:\s*(\S+)/);
      resolve({ online: false, portalUrl: loc ? loc[1].trim() : null });
    });
  });
}

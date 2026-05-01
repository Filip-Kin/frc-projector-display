// Watches network reachability via three signals:
//   1. `ip monitor link` — instant kernel notifications of carrier changes
//   2. `ip monitor route` — instant notifications when routes change
//   3. 1s polling of /sys/class/net/*/carrier and ip route — safety net
//
// Reports "online" only when there IS a default route AND the interface for
// that route has carrier=1 (cable plugged in for ethernet, associated for wifi).
// On legacy ifupdown systems, routes persist after cable unplug, so we must
// check carrier state explicitly.

import { spawn, exec } from 'child_process';
import { readFileSync } from 'fs';

export type RouteListener = (online: boolean, reason: string) => void;

let lastKnownState: boolean | null = null;

function readCarrier(iface: string): boolean {
  try { return readFileSync(`/sys/class/net/${iface}/carrier`, 'utf8').trim() === '1'; }
  catch { return false; }
}

function checkOnline(reason: string, listener: RouteListener) {
  exec('ip route show default', (err, stdout) => {
    const route = stdout.trim();
    if (err || !route) {
      report(false, `${reason}: no default route`, listener);
      return;
    }
    // Parse "default via 192.168.1.1 dev enp3s0 onlink"
    const match = route.match(/dev\s+(\S+)/);
    const iface = match?.[1];
    if (!iface) {
      report(false, `${reason}: route has no iface (${route})`, listener);
      return;
    }
    const carrier = readCarrier(iface);
    if (!carrier) {
      report(false, `${reason}: ${iface} carrier down (route exists but no link)`, listener);
      return;
    }
    report(true, `${reason}: route via ${iface} (carrier ok)`, listener);
  });
}

function report(online: boolean, detail: string, listener: RouteListener) {
  if (online === lastKnownState) return;
  console.log(`[net-mon] ${lastKnownState} → ${online} | ${detail}`);
  lastKnownState = online;
  listener(online, detail);
}

export function startNetworkMonitor(listener: RouteListener) {
  console.log('[net-mon] starting');
  checkOnline('initial', listener);

  // Subscribe to BOTH route and link netlink events
  function spawnMonitor(what: 'route' | 'link') {
    console.log(`[net-mon] spawning ip monitor ${what}`);
    const proc = spawn('ip', ['-t', 'monitor', what], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      // Only react to events that could affect connectivity
      if (what === 'link' && !/(LOWER_UP|NO-CARRIER)/.test(text)) return;
      if (what === 'route' && !text.includes('default')) return;
      console.log(`[net-mon] ${what} event: ${text.substring(0, 150)}`);
      checkOnline(`netlink-${what}`, listener);
    });

    proc.on('exit', (code) => {
      console.error(`[net-mon] ip monitor ${what} exited code=${code} — respawning in 2s`);
      setTimeout(() => spawnMonitor(what), 2000);
    });
    proc.on('error', (err) => console.error(`[net-mon] ${what} spawn error: ${err.message}`));
  }
  spawnMonitor('route');
  spawnMonitor('link');

  // Safety polling — covers any missed events (1s for fast detection)
  setInterval(() => checkOnline('poll', listener), 1000);
}

export function getCurrentRouteState(): boolean | null {
  return lastKnownState;
}

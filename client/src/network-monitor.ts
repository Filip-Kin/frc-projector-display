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
    const out = (stdout || '').trim();
    if (err || !out) {
      report(false, `${reason}: no default route`, listener);
      return;
    }
    // There may be multiple default routes (e.g. ethernet + wifi). Skip any
    // marked `linkdown` or `dead` -- those are stale routes whose interface
    // lost carrier, and the kernel is configured (via sysctl ignore_routes_
    // with_linkdown=1) to route around them anyway. Picking the first such
    // route would falsely report DOWN when wifi is actually fine.
    const lines = out.split('\n');
    for (const line of lines) {
      if (/\b(linkdown|dead)\b/.test(line)) continue;
      const m = line.match(/dev\s+(\S+)/);
      const iface = m?.[1];
      if (!iface) continue;
      if (!readCarrier(iface)) continue;
      report(true, `${reason}: route via ${iface} (carrier ok)`, listener);
      return;
    }
    report(false, `${reason}: no live default route (${lines.length} stale)`, listener);
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

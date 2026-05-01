// Watches the kernel default route via `ip monitor route` (netlink notifications)
// PLUS a 2s safety poll. Calls onChange(hasRoute) immediately on any state change.
// Logs everything with [net-mon] tag so we can trace what's happening.

import { spawn, exec } from 'child_process';

export type RouteListener = (hasRoute: boolean, reason: string) => void;

let lastKnownState: boolean | null = null;
let monitorProc: ReturnType<typeof spawn> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function checkRoute(reason: string, listener: RouteListener) {
  exec('ip route show default', (err, stdout) => {
    const hasRoute = !err && stdout.trim().length > 0;
    if (hasRoute !== lastKnownState) {
      console.log(`[net-mon] route change (${reason}): ${lastKnownState} → ${hasRoute}`);
      if (stdout.trim()) console.log(`[net-mon]   route: ${stdout.trim()}`);
      lastKnownState = hasRoute;
      listener(hasRoute, reason);
    }
  });
}

export function startNetworkMonitor(listener: RouteListener) {
  console.log('[net-mon] starting');

  // Initial state check
  checkRoute('initial', listener);

  // Subscribe to kernel netlink route events via `ip monitor route`
  function spawnMonitor() {
    console.log('[net-mon] spawning ip monitor route');
    monitorProc = spawn('ip', ['-t', 'monitor', 'route'], { stdio: ['ignore', 'pipe', 'pipe'] });

    monitorProc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Only react to default route changes
      if (text.includes('default')) {
        console.log(`[net-mon] netlink event: ${text.trim().substring(0, 200)}`);
        // Re-check actual state (events can arrive in bursts)
        checkRoute('netlink', listener);
      }
    });

    monitorProc.stderr?.on('data', (data: Buffer) => {
      console.error(`[net-mon] monitor stderr: ${data.toString().trim()}`);
    });

    monitorProc.on('exit', (code) => {
      console.error(`[net-mon] ip monitor exited code=${code} — respawning in 2s`);
      monitorProc = null;
      setTimeout(spawnMonitor, 2000);
    });

    monitorProc.on('error', (err) => {
      console.error(`[net-mon] spawn error: ${err.message}`);
    });
  }
  spawnMonitor();

  // Safety polling — covers cases where netlink events are missed
  pollInterval = setInterval(() => checkRoute('poll', listener), 2000);
}

export function getCurrentRouteState(): boolean | null {
  return lastKnownState;
}

import { readFileSync } from 'fs';
import { exec } from 'child_process';

export interface Metrics {
  cpu: number;                                            // 0-100
  mem: { usedMB: number; totalMB: number };
  net: { iface: string; rxKBps: number; txKBps: number };
}

interface CpuSnap { idle: number; total: number; }
interface NetSnap { rx: number; tx: number; iface: string; ts: number; }

let prevCpu: CpuSnap | null = null;
let prevNet: NetSnap | null = null;
let cachedIface = '';
let lastIfaceCheck = 0;

function readCpu(): CpuSnap {
  // /proc/stat first line is aggregate across all cores
  const line = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
  const f = line.split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (f[3] ?? 0) + (f[4] ?? 0);
  const total = f.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function readMem(): { usedMB: number; totalMB: number } {
  const t = readFileSync('/proc/meminfo', 'utf8');
  const total = parseInt(t.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0');     // kB
  const avail = parseInt(t.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0'); // kB
  return {
    usedMB: Math.round((total - avail) / 1024),
    totalMB: Math.round(total / 1024),
  };
}

function readNet(iface: string): { rx: number; tx: number } | null {
  const t = readFileSync('/proc/net/dev', 'utf8');
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*(\S+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
    if (m && m[1] === iface) return { rx: parseInt(m[2]), tx: parseInt(m[3]) };
  }
  return null;
}

async function getDefaultIface(): Promise<string> {
  return new Promise(r => {
    exec("ip route show default 2>/dev/null | awk '/default/ {print $5; exit}'", (_e, out) => {
      r(out.trim() || cachedIface || 'lo');
    });
  });
}

export async function sampleMetrics(): Promise<Metrics> {
  const now = Date.now();
  if (now - lastIfaceCheck > 30000 || !cachedIface) {
    cachedIface = await getDefaultIface();
    lastIfaceCheck = now;
  }

  const cpu = readCpu();
  let cpuPct = 0;
  if (prevCpu) {
    const idleDelta  = cpu.idle - prevCpu.idle;
    const totalDelta = cpu.total - prevCpu.total;
    cpuPct = totalDelta > 0 ? Math.max(0, Math.min(100, 100 - (100 * idleDelta) / totalDelta)) : 0;
  }
  prevCpu = cpu;

  const net = readNet(cachedIface);
  let rxKBps = 0, txKBps = 0;
  if (prevNet && net && prevNet.iface === cachedIface) {
    const dt = (now - prevNet.ts) / 1000;
    if (dt > 0) {
      rxKBps = (net.rx - prevNet.rx) / 1024 / dt;
      txKBps = (net.tx - prevNet.tx) / 1024 / dt;
    }
  }
  if (net) prevNet = { rx: net.rx, tx: net.tx, iface: cachedIface, ts: now };

  return {
    cpu: Math.round(cpuPct),
    mem: readMem(),
    net: {
      iface: cachedIface,
      rxKBps: Math.max(0, Math.round(rxKBps * 10) / 10),
      txKBps: Math.max(0, Math.round(txKBps * 10) / 10),
    },
  };
}

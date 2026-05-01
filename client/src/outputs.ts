import { spawn, exec, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { state, OutputState } from './state.js';
import { cdpNavigate } from './cdp.js';

const CDP_PORT_RANGE = { start: 9222, end: 9230 };
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);

interface XrandrOutput {
  id: string;
  connected: boolean;
  primary: boolean;
  width: number;
  height: number;
}

function parseXrandrQuery(stdout: string): XrandrOutput[] {
  const out: XrandrOutput[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(connected|disconnected)(\s+primary)?(?:\s+(\d+)x(\d+))?/);
    if (!m) continue;
    const [, id, status, primary, w, h] = m;
    out.push({
      id,
      connected: status === 'connected',
      primary: !!primary,
      width: w ? parseInt(w) : 1920,
      height: h ? parseInt(h) : 1080,
    });
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    exec([cmd, ...args.map(a => `'${a.replace(/'/g, "'\\''")}'`)].join(' '), { env: process.env }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

async function xrandrQuery(): Promise<XrandrOutput[]> {
  const stdout = await run('xrandr', ['--query']);
  return parseXrandrQuery(stdout);
}

async function applyVerticalLayout(outputs: XrandrOutput[]): Promise<void> {
  // Stack connected monitors vertically: y offsets accumulate; widths share
  // x=0. VNC then captures one tall framebuffer that's natural to view on a
  // portrait phone.
  let y = 0;
  const args = ['xrandr'];
  // Disable disconnected outputs to keep framebuffer minimal
  const all = await xrandrQuery();
  for (const o of all) {
    if (!outputs.find(c => c.id === o.id)) {
      args.push('--output', o.id, '--off');
    }
  }
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    args.push('--output', o.id, '--auto', '--pos', `0x${y}`);
    if (i === 0) args.push('--primary');
    y += o.height;
  }
  await new Promise<void>((resolve, reject) => {
    exec(args.join(' '), { env: process.env }, (err) => err ? reject(err) : resolve());
  });
}

function pickFreeCdpPort(): number {
  const used = new Set(state.outputs.map(o => o.cdpPort));
  for (let p = CDP_PORT_RANGE.start; p < CDP_PORT_RANGE.end; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`no free cdp port in [${CDP_PORT_RANGE.start},${CDP_PORT_RANGE.end})`);
}

function spawnChromiumForOutput(o: OutputState): ChildProcess {
  const args = [
    `--user-data-dir=/tmp/chromium-${o.id}`,
    `--remote-debugging-port=${o.cdpPort}`,
    `--window-position=0,${o.yOffset}`,
    `--window-size=${o.width},${o.height}`,
    '--kiosk',
    '--no-sandbox', '--disable-infobars',
    '--disable-translate', '--disable-features=TranslateUI',
    '--no-first-run', '--disable-default-apps',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const proc = spawn('chromium', args, {
    env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':0' },
    detached: false,
    stdio: 'ignore',
  });
  proc.on('exit', code => {
    console.log(`[chromium-${o.id}] exited (${code})`);
    if (o.chromiumProcess === proc) o.chromiumProcess = null;
  });
  return proc;
}

async function killExistingChromiums(): Promise<void> {
  await new Promise<void>(r => exec(
    `pkill -9 -f 'chromium.*--remote-debugging-port' 2>/dev/null; true`,
    () => r()
  ));
  await new Promise(r => setTimeout(r, 500));
}

export async function initOutputs(): Promise<void> {
  await killExistingChromiums();

  const detected = (await xrandrQuery()).filter(o => o.connected);
  if (detected.length === 0) {
    console.log('[outputs] no connected monitors detected');
    state.outputs = [];
    return;
  }
  detected.sort((a, b) => a.id.localeCompare(b.id));

  await applyVerticalLayout(detected);

  let y = 0;
  state.outputs = detected.map((d, i) => {
    const o: OutputState = {
      id: d.id,
      width: d.width,
      height: d.height,
      yOffset: y,
      displayIndex: i,
      cdpPort: CDP_PORT_RANGE.start + i,
      mode: 'home',
      ndiProcess: null,
      chromiumProcess: null,
    };
    y += d.height;
    return o;
  });

  for (const o of state.outputs) {
    o.chromiumProcess = spawnChromiumForOutput(o);
    console.log(`[outputs] ${o.id} ${o.width}x${o.height}+0+${o.yOffset} cdp=${o.cdpPort} display=${o.displayIndex}`);
  }

  startStrayChromiumWatcher();
  startHotplugWatcher();
}

function startStrayChromiumWatcher() {
  const ourDirs = new Set(state.outputs.map(o => `--user-data-dir=/tmp/chromium-${o.id}`));
  let ticks = 0;
  const tick = async () => {
    ticks++;
    const procs = await new Promise<string>(r => exec('ps -ww -eo pid,args 2>/dev/null', (_e, out) => r(out ?? '')));
    for (const line of procs.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*chromium\b.*--remote-debugging-port[=\s]\d+.*)/);
      if (!m) continue;
      const args = m[2];
      if (/--type=/.test(args)) continue;
      if ([...ourDirs].some(d => args.includes(d))) continue;
      const pid = parseInt(m[1], 10);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      console.log(`[outputs] killed stray chromium pid=${pid}`);
    }
    if (ticks < 12) setTimeout(tick, 5000);
  };
  setTimeout(tick, 3000);
}

// ── Hotplug watcher ─────────────────────────────────────────────────────────
// Polls /sys/class/drm/*/status. On a NEW connector becoming connected, adds
// it to the framebuffer (appended to the bottom) and spawns its chromium.
// Disconnects are no-ops: a brief cable swap should leave the existing window
// in place so it resumes drawing the moment the connector reattaches. If the
// reconnected output already exists in state, we still re-issue xrandr just
// in case X didn't auto-reactivate it.
export type OutputsChangedCb = () => void;
let onOutputsChanged: OutputsChangedCb | null = null;
export function setOnOutputsChanged(cb: OutputsChangedCb) { onOutputsChanged = cb; }

function readDrmConnectors(): { id: string; connected: boolean }[] {
  // /sys/class/drm/card0-HDMI-A-1/status -> "connected" | "disconnected"
  // The connector name there is HDMI-A-1 vs xrandr's HDMI-1, so we strip the
  // `-A` suffix when present.
  const out: { id: string; connected: boolean }[] = [];
  try {
    const dir = readDirSafe('/sys/class/drm');
    for (const entry of dir) {
      const m = entry.match(/^card\d+-(.+)$/);
      if (!m) continue;
      const sysName = m[1];
      // Normalize HDMI-A-1 -> HDMI-1, DP-1 stays DP-1, VGA-1 stays VGA-1
      const id = sysName.replace(/^([A-Z]+)-A-(\d+)$/, '$1-$2');
      const statusPath = `/sys/class/drm/${entry}/status`;
      if (!existsSync(statusPath)) continue;
      try {
        const status = readFileSync(statusPath, 'utf8').trim();
        out.push({ id, connected: status === 'connected' });
      } catch {}
    }
  } catch {}
  return out;
}

function readDirSafe(p: string): string[] {
  try { return require('fs').readdirSync(p); } catch { return []; }
}

async function addOutput(id: string): Promise<void> {
  const detected = await xrandrQuery();
  const x = detected.find(d => d.id === id && d.connected);
  if (!x) { console.log(`[outputs] addOutput: ${id} not yet visible to xrandr`); return; }
  const yOffset = state.outputs.reduce((s, o) => s + o.height, 0);
  try {
    await run('xrandr', ['--output', id, '--auto', '--pos', `0x${yOffset}`]);
  } catch (err: any) {
    console.error(`[outputs] xrandr add ${id} failed: ${err.message}`);
    return;
  }
  const cdpPort = pickFreeCdpPort();
  const displayIndex = state.outputs.length;
  const o: OutputState = {
    id, width: x.width, height: x.height, yOffset, displayIndex, cdpPort,
    mode: 'home', ndiProcess: null, chromiumProcess: null,
  };
  state.outputs.push(o);
  o.chromiumProcess = spawnChromiumForOutput(o);
  console.log(`[outputs] HOTPLUG add ${id} ${x.width}x${x.height}+0+${yOffset} cdp=${cdpPort}`);
  // Chromium needs a moment to bind its CDP port; defer the navigate so the
  // new output lands on the home QR instead of about:blank.
  setTimeout(() => cdpNavigate(`http://localhost:${LOCAL_PORT}/`, cdpPort).catch(() => {}), 1500);
  onOutputsChanged?.();
}

async function reactivateExisting(o: OutputState): Promise<void> {
  // Defensive: re-run xrandr in case X dropped the mode after a disconnect.
  // Cheap and idempotent.
  try {
    await run('xrandr', ['--output', o.id, '--auto', '--pos', `0x${o.yOffset}`]);
    console.log(`[outputs] HOTPLUG reactivated ${o.id}`);
  } catch (err: any) {
    console.error(`[outputs] reactivate ${o.id} failed: ${err.message}`);
  }
}

let lastSeenStatus = new Map<string, boolean>();
function startHotplugWatcher() {
  for (const o of state.outputs) lastSeenStatus.set(o.id, true);
  setInterval(async () => {
    const conns = readDrmConnectors();
    for (const c of conns) {
      const wasSeen   = lastSeenStatus.get(c.id);
      const knownInUI = state.outputs.find(o => o.id === c.id);
      if (c.connected && !knownInUI) {
        // New, unmanaged output appeared
        try { await addOutput(c.id); } catch (err: any) {
          console.error(`[outputs] hotplug addOutput failed: ${err.message}`);
        }
      } else if (c.connected && knownInUI && wasSeen === false) {
        // Returning after a disconnect — nudge X to re-light it up
        await reactivateExisting(knownInUI);
      }
      // c.connected && wasSeen: nothing to do
      // !c.connected: explicitly do nothing (per user direction)
      lastSeenStatus.set(c.id, c.connected);
    }
  }, 5000);
}

export function getOutput(id: string): OutputState | undefined {
  return state.outputs.find(o => o.id === id);
}

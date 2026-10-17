import { spawn, exec, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { state, OutputState } from './state.js';
import { cdpNavigate, cdpGet } from './cdp.js';

const CDP_PORT_RANGE = { start: 9222, end: 9230 };
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);

interface XrandrOutput {
  id: string;
  connected: boolean;
  primary: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
}

function parseXrandrQuery(stdout: string): XrandrOutput[] {
  const out: XrandrOutput[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(connected|disconnected)(\s+primary)?(?:\s+(\d+)x(\d+)\+(\d+)\+(\d+))?/);
    if (!m) continue;
    const [, id, status, primary, w, h, x, y] = m;
    out.push({
      id,
      connected: status === 'connected',
      primary: !!primary,
      width: w ? parseInt(w) : 1920,
      height: h ? parseInt(h) : 1080,
      x: x ? parseInt(x) : 0,
      y: y ? parseInt(y) : 0,
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

interface OutputModes {
  mm: { w: number; h: number } | null;          // physical size from the EDID
  modes: { w: number; h: number; preferred: boolean }[];
}

// Every output's modes and physical size, from `xrandr --query`.
async function xrandrModeInfo(): Promise<Map<string, OutputModes>> {
  const info = new Map<string, OutputModes>();
  let cur: OutputModes | null = null;
  for (const line of (await run('xrandr', ['--query'])).split('\n')) {
    const head = line.match(/^(\S+)\s+(?:connected|disconnected)/);
    if (head) {
      const mm = line.match(/(\d+)mm x (\d+)mm\s*$/);
      cur = { mm: mm && +mm[1] > 0 && +mm[2] > 0 ? { w: +mm[1], h: +mm[2] } : null, modes: [] };
      info.set(head[1], cur);
      continue;
    }
    const m = line.match(/^\s+(\d+)x(\d+)\S*\s+(.*)$/);
    if (m && cur) cur.modes.push({ w: +m[1], h: +m[2], preferred: m[3].includes('+') });
  }
  return info;
}

// The mode an output should run: its preferred mode, or, when the EDID marks none, the largest
// mode with the screen's physical shape. xrandr --auto takes the first listed mode then, which on
// filip-display-1's 16:9 HDMI panel was 1600x1200 and stretched the picture sideways.
function pickMode(m: OutputModes | undefined): { w: number; h: number } | null {
  if (!m?.modes.length) return null;
  const pref = m.modes.find(x => x.preferred);
  if (pref) return pref;
  if (m.mm) {
    const shape = m.mm.w / m.mm.h;
    const fits = m.modes.filter(x => Math.abs(x.w / x.h - shape) / shape < 0.05);
    if (fits.length) return fits.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  }
  return m.modes[0];
}

// xrandr arguments that light an output in its picked mode; sets o.width/o.height to it.
function modeArgs(o: { id: string; width: number; height: number }, info: Map<string, OutputModes>): string[] {
  const mode = pickMode(info.get(o.id));
  if (!mode) return ['--output', o.id, '--auto'];
  o.width = mode.w; o.height = mode.h;
  return ['--output', o.id, '--mode', `${mode.w}x${mode.h}`];
}

async function applyVerticalLayout(outputs: XrandrOutput[]): Promise<void> {
  // Stack connected monitors vertically: y offsets accumulate; widths share
  // x=0. VNC then captures one tall framebuffer that's natural to view on a
  // portrait phone. Offsets come from the mode each output is about to get, not the one it had
  // (a 1200-line HDMI over VGA placed at +0+1080 overlapped it by 120 lines).
  let y = 0;
  const args: string[] = [];
  // Undo the scaling a mirror leaves behind (X keeps it across daemon restarts). Separate call,
  // errors ignored: a driver without transforms must not stop the layout.
  for (const o of outputs) await run('xrandr', ['--output', o.id, '--scale', '1x1']).catch(() => {});
  // Disable disconnected outputs to keep framebuffer minimal
  const all = await xrandrQuery();
  for (const o of all) {
    if (!outputs.find(c => c.id === o.id)) {
      args.push('--output', o.id, '--off');
    }
  }
  const info = await xrandrModeInfo();
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    args.push(...modeArgs(o, info), '--pos', `0x${y}`);
    if (i === 0) args.push('--primary');
    y += o.height;
  }
  await run('xrandr', args);
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
    console.log('[outputs] no connected monitors detected — waiting for hotplug');
    state.outputs = [];
    // Start the watcher anyway so a monitor plugged in (or powered on)
    // after boot gets picked up without requiring a daemon restart.
    startHotplugWatcher();
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
    await run('xrandr', [...modeArgs(x, await xrandrModeInfo()), '--pos', `0x${yOffset}`]);
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
  const src = o.mode === 'mirror' && o.mirrorOf ? getOutput(o.mirrorOf) : undefined;
  if (src) {
    await sameAs(o, src).then(() => console.log(`[outputs] HOTPLUG re-mirrored ${o.id} to ${src.id}`))
      .catch((err: any) => console.error(`[outputs] re-mirror ${o.id} failed: ${err.message}`));
    return;
  }
  try {
    await run('xrandr', [...modeArgs({ ...o }, await xrandrModeInfo()), '--pos', `0x${o.yOffset}`]);
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

// ── Mirror ──────────────────────────────────────────────────────────────────
// A mirrored output copies another output's picture in hardware (xrandr --same-as), so the one
// player or page on the source feeds both screens; a second player doubles the CPU on these
// two-core boxes. The mirrored output's own Chromium is closed: left open, its window lands on top
// of the source's picture once both outputs scan out the same framebuffer area (display-1,
// 2026-10-17: the VGA screen's home QR covered the omtx feed on HDMI).

async function sameAs(o: OutputState, src: OutputState): Promise<void> {
  const cur = (await xrandrQuery()).find(d => d.id === src.id);
  const size = `${cur?.width ?? src.width}x${cur?.height ?? src.height}`;
  // The source's own mode when this output has it: a plain copy, no scaling.
  if ((await xrandrModeInfo()).get(o.id)?.modes.some(m => `${m.w}x${m.h}` === size)) {
    await run('xrandr', ['--output', o.id, '--mode', size, '--same-as', src.id]);
    return;
  }
  // Otherwise scale the source's picture onto this output's preferred mode, so a screen with a
  // different resolution shows all of it. A driver without transforms gets the unscaled copy.
  try {
    await run('xrandr', ['--output', o.id, '--auto', '--same-as', src.id, '--scale-from', size]);
  } catch (err: any) {
    console.warn(`[outputs] ${o.id} cannot scale to ${size} (${err.message.trim()}); mirroring unscaled`);
    await run('xrandr', ['--output', o.id, '--auto', '--same-as', src.id]);
  }
}

async function closeChromium(o: OutputState): Promise<void> {
  const proc = o.chromiumProcess;
  if (!proc) return;
  o.chromiumProcess = null;
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, 3000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    try { proc.kill('SIGKILL'); } catch { clearTimeout(t); resolve(); }
  });
}

export async function mirrorOutput(o: OutputState, src: OutputState): Promise<void> {
  // Copy first: if xrandr refuses, the output keeps its own Chromium and picture.
  await sameAs(o, src);
  await closeChromium(o);
  console.log(`[outputs] ${o.id} mirrors ${src.id}`);
}

// Back to its own area of the framebuffer with its own Chromium. Resolves once that Chromium
// answers on its CDP port and has had a moment to map its window, so a player started next
// lands on top of it, not under it.
export async function unmirrorOutput(o: OutputState): Promise<void> {
  await run('xrandr', ['--output', o.id, '--scale', '1x1']).catch(() => {});
  await run('xrandr', [...modeArgs({ ...o }, await xrandrModeInfo()), '--pos', `0x${o.yOffset}`]);
  if (!o.chromiumProcess) o.chromiumProcess = spawnChromiumForOutput(o);
  for (let i = 0; i < 30; i++) {
    if (await cdpGet(o.cdpPort, '/json').then(t => !!t, () => false)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 1500));
  console.log(`[outputs] ${o.id} back on its own screen at +0+${o.yOffset}`);
}

// Where the output sits in the framebuffer right now, as WxH+X+Y. Read live: a mode changed by
// hand (xrandr on the box) or a hotplug leaves the sizes in state stale.
export async function outputGeometry(o: OutputState): Promise<string> {
  const cur = (await xrandrQuery().catch(() => [] as XrandrOutput[])).find(d => d.id === o.id && d.connected);
  return cur ? `${cur.width}x${cur.height}+${cur.x}+${cur.y}` : `${o.width}x${o.height}+0+${o.yOffset}`;
}

export function getOutput(id: string): OutputState | undefined {
  return state.outputs.find(o => o.id === id);
}

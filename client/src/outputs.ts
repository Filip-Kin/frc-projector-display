import { spawn, exec, ChildProcess } from 'child_process';
import { state, OutputState } from './state.js';

const BASE_CDP_PORT = 9222;

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
  // Kill any chromium left over from openbox autostart (legacy installs) or
  // a previous daemon process that crashed without cleaning up.
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
  // Primary first, then alphabetical; SDL display index will match xrandr
  // enumeration order after we apply the layout.
  detected.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  await applyVerticalLayout(detected);

  let y = 0;
  state.outputs = detected.map((d, i) => {
    const o: OutputState = {
      id: d.id,
      width: d.width,
      height: d.height,
      yOffset: y,
      displayIndex: i,
      cdpPort: BASE_CDP_PORT + i,
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
}

export function getOutput(id: string): OutputState | undefined {
  return state.outputs.find(o => o.id === id);
}

import { spawn } from 'child_process';
import net from 'net';
import { WebSocket } from 'ws';
import { state, OutputState } from './state.js';
import { cdpNavigate, cdpNavigateAll } from './cdp.js';
import { getOutput } from './outputs.js';

const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);
const VNC_PORT   = parseInt(process.env.VNC_PORT   ?? '5900', 10);
const SERVER_URL = process.env.SERVER_URL ?? 'https://display.filipkin.com';
const WS_URL     = SERVER_URL.replace(/^https?:\/\//, m => m === 'https://' ? 'wss://' : 'ws://');

export let PIN = '';
export function setPin(p: string) { PIN = p; }

export async function stopNdiOnOutput(o: OutputState) {
  if (o.ndiProcess) {
    const proc = o.ndiProcess;
    o.ndiProcess = null;
    try { proc.kill('SIGKILL'); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function setHomeOnOutput(outputId: string) {
  const o = getOutput(outputId); if (!o) return;
  await stopNdiOnOutput(o);
  o.mode = 'home';
  await cdpNavigate(`http://localhost:${LOCAL_PORT}/`, o.cdpPort);
}

export async function setChromiumOnOutput(outputId: string, url: string) {
  const o = getOutput(outputId); if (!o) return;
  await stopNdiOnOutput(o);
  o.mode = 'chromium';
  await cdpNavigate(url, o.cdpPort);
}

export async function setQueuingOnOutput(
  outputId: string,
  eventKey: string,
  streamType: 'youtube' | 'ndi',
  streamSource: string,
  size: number = 70,
) {
  const o = getOutput(outputId); if (!o) return;
  await stopNdiOnOutput(o);

  const u = new URL(`${SERVER_URL}/queuing`);
  u.searchParams.set('event', eventKey);
  u.searchParams.set('stream', streamType);
  u.searchParams.set('size', String(size));
  if (streamType === 'youtube') u.searchParams.set('streamId', streamSource);

  o.mode = 'queuing';
  await cdpNavigate(u.toString(), o.cdpPort);

  if (streamType === 'ndi' && streamSource) {
    const streamW = Math.round(o.width  * size / 100);
    const streamH = Math.round(o.height * size / 100);
    const streamX = o.width - streamW;
    const streamY = o.yOffset;
    const geom = `${streamW}x${streamH}+${streamX}+${streamY}`;
    const env = {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ':0',
      SDL_VIDEO_FULLSCREEN_DISPLAY: String(o.displayIndex),
    };
    const proc = spawn('ndi-play-wrapper', [streamSource, 'high', '--window', geom], { env, detached: false });
    proc.on('exit', code => {
      console.log(`[ndi:${o.id}] (queuing corner) exited (${code})`);
      if (o.ndiProcess === proc) o.ndiProcess = null;
    });
    o.ndiProcess = proc;
    console.log(`[queuing:${o.id}] event=${eventKey} ndi="${streamSource}" geom=${geom}`);
  } else {
    console.log(`[queuing:${o.id}] event=${eventKey} youtube=${streamSource} size=${size}%`);
  }
}

export function setNdiOnOutput(outputId: string, source: string, bandwidth: 'high' | 'low' = 'high') {
  const o = getOutput(outputId); if (!o) return;

  if (source.startsWith('omt://')) {
    console.error(`[omt] playback not yet supported (libomt stub)`);
    return;
  }

  // Fire-and-forget stop of previous NDI on this output (source-switch path)
  stopNdiOnOutput(o);
  // Hide chromium underneath; ndi-play fullscreens over it
  cdpNavigate('about:blank', o.cdpPort);

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':0',
    SDL_VIDEO_FULLSCREEN_DISPLAY: String(o.displayIndex),
  };
  const proc = spawn('ndi-play-wrapper', [source, bandwidth], { env, detached: false });
  proc.on('exit', code => {
    console.log(`[ndi:${o.id}] exited (${code})`);
    if (o.ndiProcess === proc) o.ndiProcess = null;
  });
  o.ndiProcess = proc;
  o.mode = 'ndi';
  console.log(`[ndi:${o.id}] started for: ${source} (bandwidth: ${bandwidth}, display=${o.displayIndex})`);
}

// Mirror helpers used by AP / identify / connecting flows
export async function setHomeAll() {
  for (const o of state.outputs) await stopNdiOnOutput(o);
  for (const o of state.outputs) o.mode = 'home';
  await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/`);
}

// ── VNC: on-demand ────────────────────────────────────────────────────────────
// x11vnc and the upstream bridge to the server only run while a viewer is
// connected. This keeps relay-server bandwidth at zero when no one is watching.

function startX11vnc() {
  if (state.x11vncProcess) return;
  const display = process.env.DISPLAY ?? ':0';
  state.x11vncProcess = spawn('x11vnc', [
    '-display', display,
    '-shared',
    '-nopw',
    '-quiet',
    '-rfbport', String(VNC_PORT),
    '-wait', '10',
    '-defer', '0',
    '-speeds', 'lan',
    '-noxdamage',  // captures whole framebuffer including off-monitor regions
  ], { detached: false });
  state.x11vncProcess.on('exit', code => {
    console.log(`[vnc] x11vnc exited (${code})`);
    state.x11vncProcess = null;
  });
  console.log('[vnc] x11vnc started on demand');
}

function stopX11vnc() {
  if (state.x11vncProcess) {
    try { state.x11vncProcess.kill('SIGTERM'); } catch {}
    state.x11vncProcess = null;
  }
}

export function stopVnc() {
  if (state.vncBridgeSocket) { state.vncBridgeSocket.destroy(); state.vncBridgeSocket = null; }
  if (state.vncBridgeWs)    { try { state.vncBridgeWs.removeAllListeners(); state.vncBridgeWs.close(); } catch {} state.vncBridgeWs = null; }
  stopX11vnc();
}

export function setVnc(serverWs: WebSocket) {
  if (state.vncBridgeWs?.readyState === WebSocket.OPEN) return;
  startX11vnc();
  // Give x11vnc a moment to bind its port before we connect to it
  setTimeout(() => connectVncBridge(serverWs), 400);
}

function connectVncBridge(serverWs: WebSocket) {
  const wsUrl = `${WS_URL}/ws/vnc-upstream?pin=${PIN}`;
  state.vncBridgeWs = new WebSocket(wsUrl);
  (state.vncBridgeWs as any).binaryType = 'nodebuffer';

  state.vncBridgeWs.on('open', () => {
    console.log('[vnc-bridge] upstream connected');
    state.vncBridgeSocket = net.createConnection(VNC_PORT, '127.0.0.1');
    state.vncBridgeSocket.on('data', d => { if (state.vncBridgeWs?.readyState === WebSocket.OPEN) state.vncBridgeWs.send(d); });
    state.vncBridgeSocket.on('error', err => console.error('[vnc-bridge] socket:', err.message));
    state.vncBridgeSocket.on('close', () => { state.vncBridgeWs?.close(); });
  });
  state.vncBridgeWs.on('message', d => { if (state.vncBridgeSocket && !state.vncBridgeSocket.destroyed) state.vncBridgeSocket.write(d as any); });
  state.vncBridgeWs.on('close', () => {
    state.vncBridgeSocket?.destroy(); state.vncBridgeSocket = null;
    state.vncBridgeWs = null;
    stopX11vnc();
    console.log('[vnc-bridge] upstream closed; vnc torn down');
  });
  state.vncBridgeWs.on('error', err => console.error('[vnc-bridge] WS:', err.message));
}

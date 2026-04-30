import { spawn } from 'child_process';
import net from 'net';
import { WebSocket } from 'ws';
import { state } from './state.js';
import { cdpNavigate } from './cdp.js';

const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);
const VNC_PORT   = parseInt(process.env.VNC_PORT   ?? '5900', 10);
const SERVER_URL = process.env.SERVER_URL ?? 'https://display.filipkin.com';
const WS_URL     = SERVER_URL.replace(/^https?:\/\//, m => m === 'https://' ? 'wss://' : 'ws://');

// PIN is set in daemon.ts; imported here via env or just exported
export let PIN = '';
export function setPin(p: string) { PIN = p; }

export async function stopNdi() {
  if (state.ndiProcess) {
    const proc = state.ndiProcess;
    state.ndiProcess = null;
    try { proc.kill('SIGKILL'); } catch {}   // SIGKILL is immediate — ndi-play needs no cleanup
    await new Promise(r => setTimeout(r, 200)); // let X11 window close before CDP navigates
  }
}

export function stopVnc() {
  if (state.vncBridgeSocket) { state.vncBridgeSocket.destroy(); state.vncBridgeSocket = null; }
  if (state.vncBridgeWs)    { state.vncBridgeWs.close();       state.vncBridgeWs = null; }
}

export async function setHome() {
  await stopNdi(); stopVnc();
  await cdpNavigate(`http://localhost:${LOCAL_PORT}/`);
}

export async function setChromium(url: string) {
  await stopNdi(); stopVnc();
  await cdpNavigate(url);
}

export function setNdi(source: string, bandwidth: 'high' | 'low' = 'high') {
  stopNdi(); stopVnc(); // fire-and-forget for source switches within NDI
  cdpNavigate('about:blank');
  const display = process.env.DISPLAY ?? ':0';
  let cmd: string; let args: string[];

  if (source.startsWith('omt://')) {
    // omt-play-wrapper uses libomt which is currently non-functional on Linux
    // Fall back to an error — the daemon will log it and the server will relay
    console.error(`[omt] playback not yet supported (libomt stub)`);
    return;
  } else {
    cmd = 'ndi-play-wrapper'; args = [source, bandwidth];
    console.log(`[ndi] started for: ${source} (bandwidth: ${bandwidth})`);
  }

  const proc = spawn(cmd, args, { env: { ...process.env, DISPLAY: display }, detached: false });
  proc.on('exit', code => {
    console.log(`[video] exited (${code})`);
    // Only clear if this is still the current process — prevents orphan races
    if (state.ndiProcess === proc) state.ndiProcess = null;
  });
  state.ndiProcess = proc;
}

export function setVnc(serverWs: WebSocket) {
  if (state.vncBridgeWs?.readyState === WebSocket.OPEN) return;
  connectVncBridge(serverWs);
  console.log('[vnc] relay bridge started');
}

export function startX11vncDaemon() {
  const display = process.env.DISPLAY ?? ':0';
  state.x11vncProcess = spawn('x11vnc', [
    '-display', display,
    '-forever',   // keep running after client disconnects
    '-shared',    // allow multiple simultaneous clients
    '-nopw',
    '-quiet',
    '-rfbport', String(VNC_PORT),
    '-wait', '10',    // poll every 10ms instead of default 75ms
    '-defer', '0',    // send updates immediately, don't batch
    '-speeds', 'lan', // assume LAN speed, skip slow-connection optimisations
  ], { detached: false });
  state.x11vncProcess.on('exit', code => {
    console.log(`[vnc] x11vnc exited (${code}) — restarting in 5s`);
    state.x11vncProcess = null;
    setTimeout(startX11vncDaemon, 5000);
  });
  console.log('[vnc] x11vnc started (always-on)');
}

export function connectVncBridge(serverWs: WebSocket) {
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
  state.vncBridgeWs.on('close', () => { state.vncBridgeSocket?.destroy(); state.vncBridgeSocket = null; });
  state.vncBridgeWs.on('error', err => console.error('[vnc-bridge] WS:', err.message));
}

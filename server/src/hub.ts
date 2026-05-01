import { WebSocket } from 'ws';
import { insertLog } from './db.js';
import type { DeviceState, WsMessage } from './types.js';

export const devices   = new Map<string, DeviceState>();
export const controllers  = new Map<string, WebSocket>();
export const vncUpstream  = new Map<string, WebSocket>();
export const vncClients   = new Map<string, WebSocket>();

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function handleDevice(ws: WebSocket) {
  let pin: string | null = null;

  ws.on('message', (data) => {
    let msg: WsMessage;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'register') {
      pin = (msg.pin ?? '').toUpperCase();
      if (!pin) return;
      devices.set(pin, {
        ws,
        ndiSources: [],
        audioSinks: [],
        audioState: { sink: '', volume: 100, muted: false },
        outputs: msg.outputs ?? [],
        lastSeen: Date.now(),
      });
      console.log(`[device] registered PIN ${pin} outputs=${(msg.outputs ?? []).map(o => o.id).join(',') || '(none)'}`);
      const ctrl = controllers.get(pin);
      if (ctrl) send(ctrl, { type: 'device_connected', outputs: msg.outputs ?? [] });

    } else if (msg.type === 'heartbeat') {
      if (!pin) return;
      const d = devices.get(pin);
      if (d) {
        d.lastSeen = Date.now();
        if (msg.version) d.version = msg.version;
        if (msg.hasInternet !== undefined) d.hasInternet = msg.hasInternet;
      }

    } else if (msg.type === 'ndi_sources') {
      if (!pin) return;
      const d = devices.get(pin);
      if (d) {
        d.ndiSources = msg.sources ?? [];
        const ctrl = controllers.get(pin);
        if (ctrl) send(ctrl, { type: 'ndi_sources', sources: msg.sources });
      }

    } else if (msg.type === 'audio_sinks') {
      if (!pin) return;
      const d = devices.get(pin);
      if (d) {
        d.audioSinks = msg.sinks ?? [];
        d.audioState = msg.state ?? d.audioState;
        const ctrl = controllers.get(pin);
        if (ctrl) send(ctrl, { type: 'audio_sinks', sinks: msg.sinks, state: msg.state });
      }

    } else if (msg.type === 'metrics') {
      if (!pin || !msg.metrics) return;
      const d = devices.get(pin);
      if (d) {
        d.metrics = msg.metrics;
        const ctrl = controllers.get(pin);
        if (ctrl) send(ctrl, { type: 'metrics', metrics: msg.metrics });
      }

    } else if (msg.type === 'log') {
      if (pin && msg.level && msg.msg) {
        insertLog(pin, msg.level, msg.msg);
      }
    }
  });

  ws.on('close', () => {
    if (!pin) return;
    devices.delete(pin);
    console.log(`[device] ${pin} disconnected`);
    const ctrl = controllers.get(pin);
    if (ctrl) send(ctrl, { type: 'device_disconnected' });
  });
}

export function handleController(ws: WebSocket, rawPin: string) {
  const pin = rawPin.toUpperCase();
  controllers.set(pin, ws);
  console.log(`[controller] connected for PIN ${pin}`);

  const d = devices.get(pin);
  send(ws, d
    ? { type: 'device_connected', ndiSources: d.ndiSources, audioSinks: d.audioSinks, audioState: d.audioState, outputs: d.outputs, metrics: d.metrics }
    : { type: 'device_disconnected' }
  );

  ws.on('message', (data) => {
    let msg: WsMessage;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const dev = devices.get(pin);
    if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
      send(ws, { type: 'error', message: 'Device not connected' });
      return;
    }
    dev.ws.send(JSON.stringify(msg));
  });

  ws.on('close', () => { if (controllers.get(pin) === ws) controllers.delete(pin); });
}

// Buffers VNC data until the browser client connects — VNC sends its
// protocol handshake immediately on connection; if we don't buffer it,
// a client that connects after the upstream will miss the greeting.
const vncUpstreamBuffer = new Map<string, Buffer[]>();

export function handleVncUpstream(ws: WebSocket, rawPin: string) {
  const pin = rawPin.toUpperCase();
  vncUpstream.set(pin, ws);
  vncUpstreamBuffer.set(pin, []);
  console.log(`[vnc-upstream] connected for PIN ${pin}`);

  ws.on('message', (data: Buffer) => {
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) {
      client.send(data);
    } else {
      // Buffer until client arrives (cap at 256 KB to avoid runaway growth)
      const buf = vncUpstreamBuffer.get(pin)!;
      buf.push(Buffer.from(data));
      const total = buf.reduce((s, b) => s + b.length, 0);
      if (total > 256 * 1024) { buf.splice(0, Math.ceil(buf.length / 2)); }
    }
  });
  ws.on('close', () => {
    vncUpstream.delete(pin);
    vncUpstreamBuffer.delete(pin);
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) client.close();
    // Tell device to reconnect upstream so next client gets a fresh handshake
    const ctrl = controllers.get(pin);
    if (ctrl?.readyState === WebSocket.OPEN) {
      ctrl.send(JSON.stringify({ type: 'vnc_upstream_closed' }));
    }
  });
}

export function handleVncClient(ws: WebSocket, rawPin: string) {
  const pin = rawPin.toUpperCase();
  vncClients.set(pin, ws);
  console.log(`[vnc-client] connected for PIN ${pin}`);

  // Flush any buffered upstream data so the client gets the VNC greeting
  const buf = vncUpstreamBuffer.get(pin);
  if (buf?.length) {
    for (const chunk of buf) ws.send(chunk);
    vncUpstreamBuffer.set(pin, []);
  }

  ws.on('message', (data) => {
    const up = vncUpstream.get(pin);
    if (up?.readyState === WebSocket.OPEN) up.send(data);
  });
  ws.on('close', () => {
    if (vncClients.get(pin) === ws) vncClients.delete(pin);
    // Close upstream so device reconnects with fresh handshake for next client
    const up = vncUpstream.get(pin);
    if (up?.readyState === WebSocket.OPEN) up.close();
  });
}

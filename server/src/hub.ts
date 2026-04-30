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
      devices.set(pin, { ws, ndiSources: [], audioSinks: [], audioState: { sink: '', volume: 100, muted: false }, lastSeen: Date.now() });
      console.log(`[device] registered PIN ${pin}`);
      const ctrl = controllers.get(pin);
      if (ctrl) send(ctrl, { type: 'device_connected' });

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
    ? { type: 'device_connected', ndiSources: d.ndiSources, audioSinks: d.audioSinks, audioState: d.audioState }
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

export function handleVncUpstream(ws: WebSocket, rawPin: string) {
  const pin = rawPin.toUpperCase();
  vncUpstream.set(pin, ws);
  console.log(`[vnc-upstream] connected for PIN ${pin}`);

  ws.on('message', (data) => {
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) client.send(data);
  });
  ws.on('close', () => {
    vncUpstream.delete(pin);
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) client.close();
  });
}

export function handleVncClient(ws: WebSocket, rawPin: string) {
  const pin = rawPin.toUpperCase();
  vncClients.set(pin, ws);
  console.log(`[vnc-client] connected for PIN ${pin}`);

  ws.on('message', (data) => {
    const up = vncUpstream.get(pin);
    if (up?.readyState === WebSocket.OPEN) up.send(data);
  });
  ws.on('close', () => { if (vncClients.get(pin) === ws) vncClients.delete(pin); });
}

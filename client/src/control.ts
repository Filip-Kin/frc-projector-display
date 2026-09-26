// Local control channel. The controller page normally talks to the daemon
// through the public server (browser -> server /ws/control -> device WS).
// On a network with no internet (AV VLANs, a laptop on a direct cable) that
// path does not exist, so the daemon serves the same page itself and accepts
// the same controller protocol on its own /ws/control. Commands from either
// side run through one handler, and every device -> controller message goes
// out to both.

import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import { WebSocket, WebSocketServer } from 'ws';
import { state } from './state.js';

const localControllers = new Set<WebSocket>();

type CommandHandler = (msg: any) => Promise<void>;
type SnapshotFn = () => object;

let onCommand: CommandHandler = async () => {};
let snapshot: SnapshotFn = () => ({});
let pin = '';

export function initLocalControl(p: string, handler: CommandHandler, snap: SnapshotFn) {
  pin = p.toUpperCase();
  onCommand = handler;
  snapshot = snap;
}

// Device -> controller message. Goes to the server (which relays it to the
// remote controller, if one is open) and to every local controller.
export function emit(msg: object) {
  const s = JSON.stringify(msg);
  if (state.serverWs?.readyState === WebSocket.OPEN) state.serverWs.send(s);
  for (const ws of localControllers) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

export function hasLocalControllers(): boolean {
  return localControllers.size > 0;
}

export function attachLocalControl(servers: (HttpServer | HttpsServer | null)[]) {
  const wss = new WebSocketServer({ noServer: true });

  for (const server of servers) {
    server?.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/ws/control') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        const given = (url.searchParams.get('pin') ?? '').toUpperCase();
        if (given !== pin) {
          // Same shape the public server uses for an unknown PIN, so the
          // page shows "waiting" instead of reconnecting in a tight loop.
          ws.send(JSON.stringify({ type: 'error', message: 'Wrong PIN' }));
          ws.send(JSON.stringify({ type: 'device_disconnected' }));
          return;
        }
        localControllers.add(ws);
        console.log(`[local-control] controller connected (${localControllers.size} open)`);
        ws.send(JSON.stringify({ type: 'device_connected', kind: 'daemon', local: true, ...snapshot() }));

        ws.on('message', data => {
          let msg: any;
          try { msg = JSON.parse(data.toString()); } catch { return; }
          onCommand(msg).catch(err => console.error(`[local-control] ${msg?.type}: ${err?.message ?? err}`));
        });
        ws.on('close', () => {
          localControllers.delete(ws);
          console.log(`[local-control] controller closed (${localControllers.size} open)`);
        });
      });
    });
  }
}

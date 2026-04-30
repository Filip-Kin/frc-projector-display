import type { WebSocket } from 'ws';
import type { ChildProcess } from 'child_process';
import type { Socket } from 'net';

// Shared mutable state — all modules import and mutate this directly
export const state = {
  serverWs:          null as WebSocket | null,
  currentMode:       'home',
  apMode:            false,
  apIface:           null as string | null,
  ndiProcess:        null as ChildProcess | null,
  x11vncProcess:     null as ChildProcess | null,
  vncBridgeSocket:   null as Socket | null,
  vncBridgeWs:       null as WebSocket | null,
  networkCheckTimer: null as ReturnType<typeof setTimeout> | null,
  postConnectInProgress: false,
  wsEverConnected:   false,
  reconnectDelay:    2000,
};

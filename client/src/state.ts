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
  // Set while applyCredentials is in flight so the daemon's WS-disconnect
  // timer and other paths don't race into enterApMode and tear down the
  // wifi connection we just established.
  applyingCredentials: false,
  wsEverConnected:   false,
  reconnectDelay:    2000,
  // True once we detect the Android-disassoc-during-captive-portal pattern.
  // Causes the AP page to surface the BLE/USB alternatives below the QR.
  apEscalateImprov:  false,
  // Set when an out-of-band provisioning attempt (USB or BLE) is in flight, so
  // the projector screen shows feedback instead of looking frozen.
  provisioningStatus: null as null | { source: 'usb' | 'improv'; ssid: string; phase: 'connecting' | 'failed'; message?: string },
  // Wired up by daemon.ts at startup. Force-tears down the existing serverWs
  // (which can be stuck in CLOSING state and never fire its close event when
  // the underlying TCP path is dead) and starts a fresh connection.
  forceWsReconnect: null as (() => void) | null,
};

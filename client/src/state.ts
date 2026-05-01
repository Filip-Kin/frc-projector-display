import type { WebSocket } from 'ws';
import type { ChildProcess } from 'child_process';
import type { Socket } from 'net';

export interface OutputState {
  id: string;            // xrandr name, e.g. 'HDMI-1'
  width: number;
  height: number;
  yOffset: number;       // position in vertical-stacked framebuffer
  displayIndex: number;  // SDL_VIDEO_FULLSCREEN_DISPLAY index
  cdpPort: number;       // chromium remote-debugging port
  mode: string;          // 'home' | 'chromium' | 'ndi'
  ndiProcess: ChildProcess | null;
  chromiumProcess: ChildProcess | null;
}

export const state = {
  serverWs:          null as WebSocket | null,
  apMode:            false,
  apIface:           null as string | null,
  outputs:           [] as OutputState[],
  x11vncProcess:     null as ChildProcess | null,
  vncBridgeSocket:   null as Socket | null,
  vncBridgeWs:       null as WebSocket | null,
  networkCheckTimer: null as ReturnType<typeof setTimeout> | null,
  postConnectInProgress: false,
  applyingCredentials: false,
  wsEverConnected:   false,
  reconnectDelay:    2000,
  apEscalateImprov:  false,
  provisioningStatus: null as null | { source: 'usb' | 'improv'; ssid: string; phase: 'connecting' | 'failed'; message?: string },
  forceWsReconnect: null as (() => void) | null,
};

export function isAnyNdiActive(): boolean {
  return state.outputs.some(o => o.mode === 'ndi' && o.ndiProcess !== null);
}

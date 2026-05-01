import type { WebSocket } from 'ws';

export interface OutputInfo {
  id: string;
  width: number;
  height: number;
}

export interface Metrics {
  cpu: number;
  mem: { usedMB: number; totalMB: number };
  net: { iface: string; rxKBps: number; txKBps: number };
}

export interface DeviceState {
  ws: WebSocket;
  ndiSources: NdiSource[];
  audioSinks: AudioSink[];
  audioState: AudioState;
  outputs: OutputInfo[];
  metrics?: Metrics;
  // 'daemon' = full thin-client; 'lite' = browser-only kiosk with no NDI/audio/VNC.
  // Defaults to 'daemon' when missing for backward compatibility.
  kind?: 'daemon' | 'lite';
  lastSeen: number;
  version?: string;
  hasInternet?: boolean;
}

export type NdiSource = string | { label: string; value: string };

export interface AudioSink {
  name: string;
  description: string;
}

export interface AudioState {
  sink: string;
  volume: number;
  muted: boolean;
}

export interface WsMessage {
  type: string;
  pin?: string;
  mode?: string;
  url?: string;
  output?: string;
  outputs?: OutputInfo[];
  kind?: 'daemon' | 'lite';
  source?: string;
  sources?: NdiSource[];
  sinks?: AudioSink[];
  state?: AudioState;
  sink?: string;
  volume?: number;
  muted?: boolean;
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  ts?: number;
  version?: string;
  hasInternet?: boolean;
  ndiSources?: NdiSource[];
  audioSinks?: AudioSink[];
  audioState?: AudioState;
  metrics?: Metrics;
  message?: string;
}

import type { WebSocket } from 'ws';

export interface DeviceState {
  ws: WebSocket;
  ndiSources: NdiSource[];
  audioSinks: AudioSink[];
  audioState: AudioState;
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
  message?: string;
}

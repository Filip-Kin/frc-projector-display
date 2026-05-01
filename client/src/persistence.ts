import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

// Persisted state survives daemon restarts so a setup-day reboot doesn't
// lose the operator's per-output configuration. PIN expires after 4 days
// so the box gets a fresh code for the next event next week.
const STATE_DIR  = join(homedir(), '.frc-display');
const STATE_FILE = join(STATE_DIR, 'state.json');
const PIN_TTL_MS = 4 * 24 * 60 * 60 * 1000;

export interface OutputModeRecord {
  // Tagged unions for each mode the daemon knows how to re-apply on startup
  mode: 'home' | 'chromium' | 'ndi' | 'queuing';
  url?: string;
  source?: string;
  bandwidth?: 'high' | 'low';
  eventKey?: string;
  streamType?: 'youtube' | 'ndi';
  streamSource?: string;
  streamSize?: number;
  sidebar?: string;
  bottom?: string;
}

export interface PersistedState {
  pin: string;
  pinCreatedAt: number;
  outputs: { [outputId: string]: OutputModeRecord };
  audio: { sink?: string; volume?: number; muted?: boolean };
}

let cached: PersistedState | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function loadState(): PersistedState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState;
    if (!raw.pin || !raw.pinCreatedAt) return null;
    if (Date.now() - raw.pinCreatedAt > PIN_TTL_MS) {
      console.log('[state] cached PIN expired (>4d) — generating fresh');
      return null;
    }
    cached = {
      pin: raw.pin,
      pinCreatedAt: raw.pinCreatedAt,
      outputs: raw.outputs ?? {},
      audio:   raw.audio   ?? {},
    };
    return cached;
  } catch (err: any) {
    console.error(`[state] load failed: ${err.message} — starting fresh`);
    return null;
  }
}

export function initState(pin: string): PersistedState {
  cached = { pin, pinCreatedAt: Date.now(), outputs: {}, audio: {} };
  flushNow();
  return cached;
}

export function setStateFromLoaded(s: PersistedState) { cached = s; }

function flushNow() {
  if (!cached) return;
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
  } catch (err: any) {
    console.error(`[state] save failed: ${err.message}`);
  }
}

function scheduleSave() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { writeTimer = null; flushNow(); }, 500);
}

export function recordOutputMode(outputId: string, rec: OutputModeRecord) {
  if (!cached) return;
  cached.outputs[outputId] = rec;
  scheduleSave();
}

export function recordAudio(patch: Partial<PersistedState['audio']>) {
  if (!cached) return;
  cached.audio = { ...cached.audio, ...patch };
  scheduleSave();
}

export function getPersistedOutputs(): PersistedState['outputs'] {
  return cached?.outputs ?? {};
}

export function getPersistedAudio(): PersistedState['audio'] {
  return cached?.audio ?? {};
}

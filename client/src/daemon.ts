import { WebSocket } from 'ws';
import { execFile } from 'child_process';
import { state, isAnyNdiActive } from './state.js';
import { cdpNavigate, cdpNavigateAll } from './cdp.js';
import {
  setHomeOnOutput, setChromiumOnOutput, setNdiOnOutput, setQueuingOnOutput,
  setHomeAll, setVnc, setPin,
} from './modes.js';
import { initOutputs, setOnOutputsChanged } from './outputs.js';
import { getAudioSinks, getAudioState, setAudioOutput } from './audio.js';
import { getNdiSources } from './ndi.js';
import { localServer, httpsServer, LOCAL_PORT, enterApMode, initServer, stopProvisioningExtras } from './local-server.js';
import { getEthernetInterface, getEthernetStatus, applyFieldStaticIp } from './network.js';
import { startNetworkMonitor } from './network-monitor.js';
import { sampleMetrics } from './metrics.js';
import {
  loadState, initState, recordOutputMode, recordAudio,
  getPersistedOutputs, getPersistedAudio,
} from './persistence.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const VERSION      = (await import('../package.json')).version;
const SERVER_BASE  = process.env.SERVER_URL ?? 'https://display.filipkin.com';
const SERVER_URL   = SERVER_BASE.replace(/^https?:\/\//, m => m === 'https://' ? 'wss://' : 'ws://');
const INSTALL_DIR  = process.env.INSTALL_DIR ?? '/opt/frc-projector-display/client';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePin() {
  return Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
}
const persisted = loadState();
const PIN = persisted?.pin ?? generatePin();
if (!persisted) initState(PIN);
const AP_SSID    = `FRC-Display-${PIN}`;
const CONTROL_URL = `${SERVER_BASE}/control?pin=${PIN}`;

setPin(PIN);
initServer(PIN, AP_SSID, CONTROL_URL, VERSION, SERVER_BASE);

console.log(`[daemon] v${VERSION} PIN: ${PIN}${persisted ? ' (restored)' : ''}`);
console.log(`[daemon] Control URL: ${CONTROL_URL}`);

// ── Logging helper ────────────────────────────────────────────────────────────
export function log(level: 'info' | 'warn' | 'error', msg: string) {
  const tag = level.toUpperCase().padEnd(5);
  process.stdout.write(`[${tag}] ${new Date().toISOString()} ${msg}\n`);
  if (state.serverWs?.readyState === WebSocket.OPEN) {
    state.serverWs.send(JSON.stringify({ type: 'log', level, msg, ts: Date.now() }));
  }
}

// ── Audio polling ─────────────────────────────────────────────────────────────
let audioReplayed = false;
function pollAudioSinks(attempt = 0) {
  const delay = attempt === 0 ? 5000 : 15000;
  setTimeout(async () => {
    try {
      const sinks = await getAudioSinks();
      if (sinks.length === 0) { pollAudioSinks(attempt + 1); return; }
      let astState = await getAudioState();
      log('info', `[audio] found ${sinks.length} sink(s)`);

      if (!audioReplayed) {
        audioReplayed = true;
        const a = getPersistedAudio();
        if (a.sink && sinks.find(s => s.name === a.sink)) {
          log('info', `[state] replaying audio sink ${a.sink}`);
          await setAudioOutput(a.sink).catch(() => {});
        }
        if (typeof a.volume === 'number') {
          execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${a.volume}%`], { env: process.env }, () => {});
        }
        if (typeof a.muted === 'boolean') {
          execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', a.muted ? '1' : '0'], { env: process.env }, () => {});
        }
        astState = await getAudioState();
      }

      if (state.serverWs?.readyState === WebSocket.OPEN)
        state.serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state: astState }));
    } catch { pollAudioSinks(attempt + 1); }
  }, delay);
}

// ── Server WebSocket ──────────────────────────────────────────────────────────
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let ndiPollInterval:   ReturnType<typeof setInterval> | null = null;
let metricsInterval:   ReturnType<typeof setInterval> | null = null;
let hasReplayedOnce = false;

// Re-applies whatever per-output mode was active when the daemon last saved.
// Runs once per process on the first successful WS open (so the network is
// known-good before we navigate kiosks to remote URLs and spawn NDI).
async function replayPersistedOutputs() {
  const recs = getPersistedOutputs();
  if (!Object.keys(recs).length) return;
  log('info', `[state] replaying ${Object.keys(recs).length} output mode(s) from disk`);
  for (const o of state.outputs) {
    const r = recs[o.id]; if (!r) continue;
    try {
      if (r.mode === 'home')                                       await setHomeOnOutput(o.id);
      else if (r.mode === 'chromium' && r.url)                     await setChromiumOnOutput(o.id, r.url);
      else if (r.mode === 'ndi' && r.source)                       setNdiOnOutput(o.id, r.source, r.bandwidth ?? 'high');
      else if (r.mode === 'queuing' && r.eventKey)                 await setQueuingOnOutput(
        o.id, r.eventKey,
        r.streamType === 'ndi' ? 'ndi' : 'youtube',
        r.streamSource ?? '', r.streamSize ?? 70,
        r.sidebar ?? 'matches', r.bottom ?? 'updates',
      );
    } catch (err: any) {
      log('error', `[state] replay failed for ${o.id}: ${err.message}`);
    }
  }
}

state.forceWsReconnect = () => {
  log('info', '[ws] force reconnect requested');
  if (state.serverWs) {
    try { state.serverWs.removeAllListeners(); } catch {}
    try { state.serverWs.terminate(); } catch {}
    state.serverWs = null;
  }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (ndiPollInterval)   { clearInterval(ndiPollInterval);   ndiPollInterval   = null; }
  if (metricsInterval)   { clearInterval(metricsInterval);   metricsInterval   = null; }
  state.reconnectDelay = 1000;
  connectToServer();
};

function outputsForRegister() {
  return state.outputs.map(o => ({ id: o.id, width: o.width, height: o.height }));
}

function connectToServer() {
  const wsUrl = `${SERVER_URL}/ws/device`;
  log('info', `[ws] connecting to ${wsUrl}`);
  state.serverWs = new WebSocket(wsUrl);

  state.serverWs.on('open', async () => {
    state.wsEverConnected = true;
    if (apCheckTimer) { clearTimeout(apCheckTimer); apCheckTimer = null; }
    clearTimeout(state.networkCheckTimer!);
    state.networkCheckTimer = null;
    log('info', '[ws] connected to server');
    state.reconnectDelay = 2000;

    const wasApMode = state.apMode;
    if (wasApMode && !state.postConnectInProgress) {
      const { stopAp } = await import('./wifi.js');
      if (state.apIface) await stopAp(state.apIface).catch(() => {});
      state.apMode = false; state.apIface = null;
      await stopProvisioningExtras();
    }
    if (!hasReplayedOnce) {
      hasReplayedOnce = true;
      // Outputs with a saved mode get replayed; everything else navigates to
      // the home QR (covers fresh installs, freshly-added outputs, and any
      // output that's never had a set_mode applied to it).
      const recs = getPersistedOutputs();
      await Promise.all(state.outputs.map(o =>
        recs[o.id]
          ? Promise.resolve()
          : cdpNavigate(`http://localhost:${LOCAL_PORT}/`, o.cdpPort).catch(() => {})
      ));
      await replayPersistedOutputs();
    } else if (wasApMode) {
      // Coming back from AP mode — every kiosk was showing the AP page;
      // navigate them all to home (replayed outputs will get re-replayed via
      // their state, but that's a follow-up; for now this is the simple recovery).
      await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }

    state.serverWs!.send(JSON.stringify({ type: 'register', pin: PIN, outputs: outputsForRegister() }));

    let pongReceived = true;
    let pingTick = 0;
    state.serverWs!.on('pong', () => { pongReceived = true; });
    heartbeatInterval = setInterval(() => {
      const ws = state.serverWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!pongReceived) {
        log('warn', '[ws] no pong — force reconnecting');
        state.forceWsReconnect?.();
        return;
      }
      pongReceived = false;
      ws.ping();
      if (++pingTick % 6 === 0) ws.send(JSON.stringify({ type: 'heartbeat', version: VERSION }));
    }, 5000);

    const sendNdi = async () => {
      const sources = await getNdiSources();
      if (state.serverWs?.readyState === WebSocket.OPEN)
        state.serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
    };
    sendNdi();
    ndiPollInterval = setInterval(sendNdi, 20000);

    pollAudioSinks();

    // System metrics every 5s — server forwards to controller if one is open,
    // drops otherwise. Tiny payload, no special gating needed.
    const sendMetrics = async () => {
      try {
        const metrics = await sampleMetrics();
        if (state.serverWs?.readyState === WebSocket.OPEN)
          state.serverWs.send(JSON.stringify({ type: 'metrics', metrics }));
      } catch {}
    };
    sendMetrics();
    metricsInterval = setInterval(sendMetrics, 5000);
  });

  state.serverWs.on('message', async (data) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    log('info', `[ws] command: ${msg.type}${msg.output ? ` output=${msg.output}` : ''}`);

    switch (msg.type) {
      case 'set_mode': {
        // Without an explicit output, fall through to first output (controllers
        // that don't yet know about multi-output keep working).
        const outputId: string = msg.output ?? state.outputs[0]?.id;
        if (!outputId) { log('warn', '[ws] set_mode but no outputs available'); break; }

        if (msg.mode === 'home') {
          await setHomeOnOutput(outputId);
          recordOutputMode(outputId, { mode: 'home' });
        } else if (msg.mode === 'chromium' && msg.url) {
          await setChromiumOnOutput(outputId, msg.url);
          recordOutputMode(outputId, { mode: 'chromium', url: msg.url });
        } else if (msg.mode === 'ndi' && msg.source) {
          if ((msg.source as string).startsWith('omt://')) {
            if (state.serverWs?.readyState === WebSocket.OPEN)
              state.serverWs.send(JSON.stringify({ type: 'error', message: 'OMT playback is not yet supported on Linux. NDI from the same source works fine.' }));
          } else {
            setNdiOnOutput(outputId, msg.source, msg.bandwidth ?? 'high');
            recordOutputMode(outputId, { mode: 'ndi', source: msg.source, bandwidth: msg.bandwidth ?? 'high' });
          }
        } else if (msg.mode === 'queuing' && msg.eventKey) {
          const streamType = msg.streamType === 'ndi' ? 'ndi' : 'youtube';
          const streamSize = msg.streamSize === 60 ? 60 : 70;
          const sidebar    = msg.sidebar ?? 'matches';
          const bottom     = msg.bottom  ?? 'updates';
          await setQueuingOnOutput(
            outputId, msg.eventKey, streamType,
            msg.streamSource ?? '', streamSize, sidebar, bottom,
          );
          recordOutputMode(outputId, {
            mode: 'queuing', eventKey: msg.eventKey,
            streamType, streamSource: msg.streamSource ?? '',
            streamSize, sidebar, bottom,
          });
        }
        break;
      }
      case 'refresh_ndi': {
        const sources = await getNdiSources();
        if (state.serverWs?.readyState === WebSocket.OPEN)
          state.serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
        break;
      }
      case 'start_vnc_bridge':
        setVnc(state.serverWs!);
        break;
      // No vnc_upstream_closed handler: bridge tearing down is terminal.
      // A new viewer triggers a fresh start_vnc_bridge.
      case 'set_audio_output':
        if (msg.sink) {
          recordAudio({ sink: msg.sink });
          setAudioOutput(msg.sink).then(async () => {
            const sinks = await getAudioSinks();
            const astState = await getAudioState();
            if (state.serverWs?.readyState === WebSocket.OPEN)
              state.serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state: astState }));
          }).catch(() => {});
        }
        break;
      case 'set_volume': {
        const vol = Math.max(0, Math.min(100, parseInt(msg.volume) || 0));
        recordAudio({ volume: vol });
        execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${vol}%`], { env: process.env }, () => {});
        break;
      }
      case 'set_mute':
        recordAudio({ muted: !!msg.muted });
        execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', msg.muted ? '1' : '0'], { env: process.env }, () => {});
        break;
    }
  });

  state.serverWs.on('close', () => {
    log('warn', `[ws] disconnected — reconnecting in ${state.reconnectDelay}ms`);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (ndiPollInterval)   { clearInterval(ndiPollInterval);   ndiPollInterval   = null; }
    if (metricsInterval)   { clearInterval(metricsInterval);   metricsInterval   = null; }
    setTimeout(connectToServer, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 30000);

    if (state.wsEverConnected && !state.networkCheckTimer) {
      const ndiActive = isAnyNdiActive();
      if (!ndiActive && !state.apMode) {
        cdpNavigateAll(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
      }

      state.networkCheckTimer = setTimeout(async () => {
        state.networkCheckTimer = null;
        if (state.apMode || state.serverWs?.readyState === WebSocket.OPEN) return;
        if (isAnyNdiActive()) {
          log('info', '[ws] connection lost but NDI stream active; not entering AP mode');
          return;
        }
        if (state.applyingCredentials) {
          log('info', '[ws] connection lost but applyCredentials running; deferring AP mode');
          return;
        }
        await enterApMode();
      }, 5000);
    }
  });

  state.serverWs.on('error', (err: Error) => log('error', `[ws] ${err.message}`));
}


let apCheckTimer: ReturnType<typeof setTimeout> | null = null;

async function runNetworkStartup() {
  await new Promise(r => setTimeout(r, 15000));
  if (state.wsEverConnected) return;

  const ethIface = await getEthernetInterface();
  if (ethIface) {
    const status = await getEthernetStatus(ethIface);
    if (status.isLinkLocal) {
      log('warn', `[net] DHCP failed on ${ethIface} (got ${status.ip}) — trying field static IP`);
      try {
        const ip = await applyFieldStaticIp(ethIface);
        log('info', `[net] static IP applied: ${ip}`);
        await new Promise(r => setTimeout(r, 3000));
      } catch (err: any) {
        log('error', `[net] static IP failed: ${err.message}`);
      }
    } else if (status.hasRoutableIp) {
      log('info', `[net] ethernet has IP: ${status.ip} — checking internet`);
    }
  }

  if (!state.wsEverConnected && state.serverWs?.readyState !== WebSocket.OPEN) {
    log('warn', '[net] server unreachable after startup — entering AP mode');
    await enterApMode();
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
setOnOutputsChanged(() => {
  if (state.serverWs?.readyState === WebSocket.OPEN) {
    state.serverWs.send(JSON.stringify({ type: 'outputs_changed', outputs: outputsForRegister() }));
  }
});
await initOutputs();
log('info', `[outputs] initialised ${state.outputs.length} output(s): ${state.outputs.map(o => o.id).join(', ')}`);

localServer.listen(LOCAL_PORT, '0.0.0.0', () => {
  log('info', `[daemon] local HTTP server on port ${LOCAL_PORT}`);
  setTimeout(() => {
    if (!state.wsEverConnected) cdpNavigateAll(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
  }, 3000);
});

if (httpsServer) {
  httpsServer.listen(4443, '0.0.0.0', () => log('info', '[daemon] local HTTPS server on port 4443'));
  httpsServer.on('error', (err: Error) => log('error', `[daemon] HTTPS server: ${err.message}`));
} else {
  log('warn', '[daemon] no TLS cert at /etc/frc-display/cert.pem — HTTPS probes will fail');
}

connectToServer();
runNetworkStartup();

import('./wifi.js').then(m => m.ensureSavedWifiConnected().catch(() => {}));

// ── Real-time route monitoring ────────────────────────────────────────────────
let routeMissingSince: number | null = null;
let routeOfflineTimer: ReturnType<typeof setTimeout> | null = null;

startNetworkMonitor(async (hasRoute, reason) => {
  log('info', `[net] route change -> ${hasRoute ? 'UP' : 'DOWN'} (${reason})`);

  if (hasRoute) {
    routeMissingSince = null;
    if (routeOfflineTimer) { clearTimeout(routeOfflineTimer); routeOfflineTimer = null; }
    if (state.apMode && !state.postConnectInProgress) {
      const route = reason.match(/route via (\S+)/)?.[1];
      if (route && route !== state.apIface) {
        log('info', `[net] route restored via ${route} -> exiting AP mode`);
        const { stopAp } = await import('./wifi.js');
        if (state.apIface) await stopAp(state.apIface).catch(() => {});
        state.apMode = false; state.apIface = null;
        await stopProvisioningExtras();
        cdpNavigateAll(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
      }
    }
    return;
  }

  if (state.apMode) {
    log('info', '[net] route down but already in AP mode — ignoring');
    return;
  }
  if (isAnyNdiActive()) {
    log('info', '[net] route down but NDI streaming — keeping current mode');
    return;
  }

  if (routeMissingSince === null) {
    routeMissingSince = Date.now();
    log('warn', '[net] route DOWN — showing connecting screen, trying saved wifi');
    cdpNavigateAll(`http://localhost:${LOCAL_PORT}/connecting`).catch(err =>
      log('error', `[net] connecting nav failed: ${err.message}`));

    import('./wifi.js').then(m => m.ensureSavedWifiConnected().catch(() => {}));

    routeOfflineTimer = setTimeout(() => {
      routeOfflineTimer = null;
      routeMissingSince = null;
      log('warn', '[net] route still DOWN after 12s — entering AP mode');
      try { state.serverWs?.terminate(); } catch {}
      enterApMode().catch(err => log('error', `[net] enterApMode failed: ${err.message}`));
    }, 12000);
  }
});

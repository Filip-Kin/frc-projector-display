import { WebSocket } from 'ws';
import { execFile } from 'child_process';
import { state } from './state.js';
import { cdpNavigate } from './cdp.js';
import { setHome, setChromium, setNdi, setVnc, startX11vncDaemon, setPin } from './modes.js';
import { getAudioSinks, getAudioState, setAudioOutput } from './audio.js';
import { getNdiSources } from './ndi.js';
import { localServer, httpsServer, LOCAL_PORT, enterApMode, initServer, stopProvisioningExtras } from './local-server.js';
import { getEthernetInterface, getEthernetStatus, applyFieldStaticIp } from './network.js';
import { startNetworkMonitor } from './network-monitor.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const VERSION      = (await import('../package.json')).version;
const SERVER_BASE  = process.env.SERVER_URL ?? 'https://display.filipkin.com';
const SERVER_URL   = SERVER_BASE.replace(/^https?:\/\//, m => m === 'https://' ? 'wss://' : 'ws://');
const INSTALL_DIR  = process.env.INSTALL_DIR ?? '/opt/frc-projector-display/client';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN   = Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const AP_SSID    = `FRC-Display-${PIN}`;
const CONTROL_URL = `${SERVER_BASE}/control?pin=${PIN}`;

setPin(PIN);
initServer(PIN, AP_SSID, CONTROL_URL, VERSION, SERVER_BASE);

console.log(`[daemon] v${VERSION} PIN: ${PIN}`);
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
// PipeWire starts after the daemon; retry every 15s until sinks are found.
function pollAudioSinks(attempt = 0) {
  const delay = attempt === 0 ? 5000 : 15000;
  setTimeout(async () => {
    try {
      const sinks = await getAudioSinks();
      if (sinks.length === 0) { pollAudioSinks(attempt + 1); return; }
      const astState = await getAudioState();
      log('info', `[audio] found ${sinks.length} sink(s)`);
      if (state.serverWs?.readyState === WebSocket.OPEN)
        state.serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state: astState }));
    } catch { pollAudioSinks(attempt + 1); }
  }, delay);
}

// ── Server WebSocket ──────────────────────────────────────────────────────────
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let ndiPollInterval:   ReturnType<typeof setInterval> | null = null;

// Wire the force-reconnect hook so applyCredentials can drop a stuck WS
// (CLOSING state with no close event firing) and start fresh.
state.forceWsReconnect = () => {
  log('info', '[ws] force reconnect requested');
  if (state.serverWs) {
    try { state.serverWs.removeAllListeners(); } catch {}
    try { state.serverWs.terminate(); } catch {}
    state.serverWs = null;
  }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (ndiPollInterval)   { clearInterval(ndiPollInterval);   ndiPollInterval   = null; }
  state.reconnectDelay = 1000;
  connectToServer();
};

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

    if (state.apMode && !state.postConnectInProgress) {
      const { stopAp } = await import('./wifi.js');
      if (state.apIface) await stopAp(state.apIface).catch(() => {});
      state.apMode = false; state.apIface = null;
      await stopProvisioningExtras();
    }
    // Navigate to home QR page now that we have a connection
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});

    state.serverWs!.send(JSON.stringify({ type: 'register', pin: PIN }));

    // WS-level ping every 5s; if no pong within 4s, the connection is dead.
    // Detects ethernet drops in under 10s instead of waiting for the kernel's
    // multi-minute TCP timeout. Heartbeat with version sent every 30s.
    let pongReceived = true;
    let pingTick = 0;
    state.serverWs!.on('pong', () => { pongReceived = true; });
    heartbeatInterval = setInterval(() => {
      const ws = state.serverWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!pongReceived) {
        log('warn', '[ws] no pong — connection dead, terminating');
        ws.terminate();
        return;
      }
      pongReceived = false;
      ws.ping();
      // Send heartbeat every 6 ticks (30s) so admin panel "last seen" stays fresh
      if (++pingTick % 6 === 0) ws.send(JSON.stringify({ type: 'heartbeat', version: VERSION }));
    }, 5000);
    // Initial scan immediately on connect, then every 20s
    const sendNdi = async () => {
      const sources = await getNdiSources();
      if (state.serverWs?.readyState === WebSocket.OPEN)
        state.serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
    };
    sendNdi();
    ndiPollInterval = setInterval(sendNdi, 20000);

    // Poll for audio sinks — PipeWire starts after the daemon so retry until found
    pollAudioSinks();
  });

  state.serverWs.on('message', async (data) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    log('info', `[ws] command: ${msg.type}`);

    switch (msg.type) {
      case 'set_mode':
        state.currentMode = msg.mode;
        if (msg.mode === 'home')                         await setHome();
        else if (msg.mode === 'chromium' && msg.url)    await setChromium(msg.url);
        else if (msg.mode === 'ndi' && msg.source) {
          if ((msg.source as string).startsWith('omt://')) {
            // OMT playback not yet functional — notify controller
            if (state.serverWs?.readyState === WebSocket.OPEN)
              state.serverWs.send(JSON.stringify({ type: 'error', message: 'OMT playback is not yet supported on Linux. NDI from the same source works fine.' }));
          } else {
            setNdi(msg.source, msg.bandwidth ?? 'high');
          }
        }
        else if (msg.mode === 'vnc')                    setVnc(state.serverWs!);
        break;
      case 'refresh_ndi': {
        const sources = await getNdiSources();
        if (state.serverWs?.readyState === WebSocket.OPEN)
          state.serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
        break;
      }
      case 'start_vnc_bridge':
        setVnc(state.serverWs!);
        break;
      case 'vnc_upstream_closed':
        // Server closed the upstream — reconnect so next client gets a fresh handshake
        setTimeout(() => { if (state.serverWs?.readyState === WebSocket.OPEN) setVnc(state.serverWs!); }, 500);
        break;
      case 'set_audio_output':
        if (msg.sink) {
          setAudioOutput(msg.sink).then(async () => {
            // Re-send updated sinks after profile switch
            const sinks = await getAudioSinks();
            const astState = await getAudioState();
            if (state.serverWs?.readyState === WebSocket.OPEN)
              state.serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state: astState }));
          }).catch(() => {});
        }
        break;
      case 'set_volume': {
        const vol = Math.max(0, Math.min(100, parseInt(msg.volume) || 0));
        execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${vol}%`], { env: process.env }, () => {});
        break;
      }
      case 'set_mute':
        execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', msg.muted ? '1' : '0'], { env: process.env }, () => {});
        break;
    }
  });

  state.serverWs.on('close', () => {
    log('warn', `[ws] disconnected — reconnecting in ${state.reconnectDelay}ms`);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (ndiPollInterval)   { clearInterval(ndiPollInterval);   ndiPollInterval   = null; }
    setTimeout(connectToServer, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 30000);

    if (state.wsEverConnected && !state.networkCheckTimer) {
      // Show connecting screen immediately (unless NDI is playing — don't interrupt)
      const ndiActive = state.currentMode === 'ndi' && state.ndiProcess !== null;
      if (!ndiActive && !state.apMode) {
        cdpNavigate(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
      }

      // 5s grace period; gives reconnect a chance for transient blips
      // before tearing down to AP mode.
      state.networkCheckTimer = setTimeout(async () => {
        state.networkCheckTimer = null;
        if (state.apMode || state.serverWs?.readyState === WebSocket.OPEN) return;
        // NDI still running -> don't interrupt the stream
        const ndiStillActive = state.currentMode === 'ndi' && state.ndiProcess !== null;
        if (ndiStillActive) {
          log('info', '[ws] connection lost but NDI stream active; not entering AP mode');
          return;
        }
        // applyCredentials in flight -> don't interrupt; it'll either succeed
        // (WS will reconnect) or fail and restore AP itself
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


// Declared before connectToServer so the open handler can clear it
let apCheckTimer: ReturnType<typeof setTimeout> | null = null;

// ── Network startup sequence ──────────────────────────────────────────────────
// 1. NM handles DHCP automatically — wait 15s for it to settle
// 2. If ethernet is link-local (169.254.x.x) → DHCP failed → try random static IP
// 3. After 20s total, if still no default route → AP mode
// NM also auto-connects saved WiFi during this window.

async function runNetworkStartup() {
  // Wait for DHCP
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
        // Give the route a moment to settle
        await new Promise(r => setTimeout(r, 3000));
      } catch (err: any) {
        log('error', `[net] static IP failed: ${err.message}`);
      }
    } else if (status.hasRoutableIp) {
      log('info', `[net] ethernet has IP: ${status.ip} — checking internet`);
      // Don't return early — a routable IP doesn't mean internet is reachable
      // (e.g. field network with no WAN). Fall through to internet check.
    }
  }

  // WS not connected after network settle time → server unreachable → AP mode
  if (!state.wsEverConnected && state.serverWs?.readyState !== WebSocket.OPEN) {
    log('warn', '[net] server unreachable after startup — entering AP mode');
    await enterApMode();
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
startX11vncDaemon();

localServer.listen(LOCAL_PORT, '0.0.0.0', () => {
  log('info', `[daemon] local HTTP server on port ${LOCAL_PORT}`);
  // Show connecting screen if WS hasn't already connected within 3s
  setTimeout(() => {
    if (!state.wsEverConnected) cdpNavigate(`http://localhost:${LOCAL_PORT}/connecting`);
  }, 3000);
});

// HTTPS listener for AP-mode probes (iptables NATs port 443 → 4443).
// If cert isn't installed, httpsServer is null — log and continue.
if (httpsServer) {
  httpsServer.listen(4443, '0.0.0.0', () => log('info', '[daemon] local HTTPS server on port 4443'));
  httpsServer.on('error', (err: Error) => log('error', `[daemon] HTTPS server: ${err.message}`));
} else {
  log('warn', '[daemon] no TLS cert at /etc/frc-display/cert.pem — HTTPS probes will fail');
}

connectToServer();
runNetworkStartup();  // boot-time: 15s grace, then maybe AP

// Bring up any saved wifi profile so the box has a fallback if ethernet
// drops. NM's autoconnect can silently give up after past failures, so we
// poke it ourselves at startup.
import('./wifi.js').then(m => m.ensureSavedWifiConnected().catch(() => {}));

// ── Real-time route monitoring ────────────────────────────────────────────────
// Kernel netlink notifies us instantly when the default route changes.
// Combined with a 2s safety poll. This is the ground truth — no protocol guessing.
let routeMissingSince: number | null = null;
let routeOfflineTimer: ReturnType<typeof setTimeout> | null = null;

startNetworkMonitor(async (hasRoute, reason) => {
  log('info', `[net] route change -> ${hasRoute ? 'UP' : 'DOWN'} (${reason})`);

  if (hasRoute) {
    routeMissingSince = null;
    if (routeOfflineTimer) { clearTimeout(routeOfflineTimer); routeOfflineTimer = null; }
    // If we're in AP mode and a real route just came back (e.g. ethernet
    // reconnected), bail out of AP mode now. The WS-open auto-exit can't
    // fire here because the AP's dnsmasq is still hijacking DNS for our own
    // host -> WS to display.filipkin.com fails until we stop the AP.
    if (state.apMode && !state.postConnectInProgress) {
      const route = reason.match(/route via (\S+)/)?.[1];
      // Don't exit on routes through our own AP iface
      if (route && route !== state.apIface) {
        log('info', `[net] route restored via ${route} -> exiting AP mode`);
        const { stopAp } = await import('./wifi.js');
        if (state.apIface) await stopAp(state.apIface).catch(() => {});
        state.apMode = false; state.apIface = null;
        await stopProvisioningExtras();
        cdpNavigate(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
      }
    }
    return;
  }

  // Route gone
  if (state.apMode) {
    log('info', '[net] route down but already in AP mode — ignoring');
    return;
  }
  const ndiActive = state.currentMode === 'ndi' && state.ndiProcess !== null;
  if (ndiActive) {
    log('info', '[net] route down but NDI streaming — keeping current mode');
    return;
  }

  if (routeMissingSince === null) {
    routeMissingSince = Date.now();
    log('warn', '[net] route DOWN — showing connecting screen, trying saved wifi');
    cdpNavigate(`http://localhost:${LOCAL_PORT}/connecting`).catch(err =>
      log('error', `[net] connecting nav failed: ${err.message}`));

    // Before going to AP mode, try to bring up any saved wifi profile. NM's
    // autoconnect doesn't always fire reliably after past failures.
    import('./wifi.js').then(m => m.ensureSavedWifiConnected().catch(() => {}));

    // 12s grace lets a saved-wifi connect succeed before we tear down to AP.
    routeOfflineTimer = setTimeout(() => {
      routeOfflineTimer = null;
      routeMissingSince = null;
      log('warn', '[net] route still DOWN after 12s — entering AP mode');
      try { state.serverWs?.terminate(); } catch {}
      enterApMode().catch(err => log('error', `[net] enterApMode failed: ${err.message}`));
    }, 12000);
  }
});

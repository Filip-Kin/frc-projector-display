import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import QRCode from 'qrcode';
import path from 'path';
import { exec } from 'child_process';
import { WebSocket } from 'ws';
import { state, isAnyNdiActive } from './state.js';
import { cdpNavigateAll } from './cdp.js';
import { stopAp, startAp, connectWifi, scanWifi, checkInternet } from './wifi.js';
import { getEthernetInterface, getEthernetStatus, applyDhcp, applyCustomStaticIp } from './network.js';
import { stopNdiOnOutput, stopVnc } from './modes.js';
import { startImprov, stopImprov } from './improv.js';
import { startUsbWatcher, stopUsbWatcher } from './usb-provisioning.js';

export const LOCAL_PORT = parseInt(process.env.LOCAL_PORT ?? '3000', 10);
export const AP_IP = '192.168.4.1';

let PIN = '';
let AP_SSID = '';
let CONTROL_URL = '';
let VERSION = '';
let SERVER_BASE = '';

export function initServer(pin: string, apSsid: string, controlUrl: string, version: string, serverBase: string) {
  PIN = pin; AP_SSID = apSsid; CONTROL_URL = controlUrl; VERSION = version; SERVER_BASE = serverBase;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Ring buffer of recent HTTP requests for debugging captive portal behavior
interface ReqLog { ts: number; ip: string; method: string; host: string; path: string; ua: string; status: number; }
const reqLog: ReqLog[] = [];
const REQ_LOG_MAX = 200;

app.use((req, res, next) => {
  // Skip the debug-log polling itself — would drown out the actual events
  if (req.url === '/api/debug-log' || req.url === '/debug-log') return next();
  const entry: ReqLog = {
    ts: Date.now(),
    ip: (req.ip ?? req.socket.remoteAddress ?? '?').replace('::ffff:', ''),
    method: req.method,
    host: (req.get('host') ?? '').split(':')[0],
    path: req.url,
    ua: (req.get('user-agent') ?? '').slice(0, 80),
    status: 0,
  };
  reqLog.push(entry);
  if (reqLog.length > REQ_LOG_MAX) reqLog.shift();
  res.on('finish', () => { entry.status = res.statusCode; });
  next();
});

// Adaptive escalation: if a phone hits a captive-detection probe (we redirect
// it to /) but never actually GETs / within ~15s, it's the Android-disassoc
// signature. After 1 such ghost client we flip the AP page to lead with the
// BLE/USB alternatives.
interface GhostWatch { timer: ReturnType<typeof setTimeout>; }
const ghostClients = new Map<string, GhostWatch>();

function trackProbeRedirect(ip: string) {
  if (!state.apMode || state.apEscalateImprov) return;
  if (ghostClients.has(ip)) return;
  const timer = setTimeout(() => {
    if (!ghostClients.has(ip)) return;
    ghostClients.delete(ip);
    if (state.apEscalateImprov || !state.apMode) return;
    console.log(`[ap] ghost client ${ip} -> escalating AP page to BLE/USB`);
    state.apEscalateImprov = true;
    // Force a fresh GET so the projector picks up the new page layout
    cdpNavigateAll(`http://localhost:${LOCAL_PORT}/?_=${Date.now()}`).catch(() => {});
  }, 11000);
  ghostClients.set(ip, { timer });
}
function clearProbeWatch(ip: string) {
  const e = ghostClients.get(ip);
  if (e) { clearTimeout(e.timer); ghostClients.delete(ip); }
}
export function resetEscalation() {
  for (const e of ghostClients.values()) clearTimeout(e.timer);
  ghostClients.clear();
  state.apEscalateImprov = false;
}

// AP-mode captive portal: redirect any non-local request to our setup page.
// This triggers the "Sign in to network" notification on phones.
//
// Note: Android may push the user off the network if mobile data
// auto-switching is enabled. Disable that in phone Settings →
// Network & Internet → "Switch to mobile data automatically".
app.use((req, res, next) => {
  if (!state.apMode) return next();
  const host = (req.get('host') ?? '').split(':')[0];
  if (host === AP_IP || host === 'localhost' || host === '127.0.0.1') {
    return next();
  }
  const ip = (req.ip ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
  if (ip && ip !== '127.0.0.1') trackProbeRedirect(ip);
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, `http://${AP_IP}/`);
});

// RFC 8910 captive portal API — Android 11+ and iOS 14+ use this to manage
// the captive portal session properly without aggressive timeouts.
app.get('/captive-portal-api', (_req, res) => {
  res.setHeader('Cache-Control', 'private');
  res.json({
    captive: state.apMode,
    'user-portal-url': `http://${AP_IP}/`,
    'venue-info-url': `http://${AP_IP}/`,
    'can-extend-session': true,
  });
});

app.get('/', async (req, res) => {
  // Provisioning in flight (USB/BLE) -> show the status page regardless of
  // AP-mode flag. Without this guard we flicker through the home-QR page
  // mid-flight when applyCredentials sets apMode=false partway through.
  if (state.provisioningStatus) {
    return res.send(buildProvisioningStatusPage(state.provisioningStatus));
  }
  if (state.apMode) {
    // Phone connecting via AP → serve the setup form directly at /
    // (clean URL the captive portal browser was redirected to)
    const host = (req.get('host') ?? '').split(':')[0];
    if (host === AP_IP) {
      // Phone successfully reached the setup page — clear the ghost-client
      // watch so we don't escalate when the captive portal worked fine.
      const ip = (req.ip ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
      if (ip) clearProbeWatch(ip);
      return res.send(buildSetupPage(cachedNetworks));
    }
    // Local Chromium kiosk on projector → show the two-step setup screen
    return res.send(await buildApPageAsync());
  }
  // Not in AP mode — projector home QR
  const qr = await QRCode.toDataURL(CONTROL_URL, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
  res.send(buildQrPage(qr));
});

app.get('/youtube', async (req, res) => {
  // Accepts ?v=<videoId> | ?channel=<channelId> | ?event=<eventKey>.
  // event= resolves server-side to today's-or-latest webcast and rebuilds
  // the page hourly so a day rollover swaps streams. mute=1 is mandatory:
  // YouTube refuses unmuted autoplay regardless of Chromium's autoplay
  // policy on some configs (notably Bay Trail second output) and you get
  // a black frame instead of the stream.
  const v  = String(req.query.v ?? '').trim();
  const ch = String(req.query.channel ?? '').trim();
  const ev = String(req.query.event ?? '').trim();
  const apiBase = (process.env.SERVER_URL ?? 'https://display.filipkin.com').replace(/\/$/, '');

  function buildSrc(spec: { kind: 'video' | 'channel'; id: string }) {
    // mute=1 + enablejsapi=1: load muted so autoplay always works, then a
    // small JS block below uses the IFrame API to unmute once the player
    // says it's ready. ~1s of silence at start, then audio.
    // No start=99999: that's an out-of-bounds seek for VOD content, which
    // YouTube rejects with player error 153.
    const common = 'autoplay=1&mute=1&enablejsapi=1';
    if (spec.kind === 'channel') return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(spec.id)}&${common}`;
    return `https://www.youtube.com/embed/${encodeURIComponent(spec.id)}?${common}&rel=0`;
  }

  let src = '';
  if (ch) src = buildSrc({ kind: 'channel', id: ch });
  else if (v) src = buildSrc({ kind: 'video', id: v });
  else if (ev) {
    // Server-side resolve so the iframe loads with a real URL on first paint.
    // Avoids the empty-src then JS-sets-src dance that some chromium configs
    // render as a permanent black frame.
    try {
      const upstream = await new Promise<string>((resolve) => {
        const h = require('https');
        h.get(`${apiBase}/api/webcast-for/${encodeURIComponent(ev)}`, { timeout: 5000 },
          (r: any) => { let d = ''; r.on('data', (c: any) => d += c); r.on('end', () => resolve(d)); })
          .on('error', () => resolve(''))
          .on('timeout', () => resolve(''));
      });
      const w = upstream ? JSON.parse(upstream) : null;
      if (w?.id) src = buildSrc({ kind: w.kind === 'channel' ? 'channel' : 'video', id: w.id });
    } catch {}
  }
  if (!src) { res.status(404).send('no stream available'); return; }

  // The page reloads itself hourly so an event:KEY-resolved page picks up a
  // new day's webcast without intervention. Cheap (one HTTP request to the
  // local daemon) and reliable (full page nav, not iframe.src swap).
  const reloadJs = ev ? `setTimeout(() => location.reload(), 60 * 60 * 1000);` : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden}
iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}
</style></head><body>
<iframe id="yt" src="${src}" allow="autoplay;fullscreen" allowfullscreen></iframe>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
function onYouTubeIframeAPIReady() {
  const player = new YT.Player('yt', {
    events: {
      onReady: (e) => {
        // Unmute once the player has had a moment to start. The mute=1 in
        // the URL is what lets autoplay succeed; we flip it off as soon as
        // the player is ready so the operator gets audio. Also seekTo past
        // the playable end so live streams snap to live edge instead of
        // resuming wherever the previous session left off.
        setTimeout(() => {
          try {
            e.target.unMute();
            e.target.setVolume(100);
            e.target.seekTo(Number.MAX_SAFE_INTEGER, true);
          } catch {}
        }, 1200);
      }
    }
  });
}
${reloadJs}
</script>
</body></html>`);
});

app.get('/connecting', (_req, res) => res.send(buildConnectingPage()));
app.get('/no-connection', (_req, res) => res.send(buildNoConnectionPage()));
app.get('/identify', (_req, res) => res.send(buildIdentifyPage()));

// Phone-friendly request log viewer — open http://192.168.4.1:3000/debug-log
// to see every request hitting the daemon in real time
app.get('/debug-log', (_req, res) => res.send(buildDebugLogPage()));
app.get('/api/debug-log', (_req, res) => res.json(reqLog.slice(-100).reverse()));

// Live debug state — reachable from any device on the network for diagnosis
app.get('/api/debug', async (_req, res) => {
  const { exec: execAsync } = await import('child_process');
  const route = await new Promise<string>(r => execAsync('ip route show default', (_e, out) => r(out.trim())));
  const links = await new Promise<string>(r => execAsync('ip -br link', (_e, out) => r(out.trim())));
  res.json({
    version: VERSION,
    pin: PIN,
    apMode: state.apMode,
    apIface: state.apIface,
    outputs: state.outputs.map(o => ({ id: o.id, mode: o.mode, ndi: !!o.ndiProcess, w: o.width, h: o.height })),
    wsState: state.serverWs?.readyState,    // 0=connecting 1=open 2=closing 3=closed
    wsEverConnected: state.wsEverConnected,
    ndiActive: isAnyNdiActive(),
    defaultRoute: route || '(none)',
    links,
    timestamp: new Date().toISOString(),
  });
});

// Cached scan results from before the AP came up — running a live scan while
// the AP is broadcasting briefly drops the radio off-channel and disconnects
// connected phones (single-radio cards like rtl8723be). We do ONE scan in
// enterApMode() before starting the AP, then serve those results until the
// AP is torn down.
let cachedNetworks: { ssid: string; signal: number; secured: boolean }[] = [];
export function setCachedNetworks(networks: typeof cachedNetworks) { cachedNetworks = networks; }

// Manual rescan endpoint — triggers a fresh scan even while AP is up.
// Brief radio off-channel hop may disconnect clients momentarily, but with
// Android auto-switch disabled the phone will stay associated.
app.get('/api/wifi-scan', async (_req, res) => {
  cachedNetworks = await scanWifi().catch(() => cachedNetworks);
  res.json(cachedNetworks);
});

// Background rescan every 30s while in AP mode so the dropdown stays fresh
// (e.g. user moved location, networks just powered on)
setInterval(async () => {
  if (!state.apMode) return;
  try {
    const fresh = await scanWifi();
    if (fresh.length > 0) cachedNetworks = fresh;
  } catch {}
}, 30000);

app.get('/api/eth-status', async (_req, res) => {
  const iface = await getEthernetInterface();
  if (!iface) { res.json({ iface: null }); return; }
  const status = await getEthernetStatus(iface);
  res.json(status);
});

app.post('/api/eth-config', async (req, res) => {
  const { mode, ip, prefix, gateway } = req.body as { mode: string; ip?: string; prefix?: string; gateway?: string };
  const iface = await getEthernetInterface();
  if (!iface) { res.status(400).json({ error: 'No ethernet interface found' }); return; }
  try {
    if (mode === 'dhcp') {
      await applyDhcp(iface);
      res.json({ ok: true, message: 'DHCP enabled — reconnecting…' });
    } else {
      if (!ip) { res.status(400).json({ error: 'IP required for static mode' }); return; }
      await applyCustomStaticIp(iface, ip, prefix ?? '24', gateway ?? '');
      res.json({ ok: true, message: `Static IP ${ip} applied` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/internet-status', async (_req, res) => {
  const result = await checkInternet();
  if (result.online && !state.postConnectInProgress) {
    res.json({ online: true, status: 'proceeding' });
    runPostConnect();
  } else {
    res.json(result);
  }
});

app.get('/setup', async (_req, res) => {
  // In AP mode: serve from cache (scan was done before AP started)
  // Out of AP mode (manual nav): live scan
  const networks = state.apMode ? cachedNetworks : await scanWifi().catch(() => []);
  res.send(buildSetupPage(networks));
});

// Unified credential-apply pipeline used by all three provisioning paths
// (captive portal, Improv BLE, USB). Returns a tagged result the caller maps
// to its own response format. On failure, AP + BLE + USB watcher are restored
// so the user can try again.
type ApplyResult =
  | { kind: 'online' }
  | { kind: 'captive_portal'; portalUrl: string }
  | { kind: 'error'; message: string };

export async function applyCredentials(
  ssid: string, password: string, source: string,
  onMessage?: (msg: string) => void | Promise<void>,
): Promise<ApplyResult> {
  console.log(`[setup] applying credentials from ${source}: SSID="${ssid}"`);
  state.applyingCredentials = true;
  try {
    // connectWifi now goes through frc-handoff which does AP-down + wifi-up
    // + gateway-verify in a single shell script. No need to stopAp here.
    state.apMode = false;

    const restoreAp = async () => {
      if (!state.apIface) return;
      state.apMode = true;
      await startAp(PIN, state.apIface).catch(() => {});
      await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    };

    if (onMessage) await onMessage(`Connecting to "${ssid}"...`);
    try {
      await connectWifi(ssid, password);
    } catch {
      await restoreAp();
      return { kind: 'error', message: 'Could not connect; check SSID and password.' };
    }

    if (onMessage) await onMessage('Checking connection...');
    let result = { online: false, portalUrl: null as string | null };
    // 12 × 1s sleep + 4s curl timeout = up to 60s, but realistic case is
    // 5-15s (rtl8723be needs a few retries to settle after AP->client).
    // Failing fast on each curl is much better than 8s timeouts.
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      result = await checkInternet();
      if (result.online || result.portalUrl) break;
    }

    if (result.portalUrl) {
      await cdpNavigateAll(result.portalUrl).catch(() => {});
      return { kind: 'captive_portal', portalUrl: result.portalUrl };
    }
    if (!result.online) {
      await restoreAp();
      return { kind: 'error', message: 'Connected to WiFi but no internet; check the password or try again.' };
    }
    // Force-tear-down the existing WS and connect a fresh one. terminate()
    // alone isn't enough -- when the underlying TCP socket is dead (route
    // gone, peer unreachable), the WS can be stuck in CLOSING state with
    // its close event never firing, so the existing reconnect loop never
    // schedules. forceWsReconnect removes listeners, calls terminate, and
    // calls connectToServer directly to start a fresh connection.
    state.forceWsReconnect?.();
    // Don't await; runPostConnect can take ~minutes (update + restart).
    runPostConnect();
    return { kind: 'online' };
  } finally {
    state.applyingCredentials = false;
  }
}

app.post('/setup', async (req, res) => {
  const { ssid, password } = req.body as { ssid?: string; password?: string };
  if (!ssid) { res.status(400).json({ error: 'SSID required' }); return; }
  const r = await applyCredentials(ssid, password ?? '', 'captive');
  // On any success-ish outcome, tear down BLE + USB watcher (still running)
  if (r.kind === 'online' || r.kind === 'captive_portal') await stopProvisioningExtras();
  if (r.kind === 'online')         res.json({ status: 'online' });
  else if (r.kind === 'captive_portal') res.json({ status: 'captive_portal', portalUrl: r.portalUrl, pin: PIN });
  else                              res.json({ status: 'error', message: r.message });
});

export async function runPostConnect() {
  if (state.postConnectInProgress) return;
  state.postConnectInProgress = true;
  console.log('[wifi] connected — checking for updates');

  let updated = false;
  try {
    const checkScript = path.join(import.meta.dir, '../check-update.sh');
    const stdout: string = await new Promise(r => {
      exec(`/bin/bash "${checkScript}"`, { timeout: 120000, env: process.env }, (_, out) => r(out ?? ''));
    });
    console.log('[update]', stdout.trim());
    updated = stdout.includes('[update] done');
  } catch (e: any) { console.error('[update]', e.message); }

  if (updated) {
    console.log('[update] restarting display session');
    exec('sudo systemctl restart lightdm', () => {});
  } else {
    // Don't go straight to home QR; that would lie to operators when the
    // device-to-server WS hasn't actually reconnected yet. Show the connecting
    // spinner and let the WS-open handler in daemon.ts navigate to / when the
    // server hand-shake completes.
    await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/connecting`).catch(() => {});
    state.postConnectInProgress = false;
  }
}

export async function enterApMode() {
  console.log('[ap] === enterApMode called ===');
  console.log(`[ap] outputs=${state.outputs.map(o => `${o.id}:${o.mode}`).join(',')} ndiActive=${isAnyNdiActive()} apMode=${state.apMode} applyingCredentials=${state.applyingCredentials}`);
  // applyCredentials is mid-flight; bringing the AP back up would steal the
  // wifi adapter from the connection it just established and brick the test.
  if (state.applyingCredentials) {
    console.log('[ap] skipping; applyCredentials is in flight');
    return;
  }

  // Stop any active media — ndi-play covers Chromium fullscreen so clear it first
  for (const o of state.outputs) await stopNdiOnOutput(o);
  stopVnc();
  console.log('[ap] media stopped');

  const { getWifiInterface } = await import('./wifi.js');
  const iface = await getWifiInterface();
  console.log(`[ap] wifi interface: ${iface ?? '(none)'}`);

  if (!iface) {
    console.log('[ap] NO WIFI ADAPTER — showing no-connection screen');
    await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/no-connection`).catch(() => {});
    return;
  }

  // Pre-scan WiFi networks BEFORE bringing up the AP — once the AP is broadcasting,
  // any scan would briefly off-channel the radio and disconnect connected phones.
  console.log('[ap] pre-scanning WiFi networks…');
  try {
    cachedNetworks = await scanWifi();
    console.log(`[ap] cached ${cachedNetworks.length} networks for setup page`);
  } catch (err: any) {
    console.error(`[ap] pre-scan failed: ${err.message}`);
    cachedNetworks = [];
  }

  console.log(`[ap] starting hotspot ${AP_SSID} on ${iface}`);
  try {
    await startAp(PIN, iface);
    state.apMode = true;
    state.apIface = iface;
    console.log('[ap] hotspot ACTIVE — navigating to AP page');
    await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/`);
    console.log('[ap] navigation complete');
    await startProvisioningExtras();
  } catch (err: any) {
    console.error(`[ap] FAILED to start: ${err.message}`);
    await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/no-connection`).catch(() => {});
  }
}

// Tear down BLE + USB watcher (used both on credential success and on
// auto-exit from AP mode when ethernet reconnects).
export async function stopProvisioningExtras() {
  await stopImprov().catch(() => {});
  stopUsbWatcher();
  resetEscalation();
}

// Start the BLE Improv server + USB watcher alongside the captive-portal AP.
// Errors here are non-fatal — the captive portal still works without them.
async function startProvisioningExtras() {
  // BLE Improv — Android Chrome users can use improv-wifi.com
  const localName = AP_SSID;
  const redirectUrl = CONTROL_URL;
  startImprov({
    localName,
    redirectUrl,
    onCredentials: async (ssid, password) => {
      await setProvisioningStatus({ source: 'improv', ssid, phase: 'connecting', message: `Connecting to "${ssid}"...` });
      const r = await applyCredentials(ssid, password, 'improv', async (msg) => {
        await setProvisioningStatus({ source: 'improv', ssid, phase: 'connecting', message: msg });
      });
      const ok = r.kind === 'online' || r.kind === 'captive_portal';
      if (!ok) {
        await setProvisioningStatus({ source: 'improv', ssid, phase: 'failed', message: r.kind === 'error' ? r.message : undefined });
        setTimeout(() => { if (state.provisioningStatus?.phase === 'failed') clearProvisioningStatus(); }, 5000);
      } else {
        await clearProvisioningStatus();
      }
      return { success: ok };
    },
    onIdentify: async () => {
      // Flash a fullscreen "this is me" page for 3s so the operator can pick
      // the right device out of a fleet from the BLE picker.
      await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/identify`).catch(() => {});
      setTimeout(() => {
        if (!state.apMode) return;
        // After the flash, return to whatever AP-mode page is current
        cdpNavigateAll(`http://localhost:${LOCAL_PORT}/?_=${Date.now()}`).catch(() => {});
      }, 3000);
    },
    onProvisionedDone: async () => {
      // PROVISIONED notify has already gone out; safe to tear everything down.
      await stopProvisioningExtras();
    },
  }).catch(err => console.error(`[improv] start failed: ${err?.message ?? err}`));

  // USB drop: wifi.ini at root of any USB stick
  startUsbWatcher(async (ssid, password) => {
    await setProvisioningStatus({ source: 'usb', ssid, phase: 'connecting', message: `Connecting to "${ssid}"...` });
    const r = await applyCredentials(ssid, password, 'usb', async (msg) => {
      await setProvisioningStatus({ source: 'usb', ssid, phase: 'connecting', message: msg });
    });
    if (r.kind === 'online' || r.kind === 'captive_portal') {
      await clearProvisioningStatus();
      await stopProvisioningExtras();
    } else {
      await setProvisioningStatus({ source: 'usb', ssid, phase: 'failed', message: r.kind === 'error' ? r.message : undefined });
      setTimeout(() => { if (state.provisioningStatus?.phase === 'failed') clearProvisioningStatus(); }, 5000);
    }
  }).catch(err => console.error(`[usb] start failed: ${err?.message ?? err}`));
}

async function setProvisioningStatus(s: NonNullable<typeof state.provisioningStatus>) {
  state.provisioningStatus = s;
  // Force a fresh render so the projector picks up the status screen
  await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/?_=${Date.now()}`).catch(() => {});
}
async function clearProvisioningStatus() {
  state.provisioningStatus = null;
  await cdpNavigateAll(`http://localhost:${LOCAL_PORT}/?_=${Date.now()}`).catch(() => {});
}

export const localServer = createServer(app);

// HTTPS listener on port 4443 (iptables NATs 443→4443 in AP mode).
// Even with a self-signed cert that Android rejects at TLS handshake,
// this gives Android a "TLS handshake started" signal instead of
// "TCP connection refused", which some versions distinguish.
const CERT_PATH = '/etc/frc-display/cert.pem';
const KEY_PATH  = '/etc/frc-display/key.pem';
export const httpsServer = (existsSync(CERT_PATH) && existsSync(KEY_PATH))
  ? createHttpsServer({ cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) }, app)
  : null;

// ── HTML builders ─────────────────────────────────────────────────────────────

function buildQrPage(qrDataUrl: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:28px}h1{font-size:2.4rem;font-weight:700;letter-spacing:.02em}.qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #4af4}.qr-box img{display:block;width:280px;height:280px}.pin-label{font-size:1rem;color:#aaa;margin-bottom:4px}.pin{font-size:3rem;font-weight:800;letter-spacing:.25em;color:#4af}.url{font-size:.85rem;color:#555;word-break:break-all;text-align:center;max-width:480px}.version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}</style>
</head><body>
<h1>Configure Display</h1>
<div class="qr-box"><img src="${qrDataUrl}" alt="QR"></div>
<div><div class="pin-label">PIN</div><div class="pin">${PIN}</div></div>
<div class="url">${SERVER_BASE.replace(/^https?:\/\//, '')}</div>
<div class="version">v${VERSION}</div>
</body></html>`;
}

async function buildApPageAsync() {
  // Out-of-band provisioning in flight (USB plugged in, BLE creds received) ->
  // show a status screen instead so operators get feedback during the 15-30s
  // connect attempt instead of staring at a frozen QR page.
  if (state.provisioningStatus) {
    return buildProvisioningStatusPage(state.provisioningStatus);
  }
  const wifiQr = await QRCode.toDataURL(`WIFI:T:nopass;S:${AP_SSID};;`,
    { width: 280, margin: 2, color: { dark: '#000', light: '#fff' } });
  // Show all three provisioning options up front. WiFi captive portal is
  // primary; BLE + USB sit alongside as alternatives so an operator who
  // knows their Android disassociates can skip straight to BLE/USB.
  const wifiSetupUrl = `${SERVER_BASE}/wifi`;
  const bleQr = await QRCode.toDataURL(wifiSetupUrl,
    { width: 200, margin: 2, color: { dark: '#000', light: '#fff' } });
  const altsBlock = `
  <div class="alts-title">Or use one of these alternatives:</div>
  <div class="alts">
    <div class="alt">
      <strong>Bluetooth setup</strong>
      <p>Scan this QR or visit <code>${wifiSetupUrl.replace(/^https?:\/\//, '')}</code> in Chrome on Android. Phone needs cellular data; no WiFi join required.</p>
      <div class="alt-qr"><img src="${bleQr}" alt="Wi-Fi setup QR"></div>
    </div>
    <div class="alt">
      <strong>USB stick</strong>
      <p>Plug in a USB drive with a <code>wifi.ini</code> file at the root:</p>
      <code class="alt-code">ssid=YourNetwork
password=secret</code>
    </div>
  </div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>WiFi Setup</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:24px;gap:16px}
  h1{font-size:2.2rem;font-weight:800;color:#fa0;letter-spacing:.02em}
  .qr{background:#fff;padding:14px;border-radius:14px;box-shadow:0 0 60px #fa04}
  .qr img{display:block;width:260px;height:260px}
  .ssid{font-size:1.5rem;font-weight:700;letter-spacing:.06em;color:#fa0}
  .hint{font-size:1rem;color:#bbb;text-align:center;max-width:620px;line-height:1.5}
  .tips{background:#1a1f2e;border:1px solid #2c3a55;border-radius:10px;padding:10px 18px;
    font-size:.85rem;color:#9ab;text-align:center;max-width:620px;line-height:1.55}
  .tips strong{color:#4af}
  .alts-title{margin-top:6px;font-size:1rem;font-weight:700;color:#fc6}
  .alts{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;max-width:780px}
  .alt{background:#1a1f2e;border:1px solid #2c3a55;border-radius:10px;padding:12px 16px;
    font-size:.88rem;color:#9ab;max-width:340px;line-height:1.55;text-align:left}
  .alt strong{color:#4af;display:block;margin-bottom:4px;font-size:.95rem}
  .alt code{background:#000a;padding:1px 6px;border-radius:4px;font-size:.85em;color:#cf8}
  .alt p{margin:6px 0;color:inherit;font-size:inherit;line-height:inherit}
  .alt-qr{background:#fff;padding:8px;border-radius:8px;display:block;margin:10px auto 0;width:fit-content}
  .alt-qr img{display:block;width:140px;height:140px}
  .alt-code{display:block;background:#000a;color:#cf8;padding:8px 10px;border-radius:6px;
    font-size:.82em;line-height:1.5;margin-top:8px;white-space:pre}
  .version{font-size:.85rem;color:#666;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <h1>WiFi Setup</h1>
  <div class="qr"><img src="${wifiQr}" alt="WiFi QR"></div>
  <div class="ssid">${AP_SSID}</div>
  <div class="hint">Scan to join the network. A "Sign in to network" notification will appear; tap it to open the setup page.</div>
  <div class="tips">
    <strong>Trouble staying connected?</strong> Try turning off mobile data.
  </div>
  ${altsBlock}
  <div class="version">v${VERSION}</div>
</body></html>`;
}

// Shown on the projector while a USB or BLE provisioning attempt is in flight.
function buildProvisioningStatusPage(status: { source: 'usb' | 'improv'; ssid: string; phase: 'connecting' | 'failed'; message?: string }) {
  const sourceLabel = status.source === 'usb' ? 'USB drive' : 'Bluetooth (Improv)';
  const isFailed = status.phase === 'failed';
  const msg = status.message ?? (isFailed
    ? 'Could not connect. The setup screen will return shortly.'
    : `Connecting to "${status.ssid}"...`);
  const headColor = isFailed ? '#f55' : '#4af';
  const accent    = isFailed ? '#822' : '#345';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Provisioning</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:24px}
  .src{font-size:.85rem;text-transform:uppercase;letter-spacing:.18em;color:#888}
  h1{font-size:2rem;font-weight:800;color:${headColor};letter-spacing:.02em;text-align:center;max-width:720px}
  .spinner{width:56px;height:56px;border:5px solid ${accent};border-top-color:${headColor};
    border-radius:50%;animation:spin 0.9s linear infinite;${isFailed ? 'display:none;' : ''}}
  @keyframes spin{to{transform:rotate(360deg)}}
  .msg{font-size:1.1rem;color:#bbb;max-width:620px;text-align:center;line-height:1.5}
  .version{font-size:.85rem;color:#666;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <div class="src">${sourceLabel}</div>
  <div class="spinner"></div>
  <h1>${isFailed ? 'Provisioning failed' : 'Credentials received'}</h1>
  <div class="msg">${msg}</div>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

function signalBars(s: number) {
  return s >= 70 ? '▂▄▆█' : s >= 50 ? '▂▄▆░' : s >= 30 ? '▂▄░░' : '▂░░░';
}

function buildSetupPage(networks: { ssid: string; signal: number; secured: boolean }[]) {
  const netRows = networks.map(n => `<div class="net-row" onclick="selectNetwork('${n.ssid.replace(/'/g,"\\'")}')"><span class="bars">${signalBars(n.signal)}</span><span class="net-name">${n.ssid.replace(/</g,'&lt;')}</span>${n.secured ? '<span class="lock">lock</span>' : ''}</div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WiFi Setup</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#111;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px;min-height:100vh}h1{font-size:1.3rem;font-weight:700;color:#fa0;margin-bottom:16px}.section-title{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:16px 0 8px}.net-list{background:#1c1c1c;border-radius:10px;overflow:hidden;margin-bottom:4px}.net-row{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;border-bottom:1px solid #222}.net-row:last-child{border-bottom:none}.net-row:active{background:#2a2a2a}.bars{font-size:1rem;color:#4af;min-width:32px}.net-name{flex:1;font-size:.95rem}input{width:100%;background:#1c1c1c;border:1px solid #333;border-radius:8px;color:#f0f0f0;padding:12px 14px;font-size:1rem;outline:none;margin-top:4px}input:focus{border-color:#fa0}label{font-size:.8rem;color:#888;display:block;margin-top:14px}.pw-row{position:relative}.pw-row input{padding-right:48px}.pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#666;cursor:pointer;font-size:.85rem;padding:4px}button.connect{width:100%;background:#fa0;color:#000;border:none;border-radius:8px;padding:14px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:20px}button.connect:active{opacity:.8}#status{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:.9rem;display:none}#status.error{background:#2a0a0a;color:#f66;display:block}#status.info{background:#1a1a2a;color:#aaf;display:block}#status.success{background:#0a2a0a;color:#6f6;display:block}.vnc-link{display:block;margin-top:10px;color:#4af;font-size:.85rem}.spinner{display:inline-block;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body>
<h1>WiFi Setup</h1>
<div class="section-title">Nearby Networks</div>
<div class="net-list" id="net-list">${netRows || '<div style="padding:12px 14px;color:#555;font-size:.9rem">No networks found</div>'}</div>
<button onclick="refreshScan()" style="font-size:.8rem;background:none;border:none;color:#4af;cursor:pointer;padding:6px 0;display:block">Rescan networks</button>
<div class="section-title">Network</div>
<input type="text" id="ssid" placeholder="Network name">
<label>Password <span style="color:#555">(leave blank for open networks)</span></label>
<div class="pw-row"><input type="password" id="password" placeholder="Password"><button class="pw-toggle" onclick="togglePw()" type="button">Show</button></div>
<button class="connect" onclick="doConnect()">Connect</button>
<div id="status"></div>
<hr style="border:none;border-top:1px solid #222;margin:24px 0">
<div class="section-title">Ethernet (AV Network / No DHCP)</div>
<div id="eth-status" style="font-size:.82rem;color:#555;margin-bottom:10px">Checking…</div>
<div style="display:flex;gap:8px;margin-bottom:10px">
  <button id="btn-dhcp" onclick="setEthMode('dhcp')" style="flex:1;background:#252525;color:#ccc;padding:9px;font-size:.85rem">DHCP</button>
  <button id="btn-static" onclick="setEthMode('static')" style="flex:1;background:#252525;color:#ccc;padding:9px;font-size:.85rem">Static IP</button>
</div>
<div id="eth-static-fields" style="display:none">
  <label>IP Address</label><input type="text" id="eth-ip" placeholder="192.168.25.xxx">
  <label>Prefix length</label><input type="text" id="eth-prefix" placeholder="24" value="24">
  <label>Gateway <span style="color:#555">(leave blank if none)</span></label><input type="text" id="eth-gw" placeholder="192.168.25.1">
  <button class="connect" style="background:#4af;margin-top:12px" onclick="applyEth()">Apply Static IP</button>
</div>
<div id="eth-status2"></div>
<script>
function selectNetwork(ssid){document.getElementById('ssid').value=ssid;document.getElementById('password').focus()}
function togglePw(){const i=document.getElementById('password');const b=event.target;i.type=i.type==='password'?'text':'password';b.textContent=i.type==='password'?'Show':'Hide'}
async function refreshScan(){const l=document.getElementById('net-list');l.innerHTML='<div style="padding:12px 14px;color:#555">Scanning...</div>';const r=await fetch('/api/wifi-scan').then(r=>r.json()).catch(()=>[]);if(!r.length){l.innerHTML='<div style="padding:12px 14px;color:#555">No networks found</div>';return}l.innerHTML=r.map(n=>\`<div class="net-row" onclick="selectNetwork('\${n.ssid.replace(/'/g,"\\\\'")}')"><span class="bars">\${n.signal>=70?'▂▄▆█':n.signal>=50?'▂▄▆░':n.signal>=30?'▂▄░░':'▂░░░'}</span><span class="net-name">\${n.ssid.replace(/</g,'&lt;')}</span>\${n.secured?'<span class="lock">lock</span>':''}</div>\`).join('')}
function setStatus(cls,msg){const e=document.getElementById('status');e.className=cls;e.innerHTML=msg}
async function doConnect(){const ssid=document.getElementById('ssid').value.trim();if(!ssid){setStatus('error','Enter a network name');return}const password=document.getElementById('password').value;setStatus('info','<span class="spinner">o</span> Connecting to <b>'+ssid+'</b>...');document.querySelector('.connect').disabled=true;try{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid,password})}).then(r=>r.json());if(r.status==='online'||r.status==='connected'){setStatus('success','Connected. Display restarting...')}else if(r.status==='captive_portal'){setStatus('info','Venue requires sign-in. Use <a class="vnc-link" href="/vnc/'+r.pin+'" target="_blank">Web VNC</a> to sign in, then <button onclick="pollInternet()" style="margin-top:8px;background:#fa0;color:#000;border:none;border-radius:6px;padding:8px 16px;cursor:pointer">I signed in -&gt; continue</button>')}else{setStatus('error',r.message||'Connection failed');document.querySelector('.connect').disabled=false}}catch(e){setStatus('error','Request failed. Try again.');document.querySelector('.connect').disabled=false}}
async function pollInternet(){setStatus('info','<span class="spinner">o</span> Checking internet...');for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,2000));const r=await fetch('/api/internet-status').then(r=>r.json()).catch(()=>({}));if(r.online||r.status==='proceeding'){setStatus('success','Connected.');return}}setStatus('error','Still no internet. Try again.')}
let ethMode='dhcp';
function setEthMode(m){ethMode=m;document.getElementById('btn-dhcp').style.background=m==='dhcp'?'#333':'#252525';document.getElementById('btn-static').style.background=m==='static'?'#333':'#252525';document.getElementById('eth-static-fields').style.display=m==='static'?'block':'none'}
async function applyEth(){const ip=document.getElementById('eth-ip').value.trim();const prefix=document.getElementById('eth-prefix').value.trim()||'24';const gw=document.getElementById('eth-gw').value.trim();if(!ip){document.getElementById('eth-status2').innerHTML='<span style="color:#f66">Enter an IP address</span>';return}const r=await fetch('/api/eth-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'static',ip,prefix,gateway:gw})}).then(r=>r.json()).catch(()=>({error:'Request failed'}));document.getElementById('eth-status2').innerHTML=r.ok?'<span style="color:#6f6">✓ '+r.message+'</span>':'<span style="color:#f66">'+r.error+'</span>'}
async function loadEthStatus(){const s=await fetch('/api/eth-status').then(r=>r.json()).catch(()=>({}));if(!s.iface){document.getElementById('eth-status').textContent='No ethernet adapter detected';return}const ip=s.ip||'No IP';const note=s.isLinkLocal?' (DHCP failed — link-local)':s.hasRoutableIp?' (connected)':' (no IP)';document.getElementById('eth-status').textContent=s.iface+': '+ip+note;if(s.ip)document.getElementById('eth-ip').value=s.ip}
loadEthStatus();setEthMode('dhcp');
</script>
</body></html>`;
}

function buildDebugLogPage() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request Log</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#ddd;font-family:ui-monospace,Menlo,Monaco,monospace;
    font-size:11px;padding:8px;line-height:1.4}
  h1{font-size:13px;color:#4af;margin-bottom:4px}
  .meta{font-size:10px;color:#555;margin-bottom:10px}
  .row{padding:4px 6px;border-bottom:1px solid #1a1a1a;display:grid;
    grid-template-columns:auto auto auto 1fr;gap:6px;align-items:start}
  .ts{color:#666;white-space:nowrap}
  .status-2xx,.status-3xx{color:#4af}
  .status-4xx,.status-5xx{color:#f66}
  .method{color:#fa0;min-width:34px}
  .path{color:#dfd;word-break:break-all}
  .ua{color:#555;font-size:10px;margin-left:46px;margin-top:2px;word-break:break-all}
</style></head>
<body>
<h1>Request Log</h1>
<div class="meta" id="meta">Auto-refresh 1s · scroll up for newest</div>
<div id="log">Loading…</div>
<script>
function fmt(ts){
  const d=new Date(ts);const s=d.toLocaleTimeString([],{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
  return s;
}
function statusClass(s){if(!s)return '';return 'status-'+Math.floor(s/100)+'xx';}
async function refresh(){
  try{
    const log=await fetch('/api/debug-log').then(r=>r.json());
    const html=log.map(r=>{
      const path=r.path.length>60?r.path.slice(0,60)+'…':r.path;
      return '<div class="row">'
        +'<span class="ts">'+fmt(r.ts)+'</span>'
        +'<span class="'+statusClass(r.status)+'">'+(r.status||'?')+'</span>'
        +'<span class="method">'+r.method+'</span>'
        +'<span class="path">'+r.host+r.path.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</span>'
        +(r.ua?'<span class="ua" style="grid-column:1/-1">'+r.ip+' · '+r.ua.replace(/</g,'&lt;')+'</span>':'')
        +'</div>';
    }).join('');
    document.getElementById('log').innerHTML=html||'<div style="color:#555">No requests yet</div>';
    document.getElementById('meta').textContent='Auto-refresh 1s · '+log.length+' entries · '+new Date().toLocaleTimeString();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message;}
}
refresh();
setInterval(refresh,1000);
</script>
</body></html>`;
}

function buildConnectingPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px}
  .spinner{width:56px;height:56px;border:5px solid #222;border-top-color:#4af;border-radius:50%;
    animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.6rem;font-weight:600;color:#888}
  .version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <div class="spinner"></div>
  <h1>Connecting to server…</h1>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

function buildIdentifyPage() {
  // Pulsing fullscreen flash so an operator can spot which device responded
  // to "Identify" from the BLE picker. Auto-redirects back to / after 3s in
  // case the daemon-side timer doesn't fire.
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Identify</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#fa0;color:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    animation:flash .6s ease-in-out infinite alternate}
  @keyframes flash{from{background:#fa0}to{background:#fff}}
  h1{font-size:5rem;font-weight:900;letter-spacing:.04em}
  .ssid{font-size:2rem;font-weight:700;margin-top:24px;letter-spacing:.06em}
  .pin{font-size:2rem;letter-spacing:.25em;color:#222;margin-top:8px}
</style></head>
<body>
  <h1>THIS DEVICE</h1>
  <div class="ssid">${AP_SSID}</div>
  <div class="pin">PIN ${PIN}</div>
  <script>setTimeout(()=>location.href='/',3000)</script>
</body></html>`;
}

function buildNoConnectionPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>No Connection</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1a0505;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px;text-align:center}
  .icon{font-size:5rem}
  h1{font-size:2.2rem;font-weight:800;color:#f44;letter-spacing:.02em}
  p{font-size:1.1rem;color:#aaa;max-width:520px;line-height:1.6}
  .url{font-size:.85rem;color:#555;margin-top:8px}
  .version{font-size:1rem;color:#666;position:fixed;bottom:12px;right:16px}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h1>No Connection</h1>
  <p>This display cannot reach the control server.<br>
  Content on screen is <strong style="color:#f66">not live</strong>.</p>
  <p>Connect this device to a network with internet access,<br>
  or reboot it — a WiFi setup screen will appear after 20 seconds.</p>
  <div class="url">${SERVER_BASE}</div>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

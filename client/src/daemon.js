const express = require('express');
const { WebSocket } = require('ws');
const http = require('http');
const net = require('net');
const { execFile, exec, spawn } = require('child_process');
const path = require('path');
const QRCode = require('qrcode');
const wifi = require('./wifi');

const VERSION = require('../package.json').version;
const SERVER_BASE = process.env.SERVER_URL || 'https://display.filipkin.com';
const SERVER_URL = SERVER_BASE.replace(/^https?:\/\//, m => m === 'https://' ? 'wss://' : 'ws://');
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '3000', 10);
const CHROMIUM_DEBUG_PORT = parseInt(process.env.CHROMIUM_DEBUG_PORT || '9222', 10);
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900', 10);
const AP_IP = '192.168.4.1';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN = Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const CONTROL_URL = `${SERVER_BASE}/control?pin=${PIN}`;
const AP_SSID = `FRC-Display-${PIN}`;

console.log(`[daemon] v${VERSION} PIN: ${PIN}`);
console.log(`[daemon] Control URL: ${CONTROL_URL}`);

// ── State ─────────────────────────────────────────────────────────────────────

let currentMode = 'home';
let ndiProcess = null;
let x11vncProcess = null;
let vncBridgeSocket = null;
let vncBridgeWs = null;
let apMode = false;
let apIface = null;
let postConnectInProgress = false;
let networkCheckTimer = null;

// ── Local web server ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Captive portal middleware: when in AP mode, redirect unknown hosts to /setup
app.use((req, res, next) => {
  if (!apMode) return next();
  const host = (req.get('host') || '').split(':')[0];
  if (host !== AP_IP && host !== 'localhost' && host !== '127.0.0.1') {
    return res.redirect(`http://${AP_IP}:${LOCAL_PORT}/setup`);
  }
  next();
});

app.get('/', async (req, res) => {
  if (apMode) {
    const wifiQr = `WIFI:T:nopass;S:${AP_SSID};;`;
    const qrDataUrl = await QRCode.toDataURL(wifiQr, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
    res.send(buildApPage(qrDataUrl));
  } else {
    const qrDataUrl = await QRCode.toDataURL(CONTROL_URL, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
    res.send(buildQrPage(qrDataUrl));
  }
});

app.get('/youtube', (req, res) => {
  const videoId = req.query.v || '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}
iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}</style></head>
<body><iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0" allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>`);
});

// WiFi scan API (used by setup page refresh button)
app.get('/api/wifi-scan', async (req, res) => {
  const networks = await wifi.scanWifi();
  res.json(networks);
});

// Internet status API (polled by setup page after captive portal sign-in)
app.get('/api/internet-status', async (req, res) => {
  const result = await wifi.checkInternet();
  if (result.online && !postConnectInProgress) {
    // Online after captive portal sign-in — run update + navigate home
    res.json({ online: true, status: 'proceeding' });
    runPostConnect();
  } else {
    res.json(result);
  }
});

// WiFi setup page
app.get('/setup', async (req, res) => {
  const networks = await wifi.scanWifi().catch(() => []);
  res.send(buildSetupPage(networks));
});

// WiFi connect handler
app.post('/setup', async (req, res) => {
  const { ssid, password } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });

  // Stop AP before attempting connection
  if (apIface) {
    await wifi.stopAp(apIface).catch(() => {});
    apMode = false;
  }

  try {
    await wifi.connectWifi(ssid, password || '');
  } catch (err) {
    console.error('[wifi] connect failed:', err.message);
    if (apIface) {
      apMode = true;
      await wifi.startAp(PIN, apIface).catch(() => {});
      await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }
    return res.json({ status: 'error', message: 'Could not connect — check SSID and password' });
  }

  // Poll for connectivity
  let result = { online: false, portalUrl: null };
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    result = await wifi.checkInternet();
    if (result.online || result.portalUrl) break;
  }

  if (result.portalUrl) {
    await cdpNavigate(result.portalUrl).catch(() => {});
    return res.json({ status: 'captive_portal', portalUrl: result.portalUrl, pin: PIN });
  }

  if (!result.online) {
    if (apIface) {
      apMode = true;
      await wifi.startAp(PIN, apIface).catch(() => {});
      await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }
    return res.json({ status: 'error', message: 'Connected to WiFi but no internet — check password or try again' });
  }

  res.json({ status: 'online' });
  runPostConnect();
});

async function runPostConnect() {
  if (postConnectInProgress) return;
  postConnectInProgress = true;
  console.log('[wifi] connected — checking for updates');

  let updated = false;
  try {
    const checkScript = path.join(__dirname, '../check-update.sh');
    const stdout = await new Promise(resolve => {
      exec(`/bin/bash "${checkScript}"`, { timeout: 120000, env: process.env }, (_, out) => resolve(out || ''));
    });
    console.log('[update]', stdout.trim());
    updated = stdout.includes('[update] done');
  } catch (e) {
    console.error('[update] check error:', e.message);
  }

  if (updated) {
    console.log('[update] restarting display session');
    execFile('sudo', ['systemctl', 'restart', 'lightdm'], () => {});
    // Process will be killed by lightdm restart
  } else {
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    postConnectInProgress = false;
  }
}

async function enterApMode() {
  const iface = await wifi.getWifiInterface();
  if (!iface) {
    console.log('[ap] no WiFi adapter found — skipping AP mode');
    return;
  }
  console.log(`[ap] starting hotspot ${AP_SSID} on ${iface}`);
  try {
    await wifi.startAp(PIN, iface);
    apMode = true;
    apIface = iface;
    console.log('[ap] hotspot active');
    await cdpNavigate(`http://localhost:${LOCAL_PORT}/`);
  } catch (err) {
    console.error('[ap] failed to start:', err.message);
  }
}

const localServer = http.createServer(app);
localServer.listen(LOCAL_PORT, '0.0.0.0', () => {
  console.log(`[daemon] local server on port ${LOCAL_PORT}`);
});

// ── CDP helpers ───────────────────────────────────────────────────────────────

function cdpGet(cdpPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CHROMIUM_DEBUG_PORT, path: cdpPath }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

async function cdpNavigate(targetUrl) {
  try {
    const targets = await cdpGet('/json');
    if (!targets?.length) { console.error('[cdp] no targets'); return; }
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await new Promise((resolve) => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: targetUrl } }));
      ws.once('message', () => { ws.close(); resolve(); });
      setTimeout(() => { ws.close(); resolve(); }, 3000);
    });
    console.log(`[cdp] navigated to ${targetUrl}`);
  } catch (err) {
    console.error('[cdp] navigate error:', err.message);
  }
}

// ── Mode handlers ─────────────────────────────────────────────────────────────

function stopNdi() {
  if (ndiProcess) { ndiProcess.kill('SIGTERM'); ndiProcess = null; }
}

// x11vnc is always-on — stopVnc only disconnects the relay bridge
function stopVnc() {
  if (vncBridgeSocket) { vncBridgeSocket.destroy(); vncBridgeSocket = null; }
  if (vncBridgeWs) { vncBridgeWs.close(); vncBridgeWs = null; }
}

async function setHome() {
  stopNdi(); stopVnc();
  await cdpNavigate(`http://localhost:${LOCAL_PORT}/`);
}

async function setChromium(url) {
  stopNdi(); stopVnc();
  await cdpNavigate(url);
}

function setNdi(source) {
  stopNdi(); stopVnc();
  cdpNavigate('about:blank');
  const display = process.env.DISPLAY || ':0';
  ndiProcess = spawn('ffplay', ['-f', 'libndi_newtek', '-i', source, '-fs', '-an', '-loglevel', 'quiet'], {
    env: { ...process.env, DISPLAY: display }, detached: false
  });
  ndiProcess.on('exit', (code) => { console.log(`[ndi] ffplay exited (${code})`); ndiProcess = null; });
  console.log(`[ndi] started ffplay for: ${source}`);
}

function setVnc(sWs) {
  // x11vnc is always-on — just connect the relay bridge (don't stop current mode)
  if (vncBridgeWs?.readyState === WebSocket.OPEN) return;
  connectVncBridge(sWs);
  console.log('[vnc] relay bridge started');
}

function startX11vncDaemon() {
  const display = process.env.DISPLAY || ':0';
  x11vncProcess = spawn('x11vnc', ['-display', display, '-forever', '-nopw', '-quiet', '-rfbport', String(VNC_PORT)], { detached: false });
  x11vncProcess.on('exit', (code) => {
    console.log(`[vnc] x11vnc exited (${code}) — restarting in 5s`);
    x11vncProcess = null;
    setTimeout(startX11vncDaemon, 5000);
  });
  console.log('[vnc] x11vnc started (always-on)');
}

function connectVncBridge(sWs) {
  const wsUrl = `${SERVER_URL}/ws/vnc-upstream?pin=${PIN}`;
  vncBridgeWs = new WebSocket(wsUrl);
  vncBridgeWs.binaryType = 'nodebuffer';
  vncBridgeWs.on('open', () => {
    console.log('[vnc-bridge] upstream connected');
    vncBridgeSocket = net.createConnection(VNC_PORT, '127.0.0.1');
    vncBridgeSocket.on('data', d => { if (vncBridgeWs?.readyState === WebSocket.OPEN) vncBridgeWs.send(d); });
    vncBridgeSocket.on('error', err => console.error('[vnc-bridge] socket error:', err.message));
    vncBridgeSocket.on('close', () => { console.log('[vnc-bridge] socket closed'); vncBridgeWs?.close(); });
  });
  vncBridgeWs.on('message', d => { if (vncBridgeSocket && !vncBridgeSocket.destroyed) vncBridgeSocket.write(d); });
  vncBridgeWs.on('close', () => { console.log('[vnc-bridge] WS closed'); vncBridgeSocket?.destroy(); vncBridgeSocket = null; });
  vncBridgeWs.on('error', err => console.error('[vnc-bridge] WS error:', err.message));
}

// ── NDI source discovery ──────────────────────────────────────────────────────

async function getNdiSources() {
  return new Promise((resolve) => {
    execFile('ndi-list-sources', [], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try { const s = JSON.parse(stdout); resolve(Array.isArray(s) ? s : []); }
      catch { resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean)); }
    });
  });
}

// ── Audio ─────────────────────────────────────────────────────────────────────

async function getAudioSinks() {
  return new Promise((resolve) => {
    exec('pactl list sinks', { env: process.env }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const sinks = [];
      for (const block of stdout.split(/^Sink #/m).slice(1)) {
        const name = block.match(/\tName:\s*(.+)/)?.[1]?.trim();
        const desc = block.match(/\tDescription:\s*(.+)/)?.[1]?.trim();
        if (name) sinks.push({ name, description: desc || name });
      }
      resolve(sinks);
    });
  });
}

async function getAudioState() {
  return new Promise((resolve) => {
    exec('pactl info; pactl get-sink-volume @DEFAULT_SINK@; pactl get-sink-mute @DEFAULT_SINK@',
      { env: process.env }, (err, stdout) => {
        if (err) { resolve({ sink: '', volume: 100, muted: false }); return; }
        const sink = stdout.match(/Default Sink:\s*(.+)/)?.[1]?.trim() || '';
        const vol = stdout.match(/(\d+)%/);
        resolve({ sink, volume: vol ? parseInt(vol[1]) : 100, muted: /Mute:\s*yes/i.test(stdout) });
      });
  });
}

// ── Server WebSocket connection ───────────────────────────────────────────────

let serverWs = null;
let reconnectDelay = 2000;
let wsEverConnected = false;

function connectToServer() {
  const wsUrl = `${SERVER_URL}/ws/device`;
  console.log(`[ws] connecting to ${wsUrl}`);
  serverWs = new WebSocket(wsUrl);

  serverWs.on('open', async () => {
    wsEverConnected = true;
    clearTimeout(apCheckTimer);
    clearTimeout(networkCheckTimer);
    networkCheckTimer = null;
    console.log('[ws] connected to server');
    reconnectDelay = 2000;

    // If we were in AP mode and WiFi came back on its own, stop AP and go home
    if (apMode && !postConnectInProgress) {
      if (apIface) await wifi.stopAp(apIface).catch(() => {});
      apMode = false; apIface = null;
      await cdpNavigate(`http://localhost:${LOCAL_PORT}/`).catch(() => {});
    }

    serverWs.send(JSON.stringify({ type: 'register', pin: PIN }));
    startHeartbeat();
    startNdiPolling();

    // Delay audio detection — PipeWire may not be ready immediately on boot
    setTimeout(async () => {
      try {
        const sinks = await getAudioSinks();
        const state = await getAudioState();
        if (serverWs?.readyState === WebSocket.OPEN)
          serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state }));
      } catch {}
    }, 5000);
  });

  serverWs.on('message', async (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    console.log('[ws] command:', JSON.stringify(msg));
    if (msg.type === 'set_mode') {
      currentMode = msg.mode;
      if (msg.mode === 'home') await setHome();
      else if (msg.mode === 'chromium' && msg.url) await setChromium(msg.url);
      else if (msg.mode === 'ndi' && msg.source) setNdi(msg.source);
      else if (msg.mode === 'vnc') setVnc(serverWs);
    } else if (msg.type === 'refresh_ndi') {
      const sources = await getNdiSources();
      if (serverWs?.readyState === WebSocket.OPEN)
        serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
    } else if (msg.type === 'set_audio_output' && msg.sink) {
      execFile('pactl', ['set-default-sink', msg.sink], { env: process.env }, () => {});
    } else if (msg.type === 'set_volume') {
      const vol = Math.max(0, Math.min(100, parseInt(msg.volume) || 0));
      execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${vol}%`], { env: process.env }, () => {});
    } else if (msg.type === 'set_mute') {
      execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', msg.muted ? '1' : '0'], { env: process.env }, () => {});
    } else if (msg.type === 'start_vnc_bridge') {
      // Open VNC relay without changing current display mode
      if (vncBridgeWs?.readyState !== WebSocket.OPEN) connectVncBridge(serverWs);
    }
  });

  serverWs.on('close', () => {
    console.log(`[ws] disconnected; reconnecting in ${reconnectDelay}ms`);
    stopHeartbeat(); stopNdiPolling();
    setTimeout(connectToServer, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    // After 30s of no connection with no default route → AP provisioning
    if (wsEverConnected && !networkCheckTimer) {
      networkCheckTimer = setTimeout(async () => {
        networkCheckTimer = null;
        if (apMode || serverWs?.readyState === WebSocket.OPEN) return;
        if (!(await wifi.hasDefaultRoute())) await enterApMode();
      }, 30000);
    }
  });

  serverWs.on('error', err => console.error('[ws] error:', err.message));
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

let heartbeatInterval = null;
function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    if (serverWs?.readyState === WebSocket.OPEN) serverWs.send(JSON.stringify({ type: 'heartbeat' }));
  }, 30000);
}
function stopHeartbeat() { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } }

// ── NDI polling ───────────────────────────────────────────────────────────────

let ndiPollInterval = null;
function startNdiPolling() {
  ndiPollInterval = setInterval(async () => {
    const sources = await getNdiSources();
    if (serverWs?.readyState === WebSocket.OPEN)
      serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
  }, 20000);
}
function stopNdiPolling() { if (ndiPollInterval) { clearInterval(ndiPollInterval); ndiPollInterval = null; } }

// ── HTML pages ────────────────────────────────────────────────────────────────

function buildQrPage(qrDataUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:28px}
  h1{font-size:2.4rem;font-weight:700;letter-spacing:.02em}
  .qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #4af4}
  .qr-box img{display:block;width:280px;height:280px}
  .pin-label{font-size:1rem;color:#aaa;margin-bottom:4px}
  .pin{font-size:3rem;font-weight:800;letter-spacing:.25em;color:#4af;font-variant-numeric:tabular-nums}
  .url{font-size:.85rem;color:#555;word-break:break-all;text-align:center;max-width:480px}
  .version{font-size:.75rem;color:#333;position:fixed;bottom:12px;right:16px}
</style></head><body>
  <h1>FRC Display</h1>
  <div class="qr-box"><img src="${qrDataUrl}" alt="QR Code"></div>
  <div><div class="pin-label">PIN</div><div class="pin">${PIN}</div></div>
  <div class="url">${CONTROL_URL}</div>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

function buildApPage(qrDataUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>WiFi Setup</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:24px}
  h1{font-size:2rem;font-weight:700;color:#fa0}
  .qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #fa04}
  .qr-box img{display:block;width:260px;height:260px}
  .ssid{font-size:1.6rem;font-weight:700;letter-spacing:.06em;color:#fa0}
  .hint{font-size:.9rem;color:#888;text-align:center}
  .url{font-size:.8rem;color:#444;margin-top:4px}
  .version{font-size:.75rem;color:#333;position:fixed;bottom:12px;right:16px}
</style></head><body>
  <h1>WiFi Setup</h1>
  <div class="qr-box"><img src="${qrDataUrl}" alt="WiFi QR"></div>
  <div class="ssid">${AP_SSID}</div>
  <div>
    <div class="hint">Scan to connect, then configure WiFi</div>
    <div class="url">Or open http://${AP_IP}:${LOCAL_PORT}/setup</div>
  </div>
  <div class="version">v${VERSION}</div>
</body></html>`;
}

function signalBars(signal) {
  if (signal >= 70) return '▂▄▆█';
  if (signal >= 50) return '▂▄▆░';
  if (signal >= 30) return '▂▄░░';
  return '▂░░░';
}

function buildSetupPage(networks) {
  const netRows = networks.map(n => `
    <div class="net-row" onclick="selectNetwork('${n.ssid.replace(/'/g, "\\'")}')">
      <span class="bars">${signalBars(n.signal)}</span>
      <span class="net-name">${n.ssid.replace(/</g, '&lt;')}</span>
      ${n.secured ? '<span class="lock">🔒</span>' : ''}
    </div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WiFi Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#111;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    padding:16px;min-height:100vh}
  h1{font-size:1.3rem;font-weight:700;color:#fa0;margin-bottom:16px}
  .section-title{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:16px 0 8px}
  .net-list{background:#1c1c1c;border-radius:10px;overflow:hidden;margin-bottom:4px}
  .net-row{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;border-bottom:1px solid #222}
  .net-row:last-child{border-bottom:none}
  .net-row:active{background:#2a2a2a}
  .bars{font-size:1rem;color:#4af;min-width:32px}
  .net-name{flex:1;font-size:.95rem}
  .lock{font-size:.85rem}
  .refresh-btn{font-size:.8rem;background:none;border:none;color:#4af;cursor:pointer;padding:6px 0;display:block}
  input{width:100%;background:#1c1c1c;border:1px solid #333;border-radius:8px;color:#f0f0f0;
    padding:12px 14px;font-size:1rem;outline:none;margin-top:4px}
  input:focus{border-color:#fa0}
  label{font-size:.8rem;color:#888;display:block;margin-top:14px}
  .pw-row{position:relative}
  .pw-row input{padding-right:48px}
  .pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);
    background:none;border:none;color:#666;cursor:pointer;font-size:.85rem;padding:4px}
  button.connect{width:100%;background:#fa0;color:#000;border:none;border-radius:8px;
    padding:14px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:20px}
  button.connect:active{opacity:.8}
  #status{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:.9rem;display:none}
  #status.error{background:#2a0a0a;color:#f66;display:block}
  #status.info{background:#1a1a2a;color:#aaf;display:block}
  #status.success{background:#0a2a0a;color:#6f6;display:block}
  .vnc-link{display:block;margin-top:10px;color:#4af;font-size:.85rem}
  .spinner{display:inline-block;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<h1>WiFi Setup</h1>
<div class="section-title">Nearby Networks</div>
<div class="net-list" id="net-list">
  ${netRows || '<div style="padding:12px 14px;color:#555;font-size:.9rem">No networks found</div>'}
</div>
<button class="refresh-btn" onclick="refreshScan()">↻ Refresh scan</button>
<div class="section-title">Network</div>
<input type="text" id="ssid" placeholder="Network name (tap above or type)" autocomplete="off">
<label>Password <span style="color:#555">(leave blank for open networks)</span></label>
<div class="pw-row">
  <input type="password" id="password" placeholder="Password" autocomplete="new-password">
  <button class="pw-toggle" onclick="togglePw()" type="button">Show</button>
</div>
<button class="connect" onclick="doConnect()">Connect</button>
<div id="status"></div>
<script>
function selectNetwork(ssid) {
  document.getElementById('ssid').value = ssid;
  document.getElementById('password').focus();
}
function togglePw() {
  const inp = document.getElementById('password');
  const btn = event.target;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
}
async function refreshScan() {
  const list = document.getElementById('net-list');
  list.innerHTML = '<div style="padding:12px 14px;color:#555">Scanning…</div>';
  const r = await fetch('/api/wifi-scan').then(r=>r.json()).catch(()=>[]);
  if (!r.length) { list.innerHTML='<div style="padding:12px 14px;color:#555">No networks found</div>'; return; }
  list.innerHTML = r.map(n => \`<div class="net-row" onclick="selectNetwork('\${n.ssid.replace(/'/g,"\\\\'")}')">\${bars(n.signal)}<span class="net-name">\${esc(n.ssid)}</span>\${n.secured?'<span class="lock">🔒</span>':''}</div>\`).join('');
}
function bars(s) { return \`<span class="bars">\${s>=70?'▂▄▆█':s>=50?'▂▄▆░':s>=30?'▂▄░░':'▂░░░'}</span>\`; }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function setStatus(cls, msg) {
  const el = document.getElementById('status');
  el.className = cls; el.innerHTML = msg;
}
async function doConnect() {
  const ssid = document.getElementById('ssid').value.trim();
  if (!ssid) { setStatus('error','Enter a network name'); return; }
  const password = document.getElementById('password').value;
  setStatus('info','<span class="spinner">⟳</span> Connecting to <b>'+esc(ssid)+'</b>…');
  document.querySelector('.connect').disabled = true;
  try {
    const resp = await fetch('/setup', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ssid, password})
    }).then(r=>r.json());
    if (resp.status === 'online' || resp.status === 'connected') {
      setStatus('success','✓ Connected! Display is restarting…');
    } else if (resp.status === 'updated') {
      setStatus('success','✓ Connected and updated! Display is restarting…');
    } else if (resp.status === 'captive_portal') {
      setStatus('info','⚠ Venue network requires sign-in.<br>Use <a class="vnc-link" href="/vnc/'+resp.pin+'" target="_blank">Web VNC</a> to sign in on the display, then come back here.<br><button onclick="pollInternet()" style="margin-top:8px;background:#fa0;color:#000;border:none;border-radius:6px;padding:8px 16px;cursor:pointer">I signed in — continue</button>');
    } else {
      setStatus('error', resp.message || 'Connection failed');
      document.querySelector('.connect').disabled = false;
    }
  } catch(e) {
    setStatus('error','Request failed — please try again');
    document.querySelector('.connect').disabled = false;
  }
}
async function pollInternet() {
  setStatus('info','<span class="spinner">⟳</span> Checking internet…');
  for (let i=0; i<20; i++) {
    await new Promise(r=>setTimeout(r,2000));
    const r = await fetch('/api/internet-status').then(r=>r.json()).catch(()=>({}));
    if (r.online || r.status === 'proceeding') {
      setStatus('success','✓ Connected! Display is restarting…'); return;
    }
  }
  setStatus('error','Still no internet. Sign in via VNC and try again.');
}
</script>
</body></html>`;
}

// ── AP trigger (20s after start, if no WS and no default route) ───────────────

// Start x11vnc immediately so VNC is always accessible regardless of display mode
startX11vncDaemon();

const apCheckTimer = setTimeout(async () => {
  if (wsEverConnected) return;
  if (await wifi.hasDefaultRoute()) {
    console.log('[ap] default route exists — not entering AP mode');
    return;
  }
  await enterApMode();
}, 20000);

// ── Start ─────────────────────────────────────────────────────────────────────

connectToServer();

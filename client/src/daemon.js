const express = require('express');
const { WebSocket } = require('ws');
const http = require('http');
const net = require('net');
const { execFile, exec, spawn } = require('child_process');
const path = require('path');
const QRCode = require('qrcode');

const VERSION = require('../package.json').version;
const SERVER_BASE = process.env.SERVER_URL || 'https://display.filipkin.com';
// Convert https:// → wss:// for WebSocket connection
const SERVER_URL = SERVER_BASE.replace(/^https?:\/\//, (m) => m === 'https://' ? 'wss://' : 'ws://');
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '3000', 10);
const CHROMIUM_DEBUG_PORT = parseInt(process.env.CHROMIUM_DEBUG_PORT || '9222', 10);
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900', 10);

// Generate 6-char alphanumeric PIN (uppercase, no ambiguous chars)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN = Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const CONTROL_URL = `https://display.filipkin.com/control?pin=${PIN}`;

console.log(`[daemon] PIN: ${PIN}`);
console.log(`[daemon] Control URL: ${CONTROL_URL}`);

// ── Local web server ─────────────────────────────────────────────────────────

const app = express();

app.get('/', async (req, res) => {
  const qrDataUrl = await QRCode.toDataURL(CONTROL_URL, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
  res.send(buildQrPage(qrDataUrl));
});

app.get('/youtube', (req, res) => {
  const videoId = req.query.v || '';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  iframe { position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0" allow="autoplay; fullscreen" allowfullscreen></iframe>
</body>
</html>`);
});

function buildQrPage(qrDataUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Configure Display</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #111;
    color: #f0f0f0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    gap: 28px;
  }
  h1 { font-size: 2.4rem; font-weight: 700; letter-spacing: 0.02em; }
  .qr-box {
    background: #fff;
    padding: 16px;
    border-radius: 16px;
    box-shadow: 0 0 60px #4af4;
  }
  .qr-box img { display: block; width: 280px; height: 280px; }
  .pin-label { font-size: 1rem; color: #aaa; margin-bottom: 4px; }
  .pin {
    font-size: 3rem;
    font-weight: 800;
    letter-spacing: 0.25em;
    color: #4af;
    font-variant-numeric: tabular-nums;
  }
  .url { font-size: 0.85rem; color: #555; word-break: break-all; text-align: center; max-width: 480px; }
  .version { font-size: 0.75rem; color: #333; position: fixed; bottom: 12px; right: 16px; }
</style>
</head>
<body>
  <h1>Configure Display</h1>
  <div class="qr-box"><img src="${qrDataUrl}" alt="QR Code"></div>
  <div>
    <div class="pin-label">PIN</div>
    <div class="pin">${PIN}</div>
  </div>
  <div class="url">${CONTROL_URL}</div>
  <div class="version">v${VERSION}</div>
</body>
</html>`;
}

const localServer = http.createServer(app);
localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`[daemon] local server on port ${LOCAL_PORT}`);
});

// ── State ────────────────────────────────────────────────────────────────────

let currentMode = 'home';
let ndiProcess = null;
let x11vncProcess = null;
let vncBridgeSocket = null;
let vncBridgeWs = null;

// ── CDP helpers ───────────────────────────────────────────────────────────────

function cdpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CHROMIUM_DEBUG_PORT, path }, (res) => {
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
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await new Promise((resolve) => {
      let id = 1;
      ws.send(JSON.stringify({ id: id++, method: 'Page.navigate', params: { url: targetUrl } }));
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
  if (ndiProcess) {
    ndiProcess.kill('SIGTERM');
    ndiProcess = null;
  }
}

function stopVnc() {
  if (x11vncProcess) {
    x11vncProcess.kill('SIGTERM');
    x11vncProcess = null;
  }
  if (vncBridgeSocket) {
    vncBridgeSocket.destroy();
    vncBridgeSocket = null;
  }
  if (vncBridgeWs) {
    vncBridgeWs.close();
    vncBridgeWs = null;
  }
}

async function setHome() {
  stopNdi();
  stopVnc();
  await cdpNavigate(`http://localhost:${LOCAL_PORT}/`);
}

async function setChromium(url) {
  stopNdi();
  stopVnc();
  await cdpNavigate(url);
}

function setNdi(source) {
  stopNdi();
  stopVnc();
  cdpNavigate('about:blank');

  const display = process.env.DISPLAY || ':0';
  ndiProcess = spawn('ffplay', [
    '-f', 'libndi_newtek',
    '-i', source,
    '-fs',
    '-an',
    '-loglevel', 'quiet'
  ], {
    env: { ...process.env, DISPLAY: display },
    detached: false
  });

  ndiProcess.on('exit', (code) => {
    console.log(`[ndi] ffplay exited (${code})`);
    ndiProcess = null;
  });

  console.log(`[ndi] started ffplay for source: ${source}`);
}

function setVnc(serverWs) {
  stopNdi();
  stopVnc();

  const display = process.env.DISPLAY || ':0';
  x11vncProcess = spawn('x11vnc', [
    '-display', display,
    '-forever',
    '-nopw',
    '-quiet',
    '-rfbport', String(VNC_PORT)
  ], { detached: false });

  x11vncProcess.on('exit', (code) => {
    console.log(`[vnc] x11vnc exited (${code})`);
    x11vncProcess = null;
  });

  setTimeout(() => connectVncBridge(serverWs), 1500);
  console.log('[vnc] started x11vnc');
}

function connectVncBridge(serverWs) {
  const wsUrl = `${SERVER_URL}/ws/vnc-upstream?pin=${PIN}`;
  vncBridgeWs = new WebSocket(wsUrl);

  vncBridgeWs.binaryType = 'nodebuffer';

  vncBridgeWs.on('open', () => {
    console.log('[vnc-bridge] upstream WS connected');
    vncBridgeSocket = net.createConnection(VNC_PORT, '127.0.0.1');

    vncBridgeSocket.on('data', (data) => {
      if (vncBridgeWs?.readyState === WebSocket.OPEN) {
        vncBridgeWs.send(data);
      }
    });

    vncBridgeSocket.on('error', (err) => {
      console.error('[vnc-bridge] socket error:', err.message);
    });

    vncBridgeSocket.on('close', () => {
      console.log('[vnc-bridge] socket closed');
      vncBridgeWs?.close();
    });
  });

  vncBridgeWs.on('message', (data) => {
    if (vncBridgeSocket && !vncBridgeSocket.destroyed) {
      vncBridgeSocket.write(data);
    }
  });

  vncBridgeWs.on('close', () => {
    console.log('[vnc-bridge] upstream WS closed');
    vncBridgeSocket?.destroy();
    vncBridgeSocket = null;
  });

  vncBridgeWs.on('error', (err) => {
    console.error('[vnc-bridge] WS error:', err.message);
  });
}

// ── NDI source discovery ──────────────────────────────────────────────────────

async function getNdiSources() {
  return new Promise((resolve) => {
    execFile('ndi-list-sources', [], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const sources = JSON.parse(stdout);
        resolve(Array.isArray(sources) ? sources : []);
      } catch {
        resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      }
    });
  });
}

// ── Audio ─────────────────────────────────────────────────────────────────────

async function getAudioSinks() {
  return new Promise((resolve) => {
    exec('pactl list sinks', { env: process.env }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const sinks = [];
      const blocks = stdout.split(/^Sink #/m).slice(1);
      for (const block of blocks) {
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
      { env: process.env },
      (err, stdout) => {
        if (err) { resolve({ sink: '', volume: 100, muted: false }); return; }
        const sink = stdout.match(/Default Sink:\s*(.+)/)?.[1]?.trim() || '';
        const volMatch = stdout.match(/(\d+)%/);
        const volume = volMatch ? parseInt(volMatch[1]) : 100;
        const muted = /Mute:\s*yes/i.test(stdout);
        resolve({ sink, volume, muted });
      }
    );
  });
}

// ── Server WebSocket connection ───────────────────────────────────────────────

let serverWs = null;
let reconnectDelay = 2000;

function connectToServer() {
  const wsUrl = `${SERVER_URL}/ws/device`;
  console.log(`[ws] connecting to ${wsUrl}`);

  serverWs = new WebSocket(wsUrl);

  serverWs.on('open', async () => {
    console.log('[ws] connected to server');
    reconnectDelay = 2000;
    serverWs.send(JSON.stringify({ type: 'register', pin: PIN }));
    startHeartbeat();
    startNdiPolling();
    // Send audio sinks asynchronously after registering
    try {
      const sinks = await getAudioSinks();
      const state = await getAudioState();
      if (serverWs?.readyState === WebSocket.OPEN) {
        serverWs.send(JSON.stringify({ type: 'audio_sinks', sinks, state }));
      }
    } catch (err) {
      console.error('[audio] failed to get audio info:', err.message);
    }
  });

  serverWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    console.log('[ws] command:', JSON.stringify(msg));

    if (msg.type === 'set_mode') {
      currentMode = msg.mode;
      switch (msg.mode) {
        case 'home':
          await setHome();
          break;
        case 'chromium':
          if (msg.url) await setChromium(msg.url);
          break;
        case 'ndi':
          if (msg.source) setNdi(msg.source);
          break;
        case 'vnc':
          setVnc(serverWs);
          break;
      }
    } else if (msg.type === 'refresh_ndi') {
      const sources = await getNdiSources();
      if (serverWs?.readyState === WebSocket.OPEN) {
        serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
      }
    } else if (msg.type === 'set_audio_output') {
      if (msg.sink) {
        execFile('pactl', ['set-default-sink', msg.sink], { env: process.env }, (err) => {
          if (err) console.error('[audio] set-default-sink error:', err.message);
        });
      }
    } else if (msg.type === 'set_volume') {
      const vol = Math.max(0, Math.min(100, parseInt(msg.volume) || 0));
      execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${vol}%`], { env: process.env }, (err) => {
        if (err) console.error('[audio] set-volume error:', err.message);
      });
    } else if (msg.type === 'set_mute') {
      execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', msg.muted ? '1' : '0'], { env: process.env }, (err) => {
        if (err) console.error('[audio] set-mute error:', err.message);
      });
    }
  });

  serverWs.on('close', () => {
    console.log(`[ws] disconnected; reconnecting in ${reconnectDelay}ms`);
    stopHeartbeat();
    stopNdiPolling();
    setTimeout(connectToServer, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  });

  serverWs.on('error', (err) => {
    console.error('[ws] error:', err.message);
  });
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

let heartbeatInterval = null;

function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    if (serverWs?.readyState === WebSocket.OPEN) {
      serverWs.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ── NDI polling ───────────────────────────────────────────────────────────────

let ndiPollInterval = null;

function startNdiPolling() {
  ndiPollInterval = setInterval(async () => {
    const sources = await getNdiSources();
    if (serverWs?.readyState === WebSocket.OPEN) {
      serverWs.send(JSON.stringify({ type: 'ndi_sources', sources }));
    }
  }, 20000);
}

function stopNdiPolling() {
  if (ndiPollInterval) { clearInterval(ndiPollInterval); ndiPollInterval = null; }
}

// ── Start ─────────────────────────────────────────────────────────────────────

connectToServer();

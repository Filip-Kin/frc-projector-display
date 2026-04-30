const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/novnc', express.static(path.join(__dirname, '../node_modules/@novnc/novnc')));

app.get('/', (req, res) => res.redirect('/control'));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, '../public/control.html')));
app.get('/vnc/:pin', (req, res) => res.sendFile(path.join(__dirname, '../public/vnc.html')));

app.get('/api/nexus/events', (req, res) => {
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) { res.json([]); return; }
  https.get({
    hostname: 'frc.nexus',
    path: '/api/v1/events',
    headers: { 'Nexus-Api-Key': apiKey }
  }, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const raw = JSON.parse(data);
        const now = Date.now();
        const events = Object.entries(raw)
          .filter(([, e]) => e.end > now)
          .map(([key, e]) => ({ key, name: e.name, start: e.start }))
          .sort((a, b) => a.start - b.start);
        res.json(events);
      } catch { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

// State maps
const devices = new Map();      // pin -> { ws, ndiSources, lastSeen }
const controllers = new Map();  // pin -> ws
const vncUpstream = new Map();  // pin -> ws  (device VNC bridge)
const vncClients = new Map();   // pin -> ws  (phone noVNC)

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const parsed = url.parse(request.url, true);
  const { pathname, query } = parsed;
  const pin = query.pin;

  if (pathname === '/ws/device') {
    wss.handleUpgrade(request, socket, head, (ws) => handleDevice(ws));
  } else if (pathname === '/ws/control' && pin) {
    wss.handleUpgrade(request, socket, head, (ws) => handleController(ws, pin));
  } else if (pathname === '/ws/vnc-upstream' && pin) {
    wss.handleUpgrade(request, socket, head, (ws) => handleVncUpstream(ws, pin));
  } else if (pathname === '/ws/vnc-client' && pin) {
    wss.handleUpgrade(request, socket, head, (ws) => handleVncClient(ws, pin));
  } else {
    socket.destroy();
  }
});

function handleDevice(ws) {
  let pin = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'register') {
      pin = (msg.pin || '').toUpperCase();
      if (!pin) return;
      devices.set(pin, { ws, ndiSources: [], lastSeen: Date.now() });
      console.log(`[device] registered PIN ${pin}`);
      const ctrl = controllers.get(pin);
      if (ctrl?.readyState === WebSocket.OPEN) {
        ctrl.send(JSON.stringify({ type: 'device_connected' }));
      }
    } else if (msg.type === 'heartbeat') {
      if (pin && devices.has(pin)) devices.get(pin).lastSeen = Date.now();
    } else if (msg.type === 'ndi_sources') {
      if (pin && devices.has(pin)) {
        devices.get(pin).ndiSources = msg.sources || [];
        const ctrl = controllers.get(pin);
        if (ctrl?.readyState === WebSocket.OPEN) {
          ctrl.send(JSON.stringify({ type: 'ndi_sources', sources: msg.sources }));
        }
      }
    } else if (msg.type === 'audio_sinks') {
      if (pin && devices.has(pin)) {
        const d = devices.get(pin);
        d.audioSinks = msg.sinks || [];
        d.audioState = msg.state || {};
        const ctrl = controllers.get(pin);
        if (ctrl?.readyState === WebSocket.OPEN) {
          ctrl.send(JSON.stringify({ type: 'audio_sinks', sinks: msg.sinks, state: msg.state }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (!pin) return;
    devices.delete(pin);
    console.log(`[device] ${pin} disconnected`);
    const ctrl = controllers.get(pin);
    if (ctrl?.readyState === WebSocket.OPEN) {
      ctrl.send(JSON.stringify({ type: 'device_disconnected' }));
    }
  });
}

function handleController(ws, rawPin) {
  const pin = rawPin.toUpperCase();
  controllers.set(pin, ws);
  console.log(`[controller] connected for PIN ${pin}`);

  const device = devices.get(pin);
  ws.send(JSON.stringify(device
    ? { type: 'device_connected', ndiSources: device.ndiSources, audioSinks: device.audioSinks, audioState: device.audioState }
    : { type: 'device_disconnected' }
  ));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const dev = devices.get(pin);
    if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Device not connected' }));
      return;
    }
    dev.ws.send(JSON.stringify(msg));
  });

  ws.on('close', () => {
    if (controllers.get(pin) === ws) controllers.delete(pin);
  });
}

function handleVncUpstream(ws, rawPin) {
  const pin = rawPin.toUpperCase();
  vncUpstream.set(pin, ws);
  console.log(`[vnc-upstream] connected for PIN ${pin}`);

  ws.on('message', (data) => {
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) client.send(data);
  });

  ws.on('close', () => {
    vncUpstream.delete(pin);
    const client = vncClients.get(pin);
    if (client?.readyState === WebSocket.OPEN) client.close();
  });
}

function handleVncClient(ws, rawPin) {
  const pin = rawPin.toUpperCase();
  vncClients.set(pin, ws);
  console.log(`[vnc-client] connected for PIN ${pin}`);

  ws.on('message', (data) => {
    const upstream = vncUpstream.get(pin);
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
  });

  ws.on('close', () => {
    if (vncClients.get(pin) === ws) vncClients.delete(pin);
  });
}

server.listen(PORT, () => console.log(`Display server on port ${PORT}`));

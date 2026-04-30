import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { parse } from 'url';
import { join } from 'path';

import { handleDevice, handleController, handleVncUpstream, handleVncClient } from './hub.js';
import { registerRoutes } from './routes.js';
import { requireAuth, handleLogin } from './auth.js';
import { adminRouter } from './admin.js';

// DB initialises on import (creates tables, bootstraps admin user)
import './db.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Static files
app.use(express.static(join(import.meta.dir, '../public')));
app.use('/novnc', express.static(join(import.meta.dir, '../node_modules/@novnc/novnc')));

// Auth
app.post('/auth/login', handleLogin);

// Admin panel
app.get('/admin', (_req, res) =>
  res.sendFile(join(import.meta.dir, '../public/admin.html'))
);
app.use('/api/admin', adminRouter);

// App routes
app.get('/', (_req, res) => res.redirect('/control'));
app.get('/control', (_req, res) => res.sendFile(join(import.meta.dir, '../public/control.html')));
app.get('/vnc/:pin', (_req, res) => res.sendFile(join(import.meta.dir, '../public/vnc.html')));

// Distribution + misc routes
registerRoutes(app);

// HTTP + WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = parse(req.url ?? '', true);
  const pin = query.pin as string | undefined;

  if (pathname === '/ws/device') {
    wss.handleUpgrade(req, socket, head, (ws) => handleDevice(ws));
  } else if (pathname === '/ws/control' && pin) {
    wss.handleUpgrade(req, socket, head, (ws) => handleController(ws, pin));
  } else if (pathname === '/ws/vnc-upstream' && pin) {
    wss.handleUpgrade(req, socket, head, (ws) => handleVncUpstream(ws, pin));
  } else if (pathname === '/ws/vnc-client' && pin) {
    wss.handleUpgrade(req, socket, head, (ws) => handleVncClient(ws, pin));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

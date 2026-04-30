import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { devices } from './hub.js';

export const adminRouter = Router();

// All routes below require auth
adminRouter.use(requireAuth);

// Current device list with state
adminRouter.get('/devices', (_req, res) => {
  const list = Array.from(devices.entries()).map(([pin, d]) => ({
    pin,
    version: d.version ?? 'unknown',
    hasInternet: d.hasInternet ?? null,
    lastSeen: d.lastSeen,
    ndiSourceCount: d.ndiSources.length,
    audioSinkCount: d.audioSinks.length,
  }));
  res.json(list);
});

// Recent logs for a device
adminRouter.get('/devices/:pin/logs', (req, res) => {
  const pin = req.params.pin.toUpperCase();
  const rows = db.query<{ ts: number; level: string; msg: string }, string>(
    'SELECT ts, level, msg FROM device_logs WHERE pin = ? ORDER BY id DESC LIMIT 200'
  ).all(pin).reverse();
  res.json(rows);
});

// List users
adminRouter.get('/users', (_req, res) => {
  const rows = db.query<{ id: number; username: string; created_at: number }, []>(
    'SELECT id, username, created_at FROM users ORDER BY id'
  ).all();
  res.json(rows);
});

// Create user
adminRouter.post('/users', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) { res.status(400).json({ error: 'username and password required' }); return; }
  if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
    res.json({ id: info.lastInsertRowid, username });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

// Delete user
adminRouter.delete('/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  // Prevent deleting the last user
  const count = (db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM users').get()?.n ?? 0);
  if (count <= 1) { res.status(400).json({ error: 'Cannot delete the last admin user' }); return; }
  db.run('DELETE FROM users WHERE id = ?', [id]);
  res.json({ ok: true });
});

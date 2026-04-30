import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const SECRET = process.env.ADMIN_SECRET;

if (!SECRET) {
  console.warn('[auth] ADMIN_SECRET not set — admin panel will be disabled');
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!SECRET) {
    res.status(503).json({ error: 'Admin panel not configured (ADMIN_SECRET missing)' });
    return;
  }
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function handleLogin(req: Request, res: Response) {
  if (!SECRET) { res.status(503).json({ error: 'Admin panel not configured' }); return; }
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) { res.status(400).json({ error: 'Username and password required' }); return; }

  const row = db.query<{ id: number; password_hash: string }, string>(
    'SELECT id, password_hash FROM users WHERE username = ?'
  ).get(username);

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ id: row.id, username }, SECRET, { expiresIn: '24h' });
  res.json({ token });
}

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import bcrypt from 'bcryptjs';

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, '../../data/admin.db');

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);

db.run(`CREATE TABLE IF NOT EXISTS users (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`);

db.run(`CREATE TABLE IF NOT EXISTS device_logs (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  pin  TEXT    NOT NULL,
  ts   INTEGER NOT NULL,
  level TEXT   NOT NULL,
  msg  TEXT    NOT NULL
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_logs_pin ON device_logs(pin)`);

// Bootstrap initial admin user from env vars (safe to call on every restart)
const initUser = process.env.ADMIN_INIT_USER;
const initPass = process.env.ADMIN_INIT_PASS;
if (initUser && initPass) {
  const existing = db.query('SELECT id FROM users WHERE username = ?').get(initUser);
  if (!existing) {
    const hash = bcrypt.hashSync(initPass, 10);
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [initUser, hash]);
    console.log(`[auth] Created initial admin user: ${initUser}`);
  }
}

const insertLogStmt = db.prepare(
  'INSERT INTO device_logs (pin, ts, level, msg) VALUES (?, ?, ?, ?)'
);
const pruneLogStmt = db.prepare(
  `DELETE FROM device_logs WHERE pin = ? AND id NOT IN (
     SELECT id FROM device_logs WHERE pin = ? ORDER BY id DESC LIMIT 500
   )`
);

export function insertLog(pin: string, level: string, msg: string) {
  insertLogStmt.run(pin, Date.now(), level, msg);
  pruneLogStmt.run(pin, pin);
}

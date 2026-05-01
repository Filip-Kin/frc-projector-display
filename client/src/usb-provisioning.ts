// USB drive provisioning fallback.
// Operator drops a `wifi.ini` file at the root of any USB stick:
//   ssid=NetworkName
//   password=secret
// We mount the drive read-only, parse, hand off to connectWifi, unmount.
//
// Detection: udevadm monitor for instant block-add events, plus a one-shot
// scan at startup so a USB plugged in *before* boot still works.

import { spawn, execFile } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';

const MOUNT_BASE = '/run/frc-display-usb';
const MAX_INI_BYTES = 4096;

type CredCallback = (ssid: string, password: string, source: string) => Promise<void> | void;

interface BlockDev { name: string; fstype: string; mountpoint: string; }

let monitorProc: ReturnType<typeof spawn> | null = null;
let onCredsCb: CredCallback | null = null;
const processed = new Set<string>();   // dev paths we've already tried this session
let pollDebounce: ReturnType<typeof setTimeout> | null = null;

function lsblkUsb(): Promise<BlockDev[]> {
  return new Promise((resolve) => {
    execFile('lsblk', ['-J', '-o', 'NAME,FSTYPE,MOUNTPOINT,TRAN,RM,TYPE'], (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const data = JSON.parse(stdout);
        const out: BlockDev[] = [];
        const walk = (node: any, parentTran?: string) => {
          const tran = node.tran || parentTran;
          // We want partitions or whole disks that have a filesystem AND are USB or removable
          const isRemovable = node.rm === true || node.rm === '1' || tran === 'usb';
          const hasFs = !!node.fstype;
          if (hasFs && isRemovable) {
            out.push({
              name: `/dev/${node.name}`,
              fstype: node.fstype,
              mountpoint: node.mountpoint || '',
            });
          }
          if (node.children) for (const c of node.children) walk(c, tran);
        };
        for (const top of data.blockdevices || []) walk(top);
        resolve(out);
      } catch { resolve([]); }
    });
  });
}

function safeBaseName(dev: string): string {
  // /dev/sda1 → sda1
  return path.basename(dev).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function mount(dev: string, mountPoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/bin/frc-usb-mount', dev, mountPoint], { timeout: 8000 },
      (err, _o, stderr) => err ? reject(new Error(stderr || err.message)) : resolve());
  });
}

async function unmount(mountPoint: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('sudo', ['/usr/local/bin/frc-usb-unmount', mountPoint], { timeout: 5000 },
      () => resolve());
  });
}

function parseIni(text: string): { ssid?: string; password?: string } {
  const out: { ssid?: string; password?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = line.slice(eq + 1).trim();
    if (k === 'ssid')                          out.ssid = v;
    else if (k === 'password' || k === 'psk')  out.password = v;
  }
  return out;
}

async function tryDevice(dev: BlockDev): Promise<{ ssid: string; password: string } | null> {
  const mountPoint = `${MOUNT_BASE}/${safeBaseName(dev.name)}`;
  let mounted = false;
  try {
    await mount(dev.name, mountPoint);
    mounted = true;
    let text: string;
    try {
      text = await readFile(path.join(mountPoint, 'wifi.ini'), 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    if (text.length > MAX_INI_BYTES) {
      console.warn(`[usb] wifi.ini on ${dev.name} too large (${text.length} bytes), skipping`);
      return null;
    }
    const { ssid, password } = parseIni(text);
    if (!ssid) {
      console.warn(`[usb] wifi.ini on ${dev.name} has no ssid= line`);
      return null;
    }
    return { ssid, password: password ?? '' };
  } catch (e: any) {
    console.error(`[usb] ${dev.name}: ${e?.message ?? e}`);
    return null;
  } finally {
    if (mounted) await unmount(mountPoint);
  }
}

async function scan() {
  const devs = await lsblkUsb();
  for (const d of devs) {
    if (processed.has(d.name)) continue;
    processed.add(d.name);
    console.log(`[usb] checking ${d.name} (${d.fstype})`);
    const creds = await tryDevice(d);
    if (creds && onCredsCb) {
      console.log(`[usb] wifi.ini found on ${d.name}: SSID="${creds.ssid}"`);
      try { await onCredsCb(creds.ssid, creds.password, d.name); }
      catch (e: any) { console.error(`[usb] callback threw: ${e?.message}`); }
    }
  }
}

function scheduleScan() {
  if (pollDebounce) clearTimeout(pollDebounce);
  // Wait ~1.2s after a kernel block event — the partition node may not exist
  // yet at the instant the parent disk is announced.
  pollDebounce = setTimeout(() => { pollDebounce = null; scan().catch(() => {}); }, 1200);
}

export async function startUsbWatcher(cb: CredCallback): Promise<void> {
  if (monitorProc) return;
  onCredsCb = cb;

  // One-shot scan at startup catches USB sticks plugged in before boot/AP mode
  await scan().catch(() => {});

  monitorProc = spawn('udevadm', ['monitor', '--kernel', '--subsystem-match=block'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  monitorProc.stdout?.on('data', (data: Buffer) => {
    if (!data.toString().includes('add')) return;
    scheduleScan();
  });
  monitorProc.on('exit', (code) => {
    console.error(`[usb] udevadm monitor exited code=${code}`);
    monitorProc = null;
  });
  console.log('[usb] watcher started');
}

export function stopUsbWatcher(): void {
  if (pollDebounce) { clearTimeout(pollDebounce); pollDebounce = null; }
  if (monitorProc) {
    try { monitorProc.kill('SIGTERM'); } catch {}
    monitorProc = null;
  }
  onCredsCb = null;
  processed.clear();
  console.log('[usb] watcher stopped');
}

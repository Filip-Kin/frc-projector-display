import { execFile } from 'child_process';
import type { NdiSource } from './types.js';

// NDI, OMT and omtx sources from avahi. The script ships in the client bundle, so a client
// update changes it on installed boxes too.
const INSTALL_DIR = process.env.INSTALL_DIR ?? '/opt/frc-projector-display/client';

export function getNdiSources(): Promise<NdiSource[]> {
  return new Promise((resolve) => {
    execFile('python3', [`${INSTALL_DIR}/sources.py`], { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const s = JSON.parse(stdout);
        resolve(Array.isArray(s) ? s : []);
      } catch {
        resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      }
    });
  });
}

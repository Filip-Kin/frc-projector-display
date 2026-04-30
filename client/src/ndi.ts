import { execFile } from 'child_process';
import type { NdiSource } from './types.js';

export function getNdiSources(): Promise<NdiSource[]> {
  return new Promise((resolve) => {
    execFile('ndi-list-sources', [], { timeout: 5000 }, (err, stdout) => {
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

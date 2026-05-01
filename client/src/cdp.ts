import http from 'http';
import { WebSocket } from 'ws';

const CHROMIUM_DEBUG_PORT = parseInt(process.env.CHROMIUM_DEBUG_PORT ?? '9222', 10);

export function cdpGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CHROMIUM_DEBUG_PORT, path }, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

export async function cdpNavigate(targetUrl: string): Promise<void> {
  // Retry up to ~30s. Chromium's --remote-debugging-port often isn't listening
  // for several seconds after boot, and an unretried failure here leaves the
  // kiosk frozen on the about:blank it was launched with (white screen).
  let lastErr: any = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const targets = await cdpGet('/json');
      if (!targets?.length) { lastErr = new Error('no targets'); }
      else {
        const page = targets.find((t: any) => t.type === 'page') ?? targets[0];
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        await new Promise<void>((res) => {
          ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: targetUrl } }));
          ws.once('message', () => { ws.close(); res(); });
          setTimeout(() => { ws.close(); res(); }, 3000);
        });
        console.log(`[cdp] navigated to ${targetUrl}${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
        return;
      }
    } catch (err: any) { lastErr = err; }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error(`[cdp] navigate to ${targetUrl} failed after retries: ${lastErr?.message ?? lastErr}`);
}

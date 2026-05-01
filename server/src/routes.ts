import type { Application } from 'express';
import { join } from 'path';
import https from 'https';
import QRCode from 'qrcode';

// ── Shared kiosk pages ──────────────────────────────────────────────────────
// Single source of truth for screens that need to look identical between the
// daemon (full thin-client) and the lite browser kiosk. The daemon's `/`
// route redirects here when it's online; the lite page navigates its
// stage iframe here for the home view.

async function renderQrPage(opts: { pin: string; controlUrl: string; serverHost: string; version?: string }) {
  const qr = await QRCode.toDataURL(opts.controlUrl, {
    width: 320, margin: 2, color: { dark: '#000', light: '#fff' },
  });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FRC Display</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;gap:28px}h1{font-size:2.4rem;font-weight:700;letter-spacing:.02em}.qr-box{background:#fff;padding:16px;border-radius:16px;box-shadow:0 0 60px #4af4}.qr-box img{display:block;width:280px;height:280px}.pin-label{font-size:1rem;color:#aaa;margin-bottom:4px}.pin{font-size:3rem;font-weight:800;letter-spacing:.25em;color:#4af}.url{font-size:.85rem;color:#555;word-break:break-all;text-align:center;max-width:480px}.version{font-size:1rem;color:#777;position:fixed;bottom:12px;right:16px}</style>
</head><body>
<h1>Configure Display</h1>
<div class="qr-box"><img src="${qr}" alt="QR"></div>
<div><div class="pin-label">PIN</div><div class="pin">${opts.pin}</div></div>
<div class="url">${opts.serverHost}</div>
${opts.version ? `<div class="version">v${opts.version}</div>` : ''}
</body></html>`;
}

interface NexusEvent { key: string; name: string; start: number; end: number; }
interface TbaEvent { key: string; name: string; year?: number; }

// ── Shared TBA helpers ──────────────────────────────────────────────────────
// We fetch TBA event lists + per-event details a few different ways (rankings
// fallback, webcast aggregation), so the helpers + caches live module-scope.

const tbaEventsByYear = new Map<number, { ts: number; events: TbaEvent[] }>();
const tbaEventCache   = new Map<string, { ts: number; status: number; body: string }>();
// Maps Nexus key -> TBA key, OR Nexus key -> null to short-circuit known
// unresolvable events (Worlds practice fields, demo events, etc.) on
// subsequent /api/webcasts calls without re-walking the full TBA event list.
const resolvedTbaKey  = new Map<string, string | null>();
const nexusEventsCache: { ts: number; events: NexusEvent[] } = { ts: 0, events: [] };

function tbaGet(path: string): Promise<{ status: number; body: string }> {
  const apiKey = process.env.TBA_API_KEY;
  return new Promise((resolve) => {
    if (!apiKey) return resolve({ status: 503, body: '"TBA_API_KEY not set"' });
    const req = https.get({
      hostname: 'www.thebluealliance.com',
      path: `/api/v3${path}`,
      headers: { 'X-TBA-Auth-Key': apiKey, 'User-Agent': 'frc-projector-display' },
      timeout: 5000,
    }, r => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => resolve({ status: r.statusCode ?? 502, body: data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: '' }); });
    req.on('error',   ()  => resolve({ status: 502, body: '' }));
  });
}

async function fetchTbaEventsSimple(year: number): Promise<TbaEvent[]> {
  const c = tbaEventsByYear.get(year);
  if (c && Date.now() - c.ts < 86_400_000) return c.events;
  const r = await tbaGet(`/events/${year}/simple`);
  if (r.status !== 200) return [];
  try {
    const events = JSON.parse(r.body) as TbaEvent[];
    tbaEventsByYear.set(year, { ts: Date.now(), events });
    return events;
  } catch { return []; }
}

async function fetchTbaEvent(eventKey: string): Promise<any | null> {
  const c = tbaEventCache.get(eventKey);
  if (c && Date.now() - c.ts < 300_000) {
    if (c.status !== 200) return null;
    try { return JSON.parse(c.body); } catch { return null; }
  }
  const r = await tbaGet(`/event/${encodeURIComponent(eventKey)}`);
  tbaEventCache.set(eventKey, { ts: Date.now(), status: r.status, body: r.body });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

function fetchNexusEvents(): Promise<NexusEvent[]> {
  if (Date.now() - nexusEventsCache.ts < 60_000) return Promise.resolve(nexusEventsCache.events);
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) return Promise.resolve([]);
  return new Promise(resolve => {
    https.get({
      hostname: 'frc.nexus',
      path: '/api/v1/events',
      headers: { 'Nexus-Api-Key': apiKey },
    }, r => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => {
        try {
          const raw = JSON.parse(data) as Record<string, { end: number; name: string; start: number }>;
          const now = Date.now();
          const events: NexusEvent[] = Object.entries(raw)
            .filter(([, e]) => e.end > now)
            .map(([key, e]) => ({ key, name: e.name, start: e.start, end: e.end }));
          nexusEventsCache.ts = Date.now();
          nexusEventsCache.events = events;
          resolve(events);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// Strip a trailing "(eventKey)" suffix and normalize for matching. Both
// sides usually return identical names (e.g. "Johnson Division") so an
// exact compare nails it — token overlap is just a backup.
function normEventName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}
const TOKEN_STOPWORDS = new Set([
  'championship','first','division','event','district','regional','offseason','frc',
  'presented','by','the','of','at','on','for','and','tournament','competition',
]);
function nameTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w && !TOKEN_STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
}

async function resolveNexusKeyToTba(nexusKey: string): Promise<string | null> {
  if (resolvedTbaKey.has(nexusKey)) return resolvedTbaKey.get(nexusKey) ?? null;
  const yearMatch = nexusKey.match(/^(\d{4})/);
  if (!yearMatch) { resolvedTbaKey.set(nexusKey, null); return null; }
  const year = parseInt(yearMatch[1], 10);
  const [nexusEvents, tbaEvents] = await Promise.all([
    fetchNexusEvents(), fetchTbaEventsSimple(year),
  ]);
  const nexus = nexusEvents.find(e => e.key === nexusKey);
  if (!nexus) { resolvedTbaKey.set(nexusKey, null); return null; }

  // Primary: exact normalized name match
  const want = normEventName(nexus.name);
  if (want) {
    const hit = tbaEvents.find(e => normEventName(e.name) === want);
    if (hit) {
      resolvedTbaKey.set(nexusKey, hit.key);
      console.log(`[tba] resolved nexus=${nexusKey} -> tba=${hit.key} (exact name)`);
      return hit.key;
    }
  }

  // Fallback: token overlap with stopwords stripped
  const wantTok = nameTokens(nexus.name);
  let best = { key: '', score: 0 };
  for (const e of tbaEvents) {
    const haveTok = nameTokens(e.name);
    let score = 0;
    for (const t of wantTok) if (haveTok.has(t)) score++;
    if (score > best.score) best = { key: e.key, score };
  }
  if (best.key && best.score > 0) {
    resolvedTbaKey.set(nexusKey, best.key);
    console.log(`[tba] resolved nexus=${nexusKey} -> tba=${best.key} (token overlap=${best.score})`);
    return best.key;
  }
  resolvedTbaKey.set(nexusKey, null);
  console.log(`[tba] could not resolve nexus=${nexusKey} (name=${JSON.stringify(nexus.name)})`);
  return null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function registerRoutes(app: Application) {
  // Self-hosted distribution endpoints
  app.get('/version.json', (_req, res) => {
    try {
      const pkg = require('../client-dist/package.json');
      res.json({ version: pkg.version });
    } catch { res.json({ version: '0.0.0' }); }
  });

  app.get('/install.sh', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(join(import.meta.dir, '../client-dist/install.sh'));
  });

  // QR / home screen — used by both daemon (redirects here from its local /
  // route when online) and lite (iframes here for home mode). Single source
  // of truth so both look identical.
  app.get('/qr', async (req, res) => {
    const pin = String(req.query.pin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!pin) { res.status(400).send('missing pin'); return; }
    const controlUrl = `${req.protocol === 'http' ? 'http' : 'https'}://${req.get('host') ?? 'display.filipkin.com'}/control?pin=${pin}`;
    const serverHost = req.get('host') ?? 'display.filipkin.com';
    const version = req.query.version ? String(req.query.version) : undefined;
    res.send(await renderQrPage({ pin, controlUrl, serverHost, version }));
  });

  // Per-event status proxy — projector queuing pages poll this every 15s.
  // Caches per eventKey for 5s so multiple displays sharing one event don't
  // each round-trip to Nexus.
  const eventCache = new Map<string, { ts: number; body: string; status: number }>();
  app.get('/api/nexus/event/:eventKey', (req, res) => {
    const apiKey = process.env.NEXUS_API_KEY;
    const key = req.params.eventKey;
    if (!apiKey) { res.status(500).json({ error: 'NEXUS_API_KEY not set' }); return; }
    if (!/^[a-zA-Z0-9]+$/.test(key)) { res.status(400).json({ error: 'bad event key' }); return; }

    const cached = eventCache.get(key);
    if (cached && Date.now() - cached.ts < 5000) {
      res.status(cached.status).type('application/json').send(cached.body);
      return;
    }

    https.get({
      hostname: 'frc.nexus',
      path: `/api/v1/event/${encodeURIComponent(key)}`,
      headers: { 'Nexus-Api-Key': apiKey },
    }, (r) => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => {
        const status = r.statusCode ?? 502;
        eventCache.set(key, { ts: Date.now(), body: data, status });
        res.status(status).type('application/json').send(data);
      });
    }).on('error', (err) => {
      res.status(502).json({ error: err.message });
    });
  });

  // TBA rankings — caller passes a Nexus event key; we try TBA directly
  // first, fall back to fuzzy-matching the event name against TBA's
  // /events/{year}/simple. This handles the World Championship case where
  // Nexus uses keys like "2026johnson" but TBA uses "2026new" / "2026tx" /
  // division-suffixed parent keys.
  const rankingsCache = new Map<string, { ts: number; body: string; status: number }>();
  app.get('/api/tba/rankings/:eventKey', async (req, res) => {
    const apiKey = process.env.TBA_API_KEY;
    const key = req.params.eventKey;
    if (!apiKey) { res.status(503).json({ error: 'TBA_API_KEY not set on server' }); return; }
    if (!/^[a-z0-9]+$/i.test(key)) { res.status(400).json({ error: 'bad event key' }); return; }

    const cached = rankingsCache.get(key);
    if (cached && Date.now() - cached.ts < 30_000) {
      res.status(cached.status).type('application/json').send(cached.body);
      return;
    }

    try {
      let r = await tbaGet(`/event/${encodeURIComponent(key)}/rankings`);
      // TBA returns HTTP 200 with body 'null' (not 404) when the rankings
      // endpoint doesn't recognize the event key, so we fall back on either.
      const looksUnknown = r.status === 404 || (r.status === 200 && r.body.trim() === 'null');
      if (looksUnknown) {
        const tbaKey = await resolveNexusKeyToTba(key).catch(() => null);
        if (tbaKey && tbaKey !== key) r = await tbaGet(`/event/${encodeURIComponent(tbaKey)}/rankings`);
      }
      rankingsCache.set(key, { ts: Date.now(), body: r.body, status: r.status });
      res.status(r.status).type('application/json').send(r.body);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // Per-event, day-aware webcast pick. Returns today's webcast for the
  // event if one exists, else the most recent. queuing.html and the
  // daemon's /youtube page resolve event:<key> through this so they can
  // pick up a new day's stream automatically without a config change.
  async function pickWebcastForEvent(eventKey: string): Promise<{
    eventKey: string; eventName?: string; date: string | null;
    kind: 'video' | 'channel'; id: string;
  } | null> {
    let tbaEv = await fetchTbaEvent(eventKey).catch(() => null);
    if (!tbaEv) {
      const resolved = await resolveNexusKeyToTba(eventKey).catch(() => null);
      if (resolved) tbaEv = await fetchTbaEvent(resolved).catch(() => null);
    }
    if (!tbaEv?.webcasts?.length) return null;
    const yts = tbaEv.webcasts.filter((w: any) => w.type === 'youtube' && w.channel);
    if (!yts.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const todayHit = yts.find((w: any) => w.date === today);
    const pick = todayHit ?? [...yts].sort((a: any, b: any) =>
      (b.date || '').localeCompare(a.date || ''))[0];
    const isVideo = /^[A-Za-z0-9_-]{11}$/.test(pick.channel);
    return {
      eventKey, eventName: tbaEv.name,
      date: pick.date || null,
      kind: isVideo ? 'video' : 'channel',
      id: pick.channel,
    };
  }

  app.get('/api/webcast-for/:eventKey', async (req, res) => {
    const key = req.params.eventKey;
    if (!/^[a-z0-9]+$/i.test(key)) { res.status(400).json({ error: 'bad event key' }); return; }
    try {
      const w = await pickWebcastForEvent(key);
      if (!w) { res.status(404).json({ error: 'no webcast for event' }); return; }
      res.json(w);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // Server-side YouTube embed page. Mirror of the daemon's local /youtube
  // so the lite kiosk (no daemon) can iframe it from the public origin.
  // Same handler shape: ?v= | ?channel= | ?event=. Loads muted, unmutes
  // via the IFrame API after onReady, seeks to live edge for streams.
  function buildYtSrc(spec: { kind: 'video' | 'channel'; id: string }) {
    const common = 'autoplay=1&mute=1&enablejsapi=1';
    if (spec.kind === 'channel') return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(spec.id)}&${common}`;
    return `https://www.youtube.com/embed/${encodeURIComponent(spec.id)}?${common}&rel=0`;
  }
  app.get('/youtube', async (req, res) => {
    const v  = String(req.query.v ?? '').trim();
    const ch = String(req.query.channel ?? '').trim();
    const ev = String(req.query.event ?? '').trim();
    let src = '';
    if (ch) src = buildYtSrc({ kind: 'channel', id: ch });
    else if (v) src = buildYtSrc({ kind: 'video', id: v });
    else if (ev) {
      const w = await pickWebcastForEvent(ev).catch(() => null);
      if (w?.id) src = buildYtSrc({ kind: w.kind === 'channel' ? 'channel' : 'video', id: w.id });
    }
    if (!src) { res.status(404).send('no stream available'); return; }

    // Page reloads itself hourly so an event:KEY-resolved page picks up a
    // new day's webcast without intervention.
    const reloadJs = ev ? `setTimeout(() => location.reload(), 60 * 60 * 1000);` : '';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden}
iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}
</style></head><body>
<iframe id="yt" src="${src}" allow="autoplay;fullscreen" allowfullscreen></iframe>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
function onYouTubeIframeAPIReady() {
  const player = new YT.Player('yt', {
    events: {
      onReady: (e) => {
        setTimeout(() => {
          try {
            e.target.unMute();
            e.target.setVolume(100);
            e.target.seekTo(Number.MAX_SAFE_INTEGER, true);
          } catch {}
        }, 1200);
      }
    }
  });
}
${reloadJs}
</script>
</body></html>`);
  });

  // Drives the dropdown on /control. One row per event with an active webcast,
  // already resolved to today's-or-latest. Frontend just stores `event:<key>`
  // as the streamSource and re-resolves at render time, so day rollovers and
  // stream URL changes flow through without any operator action.
  app.get('/api/webcasts', async (_req, res) => {
    const events = await fetchNexusEvents();
    const out: any[] = [];
    for (const ev of events) {
      const w = await pickWebcastForEvent(ev.key).catch(() => null);
      if (!w) { console.log(`[webcasts] skip ${ev.key} (no tba match or no youtube)`); continue; }
      out.push({ ...w, eventName: ev.name });
      console.log(`[webcasts] ${ev.key}: today's-or-latest = ${w.date} ${w.kind}:${w.id}`);
    }
    res.json(out);
  });

  // Nexus events list (mirrors fetchNexusEvents shape so the control panel
  // populates from the cached version when it's warm)
  app.get('/api/nexus/events', async (_req, res) => {
    const events = await fetchNexusEvents();
    res.json(events.map(e => ({ key: e.key, name: e.name, start: e.start })));
  });
}

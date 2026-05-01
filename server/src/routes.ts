import type { Application } from 'express';
import { join } from 'path';
import https from 'https';

interface NexusEvent { key: string; name: string; start: number; end: number; }
interface TbaEvent { key: string; name: string; year?: number; }

// ── Shared TBA helpers ──────────────────────────────────────────────────────
// We fetch TBA event lists + per-event details a few different ways (rankings
// fallback, webcast aggregation), so the helpers + caches live module-scope.

const tbaEventsByYear = new Map<number, { ts: number; events: TbaEvent[] }>();
const tbaEventCache   = new Map<string, { ts: number; status: number; body: string }>();
const resolvedTbaKey  = new Map<string, string>();
const nexusEventsCache: { ts: number; events: NexusEvent[] } = { ts: 0, events: [] };

function tbaGet(path: string): Promise<{ status: number; body: string }> {
  const apiKey = process.env.TBA_API_KEY;
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('TBA_API_KEY not set'));
    https.get({
      hostname: 'www.thebluealliance.com',
      path: `/api/v3${path}`,
      headers: { 'X-TBA-Auth-Key': apiKey, 'User-Agent': 'frc-projector-display' },
    }, r => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => resolve({ status: r.statusCode ?? 502, body: data }));
    }).on('error', reject);
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
  if (resolvedTbaKey.has(nexusKey)) return resolvedTbaKey.get(nexusKey)!;
  const yearMatch = nexusKey.match(/^(\d{4})/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);
  const [nexusEvents, tbaEvents] = await Promise.all([
    fetchNexusEvents(), fetchTbaEventsSimple(year),
  ]);
  const nexus = nexusEvents.find(e => e.key === nexusKey);
  if (!nexus) return null;

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
  if (best.key) {
    resolvedTbaKey.set(nexusKey, best.key);
    console.log(`[tba] resolved nexus=${nexusKey} -> tba=${best.key} (token overlap=${best.score})`);
    return best.key;
  }
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

  // Aggregated youtube webcasts across currently-active Nexus events.
  // Drives the "Stream" dropdown on /control. Cached on top of the event/
  // events caches above, so this is cheap to call frequently.
  app.get('/api/webcasts', async (_req, res) => {
    const events = await fetchNexusEvents();
    const out: any[] = [];
    for (const ev of events) {
      let tbaEv = await fetchTbaEvent(ev.key).catch(() => null);
      if (!tbaEv) {
        const resolved = await resolveNexusKeyToTba(ev.key).catch(() => null);
        if (resolved) tbaEv = await fetchTbaEvent(resolved).catch(() => null);
      }
      if (!tbaEv?.webcasts) continue;
      for (const w of tbaEv.webcasts) {
        if (w.type !== 'youtube' || !w.channel) continue;
        // YouTube IDs are 11 chars [A-Za-z0-9_-]; channel IDs are longer
        // (usually 24 chars, prefix UC). The "channel" field in TBA holds
        // either, depending on how the event registered the webcast.
        const isVideo = /^[A-Za-z0-9_-]{11}$/.test(w.channel);
        out.push({
          eventKey: ev.key,
          eventName: ev.name,
          date: w.date || null,
          kind: isVideo ? 'video' : 'channel',
          id: w.channel,
        });
      }
    }
    // Today first, then by date ascending; ties keep array order
    const today = new Date().toISOString().slice(0, 10);
    out.sort((a, b) => {
      const aT = a.date === today ? 0 : 1;
      const bT = b.date === today ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return (a.date || '').localeCompare(b.date || '');
    });
    res.json(out);
  });

  // Nexus events list (mirrors fetchNexusEvents shape so the control panel
  // populates from the cached version when it's warm)
  app.get('/api/nexus/events', async (_req, res) => {
    const events = await fetchNexusEvents();
    res.json(events.map(e => ({ key: e.key, name: e.name, start: e.start })));
  });
}

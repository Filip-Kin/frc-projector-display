import type { Application } from 'express';
import { join } from 'path';
import https from 'https';

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

  // TBA rankings proxy — projector queuing pages call this for the rankings
  // widget. Caches per eventKey for 30s (rankings change slowly).
  const rankingsCache = new Map<string, { ts: number; body: string; status: number }>();
  app.get('/api/tba/rankings/:eventKey', (req, res) => {
    const apiKey = process.env.TBA_API_KEY;
    const key = req.params.eventKey;
    if (!apiKey) { res.status(503).json({ error: 'TBA_API_KEY not set on server' }); return; }
    if (!/^[a-z0-9]+$/i.test(key)) { res.status(400).json({ error: 'bad event key' }); return; }

    const cached = rankingsCache.get(key);
    if (cached && Date.now() - cached.ts < 30000) {
      res.status(cached.status).type('application/json').send(cached.body);
      return;
    }

    https.get({
      hostname: 'www.thebluealliance.com',
      path: `/api/v3/event/${encodeURIComponent(key)}/rankings`,
      headers: { 'X-TBA-Auth-Key': apiKey, 'User-Agent': 'frc-projector-display' },
    }, (r) => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => {
        const status = r.statusCode ?? 502;
        rankingsCache.set(key, { ts: Date.now(), body: data, status });
        res.status(status).type('application/json').send(data);
      });
    }).on('error', (err) => {
      res.status(502).json({ error: err.message });
    });
  });

  // Nexus events proxy
  app.get('/api/nexus/events', (_req, res) => {
    const apiKey = process.env.NEXUS_API_KEY;
    if (!apiKey) { res.json([]); return; }
    https.get({
      hostname: 'frc.nexus',
      path: '/api/v1/events',
      headers: { 'Nexus-Api-Key': apiKey },
    }, (r) => {
      let data = '';
      r.on('data', (c: string) => data += c);
      r.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const now = Date.now();
          const events = Object.entries(raw as Record<string, { end: number; name: string; start: number }>)
            .filter(([, e]) => e.end > now)
            .map(([key, e]) => ({ key, name: e.name, start: e.start }))
            .sort((a, b) => a.start - b.start);
          res.json(events);
        } catch { res.json([]); }
      });
    }).on('error', () => res.json([]));
  });
}

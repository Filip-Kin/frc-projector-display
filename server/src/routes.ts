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

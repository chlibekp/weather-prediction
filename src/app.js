import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { UpstreamError } from './data/openmeteo.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function parseCoord(value, limit) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export function createApp({ service, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/geocode', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ results: [] });
    res.json({ results: await service.geocode(q.slice(0, 100)) });
  });

  app.get('/api/forecast', async (req, res) => {
    const latitude = parseCoord(req.query.lat, 90);
    const longitude = parseCoord(req.query.lon, 180);
    if (latitude === null || longitude === null) {
      return res.status(400).json({ error: 'lat and lon query parameters are required' });
    }
    res.json(await service.forecast({ latitude, longitude }));
  });

  app.use(express.static(PUBLIC_DIR));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Express recognizes error handlers by their four parameters.
  app.use((err, _req, res, _next) => {
    if (err instanceof UpstreamError) {
      log.warn(err.message);
      return res.status(502).json({ error: 'Weather data provider is unavailable. Try again shortly.' });
    }
    log.error(err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  return app;
}

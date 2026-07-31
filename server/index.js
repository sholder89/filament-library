import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './db.js';
import { router as filamentsRouter } from './routes/filaments.js';
import { router as catalogRouter } from './routes/catalog.js';
import { router as printRouter, printMode } from './routes/print.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

app.disable('x-powered-by');

/**
 * Behind a reverse proxy, TLS is terminated upstream and the app is reached
 * over plain HTTP — so req.protocol would say "http" for an https:// site and
 * the QR codes would encode the wrong scheme. Trusting X-Forwarded-Proto fixes
 * that.
 *
 * Off by default: these headers are client-supplied, and trusting them on a
 * directly-exposed container would let a caller dictate the URL. Accepts
 * "true", a hop count, or a comma-separated list of trusted proxy addresses.
 * Setting APP_BASE_URL sidesteps this entirely.
 */
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
  const asNumber = Number(TRUST_PROXY);
  app.set(
    'trust proxy',
    TRUST_PROXY === 'true' ? true : Number.isInteger(asNumber) ? asNumber : TRUST_PROXY,
  );
}

app.use(express.json({ limit: '256kb' }));

/**
 * Inventory responses carry no validators, so a browser is free to reuse them
 * heuristically — which shows up as a phone opening the app and displaying data
 * that changed on another device. The service worker keeps its own copy for
 * offline use; Cache Storage is unaffected by this header.
 */
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, print_mode: printMode(), version: 1 });
});

app.use('/api/filaments', filamentsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/print', printRouter);

/** Whole-inventory dump, including used-up spools — handy as a backup. */
app.get('/api/export', (_req, res) => {
  res.set('Content-Disposition', `attachment; filename="filament-library-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    filaments: db.prepare('SELECT * FROM filaments ORDER BY created_at').all(),
  });
});

app.use(express.static(PUBLIC_DIR, {
  // index.html must revalidate or a stale shell can outlive a deploy.
  setHeaders: (res, path) => {
    if (path.endsWith('.html') || path.endsWith('sw.js')) {
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

// Client-side routes (/f/<id> is what the QR codes point at) fall through to
// the app shell, which reads the path and opens that spool.
app.get(/^\/(f\/.*)?$/, (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Filament Library listening on http://${HOST}:${PORT}  (label printing: ${printMode()})`);
});

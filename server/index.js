import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './db.js';
import { router as filamentsRouter, importHandler } from './routes/filaments.js';
import { router as catalogRouter } from './routes/catalog.js';
import { router as taresRouter, allTares } from './routes/tares.js';
import { router as appSettingsRouter } from './routes/app-settings.js';
import { router as printRouter, printMode } from './routes/print.js';
import { router as scanRouter, scanEnabled } from './routes/scan.js';

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

/*
 * Everything text — the app shell, the catalog, the QR SVGs — goes out gzipped.
 * It was all being served raw, which is around 1.3 MB on a first load, and the
 * phone this is built for is often the far side of a home connection. Binary
 * that's already compressed (the PNG icons) is left alone; compression skips it
 * by content type.
 *
 * In the app rather than on the reverse proxy because docker-compose also
 * publishes a LAN port straight to the container, and a Traefik middleware
 * would only cover the half of the traffic that goes through Traefik.
 */
app.use(compression());

/*
 * Mounted ahead of the global body parser with a much larger limit of its own:
 * a label photo is a megabyte or two of base64, where every other endpoint on
 * this app deals in small JSON and shouldn't have its guard relaxed to suit.
 */
app.use('/api/scan', express.json({ limit: '12mb' }), scanRouter);

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
  res.json({ ok: true, print_mode: printMode(), label_scan: scanEnabled(), version: 1 });
});

app.use('/api/filaments', filamentsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/tares', taresRouter);
app.use('/api/settings', appSettingsRouter);
app.use('/api/print', printRouter);

/**
 * The same inventory as a spreadsheet.
 *
 * This one is for reading, not for restoring — /api/import takes the JSON. So
 * the columns are named for people rather than matching the table, and the
 * grams left are worked out here instead of leaving you to write the formula.
 */
const CSV_COLUMNS = [
  ['ID',            (f) => f.id],
  ['Brand',         (f) => f.brand],
  ['Type',          (f) => f.material],
  ['Color',         (f) => f.color_name],
  ['Color hex',     (f) => f.color_hex],
  ['Finish',        (f) => f.finish],
  ['Status',        (f) => ({ new: 'Sealed', opened: 'Opened', empty: 'Used up' }[f.status] ?? f.status)],
  ['In printer',    (f) => (f.loaded ? 'Yes' : 'No')],
  ['Remaining %',   (f) => f.remaining_pct],
  ['Remaining g',   (f) => Math.round(f.spool_weight_g * f.remaining_pct / 100)],
  ['Spool size g',  (f) => f.spool_weight_g],
  ['Diameter mm',   (f) => f.diameter],
  ['Nozzle C',      (f) => f.nozzle_temp],
  ['Bed C',         (f) => f.bed_temp],
  ['Price',         (f) => f.price],
  ['Location',      (f) => f.location],
  ['Purchased',     (f) => date(f.purchased_at)],
  ['Opened',        (f) => date(f.opened_at)],
  ['Used up',       (f) => date(f.finished_at)],
  ['Added',         (f) => date(f.created_at)],
  ['Notes',         (f) => f.notes],
];

const date = (iso) => (iso ? String(iso).slice(0, 10) : '');

/**
 * RFC 4180. A field holding a comma, a quote or a line break is wrapped in
 * quotes and its own quotes doubled — which matters here because color names
 * and notes are free text, and a stray comma would otherwise shift every column
 * after it on that row.
 */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);

  /*
   * Excel and Sheets treat a cell starting = + @ - (or a tab) as a formula and
   * run it on open, so a color name or note typed into this app becomes code
   * on the machine of whoever opens the export. Prefixing with an apostrophe is
   * the standard defusing: spreadsheets read it as "this is text" and don't
   * display it, and anything else reading the CSV sees one stray character
   * rather than executing a HYPERLINK someone left in a notes field.
   */
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/export.csv', (_req, res) => {
  const rows = db.prepare('SELECT * FROM filaments ORDER BY brand COLLATE NOCASE, material COLLATE NOCASE, color_name COLLATE NOCASE').all();

  const csv = [
    CSV_COLUMNS.map(([name]) => csvCell(name)).join(','),
    ...rows.map((f) => CSV_COLUMNS.map(([, read]) => csvCell(read(f))).join(',')),
  ].join('\r\n');

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="filament-library-${new Date().toISOString().slice(0, 10)}.csv"`);
  // Excel on Windows assumes the system code page without this and mangles
  // anything non-ASCII — degree signs, accented brand names.
  res.send(`﻿${csv}`);
});

/** Whole-inventory dump, including used-up spools — handy as a backup. */
app.get('/api/export', (_req, res) => {
  res.set('Content-Disposition', `attachment; filename="filament-library-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    filaments: db.prepare('SELECT * FROM filaments ORDER BY created_at').all(),
    // Your own spool weights ride along. They're a handful of rows, and they're
    // the ones that can't be looked up again — a backup without them restores a
    // library that has quietly gone back to guessing.
    spool_tares: allTares(),
  });
});

/*
 * Restores an export. Bigger than the general limit because a large library is
 * a few hundred kilobytes of JSON, and being unable to read back a file this
 * app itself wrote would be a poor kind of backup.
 */
app.post('/api/import', express.json({ limit: '8mb' }), importHandler);

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

import { Router } from 'express';
import { db, newId, nowISO } from '../db.js';
import { importTares } from './tares.js';

export const router = Router();

const STATUSES = ['new', 'opened', 'empty'];

const SORTS = {
  newest:   'created_at DESC',
  oldest:   'created_at ASC',
  brand:    'brand COLLATE NOCASE ASC, material COLLATE NOCASE ASC, color_name COLLATE NOCASE ASC',
  material: 'material COLLATE NOCASE ASC, brand COLLATE NOCASE ASC',
  color:    'color_name COLLATE NOCASE ASC',
  opened:   'opened_at DESC',
  // What you're closest to running out of. Ties break on the smaller spool,
  // since 20% of a 250 g reel is a lot less filament than 20% of a kilo.
  remaining: 'remaining_pct ASC, spool_weight_g ASC',
};

/**
 * What's in a printer right now comes first under every sort. It's the handful
 * of spools you're most likely to be looking for, and it saves hunting for them
 * among a couple of hundred on the shelf.
 */
const LOADED_FIRST = 'loaded DESC';

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function hex(v, fallback = '#808080') {
  const s = str(v);
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback;
}

/** node:sqlite rejects undefined/boolean params, so everything lands as null|number|string. */
function num(v, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (v === undefined || v === null || str(v) === '') return null;
  const n = int ? parseInt(v, 10) : parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Accepts a date-only value from <input type="date"> or a full ISO timestamp. */
function isoDate(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const want = (k) => !partial || has(k);

  if (want('brand')) {
    out.brand = str(body.brand);
    if (!out.brand) throw new BadRequest('Brand is required.');
  }
  if (want('material')) {
    out.material = str(body.material);
    if (!out.material) throw new BadRequest('Material type is required.');
  }
  if (want('color_name')) out.color_name = str(body.color_name);
  if (want('color_hex'))  out.color_hex  = hex(body.color_hex);
  if (want('finish'))     out.finish     = str(body.finish);
  // Extra tones are optional — blank rather than defaulted, so the spool
  // graphic can tell "no second color" from "a second color that is grey".
  if (want('color_hex2')) out.color_hex2 = hex(body.color_hex2, '');
  if (want('color_hex3')) out.color_hex3 = hex(body.color_hex3, '');
  if (want('location'))   out.location   = str(body.location);
  if (want('notes'))      out.notes      = str(body.notes);

  if (want('diameter'))       out.diameter       = num(body.diameter, { min: 0.1, max: 10 }) ?? 1.75;
  if (want('spool_weight_g')) out.spool_weight_g = num(body.spool_weight_g, { min: 1, max: 100000, int: true }) ?? 1000;
  if (want('remaining_pct'))  out.remaining_pct  = num(body.remaining_pct, { min: 0, max: 100, int: true }) ?? 100;
  if (want('price'))          out.price          = num(body.price, { min: 0, max: 100000 });
  // Null rather than a default: "not weighed" and "weighed at 0 g" are
  // different, and only the first should fall back to the brand's typical spool.
  if (want('empty_spool_g'))  out.empty_spool_g  = num(body.empty_spool_g, { min: 0, max: 100000, int: true });
  if (want('nozzle_temp'))    out.nozzle_temp    = num(body.nozzle_temp, { min: 0, max: 600, int: true });
  if (want('bed_temp'))       out.bed_temp       = num(body.bed_temp, { min: 0, max: 300, int: true });

  if (want('purchased_at')) out.purchased_at = isoDate(body.purchased_at);
  if (has('opened_at'))     out.opened_at    = isoDate(body.opened_at);
  if (has('finished_at'))   out.finished_at  = isoDate(body.finished_at);

  // node:sqlite won't bind a boolean, so this lands as 0 or 1.
  if (want('loaded')) out.loaded = truthy(body.loaded) ? 1 : 0;

  if (want('status')) {
    out.status = str(body.status) || 'new';
    if (!STATUSES.includes(out.status)) {
      throw new BadRequest(`Status must be one of: ${STATUSES.join(', ')}.`);
    }
  }

  return out;
}

/** Accepts what JSON, a form and a query string each call true. */
const truthy = (v) => v === true || v === 1 || /^(1|true|yes|on)$/i.test(str(v));

/**
 * Keeps the lifecycle timestamps honest no matter which route did the writing:
 * opening stamps opened_at, emptying stamps finished_at and zeroes what's left,
 * and un-emptying clears finished_at so the spool reads as in-use again.
 */
function reconcileLifecycle(row) {
  const now = nowISO();
  if (row.status === 'opened') {
    if (!row.opened_at) row.opened_at = now;
    row.finished_at = null;
    if (row.remaining_pct === 0) row.remaining_pct = 100;
  } else if (row.status === 'empty') {
    if (!row.opened_at) row.opened_at = now;
    if (!row.finished_at) row.finished_at = now;
    row.remaining_pct = 0;
    // Whatever ran out has been taken out of the printer by definition.
    row.loaded = 0;
  } else if (row.status === 'new') {
    row.opened_at = null;
    row.finished_at = null;
    row.remaining_pct = 100;
  }
  return row;
}

const COLUMNS = [
  'brand', 'material', 'color_name', 'color_hex', 'color_hex2', 'color_hex3',
  'finish', 'diameter', 'spool_weight_g', 'empty_spool_g', 'remaining_pct',
  'status', 'loaded', 'location', 'notes', 'price', 'nozzle_temp', 'bed_temp',
  'purchased_at', 'opened_at', 'finished_at',
];

const getStmt = db.prepare('SELECT * FROM filaments WHERE id = ?');

export const getFilament = (id) => getStmt.get(id) ?? null;

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const where = [];
  const params = [];

  const multi = (value, column) => {
    const list = str(value).split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) return;
    where.push(`${column} IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  };

  multi(req.query.status, 'status');
  multi(req.query.brand, 'brand');
  multi(req.query.material, 'material');

  /*
   * Finish is a set — "Silk, Gradient" is one spool with two of them — so an
   * exact match would hide it from both the Silk filter and the Gradient one.
   * Matched against the comma-separated list instead, with separators added at
   * each end so "Silk" can't match "Silk Screen" halfway through a longer name.
   */
  const finishes = str(req.query.finish).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  if (finishes.length) {
    where.push(`(${finishes.map(() => `(', ' || finish || ', ') LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...finishes.map((f) => `%, ${f.replace(/[\\%_]/g, '\\$&')}, %`));
  }

  // Default view hides used-up spools; the record is still there behind
  // ?status=empty or ?include_empty=1.
  if (!str(req.query.status) && str(req.query.include_empty) !== '1') {
    where.push(`status != 'empty'`);
  }

  const q = str(req.query.q);
  if (q) {
    /*
     * Every word has to appear somewhere on the spool, but not all in the same
     * field. "purple translucent" is a colour and a finish, "Sunlu yellow" a
     * brand and a colour — matching each word against one column at a time
     * found neither, even though both words were plainly there.
     *
     * So the fields are joined into one string per row and each word tested
     * against that, ANDed together. Searching stays additive: every word you
     * add narrows the result, which is what typing more into a search box is
     * supposed to do.
     *
     * The columns are all NOT NULL — worth keeping that way, since one NULL
     * would make the whole concatenation NULL and the spool unfindable by any
     * of its other fields.
     */
    const HAYSTACK = "(brand || ' ' || material || ' ' || color_name || ' ' || finish || ' ' || location || ' ' || notes)";

    // Capped so a pasted paragraph can't turn into hundreds of scans.
    const words = q.split(/\s+/).filter(Boolean).slice(0, 8);

    // % and _ are LIKE's own wildcards: searching for either matched every row,
    // and "100% Cotton" or "shelf_a" could not be found at all.
    const like = (w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;

    // The id stays an exact whole-query match, so scanning a QR still lands on
    // the one spool rather than anything whose notes mention the code.
    where.push(`((${words.map(() => `${HAYSTACK} LIKE ? ESCAPE '\\'`).join(' AND ')}) OR id = ?)`);
    params.push(...words.map(like), q.toUpperCase());
  }

  const order = SORTS[str(req.query.sort)] || SORTS.newest;
  const sql = `SELECT * FROM filaments${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${LOADED_FIRST}, ${order}`;

  res.json(db.prepare(sql).all(...params));
});

// ── Stats ────────────────────────────────────────────────────────────────────

router.get('/stats', (_req, res) => {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM filaments GROUP BY status').all()) {
    byStatus[r.status] = r.n;
  }

  const active = db.prepare(`
    SELECT COALESCE(SUM(spool_weight_g * remaining_pct / 100.0), 0) AS grams
    FROM filaments WHERE status != 'empty'
  `).get().grams;

  res.json({
    ...byStatus,
    total: byStatus.new + byStatus.opened + byStatus.empty,
    active_grams: Math.round(active),
    brands: db.prepare(`SELECT COUNT(DISTINCT brand) AS n FROM filaments WHERE status != 'empty'`).get().n,
    materials: db.prepare(`SELECT COUNT(DISTINCT material) AS n FROM filaments WHERE status != 'empty'`).get().n,
  });
});

// ── Read one ─────────────────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const row = getFilament(req.params.id);
  if (!row) return res.status(404).json({ error: 'Filament not found.' });
  res.json(row);
});

// ── Create ───────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const body = req.body ?? {};
  const fields = readBody(body);

  const row = reconcileLifecycle({
    color_name: '', color_hex: '#808080', color_hex2: '', color_hex3: '',
    finish: '', diameter: 1.75,
    spool_weight_g: 1000, empty_spool_g: null, remaining_pct: 100,
    status: 'new', loaded: 0, location: '', notes: '', price: null,
    nozzle_temp: null, bed_temp: null,
    purchased_at: null, opened_at: null, finished_at: null,
    ...fields,
  });

  // An explicit opened_at in the payload implies the spool is already in use.
  if (fields.opened_at && row.status === 'new') {
    row.status = 'opened';
    row.opened_at = fields.opened_at;
  }

  const id = newId();
  const now = nowISO();

  db.prepare(`
    INSERT INTO filaments (id, ${COLUMNS.join(', ')}, created_at, updated_at)
    VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
  `).run(id, ...COLUMNS.map((c) => row[c]), now, now);

  // Support adding several identical spools in one go.
  const extra = Math.min(19, Math.max(0, (num(body.quantity, { min: 1, max: 20, int: true }) ?? 1) - 1));
  const created = [getFilament(id)];
  for (let i = 0; i < extra; i++) {
    const dupId = newId();
    db.prepare(`
      INSERT INTO filaments (id, ${COLUMNS.join(', ')}, created_at, updated_at)
      VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
    `).run(dupId, ...COLUMNS.map((c) => row[c]), now, now);
    created.push(getFilament(dupId));
  }

  res.status(201).json(created.length === 1 ? created[0] : created);
});

// ── Update ───────────────────────────────────────────────────────────────────

router.patch('/:id', (req, res) => {
  const existing = getFilament(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Filament not found.' });

  const fields = readBody(req.body ?? {}, { partial: true });
  const merged = { ...existing, ...fields };

  // Only re-derive timestamps when the status itself moved — otherwise editing
  // a note would silently rewrite the date you opened the spool.
  const row = fields.status && fields.status !== existing.status
    ? reconcileLifecycle(merged)
    : merged;

  db.prepare(`
    UPDATE filaments SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
    WHERE id = ?
  `).run(...COLUMNS.map((c) => row[c]), nowISO(), req.params.id);

  res.json(getFilament(req.params.id));
});

// ── Duplicate ────────────────────────────────────────────────────────────────

/**
 * Copies a spool's specs into fresh, sealed records — for when you buy another
 * of something you already have.
 *
 * The copy is deliberately not a clone: it starts sealed and full, with the
 * lifecycle dates and purchase details of the original left behind, since those
 * belong to that physical spool and not to this one.
 */
router.post('/:id/duplicate', (req, res) => {
  const source = getFilament(req.params.id);
  if (!source) return res.status(404).json({ error: 'Filament not found.' });

  const count = Math.min(20, Math.max(1, num(req.body?.quantity, { min: 1, max: 20, int: true }) ?? 1));
  const now = nowISO();

  const row = {
    ...source,
    status: 'new',
    remaining_pct: 100,
    // Only one physical spool is in the printer, and it isn't this new one.
    loaded: 0,
    opened_at: null,
    finished_at: null,
    purchased_at: null,
    price: null,
  };

  const insert = db.prepare(`
    INSERT INTO filaments (id, ${COLUMNS.join(', ')}, created_at, updated_at)
    VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
  `);

  const created = [];
  for (let i = 0; i < count; i++) {
    const id = newId();
    insert.run(id, ...COLUMNS.map((c) => row[c]), now, now);
    created.push(getFilament(id));
  }

  res.status(201).json(created.length === 1 ? created[0] : created);
});

// ── Lifecycle shortcuts ──────────────────────────────────────────────────────

function transition(id, status, res) {
  const existing = getFilament(id);
  if (!existing) return res.status(404).json({ error: 'Filament not found.' });

  const row = reconcileLifecycle({ ...existing, status });
  db.prepare(`
    UPDATE filaments SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
    WHERE id = ?
  `).run(...COLUMNS.map((c) => row[c]), nowISO(), id);

  res.json(getFilament(id));
}

router.post('/:id/open',    (req, res) => transition(req.params.id, 'opened', res));
router.post('/:id/empty',   (req, res) => transition(req.params.id, 'empty', res));
router.post('/:id/restore', (req, res) => transition(req.params.id, 'opened', res));
router.post('/:id/unopen',  (req, res) => transition(req.params.id, 'new', res));

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * Restores a file produced by /api/export.
 *
 * Defaults to merging: a spool whose id is already here is skipped rather than
 * overwritten, so importing the same backup twice is harmless and importing an
 * older one can't quietly revert edits you made since. `mode: 'replace'` empties
 * the library first, for restoring onto a clean install, and `mode: 'overwrite'`
 * takes the file's version of anything that clashes.
 *
 * Rows go through the same validation as a normal create, so a hand-edited file
 * can't put anything in the table that the API wouldn't accept. Ids are kept
 * when they're well-formed, which is what makes the merge idempotent and keeps
 * printed QR labels pointing at the right spool.
 */
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function importHandler(req, res, next) {
  try {
    const body = req.body ?? {};
    const rows = Array.isArray(body) ? body : body.filaments;
    if (!Array.isArray(rows)) {
      throw new BadRequest('That file has no "filaments" list — pick a file exported from this app.');
    }
    if (rows.length > 20000) throw new BadRequest('That file has too many spools to import at once.');

    const mode = str(body.mode) || 'merge';
    if (!['merge', 'overwrite', 'replace'].includes(mode)) {
      throw new BadRequest('Import mode must be merge, overwrite or replace.');
    }

    const insert = db.prepare(`
      INSERT INTO filaments (id, ${COLUMNS.join(', ')}, created_at, updated_at)
      VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE filaments SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
      WHERE id = ?
    `);

    const result = { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    // One transaction: a file that goes bad halfway through leaves no trace,
    // which matters most for 'replace' — it has already cleared the table.
    db.exec('BEGIN');
    try {
      if (mode === 'replace') db.exec('DELETE FROM filaments');

      for (const [i, raw] of rows.entries()) {
        try {
          const fields = readBody(raw ?? {});
          const row = reconcileLifecycle({
            color_name: '', color_hex: '#808080', color_hex2: '', color_hex3: '',
            finish: '', diameter: 1.75, spool_weight_g: 1000, empty_spool_g: null,
            remaining_pct: 100, status: 'new', loaded: 0, location: '', notes: '',
            price: null, nozzle_temp: null, bed_temp: null, purchased_at: null,
            opened_at: null, finished_at: null,
            ...fields,
          });

          const id = ID_RE.test(str(raw.id)) ? str(raw.id) : newId();
          const existing = getFilament(id);

          if (existing && mode === 'merge') { result.skipped += 1; continue; }

          // Keep the original timestamps where the file has usable ones — an
          // import shouldn't make a two-year-old spool look like it arrived
          // today, since that's what the default sort reads.
          const created = isoDate(raw.created_at) ?? nowISO();
          const updated = isoDate(raw.updated_at) ?? created;

          if (existing) {
            update.run(...COLUMNS.map((c) => row[c]), updated, id);
            result.updated += 1;
          } else {
            insert.run(id, ...COLUMNS.map((c) => row[c]), created, updated);
            result.imported += 1;
          }
        } catch (err) {
          result.failed += 1;
          // Enough to find the bad row without returning the whole file back.
          if (result.errors.length < 10) result.errors.push(`Row ${i + 1}: ${err.message}`);
        }
      }
      // Inside the same transaction, so a file that fails partway leaves the
      // spool weights alone too.
      result.tares = importTares(body.spool_tares);

      /*
       * 'replace' empties the table first, so a file that turns out to be
       * unreadable would otherwise commit the deletion and nothing else — the
       * whole library gone, in exchange for a report saying every row failed.
       * Nothing landing at all is the one case where that can't be what anyone
       * wanted, so it aborts instead.
       */
      if (mode === 'replace' && !result.imported && !result.updated) {
        // Thrown rather than rolled back here — the catch below owns that, and
        // rolling back twice is itself an error.
        throw new BadRequest(
          `Nothing in that file could be read (${result.failed} row${result.failed === 1 ? '' : 's'} failed), `
          + 'so the library has been left exactly as it was.',
        );
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ ...result, mode, total: rows.length });
  } catch (err) {
    next(err);
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * Real deletion, for spools entered by mistake. Running out of filament should
 * use /empty instead — that keeps the record for future reference.
 */
router.delete('/:id', (req, res) => {
  const existing = getFilament(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Filament not found.' });
  db.prepare('DELETE FROM filaments WHERE id = ?').run(req.params.id);
  res.json({ ok: true, deleted: existing });
});

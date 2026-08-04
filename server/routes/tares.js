import { Router } from 'express';
import { db, nowISO } from '../db.js';

export const router = Router();

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * A row's identity is what it applies to, not an arbitrary id: brand, and
 * optionally a capacity and material to narrow it. Weighing the same brand
 * twice should correct the figure rather than leave two rows disagreeing, so
 * writes upsert on that triple.
 *
 * "Applies to anything" is 0 and '' rather than NULL, matching the column
 * defaults — see the migration for why.
 */
function readBody(body) {
  const brand = str(body.brand);
  if (!brand) throw new BadRequest('Which brand did you weigh?');

  const grams = parseInt(body.grams, 10);
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new BadRequest('The empty spool has to weigh something.');
  }
  // Past a certain point it stops being a spool weight and starts being a
  // reading taken with the filament still on it, which would make everything
  // downstream quietly wrong.
  if (grams >= 5000) throw new BadRequest(`${grams} g is too heavy for an empty spool.`);

  const capacity = parseInt(body.capacity_g, 10);

  return {
    brand,
    // Which of the brand's spools this is — 'v3', 'Reusable', 'Cardboard'. Short
    // because it shows inline next to the weight wherever it appears.
    variant: str(body.variant).slice(0, 24),
    material: str(body.material),
    capacity_g: Number.isFinite(capacity) && capacity > 0 ? capacity : 0,
    grams,
    note: str(body.note).slice(0, 200),
  };
}

const listAll = () =>
  db
    .prepare(`
      SELECT * FROM spool_tares
      ORDER BY brand COLLATE NOCASE, variant COLLATE NOCASE, capacity_g, material COLLATE NOCASE
    `)
    .all();

router.get('/', (_req, res) => res.json({ tares: listAll() }));

router.post('/', (req, res, next) => {
  try {
    const t = readBody(req.body ?? {});
    const now = nowISO();

    db.prepare(`
      INSERT INTO spool_tares (brand, variant, material, capacity_g, grams, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (brand, variant, material, capacity_g) DO UPDATE SET
        grams = excluded.grams,
        -- Correcting a weight shouldn't discard what you wrote about the spool;
        -- the form that sends these has no note field to re-supply it from.
        note = CASE WHEN excluded.note = '' THEN spool_tares.note ELSE excluded.note END,
        updated_at = excluded.updated_at
    `).run(t.brand, t.variant, t.material, t.capacity_g, t.grams, t.note, now, now);

    res.status(201).json({
      tare: db
        .prepare(`
          SELECT * FROM spool_tares
          WHERE brand = ? AND variant = ? AND material = ? AND capacity_g = ?
        `)
        .get(t.brand, t.variant, t.material, t.capacity_g),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { changes } = db.prepare('DELETE FROM spool_tares WHERE id = ?').run(id);
    if (!changes) return res.status(404).json({ error: 'No such spool weight.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Used by the export, so a backup carries these along with the spools. */
export const allTares = listAll;

/**
 * Restores exported rows. Anything already on file wins — same rule the spool
 * import follows, so restoring a backup onto a live library can't overwrite a
 * weight you took more recently than the file.
 */
export function importTares(rows) {
  if (!Array.isArray(rows)) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO spool_tares (brand, variant, material, capacity_g, grams, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  for (const row of rows) {
    let t;
    try {
      t = readBody(row ?? {});
    } catch {
      continue; // A malformed row shouldn't sink the rest of the restore.
    }
    const now = nowISO();
    added += insert.run(
      t.brand, t.variant, t.material, t.capacity_g, t.grams, t.note,
      str(row.created_at) || now, str(row.updated_at) || now,
    ).changes;
  }
  return added;
}

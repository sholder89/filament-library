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

const KINDS = ['storage', 'printer'];

/**
 * Icons are stored as a key and drawn by the client, which owns the artwork.
 *
 * Validated by shape rather than against a list of known names on purpose: the
 * drawings live in one place, and a server that also had to know them would
 * have to be redeployed to add one. An unknown key falls back to a box on the
 * way out, so the worst case is a plain icon rather than a broken row.
 */
const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;

function readBody(body) {
  const name = str(body.name);
  if (!name) throw new BadRequest('A location needs a name.');
  if (name.length > 40) throw new BadRequest('That name is too long to fit on a card.');

  const kind = str(body.kind) || 'storage';
  if (!KINDS.includes(kind)) throw new BadRequest(`Kind must be one of: ${KINDS.join(', ')}.`);

  const icon = str(body.icon).toLowerCase();
  return { name, kind, icon: ICON_RE.test(icon) ? icon : (kind === 'printer' ? 'printer' : 'box') };
}

/**
 * Printers first, then everywhere else alphabetically.
 *
 * A spool is usually being moved either into a printer or out of one, so the
 * printers are what the list is reached for most and they sit at the top where
 * a thumb lands.
 */
const listAll = db.prepare(`
  SELECT id, name, icon, kind FROM locations
  ORDER BY kind = 'printer' DESC, name COLLATE NOCASE ASC
`);

export const allLocations = () => listAll.all();

/** How many spools are sitting in each, for the manage list. */
const counts = db.prepare(`
  SELECT TRIM(location) AS name, COUNT(*) AS spools
  FROM filaments WHERE TRIM(location) <> '' GROUP BY TRIM(location) COLLATE NOCASE
`);

router.get('/', (_req, res) => {
  const used = new Map(counts.all().map((r) => [r.name.toLowerCase(), r.spools]));
  res.json({
    locations: allLocations().map((l) => ({ ...l, spools: used.get(l.name.toLowerCase()) ?? 0 })),
  });
});

router.post('/', (req, res) => {
  const { name, icon, kind } = readBody(req.body ?? {});
  const now = nowISO();

  const existing = db.prepare('SELECT * FROM locations WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) throw new BadRequest(`There is already a location called ${existing.name}.`);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO locations (name, icon, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run(name, icon, kind, now, now);

  res.status(201).json(db.prepare('SELECT id, name, icon, kind FROM locations WHERE id = ?').get(lastInsertRowid));
});

router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'No such location.' });

  const { name, icon, kind } = readBody({ ...existing, ...req.body });

  const clash = db.prepare('SELECT id, name FROM locations WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, id);
  if (clash) throw new BadRequest(`There is already a location called ${clash.name}.`);

  /*
   * Renaming carries the spools with it.
   *
   * The filament holds the name rather than an id, so without this a rename
   * would leave every spool pointing at a place that no longer exists — the
   * saved list would say "Dry box 2" while the shelf still said "Dry box".
   * Both writes go in one transaction so a rename can never half-happen.
   */
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE locations SET name = ?, icon = ?, kind = ?, updated_at = ? WHERE id = ?')
      .run(name, icon, kind, nowISO(), id);

    if (name !== existing.name) {
      db.prepare('UPDATE filaments SET location = ? WHERE location = ? COLLATE NOCASE')
        .run(name, existing.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json(db.prepare('SELECT id, name, icon, kind FROM locations WHERE id = ?').get(id));
});

/**
 * Forgetting a place, not emptying it.
 *
 * The spools keep the name they were given: deleting a shelf from a list is a
 * statement about the list, and silently moving filament to nowhere because of
 * it would lose information nobody asked to lose. They simply stop offering an
 * icon, and the name can be saved again to bring one back.
 */
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'No such location.' });

  db.prepare('DELETE FROM locations WHERE id = ?').run(id);
  res.json({ ok: true, forgot: existing.name });
});

/** Whether a place is a printer — the one thing filaments.loaded has to know. */
const byName = db.prepare('SELECT kind FROM locations WHERE name = ? COLLATE NOCASE');
export const isPrinterLocation = (name) => byName.get(String(name ?? '').trim())?.kind === 'printer';

/** Restores the saved list from a backup, without disturbing what is here. */
export function importLocations(rows) {
  const now = nowISO();
  const add = db.prepare(`
    INSERT OR IGNORE INTO locations (name, icon, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  let n = 0;
  for (const raw of rows ?? []) {
    const name = str(raw?.name);
    if (!name || name.length > 40) continue;
    const kind = KINDS.includes(str(raw?.kind)) ? str(raw.kind) : 'storage';
    const icon = str(raw?.icon).toLowerCase();
    n += add.run(name, ICON_RE.test(icon) ? icon : 'box', kind, now, now).changes;
  }
  return n;
}

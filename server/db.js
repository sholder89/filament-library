import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the database lives when nobody says otherwise.
 *
 * The container sets DB_PATH explicitly (see the Dockerfile), so this is only
 * reached when someone runs the app directly with Node.
 *
 * On Windows that means LocalAppData rather than a folder beside the app, and
 * the reason is OneDrive. Documents and Desktop are synced by default, and a
 * sync client and a SQLite database actively fight: the folder gets locked
 * mid-write, deleted directories are recreated underneath you, and the failure
 * arrives as "unable to open database file" for a file plainly sitting there.
 * LocalAppData is never synced and always writable by the account that owns it,
 * which makes it the one place this reliably works no matter where the app
 * itself was unzipped.
 *
 * Elsewhere, beside the project — no sync client, and it keeps the data next to
 * the thing it belongs to.
 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultDbPath() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'FilamentLibrary', 'filament.db');
  }
  return join(PROJECT_ROOT, 'data', 'filament.db');
}

const DB_PATH = process.env.DB_PATH || defaultDbPath();

/**
 * SQLite reports a permission problem as a bare "unable to open database file"
 * (errcode 14), which says nothing about how to fix it. What to do about it
 * differs completely between the two ways this runs, so the message does too.
 */
function openDatabase() {
  const dir = dirname(DB_PATH);
  const posix = typeof process.getuid === 'function';

  try {
    mkdirSync(dir, { recursive: true });
    return new DatabaseSync(DB_PATH);
  } catch (err) {
    const permissionProblem =
      err.code === 'EACCES' ||
      err.code === 'EPERM' ||
      err.errcode === 14 ||
      /unable to open database file/i.test(err.message ?? '');

    if (!permissionProblem) throw err;

    const fix = posix
      ? `This process runs as uid:gid ${process.getuid()}:${process.getgid()} and can't write to ${dir}.\n` +
        `That directory is a bind mount, so its owner comes from the host.\n\n` +
        `Fix it on the host with either:\n` +
        `  sudo chown -R 1000:1000 ./data\n` +
        `or set PUID and PGID in .env to the user that owns ./data:\n` +
        `  id -u && id -g\n`
      : `Windows won't let this account write to ${dir}.\n\n` +
        `Usually that means the app was unpacked somewhere protected, like\n` +
        `Program Files. Move the folder somewhere you own — your Desktop or\n` +
        `Documents — and start it again.\n`;

    throw new Error(`Cannot open the database at ${DB_PATH}\n\n${fix}`, { cause: err });
  }
}

export const db = openDatabase();

/*
 * Journalling mode, and why it isn't simply WAL.
 *
 * WAL needs its own -wal and -shm sidecar files and real file locking. A folder
 * synced by OneDrive or Dropbox gives it neither reliably: the sidecars can be
 * created one minute and refused the next, depending on whether the sync client
 * happens to be touching the folder. The failure doesn't surface when the mode
 * is set either — the mode is recorded in the database file, so it comes back
 * on the next open, as "unable to open database file" on the first query
 * against a database that is plainly right there.
 *
 * On Windows this matters, because Documents is synced by default and that's
 * exactly where somebody unpacks a folder like this one. So the mode is chosen
 * explicitly: the container asks for WAL (see the Dockerfile), and everything
 * else gets the ordinary rollback journal, which is entirely adequate for one
 * person's filament shelf.
 *
 * Setting it also converts a database that arrived in the other mode, so a copy
 * taken off the server runs on a laptop without complaint.
 */
const JOURNAL_MODE = /^(wal|delete|truncate|persist|memory|off)$/i.test(process.env.SQLITE_JOURNAL_MODE ?? '')
  ? process.env.SQLITE_JOURNAL_MODE.toUpperCase()
  : 'DELETE';

try {
  db.exec(`PRAGMA journal_mode = ${JOURNAL_MODE}`);
} catch {
  // Not worth failing to start over: whatever mode the file already has works
  // well enough, and the alternative is no app at all.
}

db.exec('PRAGMA foreign_keys = ON');

/**
 * Schema is versioned through PRAGMA user_version so upgrades are additive and
 * never lose a spool record. Bump SCHEMA_VERSION and add a migration below.
 */
const SCHEMA_VERSION = 11;

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS filaments (
        id             TEXT PRIMARY KEY,
        brand          TEXT NOT NULL,
        material       TEXT NOT NULL,
        color_name     TEXT NOT NULL DEFAULT '',
        color_hex      TEXT NOT NULL DEFAULT '#808080',
        diameter       REAL NOT NULL DEFAULT 1.75,
        spool_weight_g INTEGER NOT NULL DEFAULT 1000,
        remaining_pct  INTEGER NOT NULL DEFAULT 100,
        status         TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'opened', 'empty')),
        location       TEXT NOT NULL DEFAULT '',
        notes          TEXT NOT NULL DEFAULT '',
        price          REAL,
        nozzle_temp    INTEGER,
        bed_temp       INTEGER,
        purchased_at   TEXT,
        opened_at      TEXT,
        finished_at    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_filaments_status   ON filaments (status);
      CREATE INDEX IF NOT EXISTS idx_filaments_brand    ON filaments (brand);
      CREATE INDEX IF NOT EXISTS idx_filaments_material ON filaments (material);
    `);
    db.exec(`PRAGMA user_version = 1`);
  }

  if (current < 2) {
    // Finish/effect (silk, glitter, matte, wood…). Empty means a plain spool.
    db.exec(`ALTER TABLE filaments ADD COLUMN finish TEXT NOT NULL DEFAULT ''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_filaments_finish ON filaments (finish)`);
    db.exec(`PRAGMA user_version = 2`);
  }

  if (current < 3) {
    // Extra colors for multi-tone stock — dual-color and gradient spools.
    // Empty means "not set", so a plain spool is unaffected.
    db.exec(`ALTER TABLE filaments ADD COLUMN color_hex2 TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE filaments ADD COLUMN color_hex3 TEXT NOT NULL DEFAULT ''`);
    db.exec(`PRAGMA user_version = 3`);
  }

  if (current < 4) {
    // Whether the spool is physically in a printer or AMS right now. Separate
    // from status: a loaded spool is still 'opened', it's just not on the shelf.
    db.exec(`ALTER TABLE filaments ADD COLUMN loaded INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_filaments_loaded ON filaments (loaded)`);
    db.exec(`PRAGMA user_version = 4`);
  }

  if (current < 5) {
    // What this particular spool weighs empty, so putting it on a scale gives
    // how much is left. NULL means "no measurement", and the brand's typical
    // figure stands in — a guess the app is careful to label as one.
    db.exec(`ALTER TABLE filaments ADD COLUMN empty_spool_g INTEGER`);
    db.exec(`PRAGMA user_version = 5`);
  }

  if (current < 6) {
    /*
     * Your own spool weights, which outrank the figures shipped in the catalog.
     *
     * Those shipped figures are crowdsourced, and they go stale: Sunlu quietly
     * revised their spool and the published numbers describe the old one, so a
     * suggestion can be eighty grams out with nothing on screen to suggest it.
     * Weighing one settles it — but until now the answer could only be recorded
     * against a single roll, so the next spool of the same stuff asked again.
     *
     * Matched the same way as the catalog: brand always, then capacity, then
     * material, each narrowing only as far as the row actually specifies. The
     * two "any" cases are 0 and '' rather than NULL so that UNIQUE means what
     * it looks like it means — in SQLite two NULLs are distinct, and a nullable
     * key column would happily store the same brand a dozen times over.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_tares (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        brand      TEXT NOT NULL,
        material   TEXT NOT NULL DEFAULT '',
        capacity_g INTEGER NOT NULL DEFAULT 0,
        grams      INTEGER NOT NULL CHECK (grams > 0 AND grams < 5000),
        note       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (brand, material, capacity_g)
      );

      CREATE INDEX IF NOT EXISTS idx_spool_tares_brand ON spool_tares (brand);
    `);
    db.exec(`PRAGMA user_version = 6`);
  }

  if (current < 7) {
    /*
     * Which of a brand's spools this weight is for.
     *
     * Brands revise the spool and keep the name: Sunlu are on their third, and
     * the three weigh 130, 155 and 222 g. Under v6 they collided — brand, type
     * and capacity were the whole key, so saving the new one overwrote the old.
     * A free-text label ('v3', 'Reusable', 'Cardboard') separates them, and it
     * has to join the key rather than sit beside it, which means rebuilding the
     * table since SQLite can't alter a constraint in place.
     */
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE spool_tares_v7 (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          brand      TEXT NOT NULL,
          variant    TEXT NOT NULL DEFAULT '',
          material   TEXT NOT NULL DEFAULT '',
          capacity_g INTEGER NOT NULL DEFAULT 0,
          grams      INTEGER NOT NULL CHECK (grams > 0 AND grams < 5000),
          note       TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (brand, variant, material, capacity_g)
        );

        INSERT INTO spool_tares_v7
          (id, brand, variant, material, capacity_g, grams, note, created_at, updated_at)
        SELECT id, brand, '', material, capacity_g, grams, note, created_at, updated_at
        FROM spool_tares;

        DROP TABLE spool_tares;
        ALTER TABLE spool_tares_v7 RENAME TO spool_tares;
        CREATE INDEX IF NOT EXISTS idx_spool_tares_brand ON spool_tares (brand);
      `);
      db.exec(`PRAGMA user_version = 7`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (current < 8) {
    /*
     * Settings that have to be typed in rather than deployed.
     *
     * Only the Vision API key uses this so far. In the container it comes from
     * the environment and always will — but somebody running the app on their
     * own PC has no environment to put it in, and telling them to edit a file
     * and restart is how a feature goes unused. The environment still wins
     * where it's set; this is the fallback, not a replacement.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`PRAGMA user_version = 8`);
  }

  if (current < 9) {
    /*
     * What happened to a spool, and when.
     *
     * The filament row only ever holds the current state, so "I marked this
     * used up last week" and "someone loaded it twice in a day" were both
     * unanswerable. This keeps the changes themselves.
     *
     * from_value/to_value are text for every field regardless of its real
     * type: this table is read to be displayed, never to be computed with,
     * and one shape beats a column per type.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS filament_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        filament_id TEXT NOT NULL,
        at          TEXT NOT NULL,
        kind        TEXT NOT NULL,
        field       TEXT NOT NULL DEFAULT '',
        from_value  TEXT NOT NULL DEFAULT '',
        to_value    TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS filament_events_by_spool
        ON filament_events (filament_id, at);
    `);

    /*
     * Backfill what the spools can still tell us.
     *
     * Only three moments survive in the filament row itself, so that is all
     * there is to recover — every other change made before today happened
     * without anywhere to write it down and is simply gone. Better a sparse
     * early history than a timeline that pretends to start at zero.
     */
    db.exec(`
      INSERT INTO filament_events (filament_id, at, kind, field, from_value, to_value)
      SELECT id, created_at, 'added', '', '', '' FROM filaments WHERE created_at <> '';
    `);
    db.exec(`
      INSERT INTO filament_events (filament_id, at, kind, field, from_value, to_value)
      SELECT id, opened_at, 'status', 'status', 'new', 'opened'
      FROM filaments WHERE opened_at IS NOT NULL AND opened_at <> '';
    `);
    db.exec(`
      INSERT INTO filament_events (filament_id, at, kind, field, from_value, to_value)
      SELECT id, finished_at, 'status', 'status', 'opened', 'empty'
      FROM filaments WHERE finished_at IS NOT NULL AND finished_at <> '';
    `);

    db.exec(`PRAGMA user_version = 9`);
  }

  if (current < 10) {
    /*
     * The feed asks for the newest few events across every spool, which is
     * the one query here that runs on nothing more than opening a menu. The
     * existing index leads on filament_id, so that query could not use it to
     * order by time: SQLite scanned the whole table and built a temp B-tree
     * to sort it, then took sixty rows.
     *
     * Measured on forty thousand events, which is a few years of ordinary
     * use: 21ms before, 0.2ms after, and the sort disappears from the plan.
     * It costs one more index to maintain on write, and writes here are one
     * row at a time when a person touches a spool.
     */
    db.exec(`
      CREATE INDEX IF NOT EXISTS filament_events_recent
        ON filament_events (at DESC, id DESC);
    `);
    db.exec(`PRAGMA user_version = 10`);
  }

  if (current < 11) {
    /*
     * Places a spool can be, with an icon so a list of them can be read at a
     * glance rather than word by word.
     *
     * `kind` is what makes a printer a location rather than a separate concept.
     * A spool in a printer was already tracked by filaments.loaded, which the
     * sort, the grouping, the card flag and the history all read - so that
     * stays exactly as it is, and assigning a location whose kind is 'printer'
     * simply sets it. Which is what lets there be three printers instead of a
     * yes-or-no.
     *
     * Names are the key rather than an id on the filament: the text column
     * already exists, is exported, searched and shown, and a spool sitting
     * somewhere that is not on the saved list still has to be describable.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        icon       TEXT NOT NULL DEFAULT 'box',
        kind       TEXT NOT NULL DEFAULT 'storage'
                   CHECK (kind IN ('storage', 'printer')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS locations_name
        ON locations (name COLLATE NOCASE);
    `);

    /*
     * Anywhere already written on a spool becomes a saved location, so an
     * existing library arrives with its list already filled in rather than
     * asking someone to retype what the records plainly say.
     */
    db.exec(`
      INSERT OR IGNORE INTO locations (name, icon, kind, created_at, updated_at)
      SELECT DISTINCT TRIM(location), 'box', 'storage',
             '${new Date().toISOString()}', '${new Date().toISOString()}'
      FROM filaments
      WHERE TRIM(location) <> '';
    `);

    db.exec(`PRAGMA user_version = 11`);
  }
}

migrate();

if (SCHEMA_VERSION !== db.prepare('PRAGMA user_version').get().user_version) {
  throw new Error('Database schema version mismatch — migration did not complete.');
}

/**
 * Short, unambiguous IDs (Crockford-ish base32, no I/L/O/U) so the QR payload
 * stays small and a hand-typed URL is hard to get wrong.
 */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId() {
  const bytes = randomBytes(8);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

export const nowISO = () => new Date().toISOString();

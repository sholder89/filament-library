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
const SCHEMA_VERSION = 4;

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

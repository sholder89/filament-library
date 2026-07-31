import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || '/data/filament.db';

/**
 * SQLite reports a permission problem as a bare "unable to open database file"
 * (errcode 14), which says nothing about how to fix it. Almost always it's the
 * data directory being owned by someone this process isn't.
 */
function openDatabase() {
  const dir = dirname(DB_PATH);
  const whoami = typeof process.getuid === 'function'
    ? `${process.getuid()}:${process.getgid()}`
    : 'unknown';

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

    throw new Error(
      `Cannot open the database at ${DB_PATH}\n\n` +
      `This process runs as uid:gid ${whoami} and can't write to ${dir}.\n` +
      `That directory is a bind mount, so its owner comes from the host.\n\n` +
      `Fix it on the host with either:\n` +
      `  sudo chown -R 1000:1000 ./data\n` +
      `or set PUID and PGID in .env to the user that owns ./data:\n` +
      `  id -u && id -g\n`,
      { cause: err },
    );
  }
}

export const db = openDatabase();

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Schema is versioned through PRAGMA user_version so upgrades are additive and
 * never lose a spool record. Bump SCHEMA_VERSION and add a migration below.
 */
const SCHEMA_VERSION = 3;

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

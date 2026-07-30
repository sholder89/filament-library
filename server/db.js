import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || '/data/filament.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Schema is versioned through PRAGMA user_version so upgrades are additive and
 * never lose a spool record. Bump SCHEMA_VERSION and add a migration below.
 */
const SCHEMA_VERSION = 1;

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

  // Future migrations: if (current < 2) { ... db.exec('PRAGMA user_version = 2') }
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

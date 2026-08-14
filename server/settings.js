import { db, nowISO } from './db.js';

/**
 * Small key/value store for things a person types in rather than deploys.
 *
 * Deliberately not part of the export: /api/export is a file you hand around —
 * to another machine, to a backup drive, to me when something breaks — and a
 * billing credential has no business traveling with it. Losing the key on a
 * restore means retyping one thing; leaking it means someone else's bill.
 */

const read = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const write = db.prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const remove = db.prepare('DELETE FROM app_settings WHERE key = ?');

export const getSetting = (key) => read.get(key)?.value ?? '';
export const setSetting = (key, value) => write.run(key, value, nowISO());
export const clearSetting = (key) => remove.run(key).changes > 0;

/**
 * Enough to recognize which key is in there without being enough to use it.
 * Google's keys all start "AIza", so the leading characters identify nothing —
 * the last four do.
 */
export function maskSecret(secret) {
  const s = String(secret ?? '');
  if (!s) return '';
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

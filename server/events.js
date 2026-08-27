import { db, nowISO } from './db.js';

/**
 * What happened to a spool, and when.
 *
 * The filament row holds only the current state, which answers "how much is
 * left" but never "when did that change" or "how many times has this been in
 * the printer". This records the changes themselves.
 *
 * Everything funnels through recordChanges: both places that write a filament
 * row already have the before and after in hand, so a diff catches every field
 * without needing a call site per kind of edit. Add a column to TRACKED and it
 * starts appearing in history — there is no second place to remember.
 */

/**
 * Fields worth a line in the history, and what to call them.
 *
 * Deliberately not every column. updated_at is the fact that something changed,
 * which is what the whole table already says, and opened_at/finished_at move as
 * a consequence of status rather than on their own — logging them would report
 * one action twice.
 */
const TRACKED = [
  ['status', 'Status', 'status'],
  ['loaded', 'Printer', 'loaded'],
  ['remaining_pct', 'Remaining', 'remaining'],
  ['empty_spool_g', 'Empty spool weight', 'weighed'],
  ['location', 'Location', 'field'],
  ['notes', 'Notes', 'field'],
  ['brand', 'Brand', 'field'],
  ['material', 'Type', 'field'],
  ['color_name', 'Color', 'field'],
  ['color_hex', 'Color hex', 'field'],
  ['finish', 'Finish', 'field'],
  ['spool_weight_g', 'Spool size', 'field'],
  ['diameter', 'Diameter', 'field'],
  ['price', 'Price', 'field'],
  ['nozzle_temp', 'Nozzle temp', 'field'],
  ['bed_temp', 'Bed temp', 'field'],
  ['purchased_at', 'Purchased', 'field'],
];

const insert = db.prepare(`
  INSERT INTO filament_events (filament_id, at, kind, field, from_value, to_value)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/** Null and undefined both mean "nothing was there" once it reaches a screen. */
const text = (v) => (v === null || v === undefined ? '' : String(v));

export function recordEvent(filamentId, kind, { field = '', from = '', to = '', at } = {}) {
  insert.run(filamentId, at || nowISO(), kind, field, text(from), text(to));
}

/**
 * Writes a line for every tracked field that actually moved.
 *
 * Compared as text on purpose: SQLite hands back 1 where the caller passed true,
 * and a price can arrive as "12.50" or 12.5 depending on which endpoint it came
 * through. Comparing the rendered values is what stops a save that changed
 * nothing from filling the history with lines saying so.
 */
export function recordChanges(filamentId, before, after, at) {
  const stamp = at || nowISO();
  let written = 0;

  for (const [column, label, kind] of TRACKED) {
    const from = text(before?.[column]);
    const to = text(after?.[column]);
    if (from === to) continue;
    insert.run(filamentId, stamp, kind, label, from, to);
    written++;
  }

  return written;
}

const bySpool = db.prepare(`
  SELECT id, at, kind, field, from_value, to_value
  FROM filament_events
  WHERE filament_id = ?
  ORDER BY at DESC, id DESC
`);

export const eventsFor = (filamentId) => bySpool.all(filamentId);

const removeFor = db.prepare('DELETE FROM filament_events WHERE filament_id = ?');
export const deleteEvents = (filamentId) => removeFor.run(filamentId).changes;

const allRows = db.prepare(`
  SELECT filament_id, at, kind, field, from_value, to_value
  FROM filament_events ORDER BY at
`);
export const allEvents = () => allRows.all();

/**
 * Restores events from a backup.
 *
 * Only for spools that made it in: importing in merge mode skips ids that are
 * already here, and history belonging to a record that was skipped would
 * describe changes to a spool this file didn't bring.
 */
export function importEvents(rows, keepIds) {
  let n = 0;
  for (const e of rows ?? []) {
    const id = e?.filament_id;
    if (!id || (keepIds && !keepIds.has(id))) continue;
    insert.run(id, text(e.at) || nowISO(), text(e.kind) || 'field',
      text(e.field), text(e.from_value), text(e.to_value));
    n++;
  }
  return n;
}

/**
 * Recent activity across the whole library, for the feed.
 *
 * Joined rather than fetched per spool: the feed needs the brand and color of
 * each spool to draw a row, and sixty rows would otherwise be sixty lookups.
 * An inner join also means an event can never outlive the spool it describes —
 * deleting one already clears its history, and this is the second guard.
 */
const recent = db.prepare(`
  SELECT e.id, e.at, e.kind, e.field, e.from_value, e.to_value,
         f.id AS filament_id, f.brand, f.material, f.color_name, f.finish,
         f.color_hex, f.color_hex2, f.color_hex3
  FROM filament_events e
  JOIN filaments f ON f.id = e.filament_id
  ORDER BY e.at DESC, e.id DESC
  LIMIT ?
`);

export const recentEvents = (limit = 60) => recent.all(limit);

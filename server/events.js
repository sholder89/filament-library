import { db, nowISO } from './db.js';
import { expandTerm, vocabularyFrom, normalizeQuery } from './search-terms.js';

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

/**
 * The finer actions the feed shows, as SQL.
 *
 * The table stores a coarse kind because that is what the diff knows: loading
 * and unloading are one column moving. A reader sees opposite actions, so the
 * filter has to split them again here rather than storing them apart.
 */
const ACTION_WHERE = {
  added:     "e.kind = 'added'",
  opened:    "e.kind = 'status' AND e.to_value = 'opened'",
  empty:     "e.kind = 'status' AND e.to_value = 'empty'",
  sealed:    "e.kind = 'status' AND e.to_value = 'new'",
  loaded:    "e.kind = 'loaded' AND e.to_value = '1'",
  unloaded:  "e.kind = 'loaded' AND e.to_value = '0'",
  remaining: "e.kind = 'remaining'",
  weighed:   "e.kind = 'weighed'",
  edit:      "e.kind = 'field'",
};

export const ACTION_KEYS = Object.keys(ACTION_WHERE);

/**
 * What a row can be found by.
 *
 * The spool's own words, plus the change itself, plus the words someone would
 * actually search for the action by — nobody types "kind:loaded", they type
 * "printer". Spelled out per action for the same reason the filament haystack
 * is: matching is on substrings, so "unloaded" would answer to "loaded".
 */
const EVENT_HAYSTACK = `(
  f.brand || ' ' || f.material || ' ' || f.color_name || ' ' || f.finish
  || ' ' || e.field || ' ' || e.from_value || ' ' || e.to_value
  || CASE e.kind
       WHEN 'added'     THEN ' added created'
       WHEN 'remaining' THEN ' remaining left usage'
       WHEN 'weighed'   THEN ' weighed weight tare'
       WHEN 'field'     THEN ' edited changed'
       WHEN 'loaded'    THEN CASE e.to_value
                               WHEN '1' THEN ' loaded printer ams'
                               ELSE ' unloaded removed printer ams'
                             END
       ELSE CASE e.to_value
              WHEN 'opened' THEN ' opened started'
              WHEN 'empty'  THEN ' finished gone'
              ELSE ' sealed'
            END
     END
)`;

/**
 * The WHERE for a narrowed activity query, shared by the page and its count.
 *
 * Built once and used twice: a paginated list has to know how many rows it is
 * a page of, and a count that filtered even slightly differently from the list
 * would put the wrong number of pages under it.
 */
function eventFilter({ q = '', action = '', filamentId = '' } = {}) {
  const where = [];
  const params = [];

  if (ACTION_WHERE[action]) where.push(`(${ACTION_WHERE[action]})`);
  if (filamentId) { where.push('e.filament_id = ?'); params.push(filamentId); }

  const text = String(q ?? '').trim();
  if (text) {
    const words = normalizeQuery(text).split(/\s+/).filter(Boolean).slice(0, 8);
    const like = (w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;
    const vocabulary = vocabularyFrom(
      db.prepare('SELECT brand, material, color_name, finish FROM filaments').all(),
    );

    for (const word of words) {
      const negated = word.length > 1 && word.startsWith('-');
      const forms = expandTerm(negated ? word.slice(1) : word, vocabulary);
      const any = `(${forms.map(() => `${EVENT_HAYSTACK} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      where.push(negated ? `NOT ${any}` : any);
      params.push(...forms.map(like));
    }
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * One page of activity, plus how many rows there are to page through.
 *
 * Search is widened exactly as the filament list widens it — same synonyms,
 * same typo pass against the words the library actually uses — so "flexible"
 * finds the TPU here too and there is only one search to learn.
 */
export function searchEvents({ q = '', action = '', filamentId = '', limit = 50, offset = 0 } = {}) {
  const { clause, params } = eventFilter({ q, action, filamentId });

  const events = db.prepare(`
    SELECT e.id, e.at, e.kind, e.field, e.from_value, e.to_value,
           f.id AS filament_id, f.brand, f.material, f.color_name, f.finish,
           f.color_hex, f.color_hex2, f.color_hex3
    FROM filament_events e
    JOIN filaments f ON f.id = e.filament_id
    ${clause}
    ORDER BY e.at DESC, e.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const { total } = db.prepare(`
    SELECT COUNT(*) AS total
    FROM filament_events e
    JOIN filaments f ON f.id = e.filament_id
    ${clause}
  `).get(...params);

  return { events, total };
}

/** Every event written by one save — they share a spool and a timestamp. */
const atMoment = db.prepare(`
  SELECT kind, field, from_value, to_value FROM filament_events
  WHERE filament_id = ? AND at = ?
`);
export const eventsAt = (filamentId, at) => atMoment.all(filamentId, at);

/**
 * Forgets one save.
 *
 * Undoing is not a second change to be filed next to the first — the two
 * together mean nothing happened, and a history that says so twice is a
 * history you have to read carefully to learn nothing. So the record goes
 * with the change.
 */
const dropMoment = db.prepare('DELETE FROM filament_events WHERE filament_id = ? AND at = ?');
export const deleteEventsAt = (filamentId, at) => dropMoment.run(filamentId, at).changes;

/** Column names by the label their events are filed under. */
export const COLUMN_FOR_LABEL = new Map(TRACKED.map(([column, label]) => [label, column]));

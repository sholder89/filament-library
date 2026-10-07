/** Exercise the real list route and SQL against an isolated in-memory database. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

// Set this before importing any application module; never open the user's DB.
process.env.DB_PATH = ':memory:';
const { db } = await import('../server/db.js');
const { router } = await import('../server/routes/filaments.js');

const insert = db.prepare(`INSERT INTO filaments
  (id, brand, material, color_name, finish, location, notes, status, loaded,
   remaining_pct, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const fixtures = [
  ['R2345678', 'Sunlu', 'PLA', 'Red', 'Silk', 'Shelf A', '', 'opened', 0, 20],
  ['B2345678', 'Elegoo', 'PETG', 'Blue', 'Matte', 'Shelf B', '', 'opened', 1, 80],
  ['C2345678', 'Elegoo', 'PLA', 'Red', 'Matte', 'Shelf B', '', 'new', 0, 100],
  ['G2345678', 'Polymaker', 'TPU', 'Grey', 'Translucent', '',
    'Mentions R2345678; 100% shelf_a C:\\spools', 'new', 0, 100],
  ['E2345678', 'Sunlu', 'PLA', 'Red', 'Silk', 'Shelf A', '', 'empty', 0, 0],
  ['A2345678', 'Sunlu', 'PLA', 'Amethyst', '', 'Shelf A', '', 'new', 0, 100],
];
for (const [i, row] of fixtures.entries()) {
  const date = `2026-01-0${i + 1}T00:00:00.000Z`;
  insert.run(...row, date, date);
}

const app = express();
app.use('/api/filaments', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/api/filaments`;
const active = ['A2345678', 'B2345678', 'C2345678', 'G2345678', 'R2345678'];
const red = ['C2345678', 'R2345678'];
const redBlue = ['B2345678', ...red];
const cases = [
  ['single word', { q: 'red' }, red],
  ['words still AND', { q: 'red blue' }, []],
  ['comma OR', { q: 'red, blue' }, redBlue],
  ['no spaces required', { q: 'red,blue' }, redBlue],
  ['multiword branches', { q: 'sunlu red, elegoo blue' }, ['B2345678', 'R2345678']],
  ['trim and ignore empty branches', { q: ' , RED, , blue , ' }, redBlue],
  ['duplicate branches do not duplicate rows', { q: 'red, red' }, red],
  ['blank search', { q: '   ' }, active],
  ['comma-only search', { q: ' , , ' }, active],
  ['unmatched branch does not broaden results', { q: 'red, nonexistent' }, red],
  ['full ID preserves notes matches', { q: 'R2345678' }, ['G2345678', 'R2345678']],
  ['ID list preserves notes matches', { q: 'r2345678, b2345678' }, ['B2345678', 'G2345678', 'R2345678']],
  ['mixed ID and text', { q: 'b2345678, red' }, redBlue],
  ['partial ID is not an ID match', { q: 'B234' }, []],
  ['ID-shaped color remains text', { q: 'amethyst, blue' }, ['A2345678', 'B2345678']],
  ['synonyms', { q: 'gray, flexible' }, ['G2345678']],
  ['phrase normalization per branch', { q: 'see through, in the printer' }, ['B2345678', 'G2345678']],
  ['typo expansion', { q: 'polymker, blue' }, ['B2345678', 'G2345678']],
  ['exclude within first branch', { q: 'red -silk, blue' }, ['B2345678', 'C2345678']],
  ['exclude within second branch', { q: 'red, blue -matte' }, red],
  ['exclude within both branches', { q: 'red -silk, blue -matte' }, ['C2345678']],
  ['negation-only branches are ORed', { q: '-silk, -matte' }, active],
  ['brand constrains all branches', { q: 'red, blue', brand: 'Sunlu' }, ['R2345678']],
  ['material constrains all branches', { q: 'red, blue', material: 'PLA' }, red],
  ['finish constrains all branches', { q: 'red, blue', finish: 'Silk' }, ['R2345678']],
  ['location constrains all branches', { q: 'red, blue', location: 'Shelf A' }, ['R2345678']],
  ['status constrains all branches', { q: 'red, blue', status: 'new' }, ['C2345678']],
  ['low-stock constrains all branches', { q: 'red, blue', low: '1' }, ['R2345678']],
  ['filters also constrain exact IDs', { q: 'R2345678, B2345678', brand: 'Elegoo' }, ['B2345678']],
  ['multi-select filter remains OR', { q: 'red, blue', brand: 'Sunlu,Elegoo' }, redBlue],
  ['empty status still available', { q: 'red, blue', status: 'empty' }, ['E2345678']],
  ['include-empty still available', { q: 'red, blue', include_empty: '1' }, ['B2345678', 'C2345678', 'E2345678', 'R2345678']],
  ['literal percent', { q: '%' }, ['G2345678']],
  ['literal underscore', { q: '_' }, ['G2345678']],
  ['literal backslash', { q: '\\, blue' }, ['B2345678', 'G2345678']],
  ['SQL punctuation remains data', { q: "' OR 1=1 --, blue" }, ['B2345678']],
  ['existing eight-word cap per branch', { q: 'sunlu red sunlu red sunlu red sunlu red nonexistent, blue' }, ['B2345678', 'R2345678']],
  ['32 branches accepted', { q: Array(32).fill('blue').join(',') }, ['B2345678']],
];

try {
  for (const [name, query, expected] of cases) {
    const res = await fetch(`${url}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    assert.equal(res.status, 200, `${name}: ${JSON.stringify(body)}`);
    assert.deepEqual(body.map((f) => f.id).sort(), [...expected].sort(), name);
    console.log(`PASS  ${name}`);
  }
  const res = await fetch(`${url}?${new URLSearchParams({ q: 'red, blue', sort: 'oldest' })}`);
  assert.deepEqual((await res.json()).map((f) => f.id), ['B2345678', 'R2345678', 'C2345678'],
    'loaded first, then selected sort; comma order does not reorder results');
  console.log('PASS  existing loaded-first and selected sorting');
  const tooMany = await fetch(`${url}?${new URLSearchParams({ q: Array(33).fill('blue').join(',') })}`);
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /at most 32/);
  console.log('PASS  oversized lists fail explicitly instead of dropping entries');
  console.log(`All ${cases.length + 2} search API checks passed.`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  db.close();
}

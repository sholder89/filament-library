/**
 * Search expansion, checked without a database.
 *
 * The SQL half is exercised by hand; this pins the part that decides what a
 * word is allowed to mean, which is where the damage would be silent — a group
 * that's too generous turns a search into "show me everything", and nobody
 * notices a search that returns too much.
 */
import { expandTerm, normalizeQuery } from '../server/search-terms.js';

// Stands in for what's written on the spools in a library.
const SHELF = ['sunlu', 'elegoo', 'overture', 'polymaker', 'creality', 'bambu',
  'pla', 'petg', 'tpu', 'tpe', 'asa', 'gray', 'grey', 'blue', 'navy', 'black',
  'silver', 'clear', 'silk', 'translucent', 'carbon'];

const CASES = [
  { term: 'gray',       wants: ['grey'],            reason: 'the spelling either way' },
  { term: 'grey',       wants: ['gray'],            reason: 'and back again' },
  { term: 'flexible',   wants: ['tpu', 'tpe'],      reason: 'asked for by feel, not by name' },
  { term: 'shiny',      wants: ['silk'],            reason: 'likewise' },
  { term: 'graey',      wants: ['gray', 'grey'],    reason: 'a typo reaches both spellings' },
  { term: 'polymker',   wants: ['polymaker'],       reason: 'a typo in a brand' },
  { term: 'trasnlucent', wants: ['translucent'],    reason: 'two edits, on a long word' },

  // The other half: words that must NOT drag anything else in.
  { term: 'red',        avoids: SHELF,              reason: 'too short to correct — "red" must not reach "grey"' },
  { term: 'blue',       avoids: ['black', 'clear'], reason: 'a real word stays itself' },
  { term: 'pla',        avoids: ['petg', 'tpu'],    reason: 'three letters, no guessing' },
  { term: 'black',      avoids: ['blue'],           reason: 'one edit apart in length only' },
];

let failures = 0;

for (const c of CASES) {
  const got = expandTerm(c.term, SHELF);
  const problems = [];

  for (const want of c.wants ?? []) {
    if (!got.includes(want)) problems.push(`expected to also search "${want}"`);
  }
  for (const avoid of c.avoids ?? []) {
    if (avoid !== c.term && got.includes(avoid)) problems.push(`must not search "${avoid}"`);
  }

  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${c.term.padEnd(13)} ${c.reason}`);
  console.log(`      -> ${got.join(', ')}`);
  for (const p of problems) console.log(`      !! ${p}`);
  if (problems.length) failures++;
}

const PHRASES = [
  ['see through', 'seethrough'],
  ['see-through', 'seethrough'],
  ['glow in the dark', 'glow'],
  ['carbon fibre', 'carbon'],
  ['tri-color', 'tricolor'],
  ['in the printer', 'loaded'],
  ['sunlu blue', 'sunlu blue'],
];

for (const [input, expected] of PHRASES) {
  const got = normalizeQuery(input);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  phrase "${input}" -> "${got}"`);
  if (!ok) { console.log(`      !! expected "${expected}"`); failures++; }
}

console.log();
const total = CASES.length + PHRASES.length;
console.log(failures ? `${failures} of ${total} failed.` : `All ${total} search expansions behaved.`);
process.exit(failures ? 1 : 0);

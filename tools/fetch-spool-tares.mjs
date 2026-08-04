/**
 * Regenerates server/spool-tares.js from the emptyspool.github.io database.
 *
 * That's a crowdsourced table of what empty spools weigh — the same data the
 * 3D Printing Stack Exchange answer on the subject reproduces, but live and as
 * JSON rather than a copy of an old snapshot. Runs at development time and
 * commits its output; nothing at runtime talks to them.
 *
 *   node tools/fetch-spool-tares.mjs
 *
 * The entries are free text written by different people, so most of the work
 * here is reading weights and spool sizes out of prose, and then refusing the
 * ones that can't be true.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BRANDS } from '../server/catalog.js';

/**
 * Contributors write the brand however they like, and a tare filed under a name
 * the app never uses is a tare that never gets found. Anything matching a known
 * brand case-insensitively is rewritten to the app's spelling; these are the
 * ones that don't match on their own.
 */
const ALIASES = new Map(Object.entries({
  bambulab: 'Bambu Lab',
  'bambu lab': 'Bambu Lab',
  '3d fuel': '3D-Fuel',
  amazonbasics: 'Amazon Basics',
  'amolen rev.2': 'Amolen',
  'coex llc': 'COEX',
  'dagoma chromatik': 'Dagoma',
  'eono (amazon)': 'Eono',
  'geeetech \\ giantarm': 'Geeetech',
  'prusa research': 'Prusament',
  'smart materials (makershop)': 'Smart Materials',
  'gizmo dorks': 'GizmoDorks',
  stronghero3d: 'StrongHero3D',
  'plastika trček': 'Plastika Trcek',
}));

const canonical = new Map(BRANDS.map((b) => [b.toLowerCase(), b]));

function normaliseBrand(raw) {
  const key = raw.toLowerCase().trim();
  const alias = ALIASES.get(key);
  if (alias) return canonical.get(alias.toLowerCase()) ?? alias;
  return canonical.get(key) ?? raw;
}

const SOURCE = 'https://raw.githubusercontent.com/emptyspool/emptyspool.github.io/main/empty_spool_weight.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'spool-tares.js');

/**
 * Grams out of things like "198", "195 g", "~173g", "288-294",
 * "est. ~200-220", "212gr but other spools: 241gr", "205g, 240g*".
 * A range becomes its midpoint; a second figure after prose is ignored, since
 * it's a different spool being mentioned rather than a better reading.
 */
function readGrams(text) {
  const s = String(text ?? '').replace(/,/g, '.');
  const range = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (range) return Math.round((Number(range[1]) + Number(range[2])) / 2);
  const one = s.match(/(\d+(?:\.\d+)?)/);
  return one ? Math.round(Number(one[1])) : null;
}

/**
 * How much filament the spool was sold holding, from "PLA, 0,5kg", "1kg",
 * "TPU 750g", "2.3kg", "250g spool", "PLA, 1 KG".
 *
 * Deliberately ignores anything under 100 g, which is filament diameter
 * ("1.75mm PLA+") rather than a spool size, and anything over 10 kg.
 */
function readCapacity(text) {
  const s = String(text ?? '').replace(/(\d),(\d)/g, '$1.$2');
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(kg|kilo|g\b|gram)/gi)) {
    const n = Number(m[1]);
    const grams = /^k/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
    if (grams >= 100 && grams <= 10000) return grams;
  }
  return null;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);
const records = await res.json();

let parsed = records.map((r) => ({
  brand: normaliseBrand(clean(r.Manufacturer)),
  grams: readGrams(r['Spool Weight, g']),
  capacity: readCapacity(r['Flavor (type, size, etc)']),
  // Measurements of the spool itself are for someone deciding whether it fits a
  // dry box, not for anyone weighing filament.
  note: clean(r.Comment)
    .replace(/\s*(Diameter|Core ID|Core OD|Core Width|Overall OD|Width|Spool size)\s*[:=].*$/i, ''),
  flavor: clean(r['Flavor (type, size, etc)']),
  year: r.Year,
})).filter((t) => t.brand && t.grams);

/*
 * Refuse what can't be true. A tare that is wrong low silently invents filament
 * that isn't there, which is worse than having no figure at all — so anything
 * less than half or more than double what its own size class weighs is dropped
 * rather than averaged in. Classes with too few entries to have an opinion are
 * left alone.
 */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const classes = new Map();
for (const t of parsed) {
  const key = t.capacity ?? 'unstated';
  if (!classes.has(key)) classes.set(key, []);
  classes.get(key).push(t.grams);
}

/*
 * An absolute floor as well as the relative test, because the size classes with
 * the fewest entries are exactly the ones with no peers to be an outlier
 * against. The lightest credible spools in the whole set are the 200–250 g
 * ones at 104–108 g, so anything under 90 g is a mis-measurement, a typo, or a
 * refill that never had a spool. Being wrong low is the dangerous direction: it
 * invents filament that isn't there and lets you start a print that can't
 * finish.
 */
const FLOOR = 90;

const dropped = [];
parsed = parsed.filter((t) => {
  if (t.grams < FLOOR) {
    dropped.push(`${t.brand} ${t.flavor || ''} — ${t.grams} g, below the ${FLOOR} g floor`);
    return false;
  }
  const peers = classes.get(t.capacity ?? 'unstated');
  if (peers.length < 3) return true;
  const mid = median(peers);
  if (t.grams < mid * 0.5 || t.grams > mid * 2) {
    dropped.push(`${t.brand} ${t.flavor || ''} — ${t.grams} g against a ${mid} g median for ${t.capacity ?? 'unstated'} g spools`);
    return false;
  }
  return true;
});

// Collapse duplicates: same brand, same size, same weight adds nothing.
const seen = new Set();
const entries = parsed.filter((t) => {
  const key = `${t.brand.toLowerCase()}|${t.capacity}|${t.grams}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).sort((a, b) =>
  a.brand.localeCompare(b.brand, 'en', { sensitivity: 'base' })
  || (a.capacity ?? 0) - (b.capacity ?? 0)
  || a.grams - b.grams);

/**
 * A short label. The flavour field mixes the material, the size and the spool
 * style together, and the size is already its own column — so it comes out,
 * along with the punctuation left behind when it does.
 */
const tidy = (s) => clean(s)
  .replace(/^[\s,;/.-]+/, '')
  .replace(/[\s,;/.-]+$/, '')
  .replace(/\s*,\s*,/g, ',');

const noteFor = (t) => {
  const flavour = tidy(
    t.flavor
      .replace(/\b\d+([.,]\d+)?\s*(kg|g)\b/gi, '')
      .replace(/\bspool\b/gi, '')
      .replace(/\b\d+([.,]\d+)?\s*mm\b/gi, ''),
  );

  const bits = [];
  if (flavour && !/^(pla|abs|petg)$/i.test(flavour)) bits.push(flavour);
  if (t.note) bits.push(tidy(t.note));

  const out = tidy(bits.join(' — '));
  return out.length > 88 ? `${out.slice(0, 87).replace(/\s+\S*$/, '')}…` : out;
};

const body = entries.map((t) =>
  `  { brand: ${JSON.stringify(t.brand)}, grams: ${t.grams}, capacity: ${t.capacity}, note: ${JSON.stringify(noteFor(t))} },`,
).join('\n');

const brands = new Set(entries.map((t) => t.brand.toLowerCase())).size;

writeFileSync(OUT, `/**
 * What empty spools weigh, for turning a reading off a kitchen scale into how
 * much filament is left: (what the scale says − this) ÷ the spool's capacity.
 *
 * Generated by tools/fetch-spool-tares.mjs from the crowdsourced database at
 * https://emptyspool.github.io — do not edit by hand, re-run the tool. Brands
 * missing from it belong in EXTRA_TARES in catalog.js.
 *
 * Retrieved: ${new Date().toISOString().slice(0, 10)}
 * ${entries.length} entries across ${brands} brands.
 *
 * These are typical, not exact, and the spread within one brand is the headline
 * rather than a footnote: manufacturers change spool design between product
 * lines and over time, and are under constant pressure to shave grams off
 * shipping weight. One contributor weighed seven spools of a single 3D-Fuel
 * product and got a consistent 262 g; another weighed three of the same brand's
 * other style and got 288–294. So the app treats every figure here as a guess,
 * says so, and lets any spool carry its own measured weight instead.
 *
 * \`capacity\` is what the spool was sold holding, which is the strongest signal
 * for choosing between a brand's entries — a 250 g spool and a 1 kg spool are
 * nothing alike. null means the source didn't say.
 */
export const SPOOL_TARES = [
${body}
];
`);

console.log(`Wrote ${entries.length} entries across ${brands} brands to ${OUT}`);
if (dropped.length) {
  console.log(`\nDropped ${dropped.length} as implausible for their size class:`);
  for (const d of dropped) console.log(`  ${d}`);
}

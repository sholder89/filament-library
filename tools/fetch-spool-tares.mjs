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
 * The weight including the cardboard centre, where a contributor separated the
 * two.
 *
 * Several spools are a plastic reel around a cardboard core, and some people
 * weighed the plastic on its own and noted the core separately. What goes on a
 * scale has the core in it, so the inclusive figure is the one that matters —
 * Bambu's is recorded as 207 g of plastic with a 36 g ring, and using 207 would
 * claim 36 g of filament that isn't there on every one of those spools.
 *
 * Three shapes appear in the data: a stated total, a "with the X" second
 * reading in the weight column, and a core weight given on its own to be added.
 */
function withCore(weightText, comment) {
  const base = readGrams(weightText);
  if (base == null) return { grams: base, adjusted: null };

  const c = String(comment ?? '');

  // "…so total weight is 243 g"
  const total = c.match(/total\s+weight\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
  if (total) {
    const g = Math.round(Number(total[1]));
    if (g > base) return { grams: g, adjusted: `stated total ${g} g rather than ${base} g of plastic` };
  }

  // "205g, 240g*" with a comment explaining the second includes the core.
  if (/\bwith\b.*\b(core|tube|ring|cardboard|insert)\b/i.test(c)) {
    const all = [...String(weightText).matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Math.round(Number(m[1])));
    const most = Math.max(...all);
    if (most > base) return { grams: most, adjusted: `${most} g including the core, not ${base} g without` };
  }

  // "Cardboard ring in center weights 36 g" with no total given.
  const core = c.match(/(?:cardboard|core|ring|tube)[^.]*?(\d+(?:\.\d+)?)\s*g/i);
  if (core && !total) {
    const add = Math.round(Number(core[1]));
    if (add > 0 && add < base) {
      return { grams: base + add, adjusted: `${base} g plus a ${add} g core` };
    }
  }

  return { grams: base, adjusted: null };
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

/**
 * Which material the entry is for, where the contributor said.
 *
 * Spool design varies by product line within a brand, not just by size —
 * Creality's standard spool is 138 g, their PETG one 188 g and their Hyper ABS
 * a 180 g cardboard reel; Overture's type I is 238 g against 170 g for their
 * cardboard. Matching on the material as well as the size gets a good deal
 * closer than a brand-wide average.
 *
 * Longest first so PETG beats PET and PLA+ beats PLA, and reduced to the base
 * family, because that's the granularity the filament records use.
 */
const MATERIAL_HINTS = [
  ['PETG', 'PETG'], ['PCTG', 'PETG'], ['PET', 'PETG'],
  ['PLA+', 'PLA'], ['PLA', 'PLA'], ['APLA', 'PLA'],
  ['ABS', 'ABS'], ['ASA', 'ABS'],
  ['TPU', 'TPU'], ['TPE', 'TPU'], ['FLEX', 'TPU'],
  ['NYLON', 'Nylon'], ['PA12', 'Nylon'], ['PA6', 'Nylon'],
  ['PVA', 'Other'], ['HIPS', 'Other'], ['PEEK', 'Other'], ['PVB', 'Other'],
  ['PC', 'Other'],
];

function readMaterial(text) {
  const s = String(text ?? '').toUpperCase();
  for (const [token, family] of MATERIAL_HINTS) {
    // A boundary check, so "PLASTIC" isn't read as PLA and "SPOOL" isn't PC.
    if (new RegExp(`(^|[^A-Z])${token.replace('+', '\\+')}([^A-Z]|$)`).test(s)) return family;
  }
  return null;
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);
const records = await res.json();

const cored = [];

let parsed = records.map((r) => {
  const w = withCore(r['Spool Weight, g'], r.Comment);
  if (w.adjusted) cored.push(`${clean(r.Manufacturer)} ${clean(r['Flavor (type, size, etc)'])} — ${w.adjusted}`);
  return {
  brand: normaliseBrand(clean(r.Manufacturer)),
  grams: w.grams,
  capacity: readCapacity(r['Flavor (type, size, etc)']),
  // Measurements of the spool itself are for someone deciding whether it fits a
  // dry box, not for anyone weighing filament.
  note: clean(r.Comment)
    .replace(/\s*(Diameter|Core ID|Core OD|Core Width|Overall OD|Width|Spool size)\s*[:=].*$/i, ''),
  material: readMaterial(`${r['Flavor (type, size, etc)']} ${r.Comment ?? ''}`),
  flavor: clean(r['Flavor (type, size, etc)']),
  year: r.Year,
  };
}).filter((t) => t.brand && t.grams);

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
  const key = `${t.brand.toLowerCase()}|${t.capacity}|${t.material}|${t.grams}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).sort((a, b) =>
  a.brand.localeCompare(b.brand, 'en', { sensitivity: 'base' })
  || (a.capacity ?? 0) - (b.capacity ?? 0)
  || String(a.material).localeCompare(String(b.material))
  || a.grams - b.grams);

/*
 * A fallback per size, for a brand nobody has weighed — without one the feature
 * simply refuses to work for anything off the beaten track. The median of every
 * spool of that size in the set, so it moves with the data rather than being a
 * number somebody once guessed.
 */
const fallbacks = [];
for (const [capacity, list] of classes) {
  if (capacity === 'unstated' || list.length < 5) continue;
  const usable = list.filter((g) => g >= FLOOR);
  if (!usable.length) continue;
  fallbacks.push({
    brand: '',
    grams: Math.round(median(usable)),
    capacity,
    material: null,
    flavor: '',
    note: `Typical across ${usable.length} spools this size`,
  });
}

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

const body = [...entries, ...fallbacks].map((t) =>
  `  { brand: ${JSON.stringify(t.brand)}, grams: ${t.grams}, capacity: ${t.capacity},`
  + ` material: ${JSON.stringify(t.material)}, note: ${JSON.stringify(noteFor(t))} },`,
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
 * \`capacity\` is what the spool was sold holding and \`material\` the base family
 * it was sold as. Both are needed to choose between a brand's entries: a 250 g
 * spool and a 1 kg spool are nothing alike, and neither are Creality's 138 g
 * standard reel and the 180 g cardboard one their Hyper ABS ships on. null in
 * either means the source didn't say.
 */
export const SPOOL_TARES = [
${body}
];
`);

console.log(`Wrote ${entries.length} entries across ${brands} brands to ${OUT}`);
if (cored.length) {
  console.log(`\nTook the cardboard-inclusive weight for ${cored.length}:`);
  for (const c of cored) console.log(`  ${c}`);
}
if (dropped.length) {
  console.log(`\nDropped ${dropped.length} as implausible for their size class:`);
  for (const d of dropped) console.log(`  ${d}`);
}

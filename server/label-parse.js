/**
 * Turns the raw text an OCR engine returns from a filament label into the
 * fields the add form uses.
 *
 * Deliberately conservative: anything it isn't reasonably sure about is left
 * out entirely rather than guessed at, because a wrong value silently saved is
 * worse than a blank the user fills in themselves. Every field is independent —
 * a label with only a material still yields that material.
 *
 * Kept free of any OCR/network concern so it can be tested against known label
 * text directly (see tools/test-label-parse.mjs).
 */

import { BRANDS, MATERIALS, COLOR_NAMES, FINISHES } from './catalog.js';
import { editDistance } from './text.js';

/**
 * Manufacturer prefixes and product-line words that sit around the real value.
 * "CR-PETG" is Creality's PETG; "Pro PCTG" is 3D-Fuel's PCTG.
 */
const BRAND_HINTS = [
  { pattern: /\bCR-[A-Z]/i, brand: 'Creality' },
  { pattern: /\b3D[\s-]?FUEL\b/i, brand: '3D-Fuel' },
];

/** Matches a "Color" heading, capturing anything on the same line after it. */
const COLOR_LABEL_LINE = /^\s*(?:colou?r|颜色)\s*[:：]?\s*(.*)$/i;

/**
 * Color words that describe opacity or sheen rather than a hue. They belong in
 * the stored name — "Transparent Burgundy Red" is what the label says — but must
 * not win when picking the swatch, or a wine-red spool renders pale blue.
 */
const MODIFIERS = new Set(['clear', 'transparent', 'translucent', 'natural']);

/** Label words that end a color value when they run onto the same line. */
const VALUE_STOP = /\b(?:diameter|直径|n\.?w\.?|weight|重量|print\s*temp|打印温度|extruder|hot\s*end|heated\s*bed|speed|made\s+in|rohs|s\/n)\b/i;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const upper = (s) => norm(s).toUpperCase();

/** Whole-word-ish search that tolerates the punctuation labels are full of. */
function containsPhrase(haystack, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(haystack);
}

/** Longest match wins, so PCTG beats PC and PETG beats PET. */
function longestMatch(text, candidates, key = (c) => c) {
  let best = null;
  for (const c of candidates) {
    const name = key(c);
    if (!name) continue;
    if (best && name.length <= key(best).length) continue;
    if (containsPhrase(text, name)) best = c;
  }
  return best;
}

function findBrand(text) {
  const direct = longestMatch(text, BRANDS);
  if (direct) return direct;
  // Only once no brand is spelled out: infer from a product-code prefix.
  for (const { pattern, brand } of BRAND_HINTS) {
    if (pattern.test(text)) return brand;
  }
  return '';
}

function findMaterial(text) {
  const match = longestMatch(text, MATERIALS, (m) => m.name);
  return match?.name ?? '';
}

/** The finishes that decide where color goes; only one can apply. */
const PATTERN_EFFECTS = new Set(['gradient', 'dual', 'marble', 'wood']);

/**
 * All of them, not just the longest.
 *
 * "PLA Silk Tricolor Gradient" names two, and returning one meant the label
 * read correctly and was recorded as half of itself. Longest-first so a pattern
 * like "Dual color" wins over a stray word inside it, and only one pattern is
 * kept — two would fight over the same pixels on the graphic.
 */
function findFinish(text, colorName) {
  const found = [...FINISHES]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((f) => containsPhrase(text, f.name));

  const names = [];
  let pattern = false;
  for (const f of found) {
    if (PATTERN_EFFECTS.has(f.effect)) {
      if (pattern) continue;
      pattern = true;
    }
    names.push(f.name);
  }

  // A color called "Transparent" or "Clear" is stating the finish too, and
  // see-through spools are the ones worth being able to pick out of a shelf.
  if (!names.length && /\b(transparent|translucent|clear)\b/i.test(colorName)) return 'Translucent';
  return names.join(', ');
}

/**
 * Color is the messiest field: it shows up after a "Color" label, inside
 * parentheses, or as a bare line. Candidates are gathered from all three and
 * scored by how much of the phrase is recognisable color vocabulary.
 */
function findColor(rawText) {
  const text = rawText.replace(/\r/g, '');
  const lines = text.split('\n');
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const m = COLOR_LABEL_LINE.exec(lines[i]);
    if (!m) continue;

    if (norm(m[1])) {
      candidates.push({ value: m[1], weight: 3 });
      continue;
    }

    /*
     * The heading is alone on its line and the value runs onto the ones below —
     * a bilingual spec table reads "Color / 颜色 / Transparent / Burgundy Red /
     * 透明酒红色". Gather the Latin lines that follow, stopping at the first
     * non-Latin line once something has been collected, which is what closes
     * the value off before the next field's heading.
     */
    const parts = [];
    for (const line of lines.slice(i + 1, i + 7)) {
      if (VALUE_STOP.test(line)) break;
      if (!/[A-Za-z]/.test(line)) {
        if (parts.length) break;
        continue;
      }
      parts.push(norm(line));
      if (parts.join(' ').split(/\s+/).length >= 4) break;
    }
    if (parts.length) candidates.push({ value: parts.join(' '), weight: 3 });
  }

  for (const m of text.matchAll(/\(([^)]{2,40})\)/g)) {
    candidates.push({ value: m[1], weight: 2 });
  }

  for (const line of lines) {
    const trimmed = norm(line);
    if (trimmed && trimmed.length <= 40) candidates.push({ value: trimmed, weight: 1 });
  }

  let best = null;
  for (const candidate of candidates) {
    // Trim at a label word and drop trailing size/weight noise like "-1KG(N.W)".
    let value = candidate.value.split(VALUE_STOP)[0];
    value = value.replace(/[-–]\s*\d.*$/, '');
    // Drop non-Latin script — labels repeat the color in Chinese right after.
    value = value.replace(/[^\x20-\x7E]/g, ' ');
    value = norm(value).replace(/^[^A-Za-z]+|[^A-Za-z)]+$/g, '');
    if (!value || value.length < 3) continue;

    /*
     * The cap counts what's printed, not what the split produced. "SkyBlue
     * RoseRed LightGreen" is three things on the label and six words after
     * splitting, and counting the latter threw out the whole phrase.
     */
    if (value.split(/[\s-]+/).filter(Boolean).length > 5) continue;

    // Kept as printed as well as split: the grouping is information. "SkyBlue
    // RoseRed LightGreen" is three colors precisely because it's three words,
    // and that's lost the moment the capitals become spaces.
    const printed = value.split(/[\s-]+/).filter(Boolean);
    value = norm(splitCamel(value));
    // Separators count as spaces here: "Turquoiso/Coral/Gold" is three words,
    // and scoring it as one matched nothing and threw the whole line away.
    const words = value.split(/[\s/,&-]+/).filter(Boolean);

    // How many words are actual color vocabulary?
    const known = words.filter((w) => Object.keys(COLOR_NAMES)
      .some((n) => n.toLowerCase() === w.toLowerCase())).length;
    if (!known) continue;

    const score = candidate.weight * 10 + known * 4 - words.length;
    if (!best || score > best.score) best = { value, score, printed };
  }

  return best ? { name: titleCase(best.value), printed: best.printed } : { name: '', printed: [] };
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Splits run-together color names: SkyBlue, RoseRed, LightGreen, OrangeRed.
 *
 * Sellers write them exactly like that — the vocabulary is all there, just
 * without the spaces, so none of it matched and a photo of the label came back
 * with no color at all. Applied only to color phrases, where a capital in the
 * middle of a word means a word boundary rather than a product code.
 *
 * Runs of capitals are left alone, so CF, PLA and 3DFuel survive intact.
 */
function splitCamel(s) {
  return String(s).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * The nearest color name, for words that are nearly one.
 *
 * Labels are printed by the same people who wrote "Turquoiso", and OCR adds its
 * own. Guessing beats dropping the color on the floor: the cost of being wrong
 * is a shade that's slightly off on a graphic, and it's a guess about a word
 * that plainly meant to be a color.
 *
 * Deliberately tight. Short words are left alone — three letters from "gold"
 * is half the word — and a tie between two colors is no answer at all.
 */
function nearestColorName(word) {
  const w = String(word).toLowerCase().trim();
  if (w.length < 5) return '';

  const limit = w.length >= 8 ? 2 : 1;
  let best = '';
  let bestAt = limit + 1;
  let tied = false;

  for (const known of Object.keys(COLOR_NAMES)) {
    const k = known.toLowerCase();
    if (Math.abs(k.length - w.length) > limit) continue;
    const d = editDistance(w, k, limit);
    if (d > limit) continue;
    if (d < bestAt) { bestAt = d; best = known; tied = false; }
    else if (d === bestAt && known !== best) tied = true;
  }

  return tied ? '' : best;
}

/** Resolves a color phrase to a hex, reusing the same vocabulary the UI does. */
function hexForColor(name) {
  if (!name) return '';
  const target = name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();

  for (const [known, hex] of Object.entries(COLOR_NAMES)) {
    if (known.toLowerCase() === target) return hex;
  }

  // Two passes: real hues first, opacity words only if nothing else matched.
  // "Clear Wine Red" has to resolve to wine, not to clear.
  for (const allowModifiers of [false, true]) {
    let bestLen = 0;
    let bestHex = '';
    for (const [known, hex] of Object.entries(COLOR_NAMES)) {
      const k = known.toLowerCase();
      if (!allowModifiers && MODIFIERS.has(k)) continue;
      if (k.length <= bestLen) continue;
      if (new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(target)) {
        bestLen = k.length;
        bestHex = hex;
      }
    }
    if (bestHex) return bestHex;
  }
  return '';
}

/**
 * Every color named in the phrase, in the order they're written.
 *
 * A tri-color spool says so on the box — "Purple Orange Teal" — and resolving
 * that to the single closest hex throws away two thirds of what it told you.
 * Those are exactly the spools where the extra tones matter, since the graphic
 * blends them.
 *
 * Returns nothing for a single color, however many words its name runs to:
 * "Snow Mountain Blue" is one color, and the exact-name check below is what
 * keeps it from being read as snow plus blue.
 */
function tonesForColor(name, text = '', tokens = []) {
  if (!name) return [];

  const target = name.toLowerCase().replace(/[\s_,/&-]+/g, ' ').trim();

  for (const known of Object.keys(COLOR_NAMES)) {
    if (known.toLowerCase() === target) return [];
  }

  /*
   * Where the label has already divided the colors up, believe it.
   *
   * Two ways it does that: a real separator — "Sky Blue/Rose Red/Light Green"
   * off the spool tag — or running each color into one word, "SkyBlue RoseRed
   * LightGreen", where the capital is the separator and no single color is
   * named that way.
   *
   * Either way each piece is resolved on its own, which is what copes with
   * halves that aren't in the vocabulary at all. "Rose" and "Emerald" are not
   * colors this app knows, and the whole-phrase matching below discards any
   * phrase holding a word it can't place — so Rose Red and EmeraldGreen took
   * their spools' other two colors down with them.
   */
  const split = String(name).split(/\s*[/|+&]\s*|\s*,\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const units = split.length > 1
    ? split
    : (tokens.filter((t) => /[a-z][A-Z]/.test(t)).length >= 2 ? tokens : []);

  if (units.length > 1) {
    const resolve = (u) => {
      const spaced = splitCamel(u);
      // Only once the word itself fails: a misspelling shouldn't cost the
      // spool its other two colors.
      return hexForColor(spaced) || COLOR_NAMES[nearestColorName(spaced)] || '';
    };
    const perUnit = [...new Set(units.map(resolve).filter(Boolean))];
    if (perUnit.length > 1) return perUnit.slice(0, 3);
  }

  const hits = [];
  for (const [known, hex] of Object.entries(COLOR_NAMES)) {
    const k = known.toLowerCase();
    // Modifiers ("clear", "light") qualify a color rather than being one.
    if (MODIFIERS.has(k)) continue;
    const m = new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).exec(target);
    if (m) hits.push({ at: m.index, end: m.index + k.length, hex });
  }

  // Longest first, so "light blue orange" takes the light blue and not the blue
  // sitting inside it; overlapping shorter matches are then discarded.
  hits.sort((a, b) => (b.end - b.at) - (a.end - a.at));
  const taken = [];
  for (const h of hits) {
    if (taken.some((t) => h.at < t.end && t.at < h.end)) continue;
    taken.push(h);
  }

  /*
   * Every word has to be part of a color, or this isn't a list of them.
   *
   * "Snow Mountain Blue" contains two known colors and is plainly one color
   * with a poetic name — "Mountain" is the tell. "Purple Orange Teal" has no
   * word left over. Without this check the evocative names filament companies
   * love get shredded into their ingredients.
   */
  const covered = new Array(target.length).fill(false);
  for (const h of taken) for (let i = h.at; i < h.end; i++) covered[i] = true;

  let at = 0;
  for (const word of target.split(' ')) {
    const start = target.indexOf(word, at);
    at = start + word.length;
    if (MODIFIERS.has(word)) continue;
    if (!covered[start]) return [];
  }

  const distinct = [...new Set(taken.sort((a, b) => a.at - b.at).map((h) => h.hex))];
  if (distinct.length < 2) return [];

  /*
   * Two color words next to each other usually qualify one another —
   * "Burgundy Red", "Light Blue" — rather than listing two. So a pair needs
   * evidence: the name separating them itself, or the label saying somewhere
   * that the spool is multi-tone. Without that, "Transparent Burgundy Red"
   * came out as burgundy *and* red, on a spool that is neither.
   *
   * Three in a row is its own evidence. Nobody qualifies a color twice, and
   * requiring the keyword failed as soon as the camera started cropping to the
   * viewfinder — "Purple Orange Teal" is on the swatch, "Tricolor" is in a
   * heading two inches away and no longer in the photograph.
   */
  if (distinct.length === 2) {
    const separated = /[,/&]|\band\b/i.test(name);
    const declared = /\b(gradient|tri[\s-]?colou?r|dual|two[\s-]?tone|multi[\s-]?colou?r|rainbow|co[\s-]?extru)/i
      .test(`${name} ${text}`);
    if (!separated && !declared) return [];
  }

  return distinct.slice(0, 3);
}

function findDiameter(text) {
  const m = /(\d\.\d{1,2})\s*MM/i.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1]);
  // Only the diameters filament actually ships in — guards against picking up
  // some unrelated millimetre measurement.
  return [1.75, 2.85, 3].includes(value) ? value : null;
}

function findWeightGrams(text) {
  const kg = /(\d+(?:\.\d+)?)\s*KG/i.exec(text);
  if (kg) {
    const grams = Math.round(parseFloat(kg[1]) * 1000);
    return grams >= 100 && grams <= 10000 ? grams : null;
  }
  const g = /(\d{3,4})\s*G(?![A-Z])/i.exec(text);
  if (g) {
    const grams = parseInt(g[1], 10);
    return grams >= 100 && grams <= 10000 ? grams : null;
  }
  return null;
}

/**
 * Temperatures are printed as ranges ("230-250°C"). The lower end is taken as
 * the starting point — it's the first figure listed and the safer place to
 * begin tuning from.
 */
function findTemp(text, keywords, range) {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!keywords.test(lines[i])) continue;

    // The heading and its value are often on separate lines, with the Chinese
    // translation in between ("Print Temp / 打印温度 / 230-250℃").
    const window = lines.slice(i, i + 3).join(' ');
    // ℃ is a single character (U+2103), not ° followed by C.
    const m = /(\d{2,3})\s*(?:°\s*C|℃)?\s*[-–~]\s*(\d{2,3})|(\d{2,3})\s*(?:°\s*C|℃)/i.exec(window);
    if (!m) continue;

    const value = parseInt(m[1] ?? m[3], 10);
    if (value >= range[0] && value <= range[1]) return value;
  }
  return null;
}

/**
 * @param {string} text Raw OCR output, newlines preserved.
 * @returns fields suitable for the add form; absent values are omitted.
 */
export function parseLabel(text) {
  const raw = String(text ?? '');
  const flat = upper(raw);

  const { name: colorName, printed } = findColor(raw);
  const tones = tonesForColor(colorName, raw, printed);
  const finish = findFinish(flat, colorName);

  /*
   * A color that names several colors is a multi-tone spool, and the graphic
   * only blends them when a pattern finish says to. Boxes usually say "gradient"
   * or "tri-color" somewhere and findFinish catches it — this is for the ones
   * that only say it in the color, and it's added rather than replacing, so a
   * silk tri-color keeps its silk.
   */
  const hasPattern = /gradient|dual|marble|wood|rainbow/i.test(`${finish} ${flat}`);
  const withPattern = tones.length > 1 && !hasPattern
    ? [finish, 'Gradient'].filter(Boolean).join(', ')
    : finish;

  const out = {
    brand: findBrand(flat),
    material: findMaterial(flat),
    color_name: colorName,
    color_hex: tones[0] ?? hexForColor(colorName),
    color_hex2: tones[1] ?? '',
    color_hex3: tones[2] ?? '',
    finish: withPattern,
    diameter: findDiameter(flat),
    spool_weight_g: findWeightGrams(flat),
    nozzle_temp: findTemp(raw, /print\s*temp|extruder|hot\s*end|打印温度|nozzle/i, [150, 400]),
    bed_temp: findTemp(raw, /heated\s*bed|bed\s*temp|热床/i, [0, 150]),
  };

  // Drop anything empty so the client can tell "not found" from "found blank"
  // and only overwrite the fields we actually read.
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
}

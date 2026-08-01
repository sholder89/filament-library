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
 * Colour words that describe opacity or sheen rather than a hue. They belong in
 * the stored name — "Transparent Burgundy Red" is what the label says — but must
 * not win when picking the swatch, or a wine-red spool renders pale blue.
 */
const MODIFIERS = new Set(['clear', 'transparent', 'translucent', 'natural']);

/** Label words that end a colour value when they run onto the same line. */
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

function findFinish(text, colorName) {
  const match = longestMatch(text, FINISHES, (f) => f.name);
  if (match) return match.name;

  // A colour called "Transparent" or "Clear" is stating the finish too, and
  // see-through spools are the ones worth being able to pick out of a shelf.
  if (/\b(transparent|translucent|clear)\b/i.test(colorName)) return 'Translucent';
  return '';
}

/**
 * Colour is the messiest field: it shows up after a "Color" label, inside
 * parentheses, or as a bare line. Candidates are gathered from all three and
 * scored by how much of the phrase is recognisable colour vocabulary.
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
    // Drop non-Latin script — labels repeat the colour in Chinese right after.
    value = value.replace(/[^\x20-\x7E]/g, ' ');
    value = norm(value).replace(/^[^A-Za-z]+|[^A-Za-z)]+$/g, '');
    if (!value || value.length < 3) continue;

    const words = value.split(/[\s-]+/).filter(Boolean);
    if (words.length > 5) continue;

    // How many words are actual colour vocabulary?
    const known = words.filter((w) => Object.keys(COLOR_NAMES)
      .some((n) => n.toLowerCase() === w.toLowerCase())).length;
    if (!known) continue;

    const score = candidate.weight * 10 + known * 4 - words.length;
    if (!best || score > best.score) best = { value, score };
  }

  return best ? titleCase(best.value) : '';
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Resolves a colour phrase to a hex, reusing the same vocabulary the UI does. */
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

  const colorName = findColor(raw);

  const out = {
    brand: findBrand(flat),
    material: findMaterial(flat),
    color_name: colorName,
    color_hex: hexForColor(colorName),
    finish: findFinish(flat, colorName),
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

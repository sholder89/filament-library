import { editDistance, typoAllowance } from './text.js';

/**
 * Words that should find each other in a search.
 *
 * Two different problems wearing the same coat. Half of these are spellings —
 * a shelf ends up holding both "Grey" and "Gray" because that's how the
 * manufacturers printed them, and searching either should find both. The rest
 * are the words people actually reach for: nobody thinks "I'll look for TPU",
 * they think "where's my flexible stuff".
 *
 * Groups are undirected: any word finds every other word in its group. Kept
 * deliberately tight, because a group that's too generous quietly turns a
 * search into "show me everything" — the failure is much harder to notice than
 * a search that finds nothing.
 */
const GROUPS = [
  // Spellings
  ['gray', 'grey'],
  ['color', 'colour'],
  ['aluminium', 'aluminum'],
  ['fiber', 'fibre'],

  // Material, as asked for rather than as labelled
  ['flexible', 'flex', 'tpu', 'tpe', 'rubber', 'rubbery', 'soft', 'squishy'],
  ['carbon', 'cf'],
  ['glass', 'gf'],
  ['nylon', 'pa'],
  ['polycarbonate', 'pc'],
  ['biodegradable', 'pla'],
  ['tough', 'petg', 'abs', 'asa'],
  ['outdoor', 'asa', 'petg'],

  // Finish, likewise
  ['clear', 'transparent', 'translucent', 'seethrough'],
  ['shiny', 'silk', 'silky', 'gloss', 'glossy'],
  ['flat', 'matte', 'matt'],
  ['sparkle', 'sparkly', 'glitter', 'glittery'],
  ['glow', 'glowing', 'luminous', 'phosphorescent'],
  ['metal', 'metallic'],
  ['wood', 'wooden'],
  ['multicolor', 'multicolour', 'rainbow', 'tricolor', 'tricolour', 'gradient'],
  ['dual', 'twotone', 'bicolor', 'bicolour'],

  // Colours that are each other in everything but name
  ['purple', 'violet'],
  ['cyan', 'aqua', 'turquoise', 'teal'],
  ['magenta', 'fuchsia'],
  ['maroon', 'burgundy', 'wine'],
  ['beige', 'tan', 'cream', 'ivory'],
  ['gold', 'golden'],
  ['silver', 'chrome'],
  ['lime', 'chartreuse'],
];

/** word -> every word that should be searched alongside it. */
const SYNONYMS = new Map();
for (const group of GROUPS) {
  for (const word of group) {
    const seen = SYNONYMS.get(word) ?? new Set([word]);
    for (const other of group) seen.add(other);
    SYNONYMS.set(word, seen);
  }
}

/**
 * Phrases people type as several words that mean one thing.
 *
 * Collapsed before the query is split up, because every word has to find
 * something on its own: "see through" was two words, neither of which is
 * anywhere on a spool, so a perfectly reasonable search found nothing.
 */
const PHRASES = [
  [/\bsee[\s-]?through\b/gi, 'seethrough'],
  [/\bglow[\s-]in[\s-]the[\s-]dark\b/gi, 'glow'],
  [/\bcarbon[\s-]fib(?:er|re)\b/gi, 'carbon'],
  [/\bglass[\s-]fib(?:er|re)\b/gi, 'glass'],
  [/\btwo[\s-]tone\b/gi, 'twotone'],
  [/\bdual[\s-]colou?r\b/gi, 'dual'],
  [/\bmulti[\s-]colou?r\b/gi, 'multicolor'],
  [/\btri[\s-]colou?r\b/gi, 'tricolor'],
  [/\bin (?:the |a )?printer\b/gi, 'loaded'],
];

export function normaliseQuery(q) {
  let out = String(q ?? '');
  for (const [pattern, word] of PHRASES) out = out.replace(pattern, word);
  return out;
}

/** Guards against one vague word dragging in half the library. */
const MAX_VARIANTS = 10;

/**
 * A search word, plus everything that ought to count as the same word.
 *
 * `vocabulary` is what's actually written on the spools in this library, which
 * is what makes the typo pass safe: a misspelling can only ever be corrected
 * towards something that is genuinely there, so the worst case is finding a
 * spool you did mean rather than inventing a match out of nothing.
 */
export function expandTerm(word, vocabulary = []) {
  const w = word.toLowerCase();
  const out = new Set([w]);

  for (const s of SYNONYMS.get(w) ?? []) out.add(s);

  const limit = typoAllowance(w);
  if (limit) {
    for (const known of vocabulary) {
      if (out.has(known) || Math.abs(known.length - w.length) > limit) continue;
      // Substrings are already handled by LIKE — this is only for words that
      // differ, not words that contain.
      if (known.includes(w) || w.includes(known)) continue;
      if (editDistance(w, known, limit) <= limit) out.add(known);
      if (out.size >= MAX_VARIANTS) break;
    }
  }

  return [...out].slice(0, MAX_VARIANTS);
}

/** Every distinct word written across the searchable columns. */
export function vocabularyFrom(rows) {
  const words = new Set();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      for (const word of String(value ?? '').toLowerCase().split(/[^a-z0-9+]+/i)) {
        if (word.length > 2) words.add(word);
      }
    }
  }
  return [...words];
}

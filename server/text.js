/** Small string helpers shared by the label parser and the search. */

/**
 * Levenshtein distance, abandoned as soon as it can't come in under `limit`.
 *
 * The bail-out is what makes it cheap enough to run a search term against every
 * word in the library: most comparisons are decided after a row or two.
 */
export function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
      best = Math.min(best, row[j]);
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How far apart two words may be and still be the same word.
 *
 * Nothing under four letters, where a single edit is most of the word and
 * "red" would reach "rod". One edit up to six, two beyond that — enough for
 * "trasnparent" without letting "black" reach "block".
 */
export function typoAllowance(word) {
  if (word.length < 4) return 0;
  return word.length >= 7 ? 2 : 1;
}

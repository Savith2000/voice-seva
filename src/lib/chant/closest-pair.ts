// Which two lines of a chant are the hardest to tell apart?
//
// This is the counterpart to the model's consistency. If two lines collapse to
// the same thing after normalisation, no amount of model stability can separate
// them — the information simply is not in the audio. So the number matters, and
// it has to be recomputed whenever a chant changes.
//
// The obvious way is to compare every line with every other. At the 33 lines of
// one anuvaka that is 528 comparisons and nobody notices. At the 303 lines of
// the full Namakam and Chamakam it is 45,753, each running a Levenshtein matrix
// over ~30 characters, and the page hitches on load. A user-imported chant
// could be larger again.
//
// THE APPROACH, AND WHAT IT DOES AND DOES NOT PROMISE
// ---------------------------------------------------
// This is the standard similarity-join shape from the near-duplicate detection
// literature — count filtering over an inverted index of q-grams, plus a length
// filter, plus branch-and-bound on the best answer so far. See Gravano et al.
// on q-gram filters for edit distance, and Xiao & Wang's PPJoin (WWW 2008) for
// the prefix/positional filtering family this belongs to.
//
// **It does not beat O(n²) in the worst case, and anything claiming otherwise
// for an exact answer under an arbitrary metric is wrong.** What it does is
// make the expensive step rare: the filters are *admissible*, meaning they only
// ever discard a pair that provably cannot beat the current best, so the answer
// is identical to brute force while the Levenshtein matrix runs on a small
// fraction of pairs. closest-pair.test.ts pins that equality on the real chant.
//
// The two bounds, both exact:
//
//   Length.  cer = edits / max(len). Turning one string into the other costs at
//            least the difference in their lengths, so cer >= Δlen / max(len).
//            If that already exceeds the best pair found so far, no comparison
//            can help.
//
//   Q-grams. A single edit changes at most q of the q-grams. Two strings
//            sharing `shared` q-grams therefore need at least
//            (longest_gram_count - shared) / q edits between them, which is
//            again a floor on cer.
//
// Both are lower bounds on the true distance, so pruning by them cannot hide a
// closer pair. Feeding the running best back into the bounds is what makes it
// fast in practice: the first real pair found sets a bar that most others fail
// on arithmetic alone.

import { cer } from "./normalize.ts";

/** Size of the character shingle. 3 is the usual choice for short strings. */
const Q = 3;

export type ClosestPair = {
  /** Indices into the array that was passed in. */
  a: number;
  b: number;
  /** Character error rate between them, 0 = identical. */
  score: number;
  /** How many pairs survived filtering and were actually measured. */
  compared: number;
  /** How many pairs existed in total, for context. */
  total: number;
};

/** Every q-gram of `text`, as a set. Short strings yield themselves. */
function grams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < Q) {
    if (text) out.add(text);
    return out;
  }
  for (let i = 0; i + Q <= text.length; i++) out.add(text.slice(i, i + Q));
  return out;
}

/**
 * The two most similar strings in the list, and their character error rate.
 *
 * Exactly the answer brute force gives. Returns null for fewer than two.
 */
export function closestPair(texts: string[]): ClosestPair | null {
  const n = texts.length;
  if (n < 2) return null;

  const gramSets = texts.map(grams);

  // trigram -> the lines containing it. Only pairs sharing at least one q-gram
  // are ever considered; anything with nothing in common cannot be the closest
  // pair unless every pair is equally hopeless, which the fallback below covers.
  const index = new Map<string, number[]>();
  gramSets.forEach((set, i) => {
    for (const gram of set) {
      const bucket = index.get(gram);
      if (bucket) bucket.push(i);
      else index.set(gram, [i]);
    }
  });

  let best: ClosestPair | null = null;
  let bar = Infinity;
  let compared = 0;
  const total = (n * (n - 1)) / 2;

  const overlap = new Int32Array(n);
  const touched: number[] = [];

  for (let i = 0; i < n; i++) {
    // Count shared q-grams with every later line, in one pass over the index.
    touched.length = 0;
    for (const gram of gramSets[i]) {
      const bucket = index.get(gram);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        if (overlap[j] === 0) touched.push(j);
        overlap[j]++;
      }
    }

    for (const j of touched) {
      const shared = overlap[j];
      overlap[j] = 0;

      const lenI = texts[i].length;
      const lenJ = texts[j].length;
      const longest = Math.max(lenI, lenJ);
      if (longest === 0) continue;

      // Length bound.
      if (Math.abs(lenI - lenJ) / longest >= bar) continue;

      // Q-gram bound.
      const gramCount = Math.max(gramSets[i].size, gramSets[j].size);
      if ((gramCount - shared) / Q / longest >= bar) continue;

      compared++;
      const score = cer(texts[i], texts[j]);
      if (score < bar) {
        bar = score;
        best = { a: i, b: j, score, compared, total };
        // Identical is as close as it gets; nothing can beat it.
        if (score === 0) return { ...best, compared, total };
      }
    }
  }

  // Nothing shared a single q-gram — every line is wildly unlike every other.
  // Rare, but a chant of very short lines could do it, and returning null there
  // would report "no closest pair" for a list that plainly has one.
  if (!best) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        compared++;
        const score = cer(texts[i], texts[j]);
        if (!best || score < best.score) best = { a: i, b: j, score, compared, total };
      }
    }
  }

  return best ? { ...best, compared, total } : null;
}

/** Brute force, kept for the test to check the fast path against. */
export function closestPairBruteForce(texts: string[]): ClosestPair | null {
  const n = texts.length;
  if (n < 2) return null;
  let best: ClosestPair | null = null;
  const total = (n * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = cer(texts[i], texts[j]);
      if (!best || score < best.score) best = { a: i, b: j, score, compared: total, total };
    }
  }
  return best;
}

// Finding the chanter's position in the script.
//
// The chant is one long normalised string with a character → line map, so
// "which line are we on?" becomes "where in this string does the last five
// seconds of audio best fit?" — approximate substring matching.
//
// This is a *global* search: it looks at the whole chant every time and has no
// memory. That is deliberate for now. Context, expected-next-line and the
// refusal to jump on a weak result all belong to the state machine in Chunk 8;
// mixing them in here would make the search impossible to test on its own, and
// a search that cannot recover from scratch cannot recover from a jump either.

import { type ChantLine, type FlatChant } from "./chant.ts";
import { normalize } from "./normalize.ts";

export type MatchResult = {
  /** Index into flat.lines. */
  lineIndex: number;
  line: ChantLine;
  /** Half-open character span within the flattened chant. */
  start: number;
  end: number;
  /** Edit distance between the query and that span. */
  distance: number;
  /** 1 − distance / query length, in [0, 1]. Higher is better. */
  score: number;
  /** The best the query could do on some *other* line, if there is one. */
  runnerUp: { lineIndex: number; score: number } | null;
  /**
   * score − runnerUp.score. Small means two places in the chant fit about
   * equally well, which is a different failure from fitting badly and needs a
   * different response: more audio rather than a wider search.
   */
  margin: number;
  /** Every line the matched span touches, in order. */
  spanLines: number[];
  /** The normalised text actually searched for. */
  query: string;
};

/**
 * Best alignment of `query` against any substring of `flat.text`.
 *
 * Sellers' variant of Levenshtein: the first row is all zeros, so a match may
 * begin anywhere in the chant at no cost, while the query must be consumed in
 * full. The minimum of the last row is the best end position.
 *
 * O(query × chant) — about 65,000 cells for a five-second window against
 * Anuvaka 1, which is nothing next to the ~885 ms the model itself takes.
 */
export function match(raw: string, flat: FlatChant): MatchResult | null {
  const query = normalize(raw);
  const text = flat.text;
  if (!query || !text) return null;

  const m = query.length;
  const n = text.length;

  // Rolling rows. `origin` carries the start index of the alignment that
  // produced each cell, so the matched span is known without a second pass.
  let prev = new Int32Array(n + 1);
  let prevOrigin = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  let currOrigin = new Int32Array(n + 1);

  // Row 0: matching nothing costs nothing, anywhere. This is the free start.
  for (let j = 0; j <= n; j++) prevOrigin[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    currOrigin[0] = 0;
    const qc = query.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      // Deleting a query character, inserting a chant character, or aligning
      // the pair. Ties go to substitution, which keeps spans compact.
      const sub = prev[j - 1] + (qc === text.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      if (sub <= del && sub <= ins) {
        curr[j] = sub;
        currOrigin[j] = prevOrigin[j - 1];
      } else if (del <= ins) {
        curr[j] = del;
        currOrigin[j] = prevOrigin[j];
      } else {
        curr[j] = ins;
        currOrigin[j] = currOrigin[j - 1];
      }
    }
    [prev, curr] = [curr, prev];
    [prevOrigin, currOrigin] = [currOrigin, prevOrigin];
  }

  // `prev` is now the last row: prev[j] is the cost of the best alignment
  // ending at character j.
  let bestEnd = 1;
  let bestDistance = prev[1];
  for (let j = 2; j <= n; j++) {
    if (prev[j] < bestDistance) {
      bestDistance = prev[j];
      bestEnd = j;
    }
  }

  const lineIndex = flat.lineAt[bestEnd - 1];
  const start = Math.min(prevOrigin[bestEnd], bestEnd - 1);

  const spanLines: number[] = [];
  for (let j = start; j < bestEnd; j++) {
    const at = flat.lineAt[j];
    if (spanLines[spanLines.length - 1] !== at) spanLines.push(at);
  }

  // The runner-up is the best this query could do somewhere that following it
  // would count as *jumping*. Neighbours are excluded on purpose.
  //
  // The obvious definition — best score on any other line — turns out to
  // measure the wrong thing. Lines are concatenated with no separator, so an
  // alignment ending one character past a boundary costs one more edit and
  // scores almost identically. Every match then looks ambiguous, including
  // the ones that are dead right: a verbatim line 2 scored 1.00 against a
  // runner-up of 0.96, purely because line 3 starts where line 2 ends.
  //
  // What actually matters is whether some *distant* part of the chant fits
  // equally well, because that is the move that would throw the screen
  // somewhere wrong. A window straddling one boundary is normal, so the
  // matched span and the lines either side of it are all "here".
  const nearby = new Set(spanLines);
  nearby.add(spanLines[0] - 1);
  nearby.add(spanLines[spanLines.length - 1] + 1);

  let runnerUp: MatchResult["runnerUp"] = null;
  let runnerDistance = Infinity;
  for (let j = 1; j <= n; j++) {
    const at = flat.lineAt[j - 1];
    if (nearby.has(at)) continue;
    if (prev[j] < runnerDistance) {
      runnerDistance = prev[j];
      runnerUp = { lineIndex: at, score: 0 };
    }
  }

  const toScore = (distance: number) => Math.max(0, 1 - distance / m);
  const score = toScore(bestDistance);
  if (runnerUp) runnerUp.score = toScore(runnerDistance);

  return {
    lineIndex,
    line: flat.lines[lineIndex],
    start,
    end: bestEnd,
    distance: bestDistance,
    score,
    runnerUp,
    margin: runnerUp ? score - runnerUp.score : score,
    spanLines,
    query,
  };
}

/**
 * Where in the *line* the match ended, as a fraction.
 *
 * The chanter is at the end of the window, not the middle of it, so this is
 * how far through the current line they are — which is what Chunk 9 needs to
 * decide whether to scroll now or wait.
 */
export function progressThroughLine(result: MatchResult, flat: FlatChant): number {
  let lineStart = 0;
  for (let i = 0; i < result.lineIndex; i++) {
    lineStart += flat.lines[i].normalized.length;
  }
  const length = flat.lines[result.lineIndex].normalized.length;
  if (length === 0) return 1;
  return Math.min(1, Math.max(0, (result.end - lineStart) / length));
}

/** A line by its 1-based sequence number, for tests and the UI. */
export function lineBySequence(
  flat: FlatChant,
  sequence: number,
): ChantLine | undefined {
  return flat.lines.find((line) => line.sequence === sequence);
}

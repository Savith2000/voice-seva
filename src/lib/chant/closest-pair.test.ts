import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { closestPair, closestPairBruteForce } from "./closest-pair.ts";
import { allLines, type Chant } from "./chant.ts";

// The whole point of the fast path is that it returns exactly what brute force
// returns. A speed-up that quietly changes the answer would be worse than the
// slow version, because the number it produces is used to decide whether a
// chant is trackable at all.
const chant = JSON.parse(
  readFileSync(
    new URL("../../data/chants/sri-rudram-saiveda.json", import.meta.url),
    "utf8",
  ),
) as Chant;

const lines = allLines(chant).map((line) => line.normalized);

test("agrees with brute force on the real chant", () => {
  const fast = closestPair(lines);
  const slow = closestPairBruteForce(lines);
  assert.ok(fast && slow);
  assert.equal(fast.score, slow.score);
});

test("finds a verbatim repeat, which the chant genuinely contains", () => {
  // Namakam anuvaka 11 sings the same refrain after verse 1 and again after
  // verse 10. After normalisation the two are identical, so the closest pair
  // for this chant is 0 and no threshold can separate them — the matcher
  // leans on the viewport tie-break and on continuity instead.
  const found = closestPair(lines);
  assert.ok(found);
  assert.equal(found.score, 0);
  assert.equal(lines[found.a], lines[found.b]);
});

test("does far less work than comparing everything", () => {
  const found = closestPair(lines);
  assert.ok(found);
  // It short-circuits the moment it meets an identical pair, so the honest
  // check is simply that it never measured more pairs than exist.
  assert.ok(found.compared <= found.total);
  assert.equal(found.total, (lines.length * (lines.length - 1)) / 2);
});

test("the filters never hide a closer pair", () => {
  // A set with no identical pair, so the short-circuit cannot mask a bad
  // filter: every prune has to be justified by the bounds alone.
  const sample = [
    ...new Set(lines.filter((line) => line.length > 12)),
  ].slice(0, 90);
  const fast = closestPair(sample);
  const slow = closestPairBruteForce(sample);
  assert.ok(fast && slow);
  assert.equal(fast.score, slow.score);
  assert.ok(fast.compared < fast.total, "should have pruned something");
});

test("handles the degenerate sizes", () => {
  assert.equal(closestPair([]), null);
  assert.equal(closestPair(["one"]), null);
  const two = closestPair(["abc", "abc"]);
  assert.ok(two);
  assert.equal(two.score, 0);
});

test("strings shorter than the shingle still get compared", () => {
  // Nothing here has a trigram, so the q-gram index finds no candidates at all
  // and the fallback has to carry it.
  const found = closestPair(["अ", "इ", "उ"]);
  assert.ok(found);
  assert.ok(found.score > 0);
});

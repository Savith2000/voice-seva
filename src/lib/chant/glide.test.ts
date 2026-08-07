import assert from "node:assert/strict";
import test from "node:test";

import { MAX_RATE, OVERRUN, anchorFrom, glide, type Anchor } from "./glide.ts";

const still: Anchor = { progress: 0.4, at: 1000, rate: 0 };
const moving: Anchor = { progress: 0.4, at: 1000, rate: 0.0005 };

test("between readings, the ink advances", () => {
  // 0.0005 per ms over 200 ms is a tenth of a line.
  assert.equal(glide(moving, 1200, 1400, true), 0.5);
});

test("it stops at the end of the line", () => {
  const nearly: Anchor = { progress: 0.98, at: 1000, rate: 0.0005 };
  assert.equal(glide(nearly, 5000, 1400, true), 1);
});

test("it never runs far past the last real reading", () => {
  // The chanter has stopped mid-line: no new reading for ten seconds. Without
  // a cap the ink would be most of a line ahead of a voice that is not moving.
  // A slow line — 0.0001 per ms is ten seconds end to end — so the cap is what
  // stops it rather than the end of the line.
  const slowLine: Anchor = { progress: 0.4, at: 1000, rate: 0.0001 };
  const capped = glide(slowLine, 11_000, 1400, true);
  const uncapped = 0.4 + 0.0001 * 10_000;
  assert.equal(capped, 0.4 + 0.0001 * (1400 * OVERRUN));
  assert.ok(capped < uncapped, "the cap must bite before the elapsed time does");
  assert.ok(capped < 0.6, `ink ran to ${capped} while the chanter was silent`);
});

test("a slower device is allowed to fill in more, not less", () => {
  const fast = glide(moving, 9_000, 250, true);
  const slow = glide(moving, 9_000, 1400, true);
  assert.ok(slow > fast, "a long gap needs more filling in than a short one");
});

test("holding and searching sit still", () => {
  assert.equal(glide(moving, 5000, 1400, false), 0.4);
});

test("with no measured pace it does not invent one", () => {
  assert.equal(glide(still, 5000, 1400, true), 0.4);
});

test("pace is learned from consecutive readings", () => {
  const first = anchorFrom({ progress: 0, at: 0, rate: 0 }, 0.5, 1000);
  assert.equal(first.rate, 0.0005);
  assert.equal(first.progress, 0.5);
});

test("a line that repeats does not read as negative speed", () => {
  // A window straddling a boundary can legitimately report the earlier line,
  // which moves progress backwards. That is not the chanter reversing.
  const back = anchorFrom(moving, 0.1, 2000);
  assert.ok(back.rate >= 0, "rate must never go negative");
  assert.equal(back.progress, 0.1, "but the position itself still moves back");
});

test("an implausible jump cannot set an implausible pace", () => {
  const wild = anchorFrom({ progress: 0, at: 0, rate: 0 }, 1, 1);
  assert.ok(wild.rate <= MAX_RATE, `rate ${wild.rate} exceeds the ceiling`);
});

test("the whole point: the gap a slow device leaves gets filled", () => {
  // A slow device hears nothing new for 1400 ms. Without this the ink would
  // sit frozen for that whole time and then jump; with it, the ink is most of
  // the way across the gap by the time the next reading lands. Sampled through
  // one window, it must move at every step and never go backwards.
  const anchor: Anchor = { progress: 0.2, at: 0, rate: 0.0003 };
  const seen = [0, 350, 700, 1050, 1400].map((t) => glide(anchor, t, 1400, true));
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `frozen or reversed at ${i}: ${seen}`);
  }
  assert.ok(
    seen[seen.length - 1] > 0.55,
    `only covered ${seen[seen.length - 1] - 0.2} of the gap`,
  );

  // The same chanter on a fast device barely needs filling in, because a real
  // reading is never more than 250 ms away. Less glide is correct there, not
  // worse — the whole point is that the reader cannot tell them apart.
  const fastAtItsGap = glide(anchor, 250, 250, true);
  assert.ok(fastAtItsGap > 0.2 && fastAtItsGap < 0.3);
});

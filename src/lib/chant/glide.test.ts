import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RATE,
  OVERRUN,
  SETTLE_MS,
  anchorFrom,
  glide,
  target,
  type Anchor,
} from "./glide.ts";

const still: Anchor = { progress: 0.4, at: 1000, rate: 0 };
const moving: Anchor = { progress: 0.4, at: 1000, rate: 0.0005 };

/** Drive the glide frame by frame, the way the animation loop does. */
function run(
  anchor: Anchor,
  shown: number,
  from: number,
  to: number,
  intervalMs: number,
  step = 10,
): number {
  let s = shown;
  for (let t = from + step; t <= to; t += step) {
    s = glide(anchor, s, t, step, intervalMs, true);
  }
  return s;
}

test("between readings, the ink advances every frame", () => {
  let shown = moving.progress;
  for (let t = 1010; t <= 1200; t += 10) {
    const next = glide(moving, shown, t, 10, 1400, true);
    assert.ok(next > shown, `frozen at t=${t}: ${next}`);
    shown = next;
  }
  // It chases the pace rather than teleporting to it, so it trails the raw
  // extrapolation slightly — by about rate x SETTLE_MS once settled.
  assert.ok(shown > 0.42 && shown < 0.5, `ended at ${shown}`);
});

test("it stops at the end of the line", () => {
  const nearly: Anchor = { progress: 0.98, at: 1000, rate: 0.0005 };
  const shown = run(nearly, 0.98, 1000, 5000, 1400);
  assert.ok(shown <= 1, `ran past the end: ${shown}`);
  assert.ok(shown > 0.99, `never reached the end: ${shown}`);
});

test("it never runs far past the last real reading", () => {
  // The chanter has stopped mid-line: no new reading for ten seconds. Without
  // a cap the ink would be most of a line ahead of a voice that is not moving.
  // A slow line — 0.0001 per ms is ten seconds end to end — so the cap is what
  // stops it rather than the end of the line.
  const slowLine: Anchor = { progress: 0.4, at: 1000, rate: 0.0001 };
  const cap = 0.4 + 0.0001 * (1400 * OVERRUN);
  let shown = 0.4;
  for (let t = 1010; t <= 11_000; t += 10) {
    shown = glide(slowLine, shown, t, 10, 1400, true);
    assert.ok(shown <= cap + 1e-9, `past the cap at t=${t}: ${shown}`);
  }
  assert.ok(shown > cap - 0.01, "the cap should be approached, not avoided");
  assert.ok(shown < 0.6, `ink ran to ${shown} while the chanter was silent`);
});

test("a slower device is allowed to fill in more, not less", () => {
  const fast = run(moving, 0.4, 1000, 9000, 250);
  const slow = run(moving, 0.4, 1000, 9000, 1400);
  assert.ok(slow > fast, "a long gap needs more filling in than a short one");
});

test("holding and searching sit exactly still", () => {
  // Where the ink stops is where it was SHOWN, not where the last reading
  // was — a hold that snapped back to the reading would itself be a jump.
  assert.equal(glide(moving, 0.47, 5000, 10, 1400, false), 0.47);
});

test("with no measured pace it does not invent one", () => {
  assert.equal(glide(still, 0.4, 5000, 10, 1400, true), 0.4);
});

test("a reading behind the ink pauses it rather than dragging it back", () => {
  // The matcher's estimate is noisy and can land behind where the ink already
  // is. The ink must not retreat — it waits, and the voice catches up. This is
  // the failure that made a fast machine feel broken: every such reading used
  // to be rendered as a backwards teleport, four times a second.
  const behind: Anchor = { progress: 0.45, at: 1000, rate: 0.0005 };
  let shown = 0.6;
  let paused = 0;
  for (let t = 1010; t <= 2000; t += 10) {
    const next = glide(behind, shown, t, 10, 1400, true);
    assert.ok(next >= shown, `moved backwards at t=${t}: ${shown} -> ${next}`);
    if (next === shown) paused += 1;
    shown = next;
  }
  assert.ok(paused > 0, "it should hold still while the target is behind");
  assert.ok(shown > 0.6, "and advance again once the target passes");
});

test("a correction ahead is approached, never arrived at in one frame", () => {
  const ahead: Anchor = { progress: 0.55, at: 1000, rate: 0 };
  const first = glide(ahead, 0.3, 1010, 10, 250, true);
  assert.ok(first > 0.3, "it must start closing the gap");
  assert.ok(first < 0.33, `a single frame moved the ink ${first - 0.3}`);
  // ~95% closed within three time constants.
  const settled = run(ahead, 0.3, 1000, 1000 + SETTLE_MS * 3, 250);
  assert.ok(settled > 0.53, `only reached ${settled}`);
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
  assert.equal(back.progress, 0.1, "but the belief itself still moves back");
});

test("an implausible jump cannot set an implausible pace", () => {
  const wild = anchorFrom({ progress: 0, at: 0, rate: 0 }, 1, 1);
  assert.ok(wild.rate <= MAX_RATE, `rate ${wild.rate} exceeds the ceiling`);
});

test("the target itself is capped, so the chase inherits the cap", () => {
  assert.equal(target(moving, 20_000, 250), 0.4 + 0.0005 * (250 * OVERRUN));
});

test("the whole point: the gap a slow device leaves gets filled", () => {
  // A slow device hears nothing new for 1400 ms. Without this the ink would
  // sit frozen for that whole time and then jump; with it, the ink is most of
  // the way across the gap by the time the next reading lands. Sampled through
  // one window, it must move at every step and never go backwards.
  const anchor: Anchor = { progress: 0.2, at: 0, rate: 0.0003 };
  let shown = 0.2;
  const seen = [shown];
  for (const stop of [350, 700, 1050, 1400]) {
    shown = run(anchor, shown, stop - 350, stop, 1400);
    seen.push(shown);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `frozen or reversed at ${i}: ${seen}`);
  }
  assert.ok(
    seen[seen.length - 1] > 0.5,
    `only covered ${seen[seen.length - 1] - 0.2} of the gap`,
  );

  // The same chanter on a fast device barely needs filling in, because a real
  // reading is never more than 250 ms away. Less glide is correct there, not
  // worse — the whole point is that the reader cannot tell them apart.
  const fastAtItsGap = run(anchor, 0.2, 0, 250, 250);
  assert.ok(fastAtItsGap > 0.2 && fastAtItsGap < 0.3);
});

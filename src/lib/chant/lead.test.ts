// Run with: npm test
//
// Leading the highlight is the one feature here that can make the app *less*
// accurate if it is wrong, so the tests are mostly about its restraint: that
// it never runs off the end, never leads by an absurd amount, and never lets
// a pause or a correction pollute its idea of tempo.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { flatten, type Chant } from "./chant.ts";
import {
  DEFAULT_RATE,
  MAX_LEAD_MS,
  MAX_RATE,
  MIN_RATE,
  NO_PACE,
  estimateLagMs,
  leadPosition,
  observePace,
} from "./lead.ts";
import { INITIAL, follow } from "./follow.ts";
import { match } from "./matcher.ts";
import { type MatchedTick } from "./tracker.ts";

const chant = JSON.parse(
  readFileSync(
    new URL("../../data/chants/sri-rudram-namakam-anuvaka-1.json", import.meta.url),
    "utf8",
  ),
) as Chant;
const flat = flatten(chant);

/** A tick carrying whatever the matcher makes of `text`. */
function matchedTick(text: string, at: number): MatchedTick {
  return {
    at,
    rms: 0.2,
    audioSeconds: 5,
    state: "matched",
    transcript: text,
    result: match(text, flat),
    inferenceMs: 930,
  };
}

/** Fold a run of (charIndex, time) observations in. */
function pacedAt(steps: [end: number, at: number][]) {
  return steps.reduce((pace, [end, at]) => observePace(pace, end, at), NO_PACE);
}

// --- estimating tempo -------------------------------------------------------

test("the first observation only sets an anchor", () => {
  const pace = observePace(NO_PACE, 100, 1000);
  assert.equal(pace.samples, 0);
  assert.equal(pace.rate, DEFAULT_RATE);
});

test("two observations give a rate", () => {
  // Six characters in one second.
  const pace = pacedAt([
    [100, 1000],
    [106, 2000],
  ]);
  assert.equal(pace.samples, 1);
  assert.ok(Math.abs(pace.rate - 6) < 0.001, `rate was ${pace.rate}`);
});

test("a pause does not make the chanting look slow", () => {
  // Someone stops for eight seconds and resumes. The position barely moved,
  // which says nothing about tempo — and taken literally would imply a rate
  // near zero and kill the lead for the rest of the session.
  const steady = pacedAt([
    [100, 1000],
    [106, 2000],
    [112, 3000],
  ]);
  const afterPause = observePace(steady, 113, 11_000);
  assert.ok(
    afterPause.rate > MIN_RATE,
    `a pause dragged the rate to ${afterPause.rate}`,
  );
  assert.equal(afterPause.samples, steady.samples, "the pause was counted");
});

test("a jump to another line does not count as tempo", () => {
  const steady = pacedAt([
    [100, 1000],
    [106, 2000],
  ]);
  const afterJump = observePace(steady, 900, 3000);
  assert.equal(afterJump.samples, steady.samples);
  assert.equal(afterJump.rate, steady.rate);
  // The anchor still moves, or the next observation would measure from a
  // position the chanting has long left.
  assert.equal(afterJump.lastEnd, 900);
});

test("going backwards is ignored too", () => {
  const steady = pacedAt([
    [100, 1000],
    [106, 2000],
  ]);
  const back = observePace(steady, 40, 3000);
  assert.equal(back.samples, steady.samples);
  assert.equal(back.lastEnd, 40);
});

test("the rate stays inside plausible bounds however odd the input", () => {
  const absurd = pacedAt([
    [100, 1000],
    [140, 1001],
    [180, 1002],
  ]);
  assert.ok(absurd.rate <= MAX_RATE, `rate reached ${absurd.rate}`);
  assert.ok(absurd.rate >= MIN_RATE);
});

test("the estimate smooths rather than chasing the last window", () => {
  // One anomalous window should nudge the rate, not redefine it.
  const steady = pacedAt([
    [100, 1000],
    [106, 2000],
    [112, 3000],
    [118, 4000],
  ]);
  const bumped = observePace(steady, 136, 5000); // suddenly 18 chars/s
  assert.ok(
    bumped.rate < 12,
    `one odd window pulled the rate to ${bumped.rate}`,
  );
  assert.ok(bumped.rate > steady.rate, "it should still move");
});

// --- placing the highlight --------------------------------------------------

test("no lead leaves the position exactly where the matcher put it", () => {
  const result = match("नम॑स्ते अस्तु॒ धन्व॑ने", flat)!;
  const led = leadPosition(flat, result.end, NO_PACE, 0);
  assert.equal(led.charIndex, result.end);
  assert.equal(led.charsAhead, 0);
  assert.equal(led.lineIndex, result.lineIndex);
});

test("a lead moves the highlight forward by tempo times time", () => {
  const pace = pacedAt([
    [100, 1000],
    [110, 2000], // 10 chars/second
  ]);
  const led = leadPosition(flat, 100, pace, 1500);
  assert.equal(led.charsAhead, 15);
  assert.equal(led.charIndex, 115);
});

test("leading crosses into the next line only near a boundary", () => {
  // The behaviour that makes this worth doing: mid-line it just advances the
  // progress bar, and it changes the highlighted line only when the chanter
  // is genuinely about to be there.
  const pace = pacedAt([
    [0, 0],
    [6, 1000],
  ]);

  const lineTwoStart = flat.lines[0].normalized.length;
  const middle = lineTwoStart + Math.floor(flat.lines[1].normalized.length / 2);
  const nearEnd = lineTwoStart + flat.lines[1].normalized.length - 2;

  assert.equal(leadPosition(flat, middle, pace, 1500).lineIndex, 1);
  assert.equal(leadPosition(flat, nearEnd, pace, 1500).lineIndex, 2);
});

test("the highlight never runs off the end of the chant", () => {
  const fast = pacedAt([
    [0, 0],
    [20, 1000],
  ]);
  const led = leadPosition(flat, flat.text.length, fast, MAX_LEAD_MS);
  assert.equal(led.charIndex, flat.text.length);
  assert.equal(led.lineIndex, flat.lines.length - 1);
  assert.ok(led.progress <= 1);
});

test("an absurd lead request is capped rather than obeyed", () => {
  const pace = pacedAt([
    [0, 0],
    [10, 1000],
  ]);
  const led = leadPosition(flat, 100, pace, 60_000);
  assert.ok(
    led.charsAhead <= (MAX_RATE * MAX_LEAD_MS) / 1000,
    `led ${led.charsAhead} characters ahead`,
  );
});

test("progress stays within the line it reports", () => {
  const pace = pacedAt([
    [0, 0],
    [8, 1000],
  ]);
  for (let end = 1; end <= flat.text.length; end += 37) {
    const led = leadPosition(flat, end, pace, 1500);
    assert.ok(led.progress >= 0 && led.progress <= 1, `progress ${led.progress}`);
    assert.equal(flat.lineAt[led.charIndex - 1], led.lineIndex);
  }
});

// --- the lag being compensated for ------------------------------------------

test("lag is inference plus half an update interval", () => {
  // Half, not a whole one: the highlight is static between updates, so
  // leading by the full interval would overshoot for the second half of every
  // cycle and land the highlight past the chanter.
  assert.equal(estimateLagMs(900, 1200), 1500);
  assert.equal(estimateLagMs(0, 0), 0);
});

test("lag survives the numbers being missing", () => {
  // inferenceMs is NaN before the first window completes, and NaN would
  // propagate silently into a charIndex of NaN and a blank screen.
  assert.equal(estimateLagMs(Number.NaN, Number.NaN), 0);
  assert.ok(Number.isFinite(estimateLagMs(Infinity, 1000)));
  assert.equal(estimateLagMs(99_999, 99_999), MAX_LEAD_MS);
});

// --- against the real recording ---------------------------------------------

test("the lead never overrules the state machine's refusal to jump", () => {
  // The composition that the screen actually runs, and the one place these
  // three modules can be wrong together while each is right alone. A window
  // the state machine rejects must not move the highlight — if the lead were
  // applied to the raw match instead of the accepted position, a refused jump
  // would drag the screen across the chant anyway, and the whole point of
  // refusing it would be lost.
  const state = follow(INITIAL, matchedTick("नम॑स्ते अस्तु॒ धन्व॑ने बा॒हुभ्या॑मु॒त ते॒ नमः॑", 1000), 0.9);
  assert.equal(state.kind, "locked");
  const held = state.lineIndex;

  // A middling window pointing at a distant line: refused on its own.
  const stray = matchedTick("नम॑स्ते अ॒स्त्वा", 2200);
  const next = follow(state, stray, 0.2);
  assert.equal(next.lineIndex, held, "the state machine let it through");

  // The screen only leads from a position the machine accepted.
  const accepted =
    next.kind === "locked" && next.lineIndex === stray.result!.lineIndex;
  assert.equal(accepted, false);

  const displayed = accepted
    ? leadPosition(flat, stray.result!.end, NO_PACE, 1500).lineIndex
    : next.lineIndex;
  assert.equal(displayed, held, "the lead moved the screen anyway");
});

test("on the real take, leading keeps the highlight inside the chanted line", () => {
  // The recording is one continuous pass through line 3. A lead that pushed
  // the highlight off it would be worse than no lead at all.
  const takes = [
    "तेरुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
    "तोत् इशवेनमः नमस्ते अश्तु धन्वने",
    "ते अश्तु धन्वने बाहोभ्याभुत्",
    "बाहोभ्याभुद्बुथतेनमः",
  ];

  let pace = NO_PACE;
  let at = 0;
  const lines: number[] = [];
  for (const take of takes) {
    at += 1200;
    const result = match(take, flat)!;
    pace = observePace(pace, result.end, at);
    lines.push(leadPosition(flat, result.end, pace, estimateLagMs(930, 1200)).lineIndex);
  }

  // Line 3 is index 2. The last window sits at the very end of it, so leading
  // may legitimately tip into line 4 — but no further.
  for (const lineIndex of lines) {
    assert.ok(
      lineIndex === 2 || lineIndex === 3,
      `lead put the highlight on line ${lineIndex + 1}`,
    );
  }
  assert.equal(lines[0], 2, "led off the line on the very first window");
});

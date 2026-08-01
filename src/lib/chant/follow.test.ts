// Run with: npm test
//
// This is the module whose bugs are invisible in a unit and obvious in a room.
// A screen that twitches during a recitation is worse than one that lags, and
// nothing about a twitch shows up as an error — so the tests here are mostly
// about what the state machine *refuses* to do.
//
// Everything is a pure fold over ticks, so a whole session replays here with
// no clock, no worker and no mocks.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { flatten, type Chant } from "./chant.ts";
import {
  CORROBORATION,
  CORROBORATION_MS,
  IDLE_AFTER_SILENT_MS,
  INITIAL,
  PATIENCE,
  classify,
  follow,
  statusLine,
  type FollowState,
} from "./follow.ts";
import { match, progressThroughLine } from "./matcher.ts";
import { type MatchedTick, type TrackerTick } from "./tracker.ts";

const chant = JSON.parse(
  readFileSync(
    new URL("../../data/chants/sri-rudram-namakam-anuvaka-1.json", import.meta.url),
    "utf8",
  ),
) as Chant;
const flat = flatten(chant);

let clock = 0;

/** A tick carrying whatever the matcher makes of `text`. */
function heard(text: string, at = (clock += 1000)): MatchedTick {
  return {
    at,
    rms: 0.2,
    audioSeconds: 5,
    state: "matched",
    transcript: text,
    result: match(text, flat),
    inferenceMs: 900,
  };
}

/** A tick for a line of the chant, verbatim — a clean, high-confidence window. */
const line = (sequence: number, at?: number) =>
  heard(flat.lines[sequence - 1].devanagari, at);

const quiet = (at = (clock += 1000)): TrackerTick => ({
  at,
  rms: 0,
  audioSeconds: 5,
  state: "silent",
});

function step(state: FollowState, tick: TrackerTick): FollowState {
  const progress =
    tick.state === "matched" && tick.result
      ? progressThroughLine(tick.result, flat)
      : 0;
  return follow(state, tick, progress);
}

const run = (ticks: TrackerTick[], from: FollowState = INITIAL) =>
  ticks.reduce(step, from);

const seq = (state: FollowState) =>
  state.lineIndex === null ? null : flat.lines[state.lineIndex].sequence;

// --- classification ---------------------------------------------------------

test("confidence needs both a good score and a real margin", () => {
  // The case that motivates having two numbers: "बभूव ते धनुः" ends both line
  // 4 and line 27, so it scores a perfect 1.00 and is still a coin flip.
  const ambiguous = match("बभूव ते धनुः", flat)!;
  assert.equal(ambiguous.score, 1);
  assert.equal(classify(ambiguous), "low");

  const clean = match(flat.lines[11].devanagari, flat)!;
  assert.equal(classify(clean), "high");

  assert.equal(classify(null), "low");
  assert.equal(classify(match("अअअअअअअअअअअअ", flat)), "low");
});

// --- getting started --------------------------------------------------------

test("starts idle and says so", () => {
  assert.equal(INITIAL.kind, "idle");
  assert.equal(statusLine(INITIAL), "Not listening.");
});

test("a clean window locks on immediately", () => {
  const state = run([line(12)]);
  assert.equal(state.kind, "locked");
  assert.equal(seq(state), 12);
  assert.equal(state.confidence, "high");
  assert.equal(statusLine(state), "Following.");
});

test("noise never produces a position", () => {
  const state = run([
    heard("अअअअअअअअअअअअ"),
    heard("the quick brown fox"),
    heard("अअअअअअअअअअअअ"),
  ]);
  assert.equal(state.kind, "searching");
  assert.equal(state.lineIndex, null);
  assert.equal(statusLine(state), "Locating chanting position…");
});

test("an ambiguous phrase alone never locks on", () => {
  // Perfect score, zero margin, three windows running. Still nothing.
  const state = run([
    heard("बभूव ते धनुः"),
    heard("बभूव ते धनुः"),
    heard("बभूव ते धनुः"),
  ]);
  assert.notEqual(state.kind, "locked");
});

// --- following forward ------------------------------------------------------

test("follows the chant line by line without needing convincing", () => {
  // Demanding corroboration for ordinary progress would leave the screen a
  // line behind for the whole recitation.
  let state = run([line(10)]);
  for (const next of [11, 12, 13, 14, 15]) {
    state = step(state, line(next));
    assert.equal(seq(state), next, `did not follow to line ${next}`);
    assert.equal(state.holding, false);
  }
});

test("a repeated line does not count as jumping", () => {
  // Chanting repeats, and a window straddling a boundary can report either
  // side of it.
  let state = run([line(10), line(11)]);
  state = step(state, line(10));
  assert.equal(seq(state), 10);
  assert.equal(state.kind, "locked");
});

// --- refusing to jump -------------------------------------------------------

// Partial windows that land on a distant line with middling confidence —
// a good score but not enough margin to be sure it is not somewhere else.
const PARTIAL_LINE_29 = "नम॑स्ते अ॒स्त्वा";
const PARTIAL_LINE_23 = "ह॑स्राक्ष॒ श";

test("one mediocre window from elsewhere does not move the screen", () => {
  // The whole point of the module. Requirement 1.7: medium confidence must be
  // verified against more audio before jumping.
  const locked = run([line(10)]);

  const elsewhere = heard(PARTIAL_LINE_29);
  assert.equal(classify(elsewhere.result), "medium");

  const after = step(locked, elsewhere);
  assert.equal(seq(after), 10, "the screen jumped on a single window");
  assert.ok(after.candidate, "the candidate was not remembered");
  assert.equal(after.holding, true);
});

test("a second window agreeing is enough to jump", () => {
  let state = run([line(10)]);

  state = step(state, heard(PARTIAL_LINE_29));
  assert.equal(seq(state), 10);
  state = step(state, heard(PARTIAL_LINE_29));
  assert.equal(seq(state), 29, "never accepted the corroborated jump");
  assert.equal(CORROBORATION, 2);
});

test("a fast loop does not make the screen four times easier to move", () => {
  // The rule used to be "two agreeing windows". At the old ~1200 ms cadence
  // that was 2.4 s of evidence; once inference dropped to ~48 ms and the loop
  // sped up to 250 ms it became 0.5 s, and the same code silently became four
  // times more willing to jump. Evidence has to be measured in seconds of
  // chanting, not in units of however fast the model happens to run.
  let state = run([line(10, 1000)]);
  let at = 1000;
  for (let i = 0; i < 3; i++) {
    at += 250;
    state = step(state, heard(PARTIAL_LINE_29, at));
  }
  assert.equal(
    seq(state),
    10,
    "three windows inside a second were enough to move the screen",
  );

  // Keep agreeing past the corroboration window and it does move.
  at += CORROBORATION_MS;
  state = step(state, heard(PARTIAL_LINE_29, at));
  assert.equal(seq(state), 29);
});

test("a lock survives a burst of bad windows at a fast cadence", () => {
  // Same arithmetic on the other side: four consecutive misses used to be
  // ~5 s of nonsense and is now 1 s, which is a cough.
  let state = run([line(10, 1000)]);
  let at = 1000;
  for (let i = 0; i < 5; i++) {
    at += 250;
    state = step(state, heard("अअअअअअअअअअअअ", at));
  }
  assert.equal(state.kind, "locked", "gave up a lock over one second of noise");

  // Sustained nonsense still ends it.
  for (let i = 0; i < 8; i++) {
    at += 250;
    state = step(state, heard("अअअअअअअअअअअअ", at));
  }
  assert.equal(state.kind, "searching");
});

test("two mediocre windows disagreeing with each other move nothing", () => {
  // Corroboration means agreement, not merely a second opinion.
  const locked = run([line(10)]);
  const a = step(locked, heard(PARTIAL_LINE_29));
  const b = step(a, heard(PARTIAL_LINE_23));
  assert.equal(seq(b), 10, "two different guesses were treated as agreement");
});

test("a weak window is still trusted when it agrees with where we are", () => {
  // The end of the real recording: score 0.65, margin 0.06, and completely
  // correct. Margin measures the risk of a jump, and there is no jump here.
  // Demanding it anyway froze the display at the end of every line — which is
  // exactly where windows are weakest.
  const state = run([line(3)]);
  const tail = heard("बाहोभ्याभुद्बुथतेनमः");
  assert.equal(classify(tail.result), "low", "not weak on its own terms");
  assert.equal(classify(tail.result, { continuing: true }), "medium");

  const after = step(state, tail);
  assert.equal(seq(after), 3);
  assert.equal(after.holding, false, "held instead of following");
});

test("agreeing with where we are does not rescue outright noise", () => {
  // The leniency above is about margin, not about score. Noise matched line
  // 12 at 0.17, and being locked on line 12 must not turn that into evidence.
  const noise = match("अअअअअअअअअअअअ", flat)!;
  assert.equal(classify(noise, { continuing: true }), "low");
});

test("a clean window elsewhere jumps at once", () => {
  // Recovering after someone skips to another anuvaka has to be possible, and
  // an unambiguous well-scored match is the evidence for it.
  const locked = run([line(10)]);
  const jumped = step(locked, line(28));
  assert.equal(seq(jumped), 28);
  assert.equal(jumped.confidence, "high");
});

// --- holding on -------------------------------------------------------------

test("a bad window holds the position instead of blanking it", () => {
  // A cough, a dropped phrase, a page turn.
  let state = run([line(10)]);
  state = step(state, heard("अअअअअअअअअअअअ"));
  assert.equal(state.kind, "locked");
  assert.equal(seq(state), 10);
  assert.equal(state.holding, true);
  assert.equal(statusLine(state), "Holding position…");
});

test("sustained nonsense eventually gives the lock up", () => {
  let state = run([line(10)]);
  for (let i = 0; i < PATIENCE; i++) state = step(state, heard("अअअअअअअअअअअअ"));
  assert.equal(state.kind, "searching");
  // The line stays on screen while searching — blanking it would be worse.
  assert.equal(seq(state), 10);
});

test("silence pauses without losing the place", () => {
  // Between anuvakas, or while the leader takes a breath.
  let state = run([line(10)]);
  for (let i = 0; i < 5; i++) state = step(state, quiet());
  assert.equal(state.kind, "locked");
  assert.equal(seq(state), 10);
  assert.equal(state.holding, true);
});

test("a long enough silence ends the session", () => {
  const at = 100_000;
  let state = run([line(10, at)]);
  state = step(state, quiet(at + IDLE_AFTER_SILENT_MS - 1));
  assert.equal(state.kind, "locked", "gave up too early");
  state = step(state, quiet(at + IDLE_AFTER_SILENT_MS + 1));
  assert.equal(state.kind, "idle");
  assert.equal(state.lineIndex, null);
});

test("chanting resumes after a pause without a fresh lock-on", () => {
  let state = run([line(10)]);
  state = step(state, quiet());
  state = step(state, quiet());
  state = step(state, line(11));
  assert.equal(state.kind, "locked");
  assert.equal(seq(state), 11);
  assert.equal(state.holding, false);
});

test("a filling buffer changes nothing but the holding flag", () => {
  const locked = run([line(10)]);
  const after = step(locked, {
    at: clock += 1000,
    rms: 0,
    audioSeconds: 1,
    state: "filling",
  });
  assert.equal(seq(after), 10);
  assert.equal(after.kind, "locked");
});

// --- the real recording -----------------------------------------------------

test("the real take locks on and stays put", () => {
  // The fifteen genuine vak-san transcripts, in the order they were produced.
  // The recording is one continuous pass through line 3, so a state machine
  // that wanders during it is wrong however good its numbers look.
  const takes = [
    "तेरुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
    "रुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
    "ुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते अ",
    "ध्रमन्यव उत्तोत् ईशवेनमः नमस्ते अश्",
    "तोत् इशवेनमः नमस्ते अश्तु धन्वने",
    "ोत् ईशवेनमः नमस्ते अस्तु धन्वने ब",
    "त् इशवेनमः नमस्ते अस्तु धन्वने बा",
    "त ईशवेनमः नमस्ते अस्तु धन्वने बाहु",
    "ईशवेनमः नमस्ते अस्तु धन्वने बाहो",
    "ते अश्तु धन्वने बाहोभ्याभुत्",
    "े अश्तु धन्वने बाहोभ्याभुत्भु",
    "अश्तु धन्वने बाहोभ्याभुद्भुथ",
    "बाहोभ्याभुद्बुथतेन मः",
    "बाहोभ्याभुद्बुथतेनमः",
    "होभ्याभुद्बुथतेनमः",
  ];

  let state = INITIAL;
  const visited = new Set<number | null>();
  for (const take of takes) {
    state = step(state, heard(take));
    if (state.kind === "locked") visited.add(seq(state));
  }

  assert.equal(state.kind, "locked");
  assert.deepEqual([...visited], [3], `wandered to lines ${[...visited]}`);
});

test("progress through the line climbs across the real take", () => {
  const early = step(INITIAL, heard("तेरुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते"));
  const late = step(early, heard("बाहोभ्याभुद्बुथतेनमः"));
  assert.ok(
    late.progress > early.progress,
    `${late.progress} did not advance on ${early.progress}`,
  );
});

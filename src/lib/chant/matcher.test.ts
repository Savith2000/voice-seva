// Run with: npm test
//
// The interesting fixture here is REAL_TAKES: fifteen actual vak-san
// transcripts of one continuous recording, lifted from
// tools/asr-bakeoff/results-ctc.txt. They are what the model really produced
// at four overlapping 5-second windows, jitter included — "उत्तोत्" for
// उतोत, "बाहोभ्याभुद्बुथतेनमः" for बाहुभ्यामुत ते नमः.
//
// Testing a matcher on text you typed yourself proves that the matcher agrees
// with you. Testing it on this proves it survives the errors the model
// actually makes, which is the only question that matters.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { allLines, flatten, type Chant } from "./chant.ts";
import { lineBySequence, match, progressThroughLine } from "./matcher.ts";

const chant = JSON.parse(
  readFileSync(
    new URL("../../data/chants/sri-rudram-namakam-anuvaka-1.json", import.meta.url),
    "utf8",
  ),
) as Chant;

const flat = flatten(chant);
const lines = allLines(chant);

/** Sequence number of the line a result points at. */
const seq = (raw: string) => match(raw, flat)!.line.sequence;

// Rudram Test 1.m4a, 12.55s continuous, four anchors x five window shifts.
// The recording covers the opening: line 2 into line 3.
const REAL_TAKES: { anchor: string; takes: string[] }[] = [
  {
    anchor: "0.30–5.30s",
    takes: [
      "तेरुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
      "रुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
      "ुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते अ",
      "ध्रमन्यव उत्तोत् ईशवेनमः नमस्ते अश्",
    ],
  },
  {
    anchor: "2.62–7.62s",
    takes: [
      "तोत् इशवेनमः नमस्ते अश्तु धन्वने",
      "ोत् ईशवेनमः नमस्ते अस्तु धन्वने ब",
      "त् इशवेनमः नमस्ते अस्तु धन्वने बा",
      "त ईशवेनमः नमस्ते अस्तु धन्वने बाहु",
      "ईशवेनमः नमस्ते अस्तु धन्वने बाहो",
    ],
  },
  {
    anchor: "4.94–9.94s",
    takes: [
      "ते अश्तु धन्वने बाहोभ्याभुत्",
      "े अश्तु धन्वने बाहोभ्याभुत्भु",
      "अश्तु धन्वने बाहोभ्याभुद्भुथ",
    ],
  },
  {
    anchor: "7.25–12.25s",
    takes: [
      "बाहोभ्याभुद्बुथतेन मः",
      "बाहोभ्याभुद्बुथतेनमः",
      "होभ्याभुद्बुथतेनमः",
    ],
  },
];

const allTakes = REAL_TAKES.flatMap((a) => a.takes);

// --- against real model output ----------------------------------------------

test("every real transcript lands on the line that was being chanted", () => {
  // The recording is the opening of the anuvaka, and every window ends inside
  // line 3 — "नम॑स्ते अस्तु॒ धन्व॑ने बा॒हुभ्या॑मु॒त ते॒ नमः॑".
  for (const { anchor, takes } of REAL_TAKES) {
    for (const take of takes) {
      assert.equal(
        seq(take),
        3,
        `anchor ${anchor}: "${take}" matched line ${seq(take)}`,
      );
    }
  }
});

test("progress through the line only moves forward as the audio advances", () => {
  // The chanter is at the *end* of the window, so this should climb as the
  // window slides. A matcher that jumped around inside the line would still
  // pass the line test above while making the screen jitter.
  let previous = -1;
  for (const { anchor, takes } of REAL_TAKES) {
    const progress = Math.max(
      ...takes.map((t) => progressThroughLine(match(t, flat)!, flat)),
    );
    assert.ok(
      progress >= previous,
      `anchor ${anchor} went backwards: ${progress} after ${previous}`,
    );
    previous = progress;
  }
  assert.ok(previous > 0.9, `never reached the end of the line: ${previous}`);
});

test("real transcripts score well above garbage", () => {
  const worst = Math.min(...allTakes.map((t) => match(t, flat)!.score));
  const noise = match("अअअअअअअअअअअअ", flat)!.score;
  assert.ok(worst > 0.6, `worst real transcript scored only ${worst}`);
  assert.ok(
    worst > noise * 2,
    `real ${worst} is not clearly above noise ${noise}`,
  );
});

test("the matched span covers the lines the window really straddled", () => {
  // A 5-second window at the start of the recording genuinely spans the line
  // 2/3 boundary, and the span should say so rather than silently truncating.
  const early = match(REAL_TAKES[0].takes[0], flat)!;
  const sequences = early.spanLines.map((i) => flat.lines[i].sequence);
  assert.deepEqual(sequences, [2, 3]);
});

// --- the chant against itself -----------------------------------------------

test("every line matches itself, exactly", () => {
  // 33 assertions, and the one that would catch a matcher that quietly
  // favours long lines or the start of the string.
  for (const line of lines) {
    const result = match(line.devanagari, flat)!;
    assert.equal(
      result.line.sequence,
      line.sequence,
      `line ${line.sequence} matched line ${result.line.sequence}`,
    );
    assert.equal(result.score, 1, `line ${line.sequence} did not score 1`);
  }
});

test("a line matches itself from its raw text, svara marks and all", () => {
  // The caller passes a transcript, not something pre-normalised, so the
  // matcher has to normalise internally. The reference text has accents that
  // no transcript ever will.
  const line = lineBySequence(flat, 2)!;
  assert.match(line.devanagari, /[॒॑]/);
  assert.equal(match(line.devanagari, flat)!.line.sequence, 2);
});

test("the first half of a line still finds that line", () => {
  // Windows do not politely align to line boundaries.
  for (const sequence of [5, 12, 20, 27]) {
    const line = lineBySequence(flat, sequence)!;
    const half = line.normalized.slice(0, Math.ceil(line.normalized.length / 2));
    const result = match(half, flat)!;
    assert.ok(
      result.spanLines.some((i) => flat.lines[i].sequence === sequence),
      `first half of line ${sequence} matched line ${result.line.sequence}`,
    );
  }
});

// --- ambiguity --------------------------------------------------------------

test("a phrase two lines share reports no margin", () => {
  // "ब॒भूव॑ ते॒ धनुः॑" ends both line 4 and line 27. The score is perfect and
  // the answer is still a coin flip — which is exactly the case a score alone
  // cannot express, and the reason margin exists.
  const result = match("बभूव ते धनुः", flat)!;
  assert.equal(result.score, 1);
  assert.equal(result.margin, 0);
  assert.ok(result.runnerUp);
  const rival = flat.lines[result.runnerUp.lineIndex].sequence;
  assert.deepEqual(
    [result.line.sequence, rival].sort((a, b) => a - b),
    [4, 27],
  );
});

test("margin ignores the neighbour a window is allowed to straddle", () => {
  // Lines are concatenated with no separator, so an alignment ending one
  // character into the next line costs one edit and scores almost the same.
  // Counting that as a rival made a verbatim line 2 look ambiguous at 0.04.
  const result = match(lineBySequence(flat, 2)!.devanagari, flat)!;
  assert.equal(result.score, 1);
  assert.ok(
    result.margin > 0.4,
    `verbatim line 2 reported margin ${result.margin}`,
  );
  assert.ok(
    !result.runnerUp || Math.abs(result.runnerUp.lineIndex - result.lineIndex) > 1,
    "runner-up should not be an adjacent line",
  );
});

test("a phrase unique to one line reports a wide margin", () => {
  const result = match("मृत्युञ्जयाय सर्वेश्वराय", flat)!;
  assert.equal(result.line.sequence, 33);
  assert.ok(result.margin > 0.3, `margin was only ${result.margin}`);
});

// --- degenerate input -------------------------------------------------------

test("input that normalises to nothing returns null rather than a guess", () => {
  // Silence transcribes to "" and punctuation-only output is not unheard of.
  // Returning line 1 with score 0 would be a lie the state machine has to
  // unpick later.
  for (const empty of ["", "   ", "।॥", "\n\t", "123 ..."]) {
    assert.equal(match(empty, flat), null, `expected null for ${empty}`);
  }
});

test("text with nothing in common scores zero", () => {
  const result = match("the quick brown fox jumps over", flat)!;
  assert.equal(result.score, 0);
});

test("a single character never scores well", () => {
  // Short queries match everywhere. This is the case that would let one stray
  // frame of audio yank the screen across the chant.
  const result = match("न", flat)!;
  assert.equal(result.margin, 0);
});

// --- invariants -------------------------------------------------------------

test("the reported span is inside the chant and matches its own text", () => {
  for (const take of allTakes) {
    const r = match(take, flat)!;
    assert.ok(r.start >= 0 && r.start < r.end, `bad span ${r.start}..${r.end}`);
    assert.ok(r.end <= flat.text.length, "span runs past the end of the chant");
    assert.equal(flat.lineAt[r.end - 1], r.lineIndex, "end is in the wrong line");
    assert.equal(r.spanLines[r.spanLines.length - 1], r.lineIndex);
  }
});

test("score and margin stay inside [0, 1]", () => {
  const probes = [...allTakes, "न", "बभूव ते धनुः", "xyz", ...lines.map((l) => l.devanagari)];
  for (const probe of probes) {
    const r = match(probe, flat);
    if (!r) continue;
    assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} for ${probe}`);
    assert.ok(r.margin >= 0 && r.margin <= 1, `margin ${r.margin} for ${probe}`);
    assert.equal(r.query, r.query.normalize("NFC"));
  }
});

test("matching is fast enough to run once a second", () => {
  // The model takes ~885 ms per window on WebGPU. If this were anywhere near
  // that it would halve the frame rate of the whole loop.
  const started = performance.now();
  for (let i = 0; i < 50; i++) match(allTakes[i % allTakes.length], flat);
  const each = (performance.now() - started) / 50;
  assert.ok(each < 50, `${each.toFixed(1)} ms per match is too slow`);
});

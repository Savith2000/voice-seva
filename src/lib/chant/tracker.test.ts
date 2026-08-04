// Run with: npm test
//
// The tracker is where a working matcher and a working model can still add up
// to a broken app. Inference takes ~885 ms and frames arrive ~15 times a
// second, so the failure to guard against is not a wrong answer — it is a
// queue. Every result stays plausible while describing audio from further and
// further in the past, and nothing errors.
//
// The clock and the model are both injected so those timings can be forced
// here rather than waited for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { flatten, type Chant } from "./chant.ts";
import {
  MAX_INTERVAL_MS,
  SAMPLE_RATE,
  SlidingWindowTracker,
  rootMeanSquare,
  type TrackerOptions,
  type TrackerTick,
} from "./tracker.ts";

const chant = JSON.parse(
  readFileSync(
    new URL("../../data/chants/sri-rudram-namakam-anuvaka-1.json", import.meta.url),
    "utf8",
  ),
) as Chant;
const flat = flatten(chant);

/** A frame of audible noise, the size the worklet actually delivers. */
function frame(amplitude = 0.2, length = 1024): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = ((i % 7) - 3) * amplitude;
  return out;
}

const silence = (length = 1024) => new Float32Array(length);

/** A controllable clock and a transcriber whose replies are resolved by hand. */
function harness(
  text = "ते अश्तु धन्वने बाहोभ्याभुत्",
  options: TrackerOptions = {},
  /** What the fake model claims it cost. Pacing is derived from this. */
  inferenceMs = 880,
) {
  let clock = 0;
  const pending: (() => void)[] = [];
  const ticks: TrackerTick[] = [];
  let calls = 0;

  const tracker = new SlidingWindowTracker(
    flat,
    () => {
      calls++;
      return new Promise((resolve) => {
        pending.push(() => resolve({ text, inferenceMs }));
      });
    },
    (tick) => ticks.push(tick),
    { now: () => clock, ...options },
  );

  return {
    tracker,
    ticks,
    get calls() {
      return calls;
    },
    get inFlight() {
      return pending.length;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    /** Let the oldest outstanding transcription return. */
    settle: async () => {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Push enough audio to fill the 5-second window. */
function fill(tracker: SlidingWindowTracker, sample = frame()) {
  const frames = Math.ceil((SAMPLE_RATE * 5) / sample.length);
  for (let i = 0; i < frames; i++) tracker.push(sample);
}

// --- backpressure -----------------------------------------------------------

test("only one transcription runs at a time, however much audio arrives", () => {
  // The whole point. 15 frames/second against ~885 ms of inference means a
  // fire-per-frame loop would be ~13 deep after one second and never recover.
  const h = harness();
  fill(h.tracker);
  assert.equal(h.calls, 1);

  for (let i = 0; i < 200; i++) {
    h.advance(10); // well past minIntervalMs, many times over
    h.tracker.push(frame());
  }

  assert.equal(h.calls, 1, "started a second transcription while one was running");
  assert.equal(h.inFlight, 1);
  assert.ok(h.tracker.dropped > 100, "dropped frames were not counted");
});

test("the next window starts only after the previous one returns", async () => {
  const h = harness();
  fill(h.tracker);
  assert.equal(h.calls, 1);

  await h.settle();
  // Long enough to clear the pacing this fake model's 880 ms earns it.
  h.advance(MAX_INTERVAL_MS);
  h.tracker.push(frame());
  assert.equal(h.calls, 2);
});

test("a slow model lowers the rate instead of building a queue", async () => {
  // Ten seconds of audio against a model that takes 2 s per window: six
  // results, not a hundred and fifty, and no backlog left over.
  const h = harness();
  const perFrame = 1000 / 15;
  let sinceStart = 0;

  fill(h.tracker);
  for (let i = 0; i < 150; i++) {
    h.advance(perFrame);
    sinceStart += perFrame;
    h.tracker.push(frame());
    if (sinceStart >= 2000) {
      await h.settle();
      sinceStart = 0;
    }
  }

  assert.ok(h.calls <= 7, `${h.calls} transcriptions for 10 s of audio`);
  assert.ok(h.calls >= 4, `only ${h.calls} transcriptions for 10 s of audio`);
  assert.ok(h.inFlight <= 1, "a backlog accumulated");
});

test("minIntervalMs throttles a model that returns instantly", async () => {
  // inferenceMs of 1 keeps duty-cycle pacing out of the way, so this tests
  // the floor rather than the protection above it.
  const h = harness("नमस्ते", { minIntervalMs: 1000 }, 1);
  fill(h.tracker);
  await h.settle();

  h.advance(300);
  h.tracker.push(frame());
  assert.equal(h.calls, 1, "fired again before the interval elapsed");

  h.advance(800);
  h.tracker.push(frame());
  assert.equal(h.calls, 2);
});

// --- not melting the machine ------------------------------------------------

test("a slow machine is paced gently, not hammered", () => {
  // Without this the loop paces on max(floor, inference), so the duty cycle
  // *rises* as the hardware weakens: 400 ms of work every 400 ms pins a
  // laptop flat for the whole session. The faster the machine, the gentler
  // the loop was being.
  const clock = 0;
  const ticks: TrackerTick[] = [];
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते", inferenceMs: 400 }),
    (tick) => ticks.push(tick),
    { now: () => clock },
  );

  fill(tracker);
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      assert.ok(
        tracker.intervalMs >= 700,
        `400 ms of work is being scheduled every ${tracker.intervalMs} ms`,
      );
      assert.ok(
        tracker.dutyCycle <= 0.55,
        `duty cycle ${tracker.dutyCycle.toFixed(2)} leaves nothing for the UI`,
      );
    });
});

test("a fast machine is not slowed down by the protection", () => {
  // The whole point is that this costs nothing where it is not needed.
  const clock = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते", inferenceMs: 48 }),
    () => {},
    { now: () => clock },
  );

  fill(tracker);
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      assert.equal(tracker.intervalMs, 250, "the floor stopped applying");
      assert.ok(tracker.dutyCycle < 0.25);
    });
});

test("pacing never stretches past the cap on a very slow backend", () => {
  // Without WebGPU a window costs ~1400 ms. The duty rule alone would pace at
  // 2.8 s, which would make an already-degraded path unusable for no gain —
  // that machine is inference-bound, not rate-limited.
  const clock = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते", inferenceMs: 1400 }),
    () => {},
    { now: () => clock },
  );

  fill(tracker);
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      assert.equal(tracker.intervalMs, MAX_INTERVAL_MS);
    });
});

test("one slow window does not re-pace the whole session", () => {
  // Smoothed, because a single hitch — a background tab, a GC pause — is not
  // evidence about the machine.
  let clock = 0;
  let call = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते", inferenceMs: ++call === 3 ? 900 : 48 }),
    () => {},
    { now: () => clock },
  );

  fill(tracker);
  return (async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await Promise.resolve();
      clock += 2000;
      tracker.push(frame());
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      tracker.intervalMs < 700,
      `one 900 ms window moved pacing to ${tracker.intervalMs} ms`,
    );
  })();
});

// --- refusing to run --------------------------------------------------------

test("a window that is mostly empty is not transcribed", () => {
  // At startup the ring holds a fraction of a second. Transcribing that wastes
  // most of a second and returns something the matcher will place anyway.
  const h = harness();
  h.tracker.push(frame());
  assert.equal(h.calls, 0);
  assert.equal(h.ticks.at(-1)?.state, "filling");
});

test("silence is reported, not transcribed", () => {
  // CTC on silence does not return "". It returns whatever the blank collapses
  // to, and the matcher would place that somewhere with a straight face.
  const h = harness();
  fill(h.tracker, silence());
  assert.equal(h.calls, 0);
  assert.equal(h.ticks.at(-1)?.state, "silent");
});

test("audio just above the silence floor is transcribed", () => {
  const h = harness("नमस्ते", { silenceRms: 0.01 });
  fill(h.tracker, frame(0.05));
  assert.equal(h.calls, 1);
});

// --- results ----------------------------------------------------------------

test("a transcript is matched to a line and handed on", async () => {
  const h = harness("ते अश्तु धन्वने बाहोभ्याभुत्");
  fill(h.tracker);
  await h.settle();

  const tick = h.ticks.at(-1);
  assert.equal(tick?.state, "matched");
  if (tick?.state !== "matched") return;
  assert.equal(tick.transcript, "ते अश्तु धन्वने बाहोभ्याभुत्");
  assert.equal(tick.result?.line.sequence, 3);
  assert.ok(tick.audioSeconds >= 3, `only ${tick.audioSeconds}s of audio`);
});

test("the first window fires at minimum fill rather than waiting for five seconds", async () => {
  // minFillRatio trades a little accuracy for two seconds off the first lock.
  // Waiting for a full window means the screen sits inert while someone is
  // already chanting, which reads as broken.
  const h = harness("नमस्ते", { minFillRatio: 0.6 });
  fill(h.tracker);
  await h.settle();

  const first = h.ticks.find((t) => t.state === "matched");
  assert.ok(first, "nothing was transcribed");
  assert.ok(
    first.audioSeconds >= 3 && first.audioSeconds < 3.2,
    `first window was ${first.audioSeconds}s, expected ~3s`,
  );
});

test("a transcript that matches nothing still produces a tick", async () => {
  // The state machine in Chunk 8 needs to see the miss. Swallowing it would
  // look identical to the loop having stalled.
  const h = harness("zzz qqq");
  fill(h.tracker);
  await h.settle();

  const tick = h.ticks.at(-1);
  assert.equal(tick?.state, "matched");
  if (tick?.state !== "matched") return;
  assert.equal(tick.result?.score, 0);
});

test("stop() suppresses a result that was already in flight", async () => {
  // Inference outlives the click that ended the session by up to a second.
  // Repainting the screen after that is a ghost update.
  const h = harness();
  fill(h.tracker);
  const before = h.ticks.length;

  h.tracker.stop();
  await h.settle();

  assert.equal(h.ticks.length, before, "delivered a result after stop()");
});

test("stop() also stops accepting audio", () => {
  const h = harness();
  h.tracker.stop();
  fill(h.tracker);
  assert.equal(h.calls, 0);
});

test("a transcription that throws does not wedge the loop", async () => {
  // One bad window must not end the session; the next is a second away.
  let attempt = 0;
  const ticks: TrackerTick[] = [];
  let clock = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async () => {
      attempt++;
      if (attempt === 1) throw new Error("backend hiccup");
      return { text: "नमस्ते", inferenceMs: 5 };
    },
    (tick) => ticks.push(tick),
    { now: () => clock },
  );

  fill(tracker);
  await Promise.resolve();
  await Promise.resolve();

  clock += 2000;
  tracker.push(frame());
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(attempt, 2, "the loop stopped after the first failure");
  assert.ok(ticks.some((t) => t.state === "matched"));
});

// --- what the reader can see ------------------------------------------------

test("the viewport reaches the matcher", () => {
  // Lines 3 and 33 both open "namaste astu", so the audio cannot separate
  // them and whatever is on screen decides. This covers the hop from
  // setInView to the match call; matcher.test.ts covers the rule itself.
  const seen: (number | null)[] = [];
  const clock = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते अस्तु", inferenceMs: 20 }),
    (tick) => {
      if (tick.state === "matched") {
        seen.push(tick.result ? tick.result.line.sequence : null);
      }
    },
    { now: () => clock },
  );

  tracker.setInView([30, 31, 32]);
  fill(tracker);
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      assert.deepEqual(seen, [33], `matched line ${seen[0]} looking at the end`);
    });
});

test("clearing the viewport goes back to the audio's own answer", () => {
  const clock = 0;
  const seen: number[] = [];
  const tracker = new SlidingWindowTracker(
    flat,
    async () => ({ text: "नमस्ते अस्तु", inferenceMs: 20 }),
    (tick) => {
      if (tick.state === "matched" && tick.result) seen.push(tick.result.line.sequence);
    },
    { now: () => clock },
  );

  tracker.setInView(null);
  fill(tracker);
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => {
      assert.equal(seen.length, 1);
      assert.notEqual(seen[0], undefined);
    });
});

// --- the window itself ------------------------------------------------------

test("the window settles at exactly five seconds and never grows", async () => {
  // A 45-minute session pushes ~43 million samples through here. If the
  // window tracked total audio rather than the ring's capacity, inference
  // time would climb all session and the leak would look like thermal
  // throttling.
  const sizes: number[] = [];
  let clock = 0;
  const tracker = new SlidingWindowTracker(
    flat,
    async (samples) => {
      sizes.push(samples.length);
      return { text: "नमस्ते", inferenceMs: 1 };
    },
    () => {},
    { now: () => clock },
  );

  // Twenty seconds of audio, letting each transcription finish.
  for (let i = 0; i < 300; i++) {
    tracker.push(frame());
    clock += 1000 / 15;
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.ok(sizes.length > 5, `only ${sizes.length} windows`);
  for (const size of sizes) {
    assert.ok(size <= SAMPLE_RATE * 5, `window grew to ${size} samples`);
  }
  assert.equal(sizes.at(-1), SAMPLE_RATE * 5, "never reached a full window");
});

test("rootMeanSquare is 0 for silence and rises with level", () => {
  assert.equal(rootMeanSquare(new Float32Array(0)), 0);
  assert.equal(rootMeanSquare(new Float32Array(100)), 0);
  assert.ok(rootMeanSquare(frame(0.5)) > rootMeanSquare(frame(0.1)));
});

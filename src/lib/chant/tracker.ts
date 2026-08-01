// The sliding window: audio in, chant position out.
//
// wav2vec2 is a batch model with no streaming mode, so "real time" is faked by
// re-transcribing an overlapping window of the recent past. Because the
// transcript is never shown to anyone, an unstable hypothesis can be consumed
// immediately — there is no need to wait for tokens to settle the way a
// captioning UI would.
//
// The hard part is not the loop, it is refusing to run it. Inference takes
// ~885 ms on WebGPU and frames arrive about fifteen times a second, so
// anything that fires per frame, or on a fixed timer that ignores whether the
// last request finished, builds a queue that never drains. Every result then
// describes older and older audio while looking perfectly healthy. So this
// keeps exactly one request in flight and drops everything that arrives while
// it is busy: falling behind by design beats falling behind by accident.

import { type FlatChant } from "./chant.ts";
import { match, type MatchResult } from "./matcher.ts";
import { RingBuffer } from "../audio/ring-buffer.ts";

export const SAMPLE_RATE = 16_000;

/** Measured in Chunk 3 against real chanting: 3 s jitters, 8 s blurs lines. */
export const WINDOW_SECONDS = 5;

/**
 * Floor between the starts of two windows.
 *
 * Was 1000 ms, chosen when a window cost ~930 ms and the floor never bound.
 * On fp16/WebGPU a window costs ~48 ms, so this became the entire update
 * cadence and therefore most of the delay between chanting a line and seeing
 * it — the loop was idle ~80% of the time waiting for its own rate limit.
 *
 * 250 ms gives four updates a second at roughly a 20% duty cycle. Lower would
 * still work; it would mostly buy heat. Where WebGPU is unavailable inference
 * takes ~1400 ms and this floor never binds, exactly as before.
 */
export const DEFAULT_INTERVAL_MS = 250;

type TickBase = {
  /** Clock reading when the window was taken. */
  at: number;
  /** Loudness of the window, 0..1. */
  rms: number;
  /** Seconds of audio actually transcribed. */
  audioSeconds: number;
};

/** A window that was actually run through the model. */
export type MatchedTick = TickBase & {
  state: "matched";
  transcript: string;
  /** Null when the transcript normalises to nothing. */
  result: MatchResult | null;
  inferenceMs: number;
};

// "silent" and "filling" are separate members rather than one member with a
// `state: "silent" | "filling"` union. TypeScript narrows a discriminated
// union by eliminating whole members, so the combined form can never be
// narrowed away — every consumer would be left unable to see `result` even
// after ruling both of them out.
export type TrackerTick =
  | MatchedTick
  | (TickBase & { state: "silent" })
  | (TickBase & { state: "filling" });

export type Transcribe = (
  samples: Float32Array,
) => Promise<{ text: string; inferenceMs: number }>;

export type TrackerOptions = {
  windowSeconds?: number;
  /**
   * Floor between the *starts* of two transcriptions. The real rate is
   * max(this, inference time), because a request may not begin while one is
   * running.
   */
  minIntervalMs?: number;
  /**
   * Below this RMS, skip the window instead of spending most of a second
   * transcribing a quiet room. Silence through a CTC model does not come back
   * empty — it comes back as whatever the blank collapses to, which the
   * matcher will then dutifully place somewhere.
   */
  silenceRms?: number;
  /** Don't transcribe until the window is at least this full. */
  minFillRatio?: number;
  sampleRate?: number;
  now?: () => number;
};

export class SlidingWindowTracker {
  private readonly flat: FlatChant;
  private readonly transcribe: Transcribe;
  private readonly ring: RingBuffer;
  private readonly windowSamples: number;
  private readonly minSamples: number;
  private readonly minIntervalMs: number;
  private readonly silenceRms: number;
  private readonly sampleRate: number;
  private readonly now: () => number;
  private readonly onTick: (tick: TrackerTick) => void;

  private busy = false;
  private stopped = false;
  private lastFireAt = Number.NEGATIVE_INFINITY;
  private lastStatusAt = Number.NEGATIVE_INFINITY;
  private lastStatusState: "silent" | "filling" | null = null;
  /** Windows dropped because inference was still running. Worth surfacing. */
  private droppedWhileBusy = 0;

  constructor(
    flat: FlatChant,
    transcribe: Transcribe,
    onTick: (tick: TrackerTick) => void,
    options: TrackerOptions = {},
  ) {
    const {
      windowSeconds = WINDOW_SECONDS,
      minIntervalMs = DEFAULT_INTERVAL_MS,
      silenceRms = 0.005,
      minFillRatio = 0.6,
      sampleRate = SAMPLE_RATE,
      now = () => performance.now(),
    } = options;

    this.flat = flat;
    this.transcribe = transcribe;
    this.onTick = onTick;
    this.sampleRate = sampleRate;
    this.windowSamples = Math.round(windowSeconds * sampleRate);
    this.minSamples = Math.round(this.windowSamples * minFillRatio);
    this.minIntervalMs = minIntervalMs;
    this.silenceRms = silenceRms;
    this.now = now;
    this.ring = new RingBuffer(this.windowSamples);
  }

  get dropped(): number {
    return this.droppedWhileBusy;
  }

  /** Feed one frame of microphone audio. Fires a transcription if it is time. */
  push(samples: Float32Array): void {
    if (this.stopped) return;
    this.ring.write(samples);

    const at = this.now();
    if (this.busy) {
      this.droppedWhileBusy++;
      return;
    }

    const window = this.ring.readLast(this.windowSamples);
    const audioSeconds = window.length / this.sampleRate;

    // The cheap refusals come before the rate limit, not after. Letting a
    // "still filling" check consume the once-a-second slot means the first
    // real transcription waits out a whole interval after the buffer is
    // already full — the loop looks like it takes two seconds to start, and
    // nothing in it is actually slow.
    if (window.length < this.minSamples) {
      this.report({ at, rms: 0, audioSeconds, state: "filling" });
      return;
    }

    const rms = rootMeanSquare(window);
    if (rms < this.silenceRms) {
      this.report({ at, rms, audioSeconds, state: "silent" });
      return;
    }

    if (at - this.lastFireAt < this.minIntervalMs) return;

    // Claim the slot before anything async, so two frames arriving back to
    // back cannot both get through.
    this.lastFireAt = at;
    this.busy = true;
    void this.run(window, at, rms, audioSeconds);
  }

  /**
   * Emit a not-transcribing tick, without emitting one per frame.
   *
   * Frames arrive ~15 times a second and a quiet room produces nothing else,
   * so this passes a change of state through immediately and otherwise holds
   * to the same once-a-second cadence as the results.
   */
  private report(tick: TrackerTick & { state: "silent" | "filling" }): void {
    const changed = tick.state !== this.lastStatusState;
    if (!changed && tick.at - this.lastStatusAt < this.minIntervalMs) return;
    this.lastStatusState = tick.state;
    this.lastStatusAt = tick.at;
    this.onTick(tick);
  }

  private async run(
    window: Float32Array,
    at: number,
    rms: number,
    audioSeconds: number,
  ): Promise<void> {
    try {
      const { text, inferenceMs } = await this.transcribe(window);
      // A result that lands after stop() describes audio from a session the
      // caller has already torn down. Delivering it would repaint a screen
      // that is meant to be idle.
      if (this.stopped) return;
      this.onTick({
        at,
        rms,
        audioSeconds,
        state: "matched",
        transcript: text,
        result: match(text, this.flat),
        inferenceMs,
      });
    } catch {
      // A failed window is not worth surfacing on its own — the next one is
      // a second away. Persistent failure shows up as a stalled position.
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

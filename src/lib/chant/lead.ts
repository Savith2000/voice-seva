// Showing where the chanter is *now*, rather than where they were.
//
// Every position the matcher reports is already old. The window ends at the
// moment it is taken, the model then spends ~930 ms on it, and the highlight
// that results stands still until the next window lands about 1.2 s later. So
// the screen is behind by the inference time, and drifts a further windowful
// behind between updates.
//
// The fix is not "highlight the next line". A line is roughly six seconds of
// chanting and the lag is under two, so jumping a whole line would overshoot
// for most of every line and be wrong in the opposite direction. Instead this
// measures how fast the chanting is actually moving through the text, in
// characters per second, and walks that many characters forward. Usually that
// stays inside the current line and only nudges the progress bar; near the end
// of a line it crosses into the next one, slightly early — which is exactly
// when a reader wants it to.
//
// It is a display adjustment and nothing else. The state machine still sees
// the matcher's real answer, so a lead that is wrong cannot make the app
// commit to a wrong position — it can only make the highlight sit a little
// ahead or behind.

import { type FlatChant } from "./chant.ts";

/**
 * Bounds on plausible chanting speed, in normalised characters per second.
 *
 * The test recording runs at roughly 5–6. The bounds exist because the
 * estimate is a ratio of two measured quantities, and a window that lands one
 * character further on after a long pause would otherwise imply a rate near
 * zero, while a corrected jump would imply hundreds.
 */
export const MIN_RATE = 1;
export const MAX_RATE = 20;

/** Starting guess, used until two windows have been seen. */
export const DEFAULT_RATE = 5.5;

/** Weight of each new observation. Low, because single windows are noisy. */
const SMOOTHING = 0.3;

/** Ignore movements bigger than this: they are jumps, not chanting. */
const MAX_STEP_CHARS = 60;

/**
 * Ignore observations further apart than this.
 *
 * Windows land about 1.2 s apart, so a longer gap means something was skipped
 * — silence, a stall, a paused session. The arithmetic across such a gap is
 * still perfectly well formed, which is the trap: one character in eight
 * seconds reads as a rate near zero and drags the estimate down for the rest
 * of the session, so the lead quietly stops working after the first pause.
 */
const MAX_GAP_SECONDS = 3;

/** Never lead by more than this, whatever the arithmetic says. */
export const MAX_LEAD_MS = 2500;

export type Pace = {
  /** Smoothed characters per second. */
  rate: number;
  /** Observations folded in so far. */
  samples: number;
  lastEnd: number | null;
  lastAt: number | null;
};

export const NO_PACE: Pace = {
  rate: DEFAULT_RATE,
  samples: 0,
  lastEnd: null,
  lastAt: null,
};

/**
 * Fold in one observation of "we were at character `end` at time `at`".
 *
 * Backwards and outsized movements update the anchor but contribute nothing
 * to the rate — a repeat, a correction or a jump says nothing about tempo.
 */
export function observePace(pace: Pace, end: number, at: number): Pace {
  const { lastEnd, lastAt } = pace;
  if (lastEnd === null || lastAt === null) {
    return { ...pace, lastEnd: end, lastAt: at };
  }

  const chars = end - lastEnd;
  const seconds = (at - lastAt) / 1000;
  if (
    seconds <= 0 ||
    seconds > MAX_GAP_SECONDS ||
    chars <= 0 ||
    chars > MAX_STEP_CHARS
  ) {
    // Anchor still moves — otherwise the next observation would measure from
    // a position the chanting left long ago.
    return { ...pace, lastEnd: end, lastAt: at };
  }

  const observed = Math.min(MAX_RATE, Math.max(MIN_RATE, chars / seconds));
  const rate =
    pace.samples === 0 ? observed : pace.rate * (1 - SMOOTHING) + observed * SMOOTHING;

  return {
    rate: Math.min(MAX_RATE, Math.max(MIN_RATE, rate)),
    samples: pace.samples + 1,
    lastEnd: end,
    lastAt: at,
  };
}

export type LeadResult = {
  lineIndex: number;
  /** 0..1 through that line. */
  progress: number;
  /** Where in the flattened chant the highlight is being placed. */
  charIndex: number;
  /** How far ahead this actually moved, in characters. */
  charsAhead: number;
};

/**
 * Walk `leadMs` worth of chanting forward from a matched position.
 *
 * `end` is the matcher's character index, which is the end of the window and
 * therefore the most recent audio it saw.
 */
export function leadPosition(
  flat: FlatChant,
  end: number,
  pace: Pace,
  leadMs: number,
): LeadResult {
  const clampedLead = Math.max(0, Math.min(MAX_LEAD_MS, leadMs));
  const charsAhead = Math.round((pace.rate * clampedLead) / 1000);

  // Never past the last character; there is nothing after the chant.
  const charIndex = Math.min(flat.text.length, Math.max(1, end + charsAhead));
  const lineIndex = flat.lineAt[charIndex - 1];

  let lineStart = 0;
  for (let i = 0; i < lineIndex; i++) {
    lineStart += flat.lines[i].normalized.length;
  }
  const length = flat.lines[lineIndex].normalized.length;

  return {
    lineIndex,
    progress: length === 0 ? 1 : Math.min(1, Math.max(0, (charIndex - lineStart) / length)),
    charIndex,
    charsAhead: charIndex - end,
  };
}

/**
 * How stale a displayed position is by the time anyone sees it.
 *
 * Two parts, both measured rather than assumed. The window's audio ends when
 * it is taken, so inference time is dead lag. And the highlight then holds
 * still until the next result arrives, so on average it is another half an
 * update interval behind — leading by the full interval would overshoot for
 * the second half of every cycle.
 */
export function estimateLagMs(inferenceMs: number, updateIntervalMs: number): number {
  const inference = Number.isFinite(inferenceMs) ? Math.max(0, inferenceMs) : 0;
  const interval = Number.isFinite(updateIntervalMs)
    ? Math.max(0, updateIntervalMs)
    : 0;
  return Math.min(MAX_LEAD_MS, inference + interval / 2);
}

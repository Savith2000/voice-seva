// Filling in the gaps between windows.
//
// The tracker delivers a position when the model finishes a window. With a GPU
// that is roughly four times a second and the ink creeps forward; without one
// it is closer to once every one and a half seconds, and the same ink lurches
// five or six words at a stroke. The rate of information is identical — only
// its presentation differs, and the lurch is what a reader calls "slow and
// noisy".
//
// So this does what a video player does with a choppy stream: measure the pace
// between arrivals and draw a continuous line through them, correcting every
// time a real reading lands.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never advances the *line*. Predicting which line someone is on was built,
// measured and deleted in 31d4d79 — a guess that is usually right still moves
// the highlight for reasons the reader cannot see, and an unexplained move
// costs more attention than a highlight that is honestly a little late. This
// only moves progress *within a line the tracker has already committed to*, so
// the worst case is ink slightly ahead of a voice on a line it is demonstrably
// on. It cannot send an eye somewhere else.
//
// Kept apart from the component, and free of React and of the DOM, because the
// governors below are the whole safety argument and they should be provable by
// a test rather than by watching a screen and feeling reassured.

/** Fastest believable pace: 0.004 of a line per ms is a line every 250 ms. */
export const MAX_RATE = 0.004;

/**
 * How far past a real reading the ink may run, as a multiple of the expected
 * gap between windows.
 *
 * Slightly over one, so the ink arrives just as the next reading does rather
 * than stalling visibly before it. Much more than that and a chanter who pauses
 * for breath watches the ink carry on without them.
 */
export const OVERRUN = 1.15;

export type Anchor = {
  /** Progress at the last real reading, 0..1. */
  progress: number;
  /** Clock reading when it arrived. */
  at: number;
  /** Progress per millisecond, learned from the last two readings. */
  rate: number;
};

/**
 * Learn the pace from a new reading.
 *
 * Backwards movement is ignored rather than treated as negative speed: lines
 * repeat, and a window straddling a boundary can legitimately report either
 * side. Smoothed against the previous estimate so a single odd gap does not
 * set the pace for the next second and a half.
 */
export function anchorFrom(
  previous: Anchor,
  progress: number,
  at: number,
): Anchor {
  const elapsed = at - previous.at;
  const moved = progress - previous.progress;
  const measured =
    elapsed > 0 && moved > 0 ? Math.min(moved / elapsed, MAX_RATE) : 0;
  return {
    progress,
    at,
    rate: previous.rate > 0 ? previous.rate * 0.5 + measured * 0.5 : measured,
  };
}

/**
 * Where the ink should be right now.
 *
 * Three governors, because unattended extrapolation is exactly how the
 * graveyard entry above got written:
 *
 *   1. never past the end of the line;
 *   2. never more than OVERRUN expected windows past a real reading, so a
 *      chanter who stops is not left watching the ink walk away;
 *   3. only while the tracker is genuinely following — a held or searching
 *      position sits still, which is the honest thing for it to do.
 */
export function glide(
  anchor: Anchor,
  now: number,
  intervalMs: number,
  live: boolean,
): number {
  if (!live || anchor.rate <= 0) return clamp(anchor.progress);
  const since = Math.max(0, now - anchor.at);
  const allowed = Math.min(since, Math.max(intervalMs, 250) * OVERRUN);
  return clamp(anchor.progress + anchor.rate * allowed);
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

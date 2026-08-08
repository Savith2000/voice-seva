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
// HOW A CORRECTION IS ALLOWED TO LOOK
//
// The first version of this file rendered each new reading the frame it
// arrived. That was wrong in a way no test caught and one chant into it did:
// the matcher's position estimate is noisy — the tail of a five-second window
// is its least reliable part, and consecutive windows can disagree by a good
// fraction of a line, including backwards. The old once-per-window bar hid
// that noise behind a 300 ms CSS ease; this system had removed the ease and
// displayed the noise raw, sixty times a second. On a fast machine readings
// land four times a second, so the ink visibly snapped four times a second —
// the machine got faster and the page got worse.
//
// So the shown position is now its own state, and it *chases* the readings
// rather than becoming them:
//
//   - ahead of the ink, a reading is approached smoothly, most of the way in
//     about three window arrivals' worth of frames (SETTLE_MS);
//   - behind the ink, a reading does not drag the ink back. The ink pauses
//     and the voice catches up. Within one line, ink only ever advances —
//     which is also how a reader's eye moves.
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

/**
 * Time constant of the chase, in milliseconds.
 *
 * A correction closes 63% of its gap in this long and ~95% in three times it.
 * 150 ms is quick enough that the ink is settled well before the next reading
 * even on a fast device, and slow enough that no single frame moves the ink
 * far enough to read as a jump.
 */
export const SETTLE_MS = 150;

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
 * Where the ink believes the voice is, from the last reading and its pace.
 *
 * Governed twice, because unattended extrapolation is exactly how the
 * graveyard entry above got written: never past the end of the line, and never
 * more than OVERRUN expected windows past a real reading, so a chanter who
 * stops is not left watching the ink walk away.
 */
export function target(anchor: Anchor, now: number, intervalMs: number): number {
  const since = Math.max(0, now - anchor.at);
  const allowed = Math.min(since, Math.max(intervalMs, 250) * OVERRUN);
  return clamp(anchor.progress + anchor.rate * allowed);
}

/**
 * Where the ink should be this frame, given where it was last frame.
 *
 * `shown` is the position actually rendered on the previous frame, and the
 * return value is the one to render now — the caller owns that piece of state
 * and threads it back in, which keeps this a pure function a test can drive
 * frame by frame.
 *
 * The governors, in the order they apply:
 *
 *   1. only while the tracker is genuinely following — a held or searching
 *      position sits exactly still, which is the honest thing for it to do;
 *   2. within a line the ink never moves backwards: a reading behind the ink
 *      pauses it rather than dragging it back (a new *line* is a jump, not a
 *      journey — the caller resets `shown` there);
 *   3. a reading ahead of the ink is approached on the SETTLE_MS ease, never
 *      arrived at in one frame;
 *   4. the position chased is itself capped by {@link target}: never past the
 *      end of the line, never more than OVERRUN windows past a real reading.
 */
export function glide(
  anchor: Anchor,
  shown: number,
  now: number,
  frameMs: number,
  intervalMs: number,
  live: boolean,
): number {
  if (!live) return clamp(shown);
  const aim = target(anchor, now, intervalMs);
  if (aim <= shown) return clamp(shown);
  const closed = 1 - Math.exp(-Math.max(0, frameMs) / SETTLE_MS);
  return clamp(shown + (aim - shown) * closed);
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Deciding what the screen should actually show.
//
// The matcher answers "where does this window fit best?" every second, and it
// always answers — even for a window of coughing. Wiring that straight to the
// display gives a screen that twitches, and a screen that twitches during a
// recitation is worse than one that lags. So this sits in between and is
// deliberately reluctant.
//
// The rule it is built around: **following is cheap, jumping is expensive.**
// Chanting moves forward one line at a time, so a result that continues from
// where we already are needs only ordinary evidence. A result that would throw
// the screen somewhere else has to say so twice. That asymmetry is the whole
// design; everything below is bookkeeping for it.
//
// Written as a pure reducer rather than a class so that a whole session can be
// replayed through it in a test, one tick at a time, with no clock and no
// mocking.

import { type MatchResult } from "./matcher.ts";
import { type TrackerTick } from "./tracker.ts";

export type Confidence = "high" | "medium" | "low";

/**
 * Provisional, and derived from the only real data that exists — the fifteen
 * vak-san transcripts in tools/asr-bakeoff/results-ctc.txt.
 *
 *   good windows, mid-recording   score 0.75–1.00   margin 0.33–0.48
 *   degraded, end of recording    score 0.63–0.65   margin 0.06
 *   a phrase two lines share      score 1.00        margin 0.00
 *   noise                         score 0.17        margin 0.00
 *
 * Note what that table says: score alone cannot separate row three from row
 * one. Both thresholds have to be met, which is why margin exists at all.
 *
 * One recording from one chanter is not enough to call these tuned. They are
 * in one place so a longer take can move them without hunting through code.
 */
export const THRESHOLDS = {
  high: { score: 0.7, margin: 0.2 },
  medium: { score: 0.5, margin: 0.08 },
} as const;

/** How far the position may move and still count as carrying on. */
export const CONTINUES = { back: 1, forward: 2 } as const;

/** Agreeing windows needed before the screen jumps somewhere unrelated. */
export const CORROBORATION = 2;

/**
 * ...and how long they must keep agreeing.
 *
 * Counting windows alone stopped meaning anything once the loop sped up. At
 * the old ~1200 ms cadence two agreeing windows were 2.4 s of evidence; at
 * 250 ms they are 0.5 s, and the same rule silently became four times more
 * willing to jump. Evidence for moving the screen should be measured in
 * seconds of chanting, not in units of however fast the model happens to run.
 */
export const CORROBORATION_MS = 800;

/** Consecutive poor windows before a lock is given up... */
export const PATIENCE = 4;

/** ...and how long they must go on for, for the same reason. */
export const PATIENCE_MS = 2000;

/** Quiet for this long and the session is over rather than paused. */
export const IDLE_AFTER_SILENT_MS = 8000;

export type ClassifyOptions = {
  /**
   * True when the result points where we already are.
   *
   * Margin is then not evidence about anything. Its definition is "how well
   * does this window fit somewhere a jump would be visible" — and staying put
   * takes no jump, so the risk it measures is not being run. Requiring it
   * anyway froze the display at the end of every line, because the last
   * window of a line is both the weakest and the one most likely to look like
   * the end of some other line: the tail of the real recording scores 0.65
   * with a margin of 0.06 and is entirely correct.
   *
   * Score still has to clear the same bar, so noise — which matched a line at
   * 0.17 — is refused either way.
   */
  continuing?: boolean;
};

export function classify(
  result: MatchResult | null,
  { continuing = false }: ClassifyOptions = {},
): Confidence {
  if (!result) return "low";
  const { score, margin } = result;
  const enough = (bar: { score: number; margin: number }) =>
    score >= bar.score && (continuing || margin >= bar.margin);

  if (enough(THRESHOLDS.high)) return "high";
  if (enough(THRESHOLDS.medium)) return "medium";
  return "low";
}

export type FollowState = {
  /**
   * idle      — nothing to show; not listening, or quiet long enough to stop.
   * searching — hearing chanting, no position worth committing to yet.
   * locked    — a position is on screen.
   */
  kind: "idle" | "searching" | "locked";
  /** The line being shown. Survives silence and poor windows while locked. */
  lineIndex: number | null;
  /** 0..1 through that line, for the scroll to aim at. */
  progress: number;
  confidence: Confidence | null;
  /** True while locked but living off an old result. */
  holding: boolean;
  /** Consecutive windows that said nothing useful. */
  misses: number;
  /** A distant position waiting to be confirmed, and since when. */
  candidate: { lineIndex: number; agreements: number; since: number } | null;
  /**
   * Someone put this position here by hand, and the audio has not yet agreed.
   *
   * A correction the next window silently undoes is worse than no correction at
   * all — the reader taps a line, sees it take, and half a second later the
   * screen is somewhere else with no explanation. So while this is set, the
   * "high confidence goes immediately" shortcut is suspended and a distant
   * result has to corroborate like any other. It is not a lock: persistent
   * disagreement from the audio still wins, because the alternative is a screen
   * that can be stranded by a mis-tap.
   *
   * Cleared the moment any result is accepted — including one that simply
   * continues from here, which is the audio saying "yes, that is where you are".
   */
  pinned: boolean;
  /** When the current run of useless windows began. */
  missingSince: number | null;
  /** Clock reading of the last accepted position. */
  updatedAt: number;
  /** Clock reading of the last window that was not silence. */
  heardAt: number;
};

export const INITIAL: FollowState = {
  kind: "idle",
  lineIndex: null,
  progress: 0,
  confidence: null,
  holding: false,
  misses: 0,
  candidate: null,
  missingSince: null,
  updatedAt: 0,
  heardAt: 0,
  pinned: false,
};

/**
 * Put the position somewhere by hand, and mean it.
 *
 * Requirement 1.6: the user must be able to correct the app. This is the only
 * input to the reducer that does not come from the audio, so it is the only one
 * allowed to overrule it — see `pinned`.
 */
export function pin(state: FollowState, lineIndex: number, at: number): FollowState {
  return {
    ...state,
    kind: "locked",
    lineIndex,
    progress: 0,
    confidence: "high",
    holding: !state.heardAt,
    misses: 0,
    candidate: null,
    missingSince: null,
    updatedAt: at,
    // A tap is a sign of life. Without this the position keeps whatever
    // heardAt it had — nothing, if the session has not started — and the very
    // next silent window reads as "quiet for eight seconds" and throws the
    // hand-placed position away before anyone has chanted a syllable.
    heardAt: at,
    pinned: true,
  };
}

function continues(from: number | null, to: number): boolean {
  if (from === null) return false;
  const delta = to - from;
  // Backwards by one is normal: lines get repeated, and a window straddling a
  // boundary can report either side.
  return delta >= -CONTINUES.back && delta <= CONTINUES.forward;
}

function accept(
  state: FollowState,
  result: MatchResult,
  confidence: Confidence,
  at: number,
  progress: number,
): FollowState {
  return {
    ...state,
    kind: "locked",
    lineIndex: result.lineIndex,
    progress,
    confidence,
    holding: false,
    misses: 0,
    candidate: null,
    missingSince: null,
    updatedAt: at,
    heardAt: at,
    // Any accepted result settles the question the pin was holding open.
    pinned: false,
  };
}

/**
 * Fold one window's result into the display state.
 *
 * `progress` is passed in rather than recomputed so this module never needs
 * the flattened chant, which keeps it a pure function of its inputs.
 */
export function follow(
  state: FollowState,
  tick: TrackerTick,
  progress = 0,
): FollowState {
  if (tick.state === "filling") {
    // Startup, or a buffer that has just been cleared. Nothing has gone wrong
    // and nothing has been learned.
    return state.kind === "idle" ? state : { ...state, holding: true };
  }

  if (tick.state === "silent") {
    // A pause between lines is normal and must not clear the screen. Only a
    // long quiet means the session has actually ended.
    if (state.kind === "locked" || state.kind === "searching") {
      if (tick.at - state.heardAt >= IDLE_AFTER_SILENT_MS) {
        return { ...INITIAL, kind: "idle" };
      }
      return { ...state, holding: true };
    }
    return state;
  }

  const result = tick.result;
  const carryingOn =
    state.kind === "locked" &&
    result !== null &&
    continues(state.lineIndex, result.lineIndex);
  const confidence = classify(result, { continuing: carryingOn });

  if (!result || confidence === "low") {
    const misses = state.misses + 1;
    const missingSince = state.missingSince ?? tick.at;
    if (state.kind !== "locked") {
      // Hearing something, making no sense of it. Say so rather than
      // pretending to a position.
      return {
        ...state,
        kind: misses >= CORROBORATION ? "searching" : state.kind,
        misses,
        missingSince,
        candidate: null,
        heardAt: tick.at,
      };
    }
    // Locked. Hold the line rather than blanking on a bad window — a dropped
    // phrase, a cough, someone turning a page. Give up only after PATIENCE of
    // them in a row.
    if (misses >= PATIENCE && tick.at - missingSince >= PATIENCE_MS) {
      return {
        ...state,
        kind: "searching",
        confidence: null,
        holding: true,
        misses,
        missingSince,
        candidate: null,
        heardAt: tick.at,
      };
    }
    return { ...state, holding: true, misses, missingSince, heardAt: tick.at };
  }

  // From here the window is worth something.
  if (carryingOn) {
    // Carrying on from where we were. This is the common case and it needs no
    // corroboration — demanding any would make the screen lag a line behind
    // for the entire recitation.
    return accept(state, result, confidence, tick.at, progress);
  }

  if (confidence === "high" && !state.pinned) {
    // Unambiguous and well-scored. Requirement 1.7's "high confidence:
    // highlight and scroll automatically" — including when it means jumping,
    // which is what makes recovering from a lost position possible at all.
    //
    // Suspended while pinned. A hand-placed position that one confident window
    // can undo is not a correction, it is a suggestion — and the window right
    // after a tap is the *least* trustworthy one, because the five seconds it
    // describes are mostly the line the reader has just left.
    return accept(state, result, confidence, tick.at, progress);
  }

  // Medium confidence, somewhere else. This is exactly the case that must not
  // move the screen on one window's say-so. Hold the position and wait for a
  // second window to agree.
  const carried =
    state.candidate && continues(state.candidate.lineIndex, result.lineIndex)
      ? state.candidate
      : null;
  const agreements = carried ? carried.agreements + 1 : 1;
  const since = carried ? carried.since : tick.at;

  if (agreements >= CORROBORATION && tick.at - since >= CORROBORATION_MS) {
    return accept(state, result, confidence, tick.at, progress);
  }

  return {
    ...state,
    holding: state.kind === "locked",
    misses: 0,
    missingSince: null,
    candidate: { lineIndex: result.lineIndex, agreements, since },
    heardAt: tick.at,
  };
}

/** What to tell the user, in their words rather than the machine's. */
export function statusLine(state: FollowState): string {
  switch (state.kind) {
    case "idle":
      return "Not listening.";
    case "searching":
      return "Locating chanting position…";
    case "locked":
      return state.holding ? "Holding position…" : "Following.";
  }
}

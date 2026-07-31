"use client";

// One line of the chant, rendered the same way everywhere it appears.
//
// The romanised text is the primary reading line and the Devanagari sits
// under it. That is a decision about who is chanting rather than about
// typography: someone who reads Devanagari fluently does not need this screen,
// and someone who does not needs the sounds in front of them, large, at the
// speed the chant moves.
//
// It is IAST, with the macrons and dots, because that is what the source
// edition prints beneath its own Devanagari — and because the diacritics are
// not decoration here. "bāhu" and "bahu" are different lengths of vowel, and
// vowel length is most of the rhythm of a chant.

import type { ChantLine } from "@/lib/chant/chant";

/** System Devanagari, in the order these platforms actually have it. */
export const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", ' +
  '"Nirmala UI", "Mangal", serif';

export type ChantLineViewProps = {
  line: ChantLine;
  /** The line the matcher is currently reporting. */
  active?: boolean;
  /** Touched by the matched window, but not the line itself. */
  inSpan?: boolean;
  /** 0..1, drawn as a rule under an active line. */
  progress?: number;
  showNormalized?: boolean;
  /** Compact spacing, for the dense harness lists. */
  dense?: boolean;
};

export default function ChantLineView({
  line,
  active = false,
  inSpan = false,
  progress,
  showNormalized = false,
  dense = false,
}: ChantLineViewProps) {
  return (
    <li
      className={`flex gap-3 rounded px-2 py-1 ${
        active ? "bg-emerald-950/40" : inSpan ? "bg-neutral-900" : ""
      }`}
    >
      <span className="w-6 shrink-0 pt-1.5 text-right font-mono text-xs text-neutral-600">
        {line.sequence}
      </span>

      <div className="min-w-0 flex-1">
        <p
          lang="sa-Latn"
          className={`${dense ? "text-lg" : "text-xl"} leading-snug ${
            active ? "text-neutral-50" : "text-neutral-300"
          }`}
        >
          {line.transliteration}
        </p>

        <p
          lang="sa"
          className={`mt-0.5 ${dense ? "text-sm" : "text-base"} leading-loose ${
            active ? "text-neutral-400" : "text-neutral-600"
          }`}
          style={{ fontFamily: DEVANAGARI_STACK }}
        >
          {line.devanagari}
        </p>

        {line.meaning ? (
          <p className="mt-1 text-sm leading-relaxed text-neutral-500">
            {line.meaning}
          </p>
        ) : null}

        {showNormalized ? (
          <p className="mt-1 break-all font-mono text-xs leading-relaxed text-emerald-800">
            {line.normalized}
          </p>
        ) : null}

        {active && progress !== undefined ? (
          <span
            className="mt-1.5 block h-0.5 rounded-full bg-emerald-600/70"
            style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }}
          />
        ) : null}
      </div>
    </li>
  );
}

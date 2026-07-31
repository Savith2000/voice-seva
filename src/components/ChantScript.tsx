"use client";

import { useMemo, useState } from "react";

import { chant } from "@/lib/chant/chant-data";
import { allLines, flatten } from "@/lib/chant/chant";
import { cer } from "@/lib/chant/normalize";

/**
 * Chunk 4's instrument: does the imported chant render?
 *
 * The thing to actually look at is the svara marks — the vertical stroke above
 * a syllable and the bar below it. They are combining characters, so a font
 * without proper Devanagari support drops them silently or parks them on the
 * wrong letter, and the text still looks like plausible Sanskrit.
 *
 * The normalised column is the other half. It is what the matcher compares
 * against, and seeing it beside the source is the quickest way to notice a
 * rule doing something unintended to real text rather than to test strings.
 */

/** System Devanagari, in the order these platforms actually have it. */
const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", ' +
  '"Nirmala UI", "Mangal", serif';

export default function ChantScript() {
  const [showNormalized, setShowNormalized] = useState(false);
  const lines = useMemo(() => allLines(chant), []);

  // The counterpart to consistency: if two lines look the same after
  // normalisation, no amount of model stability can separate them.
  const closest = useMemo(() => {
    let worst = { a: 0, b: 0, score: 1 };
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const score = cer(lines[i].normalized, lines[j].normalized);
        if (score < worst.score) {
          worst = { a: lines[i].sequence, b: lines[j].sequence, score };
        }
      }
    }
    return worst;
  }, [lines]);

  const flat = useMemo(() => flatten(chant), []);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          Chunk 4 &middot; chant script
        </p>
        <button
          type="button"
          onClick={() => setShowNormalized((on) => !on)}
          className="rounded border border-neutral-700 px-3 py-1 font-mono text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
        >
          {showNormalized ? "hide" : "show"} normalised
        </button>
      </div>

      <p className="font-mono text-xs leading-relaxed text-neutral-600">
        {chant.name.english} &middot; {lines.length} lines,{" "}
        {flat.text.length} normalised characters &middot; closest pair{" "}
        <span className="text-neutral-400">{closest.score.toFixed(3)}</span>{" "}
        (lines {closest.a}/{closest.b}), against the model&apos;s own 0.095
        stability
        <br />
        source: {chant.source.edition}
      </p>

      <ol className="flex flex-col gap-4">
        {lines.map((line) => (
          <li key={line.sequence} className="flex gap-3">
            <span className="w-8 shrink-0 pt-2 text-right font-mono text-xs text-neutral-600">
              {line.sequence}
            </span>
            <div className="min-w-0 flex-1">
              <p
                lang="sa"
                className="text-xl leading-loose text-neutral-100"
                style={{ fontFamily: DEVANAGARI_STACK }}
              >
                {line.devanagari}
              </p>
              <p className="mt-1 text-sm italic leading-relaxed text-neutral-400">
                {line.transliteration}
              </p>
              {line.meaning ? (
                <p className="mt-1 text-sm leading-relaxed text-neutral-500">
                  {line.meaning}
                </p>
              ) : null}
              {showNormalized ? (
                <p className="mt-1 break-all font-mono text-xs leading-relaxed text-emerald-700">
                  {line.normalized}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

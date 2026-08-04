"use client";

import { useMemo, useState } from "react";

import ChantLineView from "@/components/ChantLineView";
import { chant } from "@/lib/chant/chant-data";
import { allLines, flatten } from "@/lib/chant/chant";
import { closestPair } from "@/lib/chant/closest-pair";

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

export default function ChantScript() {
  const [showNormalized, setShowNormalized] = useState(false);
  const lines = useMemo(() => allLines(chant), []);

  // The counterpart to consistency: if two lines look the same after
  // normalisation, no amount of model stability can separate them.
  //
  // The nested loop this replaced was fine at one anuvaka's 33 lines and is not
  // at 303 — 45,753 Levenshtein matrices on mount, which the page wore as a
  // visible hitch. closestPair prunes with length and q-gram bounds that are
  // exact, so the answer is unchanged; see closest-pair.ts.
  const closest = useMemo(() => {
    const found = closestPair(lines.map((line) => line.normalized));
    if (!found) return null;
    return {
      a: lines[found.a].sequence,
      b: lines[found.b].sequence,
      score: found.score,
      compared: found.compared,
      total: found.total,
    };
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
        {chant.name.english} &middot; {chant.anuvakas.length} sections,{" "}
        {lines.length} lines, {flat.text.length} normalised characters
        {closest ? (
          <>
            {" "}
            &middot; closest pair{" "}
            <span className="text-neutral-400">{closest.score.toFixed(3)}</span>{" "}
            (lines {closest.a}/{closest.b}, measured{" "}
            {closest.compared.toLocaleString()} of{" "}
            {closest.total.toLocaleString()} pairs), against the model&apos;s own
            0.095 stability
          </>
        ) : null}
        <br />
        source: {chant.source.edition}
      </p>

      <ol className="flex flex-col gap-4">
        {lines.map((line) => (
          <ChantLineView
            key={line.sequence}
            line={line}
            showNormalized={showNormalized}
          />
        ))}
      </ol>
    </section>
  );
}

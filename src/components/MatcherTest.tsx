"use client";

import { useMemo, useState } from "react";

import { flatten } from "@/lib/chant/chant";
import { chant } from "@/lib/chant/chant-data";
import { match, progressThroughLine } from "@/lib/chant/matcher";

/**
 * Chunk 5's instrument: the matcher, driven by a text box instead of a
 * microphone.
 *
 * Typing is the point. Audio brings its own failures — a bad window, a quiet
 * room, a model warming up — and debugging the matcher through all that is
 * how a search bug gets mistaken for a recognition bug. Here the input is
 * exact and repeatable, so anything that goes wrong is the matcher's.
 *
 * The presets are real vak-san output from tools/asr-bakeoff, not text anyone
 * typed by hand, so what you see is what the model actually produces.
 */

const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", ' +
  '"Nirmala UI", "Mangal", serif';

type Preset = { label: string; text: string; note: string };

const PRESETS: Preset[] = [
  {
    label: "real · 0–5s",
    text: "तेरुध्रमन्यव उत्तोत् ईशवेनमः नमस्ते",
    note: "vak-san on Rudram Test 1, first window — straddles lines 2 and 3",
  },
  {
    label: "real · 5–10s",
    text: "ते अश्तु धन्वने बाहोभ्याभुत्",
    note: "the same take, five seconds later",
  },
  {
    label: "real · 7–12s",
    text: "बाहोभ्याभुद्बुथतेनमः",
    note: "end of the recording — degraded, and the margin says so",
  },
  {
    label: "ambiguous",
    text: "बभूव ते धनुः",
    note: "ends both line 4 and line 27; perfect score, zero margin",
  },
  {
    label: "unique",
    text: "मृत्युञ्जयाय सर्वेश्वराय",
    note: "occurs once, deep in the closing salutation",
  },
  {
    label: "noise",
    text: "अअअअअअअअअअअअ",
    note: "Devanagari that means nothing",
  },
];

function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <span className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-neutral-800 align-middle">
      <span
        className={`block h-full rounded-full ${tone}`}
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </span>
  );
}

export default function MatcherTest() {
  const [text, setText] = useState(PRESETS[0].text);
  const flat = useMemo(() => flatten(chant), []);
  const result = useMemo(() => match(text, flat), [text, flat]);

  const progress = result ? progressThroughLine(result, flat) : 0;
  const runnerUpLine = result?.runnerUp
    ? flat.lines[result.runnerUp.lineIndex].sequence
    : null;

  // A few lines either side, so a wrong answer is visible as a wrong answer
  // rather than as a number.
  const context = useMemo(() => {
    if (!result) return [];
    const from = Math.max(0, result.lineIndex - 2);
    return flat.lines.slice(from, result.lineIndex + 3);
  }, [result, flat]);

  return (
    <section className="flex flex-col gap-4">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
        Chunk 5 &middot; matcher
      </p>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            title={preset.note}
            onClick={() => setText(preset.text)}
            className="rounded border border-neutral-700 px-2.5 py-1 font-mono text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-100"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        spellCheck={false}
        lang="sa"
        placeholder="type or paste a transcript…"
        className="w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-lg leading-relaxed text-neutral-100 outline-none focus:border-neutral-600"
        style={{ fontFamily: DEVANAGARI_STACK }}
      />

      {result === null ? (
        <p className="font-mono text-xs text-neutral-600">
          normalises to nothing &mdash; no position reported
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-neutral-500">
            <span>
              line{" "}
              <span className="text-neutral-100">{result.line.sequence}</span>
              <span className="text-neutral-700"> / {flat.lines.length}</span>
            </span>
            <span className="flex items-center gap-2">
              score <Bar value={result.score} tone="bg-emerald-500" />
              <span className="text-neutral-300">{result.score.toFixed(2)}</span>
            </span>
            <span className="flex items-center gap-2">
              margin{" "}
              <Bar
                value={result.margin}
                tone={result.margin < 0.15 ? "bg-amber-500" : "bg-sky-500"}
              />
              <span className="text-neutral-300">{result.margin.toFixed(2)}</span>
            </span>
            {runnerUpLine !== null ? (
              <span>
                rival line{" "}
                <span className="text-neutral-300">{runnerUpLine}</span> @{" "}
                {result.runnerUp!.score.toFixed(2)}
              </span>
            ) : null}
            <span>
              {Math.round(progress * 100)}% through the line
            </span>
          </div>

          <p className="break-all font-mono text-xs leading-relaxed text-neutral-700">
            searched for: {result.query}
          </p>

          <ol className="flex flex-col gap-2">
            {context.map((line) => {
              const isMatch = line.sequence === result.line.sequence;
              const inSpan = result.spanLines.some(
                (i) => flat.lines[i].sequence === line.sequence,
              );
              return (
                <li
                  key={line.sequence}
                  className={`flex gap-3 rounded px-2 py-1 ${
                    isMatch
                      ? "bg-emerald-950/40"
                      : inSpan
                        ? "bg-neutral-900"
                        : ""
                  }`}
                >
                  <span className="w-6 shrink-0 pt-1 text-right font-mono text-xs text-neutral-600">
                    {line.sequence}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      lang="sa"
                      className={`text-lg leading-loose ${
                        isMatch ? "text-neutral-50" : "text-neutral-500"
                      }`}
                      style={{ fontFamily: DEVANAGARI_STACK }}
                    >
                      {line.devanagari}
                    </p>
                    {isMatch ? (
                      <span className="mt-1 block h-0.5 rounded-full bg-emerald-600/70" style={{ width: `${Math.round(progress * 100)}%` }} />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

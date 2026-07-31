"use client";

// Chunk 6's instrument: microphone, model and matcher wired end to end.
//
// This shows the matcher's *raw* answer, deliberately — no state machine, no
// refusal to jump, no holding through a bad window. That is what makes it an
// instrument rather than a worse copy of the chanting screen: when the real
// screen misbehaves, this is where you find out whether the matcher was wrong
// or the state machine was being sensible about a matcher that was right.
//
// It shares its audio and model plumbing with the real screen through
// useAsrSession, so the two cannot drift into reproducing different bugs.

import { useCallback, useMemo, useState } from "react";

import ChantLineView, { DEVANAGARI_STACK } from "@/components/ChantLineView";
import { flatten } from "@/lib/chant/chant";
import { chant } from "@/lib/chant/chant-data";
import { progressThroughLine } from "@/lib/chant/matcher";
import { useAsrSession } from "@/lib/chant/use-asr-session";
import type { TrackerTick } from "@/lib/chant/tracker";

type Live = {
  state: TrackerTick["state"];
  lineIndex: number | null;
  progress: number;
  transcript: string;
  score: number;
  margin: number;
  rivalLine: number | null;
  inferenceMs: number;
  windows: number;
  startedAt: number;
  elapsedMs: number;
};

const ZERO: Live = {
  state: "filling",
  lineIndex: null,
  progress: 0,
  transcript: "",
  score: 0,
  margin: 0,
  rivalLine: null,
  inferenceMs: 0,
  windows: 0,
  startedAt: 0,
  elapsedMs: 0,
};

export default function TrackingTest() {
  const [live, setLive] = useState<Live>(ZERO);
  const flat = useMemo(() => flatten(chant), []);

  const session = useAsrSession(
    flat,
    useCallback(
      (tick: TrackerTick) => {
        setLive((previous) => {
          const startedAt = previous.startedAt || tick.at;
          const base = {
            ...previous,
            startedAt,
            state: tick.state,
            elapsedMs: tick.at - startedAt,
          };
          if (tick.state !== "matched") return base;
          const result = tick.result;
          return {
            ...base,
            windows: previous.windows + 1,
            transcript: tick.transcript,
            inferenceMs: tick.inferenceMs,
            // A miss keeps the previous line on screen rather than blanking
            // it. Deciding when to actually give up is the state machine's
            // job, and it is not in this panel on purpose.
            lineIndex: result ? result.lineIndex : previous.lineIndex,
            progress: result ? progressThroughLine(result, flat) : previous.progress,
            score: result ? result.score : 0,
            margin: result ? result.margin : 0,
            rivalLine: result?.runnerUp
              ? flat.lines[result.runnerUp.lineIndex].sequence
              : null,
          };
        });
      },
      [flat],
    ),
  );

  const running = session.phase.kind === "running";
  const starting = session.phase.kind === "starting";

  const context = useMemo(() => {
    if (live.lineIndex === null) return [];
    const from = Math.max(0, live.lineIndex - 2);
    return flat.lines.slice(from, live.lineIndex + 3);
  }, [live.lineIndex, flat]);

  const rate = live.elapsedMs > 0 ? (live.windows / live.elapsedMs) * 1000 : 0;

  const begin = (source: "mic" | File) => {
    setLive(ZERO);
    void session.start(source);
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-800 p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
        Chunk 6 &middot; live tracking (raw)
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={
            running || starting ? () => void session.stop() : () => begin("mic")
          }
          disabled={starting}
          className="rounded border border-neutral-700 px-4 py-2 font-mono text-xs uppercase tracking-widest text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
        >
          {running
            ? "stop"
            : starting
              ? session.phase.kind === "starting"
                ? session.phase.step
                : "starting"
              : "start chanting"}
        </button>

        <label className="cursor-pointer rounded border border-neutral-800 px-3 py-2 font-mono text-xs uppercase tracking-widest text-neutral-400 hover:border-neutral-600 hover:text-neutral-200">
          replay a file
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) begin(file);
            }}
          />
        </label>

        {running && session.phase.kind === "running" ? (
          <span className="font-mono text-xs text-neutral-500">
            {session.phase.device} &middot; {live.state}
            {live.windows > 0 ? (
              <>
                {" "}
                &middot; {live.inferenceMs.toFixed(0)} ms/window &middot;{" "}
                {rate.toFixed(2)}/s &middot; {session.dropped} frames dropped
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {session.phase.kind === "failed" ? (
        <p className="font-mono text-xs leading-relaxed text-red-400">
          {session.phase.message}
        </p>
      ) : null}

      {live.windows > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-neutral-500">
          <span>
            line{" "}
            <span className="text-neutral-100">
              {live.lineIndex === null ? "—" : flat.lines[live.lineIndex].sequence}
            </span>
          </span>
          <span>
            score <span className="text-neutral-300">{live.score.toFixed(2)}</span>
          </span>
          <span>
            margin{" "}
            <span
              className={live.margin < 0.15 ? "text-amber-400" : "text-neutral-300"}
            >
              {live.margin.toFixed(2)}
            </span>
          </span>
          {live.rivalLine !== null ? <span>rival {live.rivalLine}</span> : null}
        </div>
      ) : null}

      {live.transcript ? (
        <p
          lang="sa"
          className="break-words text-sm leading-relaxed text-neutral-500"
          style={{ fontFamily: DEVANAGARI_STACK }}
        >
          heard: {live.transcript}
        </p>
      ) : null}

      {context.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {context.map((line) => (
            <ChantLineView
              key={line.sequence}
              line={line}
              dense
              active={flat.lines.indexOf(line) === live.lineIndex}
              progress={
                flat.lines.indexOf(line) === live.lineIndex
                  ? live.progress
                  : undefined
              }
            />
          ))}
        </ol>
      ) : null}

      <p className="font-mono text-xs leading-relaxed text-neutral-600">
        Raw matcher output, one window a second &mdash; it will jitter and
        sometimes jump. The chanting screen at{" "}
        <a href="/chant" className="text-neutral-400 underline">
          /chant
        </a>{" "}
        runs the same pipeline through the confidence state machine, which is
        what stops it acting on results like these.
      </p>
    </section>
  );
}

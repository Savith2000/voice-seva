"use client";

// Chunk 6's instrument: microphone, model and matcher wired end to end.
//
// Everything before this was testable in isolation. This is the first thing
// that can only be judged by chanting at it — the numbers to watch are the
// rate (how often a window actually completes) and the dropped count (how many
// arrived while the model was still busy). Together they say whether the
// design holds at ~885 ms per window, or whether Chunk 7's calibration and a
// smaller dtype become necessary.
//
// The highlighted line does not scroll and does not refuse to move on a weak
// match. Those are Chunks 9 and 8. Here it follows the raw matcher output, so
// what you see is what the matcher actually said, jitter included.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MicCapture } from "@/lib/audio/capture";
import { flatten } from "@/lib/chant/chant";
import { chant } from "@/lib/chant/chant-data";
import { progressThroughLine } from "@/lib/chant/matcher";
import { SlidingWindowTracker, type TrackerTick } from "@/lib/chant/tracker";
import type { AsrMessage, AsrRequest } from "@/workers/asr.worker";

const DEVANAGARI_STACK =
  '"Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", ' +
  '"Nirmala UI", "Mangal", serif';

const SAMPLE_RATE = 16_000;
/** What the capture worklet delivers, so a replay looks the same to the tracker. */
const FRAME_SAMPLES = 1024;

/**
 * Feed a recording to the tracker at the speed it was recorded.
 *
 * A microphone cannot hand two runs the same input, which makes every
 * regression here a matter of opinion. Replaying a file gives the loop
 * identical audio every time — and it is the only way to watch the line
 * follow along without chanting into the laptop.
 *
 * Paced rather than dumped in at once: the whole question this chunk answers
 * is how the loop behaves when audio arrives faster than the model consumes
 * it, and a single push would skip straight past it.
 */
async function replayFile(
  file: File,
  onFrame: (samples: Float32Array) => void,
): Promise<() => void> {
  // Decoding through a 16 kHz context resamples in native code, exactly as
  // MicCapture does, rather than hand-rolling a decimator that would alias.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const samples = decoded.getChannelData(0);

    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= samples.length) {
        clearInterval(timer);
        return;
      }
      const end = Math.min(offset + FRAME_SAMPLES, samples.length);
      onFrame(samples.slice(offset, end));
      offset = end;
    }, (FRAME_SAMPLES / SAMPLE_RATE) * 1000);

    return () => {
      clearInterval(timer);
      void ctx.close();
    };
  } catch (error) {
    await ctx.close();
    throw error;
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; step: string }
  | { kind: "running"; device: string }
  | { kind: "failed"; message: string };

type Live = {
  state: TrackerTick["state"];
  lineIndex: number | null;
  progress: number;
  transcript: string;
  score: number;
  margin: number;
  rivalLine: number | null;
  inferenceMs: number;
  rms: number;
  windows: number;
  dropped: number;
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
  rms: 0,
  windows: 0,
  dropped: 0,
  elapsedMs: 0,
};

export default function TrackingTest() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [live, setLive] = useState<Live>(ZERO);

  const flat = useMemo(() => flatten(chant), []);
  const workerRef = useRef<Worker | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const trackerRef = useRef<SlidingWindowTracker | null>(null);
  const pendingRef = useRef(
    new Map<number, (value: { text: string; inferenceMs: number }) => void>(),
  );
  const rejectRef = useRef(new Map<number, (reason: Error) => void>());
  const nextIdRef = useRef(1);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const stop = useCallback(async () => {
    trackerRef.current?.stop();
    trackerRef.current = null;

    // Anything still in flight will never be answered now.
    for (const reject of rejectRef.current.values()) {
      reject(new Error("session ended"));
    }
    pendingRef.current.clear();
    rejectRef.current.clear();

    replayRef.current?.();
    replayRef.current = null;

    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();

    workerRef.current?.terminate();
    workerRef.current = null;

    if (mountedRef.current) setPhase({ kind: "idle" });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void stop();
    };
  }, [stop]);

  const start = useCallback(async (source: "mic" | File) => {
    setLive(ZERO);
    setPhase({ kind: "starting", step: "loading model" });

    try {
      const worker = new Worker(
        new URL("../workers/asr.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;

      const ready = new Promise<string>((resolve, reject) => {
        const onMessage = (event: MessageEvent<AsrMessage>) => {
          const message = event.data;
          if (message.type === "ready") {
            resolve(message.device);
            return;
          }
          if (message.type === "result") {
            pendingRef.current.get(message.id)?.({
              text: message.text,
              inferenceMs: message.inferenceMs,
            });
            pendingRef.current.delete(message.id);
            rejectRef.current.delete(message.id);
            return;
          }
          // An error with no id is a load failure and ends the session; one
          // with an id is a single bad window, which the tracker shrugs off.
          if (message.id === undefined) {
            reject(new Error(message.message));
          } else {
            rejectRef.current.get(message.id)?.(new Error(message.message));
            pendingRef.current.delete(message.id);
            rejectRef.current.delete(message.id);
          }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", (event) =>
          reject(new Error(event.message || "worker failed")),
        );
        worker.postMessage({ type: "load", device: "auto" } satisfies AsrRequest);
      });

      const device = await ready;
      if (!mountedRef.current || !workerRef.current) return;

      setPhase({
        kind: "starting",
        step: source === "mic" ? "opening microphone" : "decoding file",
      });

      const transcribe = (samples: Float32Array) =>
        new Promise<{ text: string; inferenceMs: number }>((resolve, reject) => {
          const id = nextIdRef.current++;
          pendingRef.current.set(id, resolve);
          rejectRef.current.set(id, reject);
          // Transferred rather than copied: 320 KB per window, once a second,
          // and the tracker never looks at the array again.
          worker.postMessage({ type: "transcribe", id, samples } satisfies AsrRequest, [
            samples.buffer,
          ]);
        });

      const tracker = new SlidingWindowTracker(flat, transcribe, (tick) => {
        if (!mountedRef.current) return;
        setLive((previous) => {
          const base = {
            ...previous,
            state: tick.state,
            rms: tick.rms,
            dropped: tracker.dropped,
            elapsedMs: performance.now() - startedAtRef.current,
          };
          if (tick.state !== "matched") return base;
          const result = tick.result;
          return {
            ...base,
            windows: previous.windows + 1,
            transcript: tick.transcript,
            inferenceMs: tick.inferenceMs,
            // A miss keeps the previous line on screen rather than blanking
            // it. Deciding when to actually give up is Chunk 8's job.
            lineIndex: result ? result.lineIndex : previous.lineIndex,
            progress: result ? progressThroughLine(result, flat) : previous.progress,
            score: result ? result.score : 0,
            margin: result ? result.margin : 0,
            rivalLine: result?.runnerUp
              ? flat.lines[result.runnerUp.lineIndex].sequence
              : null,
          };
        });
      });
      trackerRef.current = tracker;

      startedAtRef.current = performance.now();
      const push = (samples: Float32Array) => trackerRef.current?.push(samples);

      if (source === "mic") {
        const capture = await MicCapture.start(
          (frame) => push(frame.samples),
          () => {},
          { processing: false },
        );
        captureRef.current = capture;
        if (!mountedRef.current) {
          await capture.stop();
          return;
        }
      } else {
        const cancel = await replayFile(source, push);
        replayRef.current = cancel;
        if (!mountedRef.current) {
          cancel();
          return;
        }
      }

      setPhase({ kind: "running", device: `${device} · ${source === "mic" ? "mic" : source.name}` });
    } catch (error) {
      await stop();
      if (mountedRef.current) {
        setPhase({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [flat, stop]);

  const running = phase.kind === "running";
  const busy = phase.kind === "starting";

  const context = useMemo(() => {
    if (live.lineIndex === null) return [];
    const from = Math.max(0, live.lineIndex - 2);
    return flat.lines.slice(from, live.lineIndex + 3);
  }, [live.lineIndex, flat]);

  const rate =
    live.elapsedMs > 0 ? (live.windows / live.elapsedMs) * 1000 : 0;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-800 p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
        Chunk 6 &middot; live tracking
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={running || busy ? () => void stop() : () => void start("mic")}
          disabled={busy}
          className="rounded border border-neutral-700 px-4 py-2 font-mono text-xs uppercase tracking-widest text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
        >
          {running ? "stop" : busy ? phase.step : "start chanting"}
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
              if (file) void start(file);
            }}
          />
        </label>
        {running ? (
          <span className="font-mono text-xs text-neutral-500">
            {phase.device} &middot; {live.state}
            {live.windows > 0 ? (
              <>
                {" "}&middot; {live.inferenceMs.toFixed(0)} ms/window &middot;{" "}
                {rate.toFixed(2)}/s &middot; {live.dropped} frames dropped
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {phase.kind === "failed" ? (
        <p className="font-mono text-xs leading-relaxed text-red-400">
          {phase.message}
        </p>
      ) : null}

      {running && live.windows > 0 ? (
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

      {running && live.transcript ? (
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
          {context.map((line) => {
            const isMatch = flat.lines.indexOf(line) === live.lineIndex;
            return (
              <li
                key={line.sequence}
                className={`flex gap-3 rounded px-2 py-1 ${
                  isMatch ? "bg-emerald-950/40" : ""
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
                    <span
                      className="mt-1 block h-0.5 rounded-full bg-emerald-600/70"
                      style={{ width: `${Math.round(live.progress * 100)}%` }}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      <p className="font-mono text-xs leading-relaxed text-neutral-600">
        Raw matcher output, one window a second. It will jitter and it will
        sometimes jump &mdash; refusing to act on a weak match is Chunk 8, and
        scrolling calmly is Chunk 9.
      </p>
    </section>
  );
}

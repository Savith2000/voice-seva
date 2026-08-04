// One live listening session: worker, model, microphone, sliding window.
//
// Extracted so the harness panel and the real chanting screen run the *same*
// pipeline and differ only in what they do with the results — the harness
// shows raw matcher output, the screen folds it through the state machine. A
// second copy of this plumbing is how the two would quietly drift apart, and
// then a bug would reproduce in one and not the other.

import { useCallback, useEffect, useRef, useState } from "react";

import { MicCapture } from "../audio/capture.ts";
import { type FlatChant } from "./chant.ts";
import { SlidingWindowTracker, type TrackerTick } from "./tracker.ts";
import type { AsrMessage, AsrRequest } from "../../workers/asr.worker.ts";

const SAMPLE_RATE = 16_000;
/** What the capture worklet delivers, so a replay looks the same downstream. */
const FRAME_SAMPLES = 1024;

export type SessionSource = "mic" | File;

export type StartOptions = { deviceId?: string };

export type SessionPhase =
  | { kind: "idle" }
  | { kind: "starting"; step: string }
  | { kind: "running"; device: string; source: string }
  | { kind: "failed"; message: string };

export type LoadProgress = {
  loaded: number;
  total: number;
  /** 0..1, or null while the total size is still unknown. */
  fraction: number | null;
  file: string | null;
};

/**
 * Feed a recording to the tracker at the speed it was recorded.
 *
 * A microphone cannot hand two runs the same input, which makes every
 * regression a matter of opinion. Paced rather than pushed in at once,
 * because how the loop behaves when audio outruns the model is the entire
 * question — dumping the file in would skip straight past it.
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
    const timer = setInterval(
      () => {
        if (offset >= samples.length) {
          clearInterval(timer);
          return;
        }
        const end = Math.min(offset + FRAME_SAMPLES, samples.length);
        onFrame(samples.slice(offset, end));
        offset = end;
      },
      (FRAME_SAMPLES / SAMPLE_RATE) * 1000,
    );
    return () => {
      clearInterval(timer);
      void ctx.close();
    };
  } catch (error) {
    await ctx.close();
    throw error;
  }
}

/**
 * Turn a frame's RMS into something an eye can read.
 *
 * Raw RMS is unusable as a display value: chanting sits between roughly 0.02
 * and 0.2, so a linear 0..1 mapping leaves the needle pinned near the floor.
 * This lifts off the tracker's own silence threshold, compresses with a square
 * root so ordinary recitation uses the middle of the range rather than the
 * bottom, and then moves fast up and slow down.
 *
 * The asymmetry is the whole trick and it is borrowed from every level meter
 * ever built: attack quickly so a syllable registers the instant it lands,
 * release slowly so the mark settles between syllables instead of strobing at
 * fifteen hertz. Symmetric smoothing gives you either a jitter or a lag; there
 * is no value that gives you neither.
 */
const SILENCE = 0.005;
const FULL = 0.14;

function meter(previous: number, rms: number): number {
  const lifted = Math.max(0, rms - SILENCE) / (FULL - SILENCE);
  const target = Math.min(1, Math.sqrt(lifted));
  const rate = target > previous ? 0.55 : 0.12;
  return previous + (target - previous) * rate;
}

export function useAsrSession(
  flat: FlatChant,
  onTick: (tick: TrackerTick) => void,
) {
  const [phase, setPhase] = useState<SessionPhase>({ kind: "idle" });
  const [progress, setProgress] = useState<LoadProgress | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const replayRef = useRef<(() => void) | null>(null);
  const trackerRef = useRef<SlidingWindowTracker | null>(null);
  const resolversRef = useRef(
    new Map<
      number,
      {
        resolve: (value: { text: string; inferenceMs: number }) => void;
        reject: (reason: Error) => void;
      }
    >(),
  );
  const nextIdRef = useRef(1);
  const mountedRef = useRef(true);

  /**
   * How loud the room is right now, 0..1 — a ref, never state.
   *
   * Frames arrive about fifteen times a second. Putting this in state would
   * re-render a consumer holding three hundred lines of scripture fifteen times
   * a second, to move one small mark. So it is published as a mutable ref and
   * whoever wants it reads it from an animation frame and writes straight to
   * the DOM, which keeps React out of the loop entirely.
   */
  const levelRef = useRef(0);

  // Held in a ref so a re-render of the consumer does not tear down the
  // session just to install a new closure. Assigned in an effect rather than
  // during render, which React forbids.
  const tickRef = useRef(onTick);
  useEffect(() => {
    tickRef.current = onTick;
  }, [onTick]);

  const stop = useCallback(async () => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    levelRef.current = 0;

    // Anything still in flight will never be answered now.
    for (const { reject } of resolversRef.current.values()) {
      reject(new Error("session ended"));
    }
    resolversRef.current.clear();

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

  const start = useCallback(
    async (source: SessionSource, { deviceId }: StartOptions = {}) => {
      setPhase({ kind: "starting", step: "loading model" });
      setProgress(null);
      try {
        const worker = new Worker(
          new URL("../../workers/asr.worker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;

        const device = await new Promise<string>((resolve, reject) => {
          worker.addEventListener("message", (event: MessageEvent<AsrMessage>) => {
            const message = event.data;
            if (message.type === "ready") {
              resolve(message.device);
              return;
            }
            if (message.type === "progress") {
              if (mountedRef.current) {
                setProgress({
                  loaded: message.loaded,
                  total: message.total,
                  fraction: message.fraction,
                  file: message.file,
                });
              }
              return;
            }
            if (message.type === "result") {
              resolvers().get(message.id)?.resolve({
                text: message.text,
                inferenceMs: message.inferenceMs,
              });
              resolvers().delete(message.id);
              return;
            }
            // No id means the model failed to load, which ends the session.
            // With an id it is one bad window, which the tracker shrugs off.
            if (message.id === undefined) {
              reject(new Error(message.message));
            } else {
              resolvers().get(message.id)?.reject(new Error(message.message));
              resolvers().delete(message.id);
            }
          });
          // "worker failed" was all this used to say, and it is the least
          // useful sentence in the app: it fires for a module that would not
          // parse, a network fetch the browser refused, a backend that could
          // not initialise, and a genuine bug, and it distinguishes none of
          // them. On a device that cannot be attached to a debugger, that
          // sentence is the entire diagnosis.
          //
          // An ErrorEvent from a worker carries a filename and a line even when
          // `message` is empty — which is exactly what happens when the failure
          // is a cross-origin load the browser will not describe. Say so
          // explicitly rather than shrugging, because "blocked or unreachable"
          // points at a policy or a network and "message" points at code.
          worker.addEventListener("error", (event) => {
            const where = event.filename
              ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ""})`
              : "";
            const detail =
              event.message ||
              (event.error instanceof Error ? event.error.message : "") ||
              "the worker could not start — its script or one of its resources " +
                "was blocked or unreachable";
            reject(new Error(`${detail}${where}`));
          });
          // Fires when a posted message cannot be deserialised. Distinct from
          // "error", and silently dropping it turns a real fault into a hang.
          worker.addEventListener("messageerror", () =>
            reject(new Error("the worker sent a message that could not be read")),
          );
          worker.postMessage({ type: "load", device: "auto" } satisfies AsrRequest);
        });

        if (!mountedRef.current || workerRef.current !== worker) return;
        setProgress(null);

        setPhase({
          kind: "starting",
          step: source === "mic" ? "opening microphone" : "decoding file",
        });

        const transcribe = (samples: Float32Array) =>
          new Promise<{ text: string; inferenceMs: number }>((resolve, reject) => {
            const id = nextIdRef.current++;
            resolvers().set(id, { resolve, reject });
            // Transferred rather than copied: 320 KB a second, and the
            // tracker never looks at the array again.
            worker.postMessage(
              { type: "transcribe", id, samples } satisfies AsrRequest,
              [samples.buffer],
            );
          });

        const tracker = new SlidingWindowTracker(flat, transcribe, (tick) => {
          if (mountedRef.current) tickRef.current(tick);
        });
        trackerRef.current = tracker;

        const push = (samples: Float32Array) => trackerRef.current?.push(samples);

        if (source === "mic") {
          const capture = await MicCapture.start(
            (frame) => {
              levelRef.current = meter(levelRef.current, frame.rms);
              push(frame.samples);
            },
            () => {},
            { processing: false, deviceId },
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

        setPhase({
          kind: "running",
          device,
          source: source === "mic" ? "microphone" : source.name,
        });
      } catch (error) {
        await stop();
        if (mountedRef.current) {
          setPhase({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      function resolvers() {
        return resolversRef.current;
      }
    },
    [flat, stop],
  );

  const setInView = useCallback((lines: Iterable<number> | null) => {
    trackerRef.current?.setInView(lines);
  }, []);

  return {
    phase,
    progress,
    start,
    stop,
    setInView,
    /** Live loudness, 0..1. Read it from an animation frame, not from render. */
    level: levelRef,
    get dropped() {
      return trackerRef.current?.dropped ?? 0;
    },
    /** Gap between window starts, after duty-cycle protection. */
    get intervalMs() {
      return trackerRef.current?.intervalMs ?? 0;
    },
    /** Share of wall-clock time the model is running, 0..1. */
    get dutyCycle() {
      return trackerRef.current?.dutyCycle ?? 0;
    },
  };
}

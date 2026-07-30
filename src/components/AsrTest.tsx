"use client";

// Chunk 2's instrument: load the model, transcribe one clip, show the text.
//
// Two things it deliberately reports that a user-facing screen never would —
// which backend the model got, and the realtime factor. Both decide whether
// Chunk 6's sliding window is feasible at all: a 5-second window transcribed
// every second needs inference well under a second, and the difference between
// WebGPU and WASM here is the difference between comfortable and marginal.

import { useCallback, useEffect, useRef, useState } from "react";

import { MicCapture, type CaptureFrame } from "@/lib/audio/capture";
import { RingBuffer } from "@/lib/audio/ring-buffer";
import type {
  AsrDevice,
  AsrMessage,
  AsrRequest,
  AsrResult,
} from "@/workers/asr.worker";

const SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = 5;

type Model =
  | { kind: "cold" }
  | { kind: "loading" }
  | { kind: "ready"; device: string; loadMs: number; fallbackReason?: string }
  | { kind: "failed"; message: string };

type Job =
  | { kind: "idle" }
  | { kind: "recording"; seconds: number }
  | { kind: "running" }
  | { kind: "done"; result: AsrResult }
  | { kind: "failed"; message: string };

export default function AsrTest() {
  const [model, setModel] = useState<Model>({ kind: "cold" });
  const [job, setJob] = useState<Job>({ kind: "idle" });

  const workerRef = useRef<Worker | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const ringRef = useRef<RingBuffer | null>(null);
  const jobIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Deferred, as in MlSmokeTest: the worker's own `error` event is already
    // async, so reporting the constructor's synchronous throw the same way keeps
    // both failure paths consistent and avoids a cascading render.
    const fail = (message: string) =>
      queueMicrotask(() => setModel({ kind: "failed", message }));

    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/asr.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    workerRef.current = worker;

    const onMessage = (event: MessageEvent<AsrMessage>) => {
      const message = event.data;
      if (message.type === "ready") {
        setModel({
          kind: "ready",
          device: message.device,
          loadMs: message.loadMs,
          fallbackReason: message.fallbackReason,
        });
      } else if (message.type === "result") {
        // Ignore a result for a job that has been superseded — otherwise a slow
        // first inference can land after a faster second one and overwrite it.
        if (message.id === jobIdRef.current) {
          setJob({ kind: "done", result: message });
        }
      } else {
        // A failure during load and a failure during inference are different
        // problems and belong in different places on screen.
        if (message.id === undefined) {
          setModel({ kind: "failed", message: message.message });
        } else if (message.id === jobIdRef.current) {
          setJob({ kind: "failed", message: message.message });
        }
      }
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", (event) =>
      setModel({ kind: "failed", message: event.message || "worker failed" }),
    );

    return () => {
      mountedRef.current = false;
      captureRef.current?.stop();
      captureRef.current = null;
      worker.removeEventListener("message", onMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const post = (request: AsrRequest, transfer?: Transferable[]) =>
    workerRef.current?.postMessage(request, transfer ?? []);

  const loadModel = useCallback((device: AsrDevice) => {
    setModel({ kind: "loading" });
    setJob({ kind: "idle" });
    post({ type: "load", device });
  }, []);

  const stopRecording = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;

    const ring = ringRef.current;
    if (!ring || ring.available === 0) {
      setJob({ kind: "failed", message: "no audio captured" });
      return;
    }

    setJob({ kind: "running" });
    const samples = ring.readLast(WINDOW_SECONDS * SAMPLE_RATE);
    jobIdRef.current += 1;
    // Transfer rather than copy: readLast already returned a private buffer, so
    // handing it over costs nothing and avoids duplicating 320 KB per window —
    // which matters once Chunk 6 does this every second for 45 minutes.
    post(
      { type: "transcribe", id: jobIdRef.current, samples },
      [samples.buffer],
    );
  }, []);

  // Transcribing a file matters more than it looks. It is the only way to run
  // the *same* audio through the browser and through the Python harness and
  // compare the transcripts — which is what proves the ONNX export behaves like
  // the model the gate was measured on. A microphone can never give two runs
  // the same input.
  const transcribeFile = useCallback(async (file: File) => {
    setJob({ kind: "running" });
    try {
      const bytes = await file.arrayBuffer();
      // Constructed at 16 kHz so decodeAudioData resamples through the same
      // native path the microphone capture uses. Decoding at 48 kHz and
      // downsampling by hand here would make this measurement disagree with
      // production for reasons that have nothing to do with the model.
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(bytes);
      } finally {
        await ctx.close();
      }

      const channel = decoded.getChannelData(0);
      // Skip the first 4 s, matching the harness's --from 4.0. Recordings
      // reliably open with a quiet lead-in, and near-silence is where character
      // error rate is most sensitive to nothing at all.
      const skip = channel.length > 9 * SAMPLE_RATE ? 4 * SAMPLE_RATE : 0;
      const samples = channel.slice(skip, skip + WINDOW_SECONDS * SAMPLE_RATE);

      jobIdRef.current += 1;
      post({ type: "transcribe", id: jobIdRef.current, samples }, [
        samples.buffer,
      ]);
    } catch (error) {
      setJob({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const record = useCallback(async () => {
    setJob({ kind: "recording", seconds: 0 });
    ringRef.current = new RingBuffer(WINDOW_SECONDS * SAMPLE_RATE);

    const onFrame = (frame: CaptureFrame) => {
      const ring = ringRef.current;
      if (!ring) return;
      ring.write(frame.samples);
      const seconds = ring.available / SAMPLE_RATE;
      setJob((current) =>
        current.kind === "recording" ? { kind: "recording", seconds } : current,
      );
      // Auto-stop at a full window. The model takes a fixed 5 seconds either
      // way, so recording longer would just silently discard the beginning.
      if (ring.available >= WINDOW_SECONDS * SAMPLE_RATE) stopRecording();
    };

    try {
      const capture = await MicCapture.start(onFrame, () => {});
      // start() is awaited, so the panel may have unmounted meanwhile. Without
      // this the microphone stays open with no way left to close it.
      if (!mountedRef.current) {
        capture.stop();
        return;
      }
      captureRef.current = capture;
    } catch (error) {
      setJob({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [stopRecording]);

  const busy = job.kind === "recording" || job.kind === "running";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-5 font-mono text-sm">
      <h2 className="mb-4 text-xs uppercase tracking-widest text-neutral-500">
        Chunk 2 · speech model
      </h2>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {(["webgpu", "wasm"] as const).map((device) => (
          <button
            key={device}
            type="button"
            onClick={() => loadModel(device)}
            disabled={model.kind === "loading" || busy}
            className={`rounded border px-4 py-2 text-xs uppercase tracking-widest transition disabled:opacity-40 ${
              model.kind === "ready" && model.device === device
                ? "border-emerald-700 text-emerald-400"
                : "border-neutral-700 hover:border-neutral-500"
            }`}
          >
            load · {device}
          </button>
        ))}
        <button
          type="button"
          onClick={record}
          disabled={model.kind !== "ready" || busy}
          className="rounded border border-neutral-700 px-4 py-2 text-xs uppercase tracking-widest transition hover:border-neutral-500 disabled:opacity-40"
        >
          chant 5s
        </button>
        <label
          className={`rounded border border-neutral-700 px-4 py-2 text-xs uppercase tracking-widest transition ${
            model.kind !== "ready" || busy
              ? "opacity-40"
              : "cursor-pointer hover:border-neutral-500"
          }`}
        >
          from file
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={model.kind !== "ready" || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset so picking the same file twice fires onChange again —
              // re-running one clip is the whole point of this control.
              event.target.value = "";
              if (file) void transcribeFile(file);
            }}
          />
        </label>
        {job.kind === "recording" && (
          <span className="text-amber-400">
            listening… {job.seconds.toFixed(1)}s / {WINDOW_SECONDS}s
          </span>
        )}
        {job.kind === "running" && (
          <span className="text-amber-400">transcribing…</span>
        )}
      </div>

      {model.kind === "cold" && (
        <p className="text-neutral-500">
          ~123 MB, cached by the browser after the first load.
        </p>
      )}
      {model.kind === "loading" && (
        <p className="text-amber-400">fetching and compiling the graph…</p>
      )}
      {model.kind === "failed" && (
        <div className="text-red-400">
          <p>✗ model failed to load</p>
          <p className="mt-1 break-words text-red-300/70">{model.message}</p>
          <p className="mt-2 text-neutral-500">
            If this is a 404: the weights are gitignored. Run{" "}
            <span className="text-neutral-400">
              uv run python export_onnx.py
            </span>{" "}
            in tools/asr-bakeoff.
          </p>
        </div>
      )}

      {model.kind === "ready" && (
        <dl className="space-y-2">
          <Row
            label="backend"
            value={model.device}
            good={model.device === "webgpu"}
          />
          <Row
            label="load time"
            value={`${(model.loadMs / 1000).toFixed(2)}s`}
            good
          />
          {model.fallbackReason && (
            <Row
              label="webgpu declined"
              value={model.fallbackReason}
              good={false}
            />
          )}
          {job.kind === "done" && (
            <>
              <Row
                label="inference"
                value={`${job.result.inferenceMs.toFixed(0)}ms for ${job.result.audioSeconds.toFixed(1)}s audio — ${(
                  job.result.audioSeconds /
                  (job.result.inferenceMs / 1000)
                ).toFixed(1)}× realtime`}
                good={job.result.inferenceMs < 1000}
              />
              <div className="pt-2">
                <dt className="mb-2 text-neutral-500">transcript</dt>
                <dd
                  lang="sa"
                  className="rounded border border-neutral-800 bg-black/40 p-3 text-base leading-loose text-neutral-200"
                >
                  {job.result.text || (
                    <span className="text-neutral-600">(empty)</span>
                  )}
                </dd>
                <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                  It is not supposed to be correct. The only question is whether
                  it says the same thing every time — which Chunk 3 already
                  measured, and Chunk 5 will exploit.
                </p>
              </div>
            </>
          )}
          {job.kind === "failed" && (
            <Row label="error" value={job.message} good={false} />
          )}
        </dl>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-40 shrink-0 text-neutral-500">{label}</dt>
      <dd className={`break-words ${good ? "text-emerald-400" : "text-amber-400"}`}>
        {value}
      </dd>
    </div>
  );
}

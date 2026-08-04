"use client";

// Where the felt delay actually goes.
//
// The loop takes a new window only once the previous one has returned, so the
// update cadence *is* the inference time, and the lag between chanting a line
// and seeing it highlighted is roughly:
//
//     inference + cadence/2  ≈  1.5 × inference
//
// Everything after the model — matching, the state machine, React — is under
// 5 ms combined. So this panel measures the one number that matters, against
// the two things that plausibly change it: how much audio is in the window,
// and which graph is being executed.
//
// The suspicion worth testing: the same graph runs in ~20 ms on CPU in Python
// and ~930 ms here. A 45× gap on a working GPU is not a slow GPU, it is a
// graph the GPU cannot run — onnxruntime-web's WebGPU backend has thin int8
// kernel coverage, so quantised MatMuls fall back or get dequantised per node.
// If that is what is happening then fp16, despite being a larger download,
// should be *faster* than int8. That is the sort of claim that has to be
// measured rather than reasoned about.

import { useCallback, useRef, useState } from "react";

import type {
  AsrDevice,
  AsrDtype,
  AsrMessage,
  AsrRequest,
} from "@/workers/asr.worker";

const SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = [1, 2, 3, 5] as const;
const REPEATS = 3;

type Row = {
  device: AsrDevice;
  dtype: AsrDtype;
  seconds: number;
  medianMs: number | null;
  note?: string;
};

/** Noise, not silence: timing depends on input length, not on content, but a
 * buffer of zeros can hit fast paths that real audio never would. */
function noise(seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 12345;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = (seed / 0x7fffffff) * 0.4 - 0.2;
  }
  return samples;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export default function BenchPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  const run = useCallback(async (combos: { device: AsrDevice; dtype: AsrDtype }[]) => {
    setBusy(true);
    setRows([]);
    const collected: Row[] = [];

    const worker = new Worker(
      new URL("../workers/asr.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    const pending = new Map<
      number,
      { resolve: (ms: number) => void; reject: (error: Error) => void }
    >();
    let readyResolve: ((value: void) => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    let nextId = 1;

    worker.addEventListener("message", (event: MessageEvent<AsrMessage>) => {
      const message = event.data;
      if (message.type === "ready") readyResolve?.();
      else if (message.type === "result") {
        pending.get(message.id)?.resolve(message.inferenceMs);
        pending.delete(message.id);
      } else if (message.type === "error") {
        if (message.id === undefined) readyReject?.(new Error(message.message));
        else {
          pending.get(message.id)?.reject(new Error(message.message));
          pending.delete(message.id);
        }
      }
    });

    const loadModel = (device: AsrDevice, dtype: AsrDtype) =>
      new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
        worker.postMessage({ type: "load", device, dtype } satisfies AsrRequest);
      });

    const time = (samples: Float32Array) =>
      new Promise<number>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "transcribe", id, samples } satisfies AsrRequest, [
          samples.buffer,
        ]);
      });

    try {
      for (const { device, dtype } of combos) {
        setStatus(`loading ${dtype} on ${device}…`);
        try {
          await loadModel(device, dtype);
        } catch (error) {
          collected.push({
            device,
            dtype,
            seconds: 0,
            medianMs: null,
            note: error instanceof Error ? error.message : String(error),
          });
          setRows([...collected]);
          continue;
        }

        for (const seconds of WINDOW_SECONDS) {
          setStatus(`${dtype} · ${device} · ${seconds}s window…`);
          const timings: number[] = [];
          let failure: string | undefined;
          // One warm-up: the first call after a load pays for shader
          // compilation and buffer allocation, which no later window does.
          try {
            await time(noise(seconds));
            for (let i = 0; i < REPEATS; i++) timings.push(await time(noise(seconds)));
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
          collected.push({
            device,
            dtype,
            seconds,
            medianMs: timings.length ? median(timings) : null,
            note: failure,
          });
          setRows([...collected]);
        }
      }
      setStatus("done");
    } finally {
      worker.terminate();
      workerRef.current = null;
      setBusy(false);
    }
  }, []);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-800 p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
        Latency bench
      </p>

      <p className="max-w-2xl font-mono text-xs leading-relaxed text-neutral-600">
        The loop starts a window only when the last one returns, so cadence{" "}
        <span className="text-neutral-400">is</span> inference time and the felt
        delay is about 1.5&times; it. Everything after the model is under 5 ms.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run([
              { device: "webgpu", dtype: "q8" },
              { device: "wasm", dtype: "q8" },
            ])
          }
          className="rounded border border-neutral-700 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
        >
          shipped graph (int8)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run([
              { device: "webgpu", dtype: "fp16" },
              { device: "webgpu", dtype: "fp32" },
              { device: "wasm", dtype: "fp16" },
            ])
          }
          className="rounded border border-neutral-800 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-neutral-400 hover:border-neutral-600 disabled:opacity-40"
        >
          float graphs
        </button>
        {busy ? (
          <span className="self-center font-mono text-xs text-neutral-500">
            {status}
          </span>
        ) : status ? (
          <span className="self-center font-mono text-xs text-neutral-600">
            {status}
          </span>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <table className="w-full font-mono text-xs">
          <thead className="text-neutral-600">
            <tr className="text-left">
              <th className="py-1 font-normal">graph</th>
              <th className="py-1 font-normal">device</th>
              <th className="py-1 font-normal">window</th>
              <th className="py-1 text-right font-normal">inference</th>
              <th className="py-1 text-right font-normal">felt lag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-neutral-900">
                <td className="py-1 text-neutral-400">{row.dtype}</td>
                <td className="py-1 text-neutral-500">{row.device}</td>
                <td className="py-1 text-neutral-500">
                  {row.seconds ? `${row.seconds}s` : "—"}
                </td>
                <td className="py-1 text-right text-neutral-200">
                  {row.medianMs === null ? "—" : `${row.medianMs.toFixed(0)} ms`}
                </td>
                <td className="py-1 text-right text-neutral-500">
                  {row.medianMs === null
                    ? ""
                    : `~${(row.medianMs * 1.5).toFixed(0)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {rows.some((row) => row.note) ? (
        <ul className="flex flex-col gap-1 font-mono text-xs text-amber-600/80">
          {rows
            .filter((row) => row.note)
            .map((row, index) => (
              <li key={index}>
                {row.dtype}/{row.device}: {row.note}
              </li>
            ))}
        </ul>
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { SmokeResult } from "@/workers/smoke.worker";

type Status =
  | { kind: "running" }
  | { kind: "done"; result: SmokeResult }
  | { kind: "failed"; message: string };

export default function MlSmokeTest() {
  // Starts as "running" rather than "idle": the effect always fires on mount,
  // so there is no observable idle state, and setting it inside the effect
  // would just be a cascading render.
  const [status, setStatus] = useState<Status>({ kind: "running" });

  useEffect(() => {
    // useEffect never runs on the server, so the worker is inherently
    // client-only. No `next/dynamic` + `ssr: false` needed (and in Next 16
    // that combination isn't allowed from a Server Component anyway).
    // Both failure paths report asynchronously. The worker's own `error` event
    // is already async; deferring the constructor's synchronous throw to match
    // keeps the two consistent and avoids setting state during the effect body.
    const fail = (message: string) =>
      queueMicrotask(() => setStatus({ kind: "failed", message }));

    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/smoke.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }

    const onMessage = (event: MessageEvent<SmokeResult>) => {
      setStatus({ kind: "done", result: event.data });
    };
    const onError = (event: ErrorEvent) => {
      fail(event.message || "worker failed to load");
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage("ping");

    return () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
    };
  }, []);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-5 font-mono text-sm">
      <h2 className="mb-4 text-xs uppercase tracking-widest text-neutral-500">
        Chunk 0 · build smoke test
      </h2>

      {status.kind === "running" && (
        <p className="text-amber-400">spawning worker…</p>
      )}

      {status.kind === "failed" && (
        <div className="text-red-400">
          <p>✗ worker failed to start</p>
          <p className="mt-1 text-red-300/70">{status.message}</p>
        </div>
      )}

      {status.kind === "done" && (
        <dl className="space-y-2">
          <Row
            label="transformers.js bundled"
            value={status.result.ok ? "yes" : "no"}
            good={status.result.ok}
          />
          <Row
            label="WebGPU API exposed"
            value={status.result.webgpuApi ? "yes" : "no"}
            good={status.result.webgpuApi}
          />
          <Row
            label="WebGPU adapter"
            value={
              status.result.webgpuAdapter
                ? `acquired — ${status.result.adapterInfo}`
                : `unavailable — will fall back to WASM${
                    status.result.adapterInfo
                      ? ` (${status.result.adapterInfo})`
                      : ""
                  }`
            }
            good={status.result.webgpuAdapter}
          />
          <Row
            label="onnx backends"
            value={status.result.onnxBackends.join(", ") || "(none registered)"}
            good
          />
          {status.result.error && (
            <Row label="error" value={status.result.error} good={false} />
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
      <dt className="w-48 shrink-0 text-neutral-500">{label}</dt>
      <dd className={good ? "text-emerald-400" : "text-amber-400"}>{value}</dd>
    </div>
  );
}

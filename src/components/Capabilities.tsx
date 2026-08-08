"use client";

// A five-second answer to "what is this device actually able to do?"
//
// The speech model can run on four quite different things — an NPU, a GPU, a
// multi-threaded CPU, or a single CPU core — and they are roughly thirty times
// apart end to end. Which one a visitor gets is decided entirely by what their
// browser reports, and nothing in the app has ever shown that. Two attempts at
// making the slow path faster were aimed from the wrong machine because of it.
//
// Everything here is read from the browser. No model is fetched, nothing is
// timed, and the page is safe in production.

import { useCallback, useEffect, useState } from "react";

type Finding = {
  label: string;
  value: string;
  /** good — this is the fast path. bad — this is why it is slow. */
  /**
   * good — this device can. bad — it cannot, and that is why it is slow.
   * warn — it can, and the app refuses to, which is a third thing and needs
   * saying differently from both.
   */
  tone: "good" | "bad" | "warn" | "plain";
  note?: string;
};

const UNKNOWN = "—";

export default function Capabilities() {
  const [findings, setFindings] = useState<Finding[] | null>(null);

  const probe = useCallback(async () => {
    const out: Finding[] = [];

    // --- the three ways this can go fast ---------------------------------
    const hasWebNN = typeof navigator !== "undefined" && "ml" in navigator;
    out.push({
      label: "WebNN",
      value: hasWebNN ? "available" : "not available",
      tone: hasWebNN ? "good" : "plain",
      note: hasWebNN
        ? "The only web API with direct access to an NPU. Untried by this app so far."
        : "No NPU path from the browser. Chrome and Edge expose this on Copilot+ hardware; Safari does not yet.",
    });

    // Apple's engine, on any platform: every browser on an iPhone is this one,
    // so naming Safari would miss most of the devices that need this said.
    const webkit =
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrome|Chromium|Edg\/|Firefox/.test(navigator.userAgent);

    let gpu = "not available";
    let gpuTone: Finding["tone"] = "bad";
    let gpuNote = "This is the single biggest cause of slowness. Without it the model runs on the CPU.";
    try {
      const anyNav = navigator as Navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> };
      };
      if (anyNav.gpu) {
        const adapter = await anyNav.gpu.requestAdapter();
        if (adapter && webkit) {
          // Present, granted, and deliberately not used. Saying "fast path"
          // here was wrong in the way that matters most: the page told the
          // owner their phone was fine while the app was restarting itself
          // mid-chant on that very device.
          gpu = "available, but not used here";
          gpuTone = "warn";
          gpuNote =
            "Apple's engine has an open bug in the WebGPU path of the model runtime: its memory climbs without limit and the page is killed and reloaded within seconds of chanting. The app takes the CPU path here on purpose — slower, and it does not restart.";
        } else if (adapter) {
          gpu = "available, adapter granted";
          gpuTone = "good";
          gpuNote = "The fast path — about 48 ms per window on tested hardware.";
        } else {
          gpu = "API present, but no adapter";
          gpuTone = "bad";
          gpuNote =
            "The browser offers WebGPU but the driver or GPU was refused. Usually a driver blocklist.";
        }
      }
    } catch (error) {
      gpu = `failed: ${error instanceof Error ? error.message : String(error)}`;
      gpuTone = "bad";
    }
    out.push({ label: "WebGPU", value: gpu, tone: gpuTone, note: gpuNote });

    // --- how fast the CPU fallback is allowed to be -----------------------
    const isolated =
      typeof globalThis !== "undefined" && Boolean(globalThis.crossOriginIsolated);
    const cores = navigator.hardwareConcurrency ?? 0;
    out.push({
      label: "CPU threads for the model",
      value: isolated ? `${cores || UNKNOWN}` : `1 of ${cores || UNKNOWN}`,
      tone: isolated ? "good" : "bad",
      note: isolated
        ? "Cross-origin isolated, so ONNX Runtime may use every core."
        : "Not cross-origin isolated. ONNX Runtime pins the CPU backend to a single thread by its own rule, whatever the machine has.",
    });
    out.push({
      label: "SharedArrayBuffer",
      value: typeof SharedArrayBuffer !== "undefined" ? "present" : "absent",
      tone: typeof SharedArrayBuffer !== "undefined" ? "good" : "plain",
      note: "Required for multi-threaded WebAssembly.",
    });

    // WebAssembly SIMD, detected by compiling a module that uses it. int8
    // inference leans on this heavily — it is worth 2-3x on its own.
    let simd = "no";
    try {
      simd = WebAssembly.validate(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
          10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
        ]),
      )
        ? "yes"
        : "no";
    } catch {
      simd = "unknown";
    }
    out.push({
      label: "WebAssembly SIMD",
      value: simd,
      tone: simd === "yes" ? "good" : "bad",
      note: "Packed 8-bit maths. The int8 graph depends on it.",
    });

    // --- context ----------------------------------------------------------
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    out.push({
      label: "Device memory",
      value: memory ? `${memory} GB or more` : "not reported",
      tone: "plain",
      note: "The fp16 graph alone is 190 MB, shared with system RAM on integrated graphics.",
    });
    out.push({
      label: "Secure context",
      value: window.isSecureContext ? "yes" : "no",
      tone: window.isSecureContext ? "good" : "bad",
      note: "The microphone needs one. localhost counts; plain HTTP on a LAN address does not.",
    });
    out.push({
      label: "Browser",
      value: navigator.userAgent,
      tone: "plain",
    });

    setFindings(out);
  }, []);

  useEffect(() => {
    // Deferred: the probe resolves into a setState, which React objects to
    // being reachable synchronously from an effect body.
    queueMicrotask(() => void probe());
  }, [probe]);

  const gpuTone = findings?.find((f) => f.label === "WebGPU")?.tone;
  const verdict = findings
    ? gpuTone === "good"
      ? "This device has the fast path. If chanting still lags, the cause is not the backend."
      : gpuTone === "warn"
        ? "This device has WebGPU and the app will not use it — see below. The model runs on the CPU here, and the thread count above is the ceiling, so expect it to be slow. It should not restart itself."
        : findings.find((f) => f.label === "WebNN")?.tone === "good"
          ? "No WebGPU, but this device exposes WebNN — so there is an NPU path the app has never tried."
          : "No WebGPU and no WebNN. The model runs on the CPU here, and the thread count above is the ceiling."
    : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 px-6 py-14">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">Device capabilities</h1>
        <p className="max-w-xl text-sm leading-relaxed text-neutral-400">
          What this browser can use to run the speech model. Nothing is
          downloaded and nothing is timed — every line is read straight from the
          browser.
        </p>
      </header>

      {verdict ? (
        <p className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm leading-relaxed text-neutral-200">
          {verdict}
        </p>
      ) : null}

      <dl className="flex flex-col">
        {(findings ?? []).map((f) => (
          <div
            key={f.label}
            className="flex flex-col gap-1 border-t border-neutral-900 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <dt className="text-sm text-neutral-400">{f.label}</dt>
              <dd
                className={`font-mono text-xs ${
                  f.tone === "good"
                    ? "text-emerald-400"
                    : f.tone === "bad"
                      ? "text-amber-400"
                      : f.tone === "warn"
                        ? "text-sky-400"
                        : "text-neutral-300"
                }`}
              >
                {f.value}
              </dd>
            </div>
            {f.note ? (
              <p className="max-w-2xl text-xs leading-relaxed text-neutral-600">
                {f.note}
              </p>
            ) : null}
          </div>
        ))}
      </dl>

      {findings === null ? (
        <p className="font-mono text-xs text-neutral-600">reading…</p>
      ) : null}
    </main>
  );
}

/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

// Chunk 0 smoke test.
//
// This worker exists to prove one thing: that `@huggingface/transformers`
// resolves to its *web* build and bundles cleanly inside a Next.js worker.
// It deliberately does NOT load a model — that's Chunk 2. If the import below
// pulled in `onnxruntime-node`, the build would fail here rather than three
// chunks later, tangled up with audio bugs.

import { env } from "@huggingface/transformers";

export type SmokeResult = {
  ok: boolean;
  webgpuApi: boolean;
  webgpuAdapter: boolean;
  adapterInfo: string;
  onnxBackends: string[];
  error?: string;
};

self.addEventListener("message", async () => {
  try {
    // WebGPU is the difference between ~300ms and ~2s inference later on, so
    // check it now rather than discovering the fallback mid-way through Chunk 3.
    //
    // Note the two-step check: `'gpu' in navigator` only proves the API is
    // exposed. Actually acquiring an adapter can still fail (driver blocklists,
    // headless contexts, VMs), and it's the adapter that decides whether we get
    // real acceleration. Only the second check is load-bearing.
    const webgpuApi = typeof navigator !== "undefined" && "gpu" in navigator;

    let webgpuAdapter = false;
    let adapterInfo = "";
    if (webgpuApi) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        webgpuAdapter = adapter !== null;
        if (adapter) {
          const info = adapter.info;
          adapterInfo =
            [info?.vendor, info?.architecture].filter(Boolean).join(" / ") ||
            "(adapter acquired, no info exposed)";
        }
      } catch (gpuError) {
        adapterInfo =
          gpuError instanceof Error ? gpuError.message : String(gpuError);
      }
    }

    const result: SmokeResult = {
      ok: true,
      webgpuApi,
      webgpuAdapter,
      adapterInfo,
      // Filter to actual execution providers — `env.backends.onnx` also carries
      // config keys like `logLevel` that aren't backends.
      onnxBackends: Object.keys(env.backends?.onnx ?? {}).filter((key) =>
        ["wasm", "webgl", "webgpu", "webnn"].includes(key),
      ),
    };

    self.postMessage(result);
  } catch (error) {
    const result: SmokeResult = {
      ok: false,
      webgpuApi: false,
      webgpuAdapter: false,
      adapterInfo: "",
      onnxBackends: [],
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(result);
  }
});

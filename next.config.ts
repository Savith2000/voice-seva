import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Cross-origin isolation, so the WASM path may use more than one core.
   *
   * ONNX Runtime decides this for us and there is no arguing with it. From its
   * own source:
   *
   *     if (typeof self !== "undefined" && !self.crossOriginIsolated)
   *         env.wasm.numThreads = 1;
   *
   * Without these two headers `crossOriginIsolated` is false, SharedArrayBuffer
   * is unavailable, and a 94 M-parameter transformer runs on a single core
   * while the rest of the machine idles. That is the WASM path's real problem —
   * not the graph, not the model, just one thread.
   *
   * COEP is `credentialless` rather than `require-corp` on purpose: the model
   * is fetched from huggingface.co, and require-corp blocks any cross-origin
   * subresource that does not send CORP back. Credentialless keeps the
   * isolation while letting cross-origin fetches through without credentials,
   * which is exactly the shape of a public model download.
   */
  async headers() {
    // ON by default. Set VOICE_SEVA_ISOLATE=0 to turn it off again.
    //
    // History, because this flag has been through it: isolation was on for two
    // commits and broke the worker on every machine it met — a Surface and a
    // Mac — while every test here passed. The tests passed because headless
    // Chromium has no GPU adapter, so all of them took the WASM path; the
    // WebGPU path, which is what a real machine actually uses, was never
    // exercised with these headers once. The cause was ONNX Runtime fetching
    // its backend from cdn.jsdelivr.net, which cross-origin isolation is
    // precisely designed to stop, so it was turned off (f15d00a) until both
    // named conditions were met:
    //
    //   1. ORT's binaries served from this origin — tools/copy-ort-wasm.mjs
    //      copies them into public/ort/ before every dev and build, and the
    //      worker points ORT there;
    //   2. a real GPU-capable browser watched starting a session with the
    //      headers present — the verification whose absence shipped the
    //      breakage last time.
    //
    // The kill switch stays, because the failure mode is "the worker will not
    // start on someone else's machine" and a deploy-time escape hatch beats
    // a revert.
    if (process.env.VOICE_SEVA_ISOLATE === "0") return [];

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;

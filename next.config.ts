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
    // OFF by default. Set VOICE_SEVA_ISOLATE=1 to try it.
    //
    // It was on for two commits and it broke the worker on every machine it
    // met — a Surface and a Mac — while every test here passed. The tests
    // passed because headless Chromium has no GPU adapter, so all of them took
    // the WASM path; the WebGPU path, which is what a real machine actually
    // uses, was never exercised with these headers once. ONNX Runtime fetches
    // its backend from cdn.jsdelivr.net and spawns nested workers from it, and
    // cross-origin isolation is precisely what stops that.
    //
    // The threading win behind this is real and still worth having — without
    // isolation the WASM backend is pinned to a single core by ORT itself. But
    // it costs nothing to be slow and everything to be broken, so it does not
    // come back on until ONNX Runtime's binaries are served from this origin
    // and someone has watched a real GPU-capable browser start a session with
    // it enabled.
    if (process.env.VOICE_SEVA_ISOLATE !== "1") return [];

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

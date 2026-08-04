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
    // Set VOICE_SEVA_ISOLATE=0 to turn this off without touching code.
    //
    // Cross-origin isolation changes how the browser loads *everything*, and
    // ONNX Runtime responds by switching to its threaded WASM build — a
    // different binary, fetched from a different place, spawning nested
    // workers. That is a lot of new behaviour to buy with two lines of config,
    // and it cannot be exercised on a machine that takes the WebGPU path
    // anyway. So it stays reversible: if a device fails to start its worker,
    // one environment variable puts it back to the way that was merely slow,
    // instead of needing a code change and a redeploy to find out.
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

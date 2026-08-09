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
   * COEP is `credentialless`, and it went to `require-corp` for exactly one
   * commit before an actual browser said no. Read this before changing it
   * again, because the reasoning that leads to require-corp is sound and the
   * conclusion is still wrong.
   *
   * The argument for require-corp: credentialless is not implemented in Safari
   * and Apple has said it does not intend to implement it, so on every iPhone
   * the isolation header does nothing, and ONNX Runtime pins itself to a
   * single core. The owner's phone reported "1 of 4" and require-corp fixed
   * exactly that — their next reading said four.
   *
   * The reason it cannot stay: making Safari isolated for the first time also
   * exposes it to ONNX Runtime's own long-standing bug, microsoft/onnxruntime
   * #11567, "Inference is Broken in Safari when Cross Origin Isolation is
   * active". The worker stops starting at all. Safari was previously immune to
   * that bug for the accidental reason that it was never isolated, and the
   * moment that changed, the app stopped working — the owner reported it as
   * "the worker could not start", the exact sentence this app prints when a
   * worker dies without a message.
   *
   * So the trade is: credentialless means a slow iPhone, require-corp means a
   * broken one. **It costs nothing to be slow and everything to be broken** —
   * this project's own hard-won rule, written after the same header broke
   * every real machine in f15d00a, and now demonstrated twice.
   *
   * What would let require-corp come back is upstream #11567 being fixed, and
   * that must be TESTED in Safari rather than inferred from a changelog. Until
   * then a phone's threads are not available to us at any price we can pay.
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

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
    // OFF by default. Set VOICE_SEVA_ISOLATE=1 to turn it on.
    //
    // THIRD OUTAGE FROM THIS HEADER. Read the whole comment before enabling it.
    //
    // This time the browser said it outright, in the owner's console: a
    // Turbopack worker chunk under /_next/static was blocked for want of a
    // COEP header. The chunks are served WITH the header now — that was
    // checked — but they are also served `immutable, max-age=31536000`, so a
    // browser that fetched them during any period when isolation was off holds
    // a copy with no COEP header for a year, and Chrome enforces the policy
    // against the cached response. Enabling isolation therefore breaks exactly
    // the people who used the app before it was enabled, which is everybody,
    // and it cannot be tested by any browser that has not been running the app
    // for days — which is why three separate verifications missed it.
    //
    // WHAT IT WAS BUYING, HONESTLY
    //
    // Isolation only ever helps the CPU path, by letting ONNX Runtime use more
    // than one thread. It is worth nothing to a machine with WebGPU, which
    // takes the GPU path regardless and is the case for every desktop this app
    // has met. It is worth nothing on any iPhone, because Safari does not
    // implement `credentialless` and Apple has said it does not intend to. So
    // the entire benefit is: a desktop browser with no WebGPU, of which this
    // project has not yet met one.
    //
    // Against that: three outages, each one presenting as "the worker could
    // not start", each one invisible on the machine that shipped it.
    //
    // It costs nothing to be slow and everything to be broken.
    if (process.env.VOICE_SEVA_ISOLATE !== "1") return [];
    //
    // Earlier history, kept because it is the same lesson twice more. Isolation
    // was on for two commits and broke the worker on a Surface and a Mac while
    // every test here passed — the tests passed because headless Chromium has
    // no GPU adapter and so took the WASM path, while the WebGPU path that real
    // machines take was never exercised with these headers once. That cause was
    // ONNX Runtime fetching its backend from cdn.jsdelivr.net; it was fixed by
    // serving those binaries from this origin (tools/copy-ort-wasm.mjs), which
    // remains worth doing on its own merits and is not undone here.
    //
    // Turning it back on then produced outages two and three: a Safari that
    // became isolated for the first time and met onnxruntime#11567, and the
    // year-long immutable cache described above.
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

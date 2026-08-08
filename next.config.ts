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
   * COEP is `require-corp`, and it was `credentialless` until an iPhone proved
   * why that could not stay.
   *
   * Credentialless is the friendlier mode — it keeps the isolation while
   * letting cross-origin subresources through without credentials, which is
   * exactly the shape of a public model download. But **Safari does not
   * implement it and Apple has said it does not intend to**, so on every
   * iPhone the header did nothing at all: no isolation, no SharedArrayBuffer,
   * and the model pinned to one core of four. The owner's /capabilities
   * readout said precisely that, which is the only reason we know.
   *
   * require-corp is the mode Safari does honour. It is stricter — a
   * cross-origin subresource fetched in no-cors mode must send CORP back or it
   * is blocked — and this app can afford it because it has exactly one
   * cross-origin resource: the model, fetched from huggingface.co with fetch()
   * in CORS mode, which the CORS check governs rather than CORP. Everything
   * else is already served from this origin: the fonts (next/font self-hosts
   * at build, Shobhika lives in public/fonts), the emblem, and ONNX Runtime's
   * own WASM binaries.
   *
   * The bill for this comes due the first time somebody adds a cross-origin
   * image, script, or iframe. It will be blocked outright, and the console
   * will say so plainly.
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
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;

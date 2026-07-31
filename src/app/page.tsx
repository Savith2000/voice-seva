import AsrTest from "@/components/AsrTest";
import ChantScript from "@/components/ChantScript";
import MatcherTest from "@/components/MatcherTest";
import MicCaptureTest from "@/components/MicCaptureTest";
import MlSmokeTest from "@/components/MlSmokeTest";
import TrackingTest from "@/components/TrackingTest";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          voice&nbsp;seva
        </p>
        <h1 className="mt-2 text-2xl font-medium">Development harness</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">
          Scaffolding for the chant-following engine. Everything on this page is
          an instrument, not a feature &mdash; the real interface arrives in
          Chunk&nbsp;9.
        </p>
      </header>

      <MlSmokeTest />

      <MicCaptureTest />

      <AsrTest />

      <TrackingTest />

      <MatcherTest />

      <ChantScript />

      <section className="font-mono text-xs leading-relaxed text-neutral-600">
        <p className="mb-2 uppercase tracking-widest text-neutral-500">
          Chunk 3 &middot; consistency gate
        </p>
        <p className="mb-4 max-w-xl leading-relaxed">
          <span className="text-emerald-500">passed</span> &mdash; run offline in{" "}
          <span className="text-neutral-400">tools/asr-bakeoff</span>, not here,
          because swapping models there costs one line and in the browser costs
          an ONNX conversion. Pick:{" "}
          <span className="text-neutral-400">
            vakyansh-wav2vec2-sanskrit-sam-60
          </span>
          , 94&nbsp;M params, stability 0.095 on real chanting. It beat a model
          ten times its size.
        </p>
        <p className="mb-2 uppercase tracking-widest text-neutral-500">Next up</p>
        <ol className="space-y-1">
          <li>Chunk 7 &middot; calibration, reference text tuned to the model</li>
          <li>Chunk 8 &middot; confidence state machine</li>
        </ol>
      </section>
    </main>
  );
}

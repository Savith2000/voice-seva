import Link from "next/link";
import { notFound } from "next/navigation";

import AsrTest from "@/components/AsrTest";
import BenchPanel from "@/components/BenchPanel";
import ChantScript from "@/components/ChantScript";
import MatcherTest from "@/components/MatcherTest";
import MicCaptureTest from "@/components/MicCaptureTest";
import MlSmokeTest from "@/components/MlSmokeTest";
import TrackingTest from "@/components/TrackingTest";

/**
 * The instruments are for whoever is building this, not for whoever is chanting.
 *
 * Open in development always; in a production build only when the deployment
 * explicitly asks for them. A visitor handed the live link should find a chant
 * screen, not seven panels of dtype sweeps and raw matcher output — and the
 * raw transcript on TrackingTest is the specific thing that must never greet a
 * reciter, since the model is *allowed* to be wrong and seeing it be wrong
 * would read as the app being broken.
 *
 * This makes the route unreachable, not absent: the panels are still compiled
 * into the build behind a 404. Enough for a test deployment; if the harness
 * should genuinely not ship, it needs excluding from the bundle rather than
 * hiding behind a check.
 *
 * To turn it on for a deployment, set VOICE_SEVA_HARNESS=1 in that
 * environment's variables.
 */
function harnessAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.VOICE_SEVA_HARNESS === "1"
  );
}

export default function Home() {
  if (!harnessAllowed()) notFound();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          voice&nbsp;seva
        </p>
        <h1 className="mt-2 text-2xl font-medium">Development harness</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">
          Instruments, not features. Each one tests a single piece in isolation
          and reports numbers the finished app has no reason to show. The app
          itself is at{" "}
          <Link href="/chant" className="text-neutral-200 underline">
            /chant
          </Link>
          .
        </p>
      </header>

      <MlSmokeTest />

      <MicCaptureTest />

      <AsrTest />

      <BenchPanel />

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
        <p className="mb-2 uppercase tracking-widest text-neutral-500">
          Not built
        </p>
        <p className="max-w-xl leading-relaxed">
          Chunk 7 &middot; calibration &mdash; deliberately skipped. It exists
          to tune the reference text toward what the model actually says, and
          real windows are scoring 0.9+ against the text as printed. Worth
          revisiting only if a longer or group recording says otherwise.
        </p>
      </section>
    </main>
  );
}

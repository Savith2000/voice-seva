import MicCaptureTest from "@/components/MicCaptureTest";
import MlSmokeTest from "@/components/MlSmokeTest";

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

      <section className="font-mono text-xs leading-relaxed text-neutral-600">
        <p className="mb-2 uppercase tracking-widest text-neutral-500">Next up</p>
        <ol className="space-y-1">
          <li>Chunk 2 &middot; Whisper in a worker, single clip</li>
          <li>Chunk 3 &middot; consistency test (go/no-go gate)</li>
          <li>Chunk 4 &middot; Anuvaka 1 of Namakam as JSON</li>
        </ol>
      </section>
    </main>
  );
}

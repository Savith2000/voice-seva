import Link from "next/link";

// Chunk 10: the front door.
//
// The harness used to live here, which meant the first thing anyone saw was
// six instruments and no indication which of them was the app. Someone handed
// this link with no explanation should be chanting one click later; the
// instruments moved to /harness for whoever actually needs them.

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-10 px-6 py-20">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          voice&nbsp;seva
        </p>
        <h1 className="mt-3 text-3xl font-medium leading-tight">
          Chant, and the script follows you.
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-relaxed text-neutral-400">
          Listens through the microphone, works out which line of Sri Rudram is
          being recited, and keeps the page with you. Everything runs on this
          device &mdash; no account, no server, and no audio ever leaves the
          browser.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-6">
        <Link
          href="/chant"
          className="rounded-full bg-neutral-100 px-6 py-3 text-sm font-medium text-neutral-950 transition-colors hover:bg-white"
        >
          Start chanting
        </Link>
        <Link
          href="/harness"
          className="font-mono text-xs uppercase tracking-widest text-neutral-500 underline-offset-4 hover:text-neutral-300 hover:underline"
        >
          development harness
        </Link>
      </div>

      <section className="flex flex-col gap-3 border-t border-neutral-900 pt-8 text-sm leading-relaxed text-neutral-500">
        <p>
          <span className="text-neutral-300">First time:</span> the speech model
          is about 123&nbsp;MB and downloads once, then stays cached. Allow the
          microphone when the browser asks.
        </p>
        <p>
          <span className="text-neutral-300">If it loses you:</span> tap any
          line to put it back. It would rather hold still than jump to a line it
          is unsure of, so pausing on the last good line is the design working
          rather than failing.
        </p>
        <p>
          <span className="text-neutral-300">Needs Chrome</span> on a desktop,
          over <span className="font-mono text-xs">localhost</span> or HTTPS
          &mdash; browsers refuse microphone access on plain HTTP.
        </p>
      </section>

      <footer className="font-mono text-xs leading-relaxed text-neutral-700">
        Sri Rudram Namakam, Anuvaka 1 &mdash; text decoded from the Sri Sathya
        Sai Books and Publications Trust edition, Prasanthi Nilayam.
      </footer>
    </main>
  );
}

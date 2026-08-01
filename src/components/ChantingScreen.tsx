"use client";

// Chunk 9: the actual interface, as opposed to the instruments.
//
// Every design decision here is about calm. The screen is looked at by someone
// mid-recitation who cannot stop to interpret it, so: one line is bright and
// the rest are legible but quiet, scrolling is slow and only when needed, and
// the status text says what is happening in words rather than numbers. When
// the app is unsure it says so and holds still — a screen that guesses is
// worse than one that admits it is lost, because a wrong line pulls someone
// out of the chant and a stale one does not.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEVANAGARI_STACK } from "@/components/ChantLineView";
import { listAudioInputs, type AudioInput } from "@/lib/audio/capture";
import { allLines, flatten, type ChantLine } from "@/lib/chant/chant";
import { chant } from "@/lib/chant/chant-data";
import { INITIAL, follow, statusLine, type FollowState } from "@/lib/chant/follow";
import { progressThroughLine } from "@/lib/chant/matcher";
import { useAsrSession } from "@/lib/chant/use-asr-session";

const FONT_STEPS = [0.85, 1, 1.2, 1.45, 1.75] as const;
const DEFAULT_FONT_STEP = 1;

/**
 * Strip IAST diacritics so search works the way people type.
 *
 * The transliteration is "mṛtyuñjayāya", and nobody hunting for a line
 * mid-recitation is going to produce ṛ or ñ. Decomposing and dropping the
 * combining marks makes "mrtyunjayaya" find it — and "sivo", and "namaste".
 *
 * Applied only to the romanised side. NFD decomposes Devanagari too, and
 * dropping its combining marks would delete every matra and turn the text
 * into a row of bare consonants.
 */
function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export default function ChantingScreen() {
  const flat = useMemo(() => flatten(chant), []);
  const lines = useMemo(() => allLines(chant), []);

  const [state, setState] = useState<FollowState>(INITIAL);
  const [autoScroll, setAutoScroll] = useState(true);
  const [fontStep, setFontStep] = useState(DEFAULT_FONT_STEP);
  const [query, setQuery] = useState("");
  const [showMeaning, setShowMeaning] = useState(true);
  /** Which script gets the large size. Devanagari is the source; the
   *  romanisation is what most people here actually read from. Neither is
   *  the obviously correct default, so it is a button. */
  const [devanagariLeads, setDevanagariLeads] = useState(false);
  /** Set when the last position was settled by what was on screen. */
  const [settledByView, setSettledByView] = useState(false);
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [deviceId, setDeviceId] = useState("");

  const session = useAsrSession(
    flat,
    useCallback(
      (tick) => {
        const matched = tick.state === "matched";
        const progress =
          matched && tick.result ? progressThroughLine(tick.result, flat) : 0;
        setState((previous) => follow(previous, tick, progress));
        // Worth saying out loud: it is the one answer that came from
        // somewhere other than the audio.
        if (matched) setSettledByView(tick.result?.chosenByView ?? false);
      },
      [flat],
    ),
  );

  const running = session.phase.kind === "running";
  const starting = session.phase.kind === "starting";

  const displayIndex = state.lineIndex;
  const displayProgress = state.progress;

  // --- scrolling -------------------------------------------------------------

  const verseRefs = useRef<(HTMLLIElement | null)[]>([]);
  const lastScrolledTo = useRef<number | null>(null);



  useEffect(() => {
    if (!autoScroll || displayIndex === null) return;
    // Only scroll when the line actually changes. Re-centring on every window
    // would mean the page creeping under the reader once a second, which is
    // more distracting than not scrolling at all.
    if (lastScrolledTo.current === displayIndex) return;
    lastScrolledTo.current = displayIndex;
    verseRefs.current[displayIndex]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [displayIndex, autoScroll]);

  // --- manual control --------------------------------------------------------

  /** Put the position somewhere by hand, and treat it as a firm lock.
   *
   * Requirement 1.6: the user must be able to correct the app. A correction
   * that the next window immediately overrules would be worse than none, so
   * this lands as a locked position and the ordinary "jumping needs
   * corroboration" rule then protects it. */
  const selectLine = useCallback((index: number) => {
    lastScrolledTo.current = null;
    setState((previous) => ({
      ...previous,
      kind: "locked",
      lineIndex: index,
      progress: 0,
      confidence: "high",
      holding: !previous.heardAt,
      misses: 0,
      candidate: null,
    }));
  }, []);

  /**
   * The verses, each holding its own lines.
   *
   * A verse is two half-lines separated by a danda, which is how the book
   * sets it and how it is chanted — so showing them together means the whole
   * unit is in front of you rather than half of it. Fifteen of the eighteen
   * are exactly two lines; the three that are not (the opening invocation,
   * verse 10, and the closing salutation) really are single lines, which is
   * why this groups by verse rather than by pairs. Blind pairs would put the
   * invocation and the first half of verse 2 in the same box.
   */
  const verses = useMemo(() => {
    const out: { verse: number; lines: ChantLine[] }[] = [];
    for (const line of lines) {
      const last = out[out.length - 1];
      if (last && last.verse === line.verse) last.lines.push(line);
      else out.push({ verse: line.verse, lines: [line] });
    }
    return out;
  }, [lines]);

  const matches = useMemo(() => {
    const raw = query.trim();
    if (!raw) return null;
    const needle = foldDiacritics(raw);
    return lines.filter(
      (line) =>
        foldDiacritics(line.transliteration).includes(needle) ||
        line.devanagari.includes(raw) ||
        String(line.sequence) === raw,
    );
  }, [query, lines]);

  // --- microphones -----------------------------------------------------------

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listAudioInputs());
    } catch {
      // Enumeration is a convenience; a failure here must not stop anyone
      // from chanting on the default input.
    }
  }, []);

  useEffect(() => {
    // Deferred, as elsewhere in this codebase: enumeration resolves into a
    // setState, and React objects to one being reachable synchronously from
    // an effect body.
    queueMicrotask(() => void refreshDevices());
    // Labels stay blank until permission is granted, and the set changes when
    // a headset is plugged in mid-session.
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    // Real names arrive only once a stream has been opened.
    if (running) queueMicrotask(() => void refreshDevices());
  }, [running, refreshDevices]);

  /** Verses to show: all of them, or only those a search touched. */
  const shownVerses = useMemo(() => {
    if (!matches) return verses;
    const wanted = new Set(matches.map((line) => line.sequence));
    return verses
      .map((group) => ({
        ...group,
        lines: group.lines.filter((line) => wanted.has(line.sequence)),
      }))
      .filter((group) => group.lines.length > 0);
  }, [verses, matches]);

  // --- what the reader can see -----------------------------------------------
  //
  // Several lines of this chant open identically — 3 and 33 both begin
  // "namaste astu" — so a window of just those syllables fits both and the
  // audio cannot separate them. Where someone has scrolled is real evidence
  // about which they mean, and at that moment it is the only evidence there
  // is. It settles ties only; see matcher.ts.
  const setInView = session.setInView;
  useEffect(() => {
    const nodes = verseRefs.current;
    const visible = new Set<number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = nodes.indexOf(entry.target as HTMLLIElement);
          if (index < 0) continue;
          // A verse box covers every line in it, so mark them all.
          for (let i = 0; i < nodes.length; i++) {
            if (nodes[i] !== entry.target) continue;
            if (entry.isIntersecting) visible.add(i);
            else visible.delete(i);
          }
        }
        setInView(visible.size ? visible : null);
      },
      // A sliver counts: a line half off the bottom of the screen is still
      // one the reader can see and might be about to chant.
      { threshold: 0.1 },
    );

    const seen = new Set<Element>();
    for (const node of nodes) {
      if (node && !seen.has(node)) {
        seen.add(node);
        observer.observe(node);
      }
    }
    return () => observer.disconnect();
  }, [setInView, shownVerses]);

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }, []);

  const scale = FONT_STEPS[fontStep];

  const current: ChantLine | null =
    displayIndex === null ? null : lines[displayIndex];

  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-100">
      {/* --- header ---------------------------------------------------- */}
      <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-sm font-medium">
              {chant.name.english}
            </h1>
            <p className="truncate font-mono text-xs text-neutral-500">
              {chant.anuvakas[0].title.english} &middot; {lines.length} lines
            </p>
          </div>

          <Status state={state} running={running} starting={starting} />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={
                running || starting
                  ? () => void session.stop()
                  : () => void session.start("mic", { deviceId: deviceId || undefined })
              }
              disabled={starting}
              className="rounded-full border border-neutral-700 px-4 py-1.5 font-mono text-xs uppercase tracking-widest hover:border-neutral-500 disabled:opacity-40"
            >
              {running ? "pause" : starting ? "starting…" : "listen"}
            </button>

            {devices.length > 0 ? (
              <select
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                disabled={running || starting}
                title="Microphone"
                className="max-w-40 truncate rounded-full border border-neutral-800 bg-neutral-950 px-3 py-1 font-mono text-xs text-neutral-400 outline-none hover:border-neutral-600 disabled:opacity-40"
              >
                <option value="">default mic</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            ) : null}

            {/* Which script is the big one. A segmented control rather than
                a labelled switch, because the two options say themselves. */}
            <div
              className="flex items-center rounded-full border border-neutral-800"
              role="group"
              aria-label="Which script to read from"
            >
              <button
                type="button"
                onClick={() => setDevanagariLeads(false)}
                aria-pressed={!devanagariLeads}
                title="Romanised text large"
                className={`rounded-l-full px-3 py-1 text-xs transition-colors ${
                  devanagariLeads
                    ? "text-neutral-600 hover:text-neutral-400"
                    : "bg-neutral-800 text-neutral-100"
                }`}
              >
                A
              </button>
              <button
                type="button"
                onClick={() => setDevanagariLeads(true)}
                aria-pressed={devanagariLeads}
                title="Devanagari large"
                lang="sa"
                style={{ fontFamily: DEVANAGARI_STACK }}
                className={`rounded-r-full px-3 py-1 text-xs transition-colors ${
                  devanagariLeads
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-600 hover:text-neutral-400"
                }`}
              >
                अ
              </button>
            </div>

            <IconToggle
              on={autoScroll}
              onClick={() => setAutoScroll((v) => !v)}
              title="Auto-scroll"
            >
              scroll
            </IconToggle>


            <IconToggle
              on={showMeaning}
              onClick={() => setShowMeaning((v) => !v)}
              title="Show meaning"
            >
              meaning
            </IconToggle>

            <div className="flex items-center rounded-full border border-neutral-800">
              <button
                type="button"
                onClick={() => setFontStep((s) => Math.max(0, s - 1))}
                disabled={fontStep === 0}
                className="px-2.5 py-1 font-mono text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
                aria-label="Smaller text"
              >
                A&minus;
              </button>
              <button
                type="button"
                onClick={() =>
                  setFontStep((s) => Math.min(FONT_STEPS.length - 1, s + 1))
                }
                disabled={fontStep === FONT_STEPS.length - 1}
                className="px-2.5 py-1 font-mono text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
                aria-label="Larger text"
              >
                A+
              </button>
            </div>

            <button
              type="button"
              onClick={toggleFullScreen}
              className="rounded-full border border-neutral-800 px-3 py-1 font-mono text-xs text-neutral-400 hover:text-neutral-100"
            >
              full
            </button>
          </div>
        </div>

        {starting && session.progress ? (
          <div className="border-t border-neutral-900 px-4 py-2">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-baseline justify-between font-mono text-xs text-neutral-500">
                <span>
                  Downloading the speech model
                  {session.progress.fraction !== null
                    ? ` — ${Math.round(session.progress.fraction * 100)}%`
                    : "…"}
                </span>
                <span className="text-neutral-700">
                  {formatMb(session.progress.loaded)}
                  {session.progress.total > 0
                    ? ` / ${formatMb(session.progress.total)}`
                    : ""}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className={`h-full rounded-full bg-emerald-500 ${
                    session.progress.fraction === null
                      ? "w-1/3 animate-pulse"
                      : "transition-[width] duration-300"
                  }`}
                  style={
                    session.progress.fraction === null
                      ? undefined
                      : { width: `${session.progress.fraction * 100}%` }
                  }
                />
              </div>
              <p className="mt-1 font-mono text-xs text-neutral-700">
                Happens once &mdash; the browser keeps it cached afterwards.
              </p>
            </div>
          </div>
        ) : null}

        {session.phase.kind === "failed" ? (
          <p className="border-t border-red-900/50 bg-red-950/30 px-4 py-2 text-center font-mono text-xs text-red-300">
            {session.phase.message}
          </p>
        ) : null}
      </header>

      {/* --- search ------------------------------------------------------ */}
      <div className="mx-auto w-full max-w-4xl px-4 pt-4">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a line — type any words, then pick it below"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
        />
        {matches && matches.length === 0 ? (
          <p className="mt-2 font-mono text-xs text-neutral-600">no matches</p>
        ) : null}
      </div>

      {/* --- the script -------------------------------------------------- */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <ol className="flex flex-col gap-6">
          {shownVerses.map((group) => {
            // The verse is the visual unit; the line inside it is the
            // position. Scrolling by verse is calmer than scrolling by
            // half-line, and it keeps the second half of a couplet on screen
            // while the first is being chanted.
            const holdsActive = group.lines.some(
              (line) => lines.indexOf(line) === displayIndex,
            );
            return (
              <li
                key={group.verse}
                ref={(node) => {
                  for (const line of group.lines) {
                    verseRefs.current[lines.indexOf(line)] = node;
                  }
                }}
                className={`rounded-lg px-4 py-3 transition-colors ${
                  holdsActive
                    ? "bg-emerald-950/40 ring-1 ring-emerald-800/50"
                    : ""
                }`}
              >
                {group.lines.map((line) => {
                  const index = lines.indexOf(line);
                  const active = index === displayIndex;
                  const primary = devanagariLeads ? "devanagari" : "translit";
                  return (
                    <div
                      key={line.sequence}
                      onClick={() => selectLine(index)}
                      className={`-mx-2 flex cursor-pointer gap-4 rounded px-2 py-1.5 transition-colors ${
                        active ? "" : "hover:bg-neutral-900/50"
                      }`}
                    >
                      <span
                        className={`w-7 shrink-0 pt-1 text-right font-mono text-xs ${
                          active ? "text-emerald-500" : "text-neutral-700"
                        }`}
                      >
                        {line.sequence}
                      </span>
                      <div className="min-w-0 flex-1">
                        {primary === "devanagari" ? (
                          <>
                            <p
                              lang="sa"
                              className={`leading-loose ${
                                active ? "text-neutral-50" : "text-neutral-400"
                              }`}
                              style={{
                                fontFamily: DEVANAGARI_STACK,
                                fontSize: `${scale * 1.5}rem`,
                              }}
                            >
                              {line.devanagari}
                            </p>
                            <p
                              lang="sa-Latn"
                              className={`mt-1 leading-snug ${
                                active ? "text-neutral-400" : "text-neutral-600"
                              }`}
                              style={{ fontSize: `${scale * 0.95}rem` }}
                            >
                              {line.transliteration}
                            </p>
                          </>
                        ) : (
                          <>
                            <p
                              lang="sa-Latn"
                              className={`leading-snug ${
                                active ? "text-neutral-50" : "text-neutral-400"
                              }`}
                              style={{ fontSize: `${scale * 1.5}rem` }}
                            >
                              {line.transliteration}
                            </p>
                            <p
                              lang="sa"
                              className={`mt-1 leading-loose ${
                                active ? "text-neutral-400" : "text-neutral-600"
                              }`}
                              style={{
                                fontFamily: DEVANAGARI_STACK,
                                fontSize: `${scale}rem`,
                              }}
                            >
                              {line.devanagari}
                            </p>
                          </>
                        )}
                        {showMeaning && line.meaning ? (
                          <p
                            className="mt-2 leading-relaxed text-neutral-500"
                            style={{ fontSize: `${scale * 0.85}rem` }}
                          >
                            {line.meaning}
                          </p>
                        ) : null}
                        {active ? (
                          <span
                            className="mt-2 block h-0.5 rounded-full bg-emerald-600/70 transition-all duration-700"
                            style={{
                              width: `${Math.round(displayProgress * 100)}%`,
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ol>

        {showMeaning && !lines.some((line) => line.meaning) ? (
          <p className="mt-8 rounded-lg border border-neutral-900 px-4 py-3 font-mono text-xs leading-relaxed text-neutral-600">
            No translation is loaded. The source PDF has none, and a
            translation is an interpretation rather than a transcription &mdash;
            it needs a named edition rather than being filled in from memory.
          </p>
        ) : null}
      </main>

      {/* --- footer ------------------------------------------------------ */}
      <footer className="sticky bottom-0 border-t border-neutral-800 bg-neutral-950/95 px-4 py-2 backdrop-blur">
        <p className="mx-auto max-w-4xl truncate font-mono text-xs text-neutral-600">
          {current
            ? `line ${current.sequence} of ${lines.length}`
            : "tap any line to set the position by hand"}
          {settledByView && running
            ? " · matched what you were looking at"
            : ""}
          {running && session.phase.kind === "running"
            ? ` · ${session.phase.device} · ${session.phase.source}`
            : ""}
        </p>
      </footer>
    </div>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function Status({
  state,
  running,
  starting,
}: {
  state: FollowState;
  running: boolean;
  starting: boolean;
}) {
  const label = starting
    ? "Starting…"
    : !running
      ? "Paused."
      : statusLine(state);

  // Amber for "unsure", not red. Nothing has gone wrong when the app is
  // looking for its place; it is doing what it was asked to do.
  const tone =
    !running || starting
      ? "bg-neutral-700"
      : state.kind === "locked" && !state.holding
        ? "bg-emerald-500"
        : state.kind === "idle"
          ? "bg-neutral-700"
          : "bg-amber-500";

  return (
    <span className="flex items-center gap-2 font-mono text-xs text-neutral-400">
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

function IconToggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
        on
          ? "border-neutral-600 text-neutral-200"
          : "border-neutral-800 text-neutral-600"
      }`}
    >
      {children}
    </button>
  );
}

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
import {
  NO_PACE,
  estimateLagMs,
  leadPosition,
  observePace,
  type Pace,
} from "@/lib/chant/lead";
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
  const [leadEnabled, setLeadEnabled] = useState(true);
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [deviceId, setDeviceId] = useState("");

  // Where the highlight actually goes, once the model's lag is added back on.
  const [lead, setLead] = useState<{
    lineIndex: number;
    progress: number;
    charsAhead: number;
    rate: number;
  } | null>(null);
  const paceRef = useRef<Pace>(NO_PACE);
  const lastTickAtRef = useRef<number | null>(null);
  const stateRef = useRef<FollowState>(INITIAL);

  const session = useAsrSession(
    flat,
    useCallback(
      (tick) => {
        const progress =
          tick.state === "matched" && tick.result
            ? progressThroughLine(tick.result, flat)
            : 0;

        // Folded through a ref as well as state, so the lead below can see
        // what the state machine actually decided about this very tick.
        const next = follow(stateRef.current, tick, progress);
        stateRef.current = next;
        setState(next);

        if (tick.state !== "matched" || !tick.result) return;

        // The lead is a *display* adjustment applied to the position the
        // state machine accepted — never to the raw match. Without this
        // check, a jump the machine deliberately refused would still drag the
        // highlight across the screen, which is precisely the behaviour the
        // machine exists to prevent.
        const accepted =
          next.kind === "locked" && next.lineIndex === tick.result.lineIndex;
        if (!accepted) {
          setLead(null);
          return;
        }

        // Tempo comes from where consecutive windows actually landed; the lag
        // from how long this window took plus how long the highlight will now
        // sit still. Both measured, neither assumed.
        const previousAt = lastTickAtRef.current;
        lastTickAtRef.current = tick.at;
        paceRef.current = observePace(paceRef.current, tick.result.end, tick.at);

        const interval = previousAt === null ? 0 : tick.at - previousAt;
        const placed = leadPosition(
          flat,
          tick.result.end,
          paceRef.current,
          estimateLagMs(tick.inferenceMs, interval),
        );
        setLead({
          lineIndex: placed.lineIndex,
          progress: placed.progress,
          charsAhead: placed.charsAhead,
          rate: paceRef.current.rate,
        });
      },
      [flat],
    ),
  );

  const running = session.phase.kind === "running";
  const starting = session.phase.kind === "starting";

  // What the screen shows. The state machine owns the position; the lead only
  // nudges it forward, and only while there is a live lock to nudge.
  const useLead = leadEnabled && lead !== null && state.kind === "locked";
  const displayIndex = useLead ? lead.lineIndex : state.lineIndex;
  const displayProgress = useLead ? lead.progress : state.progress;

  // --- scrolling -------------------------------------------------------------

  const lineRefs = useRef<(HTMLLIElement | null)[]>([]);
  const lastScrolledTo = useRef<number | null>(null);

  useEffect(() => {
    if (!autoScroll || displayIndex === null) return;
    // Only scroll when the line actually changes. Re-centring on every window
    // would mean the page creeping under the reader once a second, which is
    // more distracting than not scrolling at all.
    if (lastScrolledTo.current === displayIndex) return;
    lastScrolledTo.current = displayIndex;
    lineRefs.current[displayIndex]?.scrollIntoView({
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
    // The old lead was measured from the position being overruled.
    setLead(null);
    paceRef.current = NO_PACE;
    lastTickAtRef.current = null;
    setState((previous) => {
      const next: FollowState = {
        ...previous,
        kind: "locked",
        lineIndex: index,
        progress: 0,
        confidence: "high",
        holding: !previous.heardAt,
        misses: 0,
        candidate: null,
      };
      stateRef.current = next;
      return next;
    });
  }, []);

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

            <IconToggle
              on={autoScroll}
              onClick={() => setAutoScroll((v) => !v)}
              title="Auto-scroll"
            >
              scroll
            </IconToggle>

            <IconToggle
              on={leadEnabled}
              onClick={() => setLeadEnabled((v) => !v)}
              title={
                "Highlight slightly ahead of the model, to cancel the delay " +
                "between chanting and recognising it"
              }
            >
              lead
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
          {(matches ?? lines).map((line) => {
            const index = lines.indexOf(line);
            const active = index === displayIndex;
            return (
              <li
                key={line.sequence}
                ref={(node) => {
                  lineRefs.current[index] = node;
                }}
                onClick={() => selectLine(index)}
                className={`cursor-pointer rounded-lg px-4 py-3 transition-colors ${
                  active
                    ? "bg-emerald-950/50 ring-1 ring-emerald-800/60"
                    : "hover:bg-neutral-900/60"
                }`}
              >
                <div className="flex gap-4">
                  <span
                    className={`w-7 shrink-0 pt-1 text-right font-mono text-xs ${
                      active ? "text-emerald-500" : "text-neutral-700"
                    }`}
                  >
                    {line.sequence}
                  </span>
                  <div className="min-w-0 flex-1">
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
                        className="mt-3 block h-0.5 rounded-full bg-emerald-600/70 transition-all duration-700"
                        style={{
                          width: `${Math.round(displayProgress * 100)}%`,
                        }}
                      />
                    ) : null}
                  </div>
                </div>
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
          {running && session.phase.kind === "running"
            ? ` · ${session.phase.device} · ${session.phase.source}`
            : ""}
          {useLead && lead
            ? ` · leading ${lead.charsAhead} chars at ${lead.rate.toFixed(1)}/s`
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

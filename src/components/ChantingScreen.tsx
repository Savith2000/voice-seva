"use client";

// The chanting screen — a page of a printed book, not an application window.
//
// Design direction C, chosen 2026-08-04 from three built alternatives; the
// reasoning and the two rejected directions are in design/direction-approved.md
// and the working pages are in design/design-demos/. Read those before
// reshaping any of this, because most of what looks arbitrary here is load
// bearing.
//
// The idea it is built on is emptiness as a vessel. The reading window holds
// nothing of its own — it is drawn only as a slightly lighter field of unprinted
// paper between two rules. The chanter fills it: the active line is inked from
// left to right by their own voice, word by word, at the progress the tracker
// reports. A person reciting scripture is filling exactly such a vessel, so the
// screen should hold rather than perform.
//
// Everything else follows from the page metaphor. The measure down the left is
// the fore-edge of a book, telling you where you are in a text whose length is
// already fixed. The meaning sits in the outer margin as a gloss beside the
// verse it glosses. The emblem is set at the foot of that margin as a printer's
// seal rather than as a logo in a navigation bar. The controls are a colophon
// along the bottom, and they withdraw after ten seconds of stillness — present
// when wanted, gone while chanting.
//
// Three inks, as a book is printed: ink for the received text, SSIO blue for
// every piece of apparatus, and saffron for the voice alone. Full-chroma brand
// orange is spent on exactly two marks — the progress rule and the following
// disc — and nothing else in the product wears it.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { listAudioInputs, type AudioInput } from "@/lib/audio/capture";
import { allLines, flatten, type ChantLine } from "@/lib/chant/chant";
import { chant, works } from "@/lib/chant/chant-data";
import { INITIAL, follow, pin, type FollowState } from "@/lib/chant/follow";
import { anchorFrom, glide, type Anchor } from "@/lib/chant/glide";
import { progressThroughLine } from "@/lib/chant/matcher";
import { useAsrSession } from "@/lib/chant/use-asr-session";

/** Three steps of text size, plainly named. */
const SIZES = [0.86, 1, 1.18] as const;
const SIZE_NAMES = ["Small", "Medium", "Large"] as const;

const ROMAN = [
  "", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI",
  "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
] as const;

/**
 * Two polarities of the same page.
 *
 * A light page genuinely reads better at three metres — positive polarity gives
 * better acuity for small complex glyphs, and Devanagari carrying svara marks
 * is exactly that case. But a full white screen at five in the morning is a
 * lamp pointed at the reciter's face, and that is a functional cost rather than
 * a matter of taste. So both are real, and the sheet inverting to ink changes
 * only the polarity of the paper: the composition, the measure, the vessel and
 * the seal are identical.
 *
 * A third, brighter step existed and is gone. Its paper was near-white, which
 * is the one setting nobody using this at dawn would ever reach for, and it
 * made the choice a three-way when it is really a question with two answers.
 */
const LIGHTS = {
  lamp: {
    "--page": "#E8E1D3", "--paper": "#F1EBDE",
    "--ink": "#221B12", "--ink2": "#5C5245", "--ink3": "#6F6456",
    "--blue": "#0C5098", "--rule": "rgba(12,80,152,.32)", "--rule-soft": "rgba(12,80,152,.17)",
    "--saffron": "#9C4A05", "--saffron-full": "#EE7900", "--saffron-pale": "rgba(238,121,0,.22)",
    "--key-side": "#A24E00", "--key-face": "#FFF7EC", "--key-well": "rgba(120,70,20,.18)",
  },
  dawn: {
    "--page": "#131110", "--paper": "#1C1917",
    "--ink": "#EDE6D8", "--ink2": "#A99C88", "--ink3": "#9C907D",
    "--blue": "#8FB3DC", "--rule": "rgba(143,179,220,.34)", "--rule-soft": "rgba(143,179,220,.18)",
    "--saffron": "#EE9A45", "--saffron-full": "#EE7900", "--saffron-pale": "rgba(238,154,69,.24)",
    "--key-side": "#7E3D00", "--key-face": "#20180F", "--key-well": "rgba(0,0,0,.42)",
  },
} as const;

type Light = keyof typeof LIGHTS;
type Lead = "dev" | "ia";

/** Quiet this long and the marginalia withdraw. */
const STILL_AFTER_MS = 10_000;

/**
 * A printed group up to this many lines is kept whole; longer ones read in twos.
 *
 * Four, because the closing salutation of Namakam anuvaka 1 is four lines and
 * is chanted as one breath — splitting it would put a break where a reciter
 * does not take one.
 */
const HELD_TOGETHER = 4;

/**
 * What the screen says it is doing.
 *
 * Kept short and close to the same length on purpose. These are stacked in one
 * grid cell, so the block is permanently as tall as the longest of them —
 * "Locating chanting position…" wrapped to a second line and reserved 44 px
 * that four of the five states never used.
 */
const STATE_WORDS = {
  following: { word: "Following.", sub: "Your voice is being tracked line by line." },
  holding: { word: "Holding your place.", sub: "Still on the last line it was sure of." },
  locating: { word: "Finding your place…", sub: "It can hear you, but has not found the line yet." },
  starting: { word: "Starting…", sub: "Opening the microphone and waking the model." },
  idle: { word: "Not listening.", sub: "The microphone is off. Nothing is being heard." },
} as const;

type Condition = keyof typeof STATE_WORDS;

const SHOWN: Condition[] = ["idle", "starting", "locating", "following", "holding"];

function conditionOf(state: FollowState, running: boolean): Condition {
  if (!running) return "idle";
  if (state.kind === "locked") return state.holding ? "holding" : "following";
  if (state.kind === "searching") return "locating";
  return "idle";
}

export default function ChantingScreen() {
  const flat = useMemo(() => flatten(chant), []);
  const lines = useMemo(() => allLines(chant), []);
  const grouped = useMemo(() => works(), []);

  /** Which section each line belongs to, and where each section starts. */
  const { sectionOf, sectionStart } = useMemo(() => {
    const of: number[] = [];
    const start: number[] = [];
    let n = 0;
    chant.anuvakas.forEach((section, index) => {
      start.push(n);
      for (let i = 0; i < section.lines.length; i++) of.push(index);
      n += section.lines.length;
    });
    return { sectionOf: of, sectionStart: start };
  }, []);

  const [state, setState] = useState<FollowState>(INITIAL);
  const [lead, setLead] = useState<Lead>("dev");
  const [light, setLight] = useState<Light>("lamp");
  const [size, setSize] = useState(1);
  const [showGloss, setShowGloss] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [still, setStill] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [devices, setDevices] = useState<AudioInput[]>([]);
  const [deviceId, setDeviceId] = useState("");
  /** Cadence the device actually achieved, whatever backend won the ladder. */
  const [cadence, setCadence] = useState(250);

  const session = useAsrSession(
    flat,
    useCallback(
      (tick) => {
        const progress =
          tick.state === "matched" && tick.result
            ? progressThroughLine(tick.result, flat)
            : 0;
        setState((previous) => follow(previous, tick, progress));
        if (tick.state === "matched") {
          // Read once per window rather than per frame. This is what makes the
          // glide device-aware: a machine that found an NPU reports a short
          // interval and needs little filling in; one on a single CPU thread
          // reports a long one and needs a lot.
          setCadence((was) => {
            const now = Math.round(tick.inferenceMs * 2);
            return Math.abs(now - was) < 40 ? was : Math.max(200, now);
          });
        }
      },
      [flat],
    ),
  );

  const running = session.phase.kind === "running";
  const starting = session.phase.kind === "starting";
  const condition = conditionOf(state, running || starting);
  /** The one value the whole block reads from, so nothing can disagree. */
  const shows: Condition = starting ? "starting" : condition;

  // Before anything has been heard the page still has to be a page, so it opens
  // on the first line rather than on nothing.
  const active = state.lineIndex ?? 0;
  /** Words in the line being chanted — the quantum the ink moves in. */
  const activeWords = useMemo(() => {
    const line = lines[state.lineIndex ?? 0];
    if (!line) return 0;
    const text = lead === "dev" ? line.devanagari : line.transliteration;
    return text.split(/\s+/).filter(Boolean).length;
  }, [lines, state.lineIndex, lead]);

  const { stageRef, inked } = useGlide({
    progress: state.progress,
    updatedAt: state.updatedAt,
    line: state.lineIndex ?? -1,
    words: activeWords,
    intervalMs: cadence,
    live: state.kind === "locked" && !state.holding && running,
  });
  const section = chant.anuvakas[sectionOf[active] ?? 0];
  const sectionIndex = sectionOf[active] ?? 0;
  const withinSection = active - (sectionStart[sectionIndex] ?? 0);

  // --- the scroll ----------------------------------------------------------
  //
  // The reading area is a real scroll container, and the fade belongs to the
  // container rather than to the content moving through it. scrollIntoView is
  // deliberately not used: it walks up and scrolls every ancestor it can find,
  // which fights the page's own layout.

  const clipRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const followedRef = useRef<number | null>(null);

  /**
   * Bring the tracked line to the anchor.
   *
   * The reading area is a real scroll container. It used to be a fixed window
   * with the whole stack translated under it by transform, which animated
   * beautifully and could not be scrolled by hand at all — no wheel, no
   * trackpad, no touch, no keyboard, no scrollbar. The only way to move was to
   * click a line, which is exactly the wrong affordance for a reader who wants
   * to glance ahead. Native overflow gets all of that for free, and
   * scroll-behavior does the smoothing.
   */
  const place = useCallback(
    (smooth = true) => {
      const clip = clipRef.current;
      const node = lineRefs.current[active];
      if (!clip || !node || !autoScroll) return;
      // Centre the UNIT, not the line. Centring the line puts the other half of
      // the couplet above the fade, so the reader sees half of the thing they
      // are chanting — which is the failure the unit grouping exists to fix.
      const unit = node.closest<HTMLElement>(".vs-unit") ?? node;
      const target =
        unit.offsetTop + unit.offsetHeight / 2 - clip.clientHeight * 0.5;
      clip.scrollTo({
        top: Math.max(0, target),
        behavior: smooth ? "smooth" : "auto",
      });
    },
    [active, autoScroll],
  );

  // Follow only when the position actually moves. Re-anchoring on every render
  // would drag the page back the instant anyone scrolled away to look ahead.
  useEffect(() => {
    if (followedRef.current === active) return;
    followedRef.current = active;
    place();
  }, [active, place]);

  // Watch the stack rather than trying to list everything that could move it.
  //
  // Changing script or text size re-flows every one of the 303 lines, so every
  // offset the placement depends on changes at once. Naming those inputs as
  // effect dependencies looks right and silently rots: it left the reader
  // parked sixty lines above the line the tracker was actually on, with the
  // heading and the gloss both correctly reporting somewhere the screen was
  // not showing. Observing the content covers the cases nobody thought to
  // list, including a webfont finishing loading after first paint.
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(stack);
    return () => observer.disconnect();
  }, [place]);

  // --- what the reader can see ---------------------------------------------
  //
  // Several lines of this chant genuinely open the same way, and Namakam
  // anuvaka 11 repeats a refrain verbatim — after normalisation those two lines
  // are identical, so no amount of audio can separate them. Where someone has
  // scrolled is real evidence about which they mean, and at that moment it is
  // the only evidence there is. It settles ties only; see matcher.ts.
  const setInView = session.setInView;
  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const report = () => {
      const top = clip.scrollTop;
      const bottom = top + clip.clientHeight;
      const visible = new Set<number>();
      lineRefs.current.forEach((node, index) => {
        if (!node) return;
        if (node.offsetTop + node.offsetHeight > top && node.offsetTop < bottom) {
          visible.add(index);
        }
      });
      setInView(visible.size ? visible : null);
    };
    report();
    clip.addEventListener("scroll", report, { passive: true });
    return () => clip.removeEventListener("scroll", report);
  }, [setInView]);

  // --- marginalia withdraw while chanting, return on any movement -----------
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setStill(false);
      clearTimeout(timer);
      timer = setTimeout(() => setStill(true), STILL_AFTER_MS);
    };
    const events = ["mousemove", "keydown", "pointerdown", "wheel"] as const;
    events.forEach((name) => window.addEventListener(name, wake, { passive: true }));
    wake();
    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, wake));
    };
  }, []);

  // --- microphones ----------------------------------------------------------
  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listAudioInputs());
    } catch {
      // Enumeration is a convenience; failing it must not stop anyone chanting.
    }
  }, []);

  useEffect(() => {
    // Deferred: enumeration resolves into a setState, and React objects to one
    // being reachable synchronously from an effect body.
    queueMicrotask(() => void refreshDevices());
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    if (running) queueMicrotask(() => void refreshDevices());
  }, [running, refreshDevices]);

  /** Put the position somewhere by hand — and have it stick.
   *
   * This overrules the audio rather than competing with it: see `pinned` in
   * follow.ts. Tapping a line is a statement about where the reader is, and the
   * window arriving right after a tap is the least trustworthy one there is,
   * because the five seconds it describes are mostly the line just left. */
  const selectLine = useCallback((index: number) => {
    setState((previous) => pin(previous, index, performance.now()));
  }, []);

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }, []);

  // --- the reading unit ----------------------------------------------------
  //
  // What goes big together, because it is chanted together.
  //
  // Namakam is set in couplets and the page prints them that way, so the unit
  // is simply the printed group: the opening invocation stands alone, the
  // verses are pairs, and the closing salutation runs to four lines that are
  // one breath and must not be broken.
  //
  // Chamakam is not couplets. It is a litany, and the page prints ||N|| only
  // at the END of a whole anuvaka — so taking the printed group literally there
  // yields one block of ten "ca me" clauses, which is not a thing anyone reads
  // as a unit. Anything longer than a held-together group gets read in twos.
  const units = useMemo(() => {
    const printed: { section: number; verse: number; indices: number[] }[] = [];
    lines.forEach((line, index) => {
      const owner = sectionOf[index];
      const last = printed[printed.length - 1];
      if (last && last.verse === line.verse && last.section === owner) {
        last.indices.push(index);
      } else {
        printed.push({ section: owner, verse: line.verse, indices: [index] });
      }
    });

    const out: {
      key: string;
      verse: number;
      indices: number[];
      opens: number | null;
    }[] = [];
    let lastSection = -1;
    for (const group of printed) {
      const key = `${group.section}:${group.verse}`;
      // The first unit of a section carries it, so the scroll can print a
      // heading there. Without one, 303 lines run together and nothing on the
      // paper says where Namakam ends and Chamakam begins.
      const opens = group.section !== lastSection ? group.section : null;
      lastSection = group.section;
      if (group.indices.length <= HELD_TOGETHER) {
        out.push({ key, verse: group.verse, indices: group.indices, opens });
        continue;
      }
      for (let i = 0; i < group.indices.length; i += 2) {
        out.push({
          key: `${key}:${i}`,
          verse: group.verse,
          indices: group.indices.slice(i, i + 2),
          opens: i === 0 ? opens : null,
        });
      }
    }
    return out;
  }, [lines, sectionOf]);

  /** The measure shows the section you are in, not all 303 lines.
   *
   * The fore-edge of a book shows the whole book because a book is one object.
   * At three hundred lines a stroke per line stops being a fore-edge and starts
   * being a barcode, so the measure holds the current section and the row of
   * numerals across the head carries position within the work. The composition
   * is unchanged; only what it counts has moved up a level. */
  const measureLines = useMemo(() => {
    const start = sectionStart[sectionIndex] ?? 0;
    return section.lines.map((_, i) => start + i);
  }, [section, sectionIndex, sectionStart]);

  const current: ChantLine | undefined = lines[active];
  const scale = SIZES[size];

  const glossVerse = useMemo(() => {
    if (!current) return null;
    const owner = sectionOf[active];
    const same = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => sectionOf[index] === owner && line.verse === current.verse);
    if (same.length === 0) return null;
    return {
      first: same[0].line.sequence,
      last: same[same.length - 1].line.sequence,
      meaning: current.meaning,
    };
  }, [current, active, lines, sectionOf]);

  return (
    <div
      ref={stageRef}
      className="vs-stage"
      data-light={light}
      data-lead={lead}
      data-still={still ? "yes" : "no"}
      style={{ ...LIGHTS[light], "--scale": scale } as unknown as React.CSSProperties}
    >
      <style>{CSS}</style>

      {/* --- running head ------------------------------------------------- */}
      <header className="vs-head">
        <div className="vs-work">
          <Link href="/" className="vs-lib" title="Chant library">
            <svg viewBox="0 0 13 9" fill="none" aria-hidden="true">
              <path
                d="M12.2 4.5H1M4.6 1 1 4.5 4.6 8"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            All chants
          </Link>
          <div className="vs-title">
            <span className="vs-sa" lang="sa">
              {chant.name.devanagari}
            </span>
            <span className="vs-ia">{chant.name.english}</span>
          </div>

          <div className="vs-nav">
            {grouped.map((group) => (
              <NavRow key={group.work || "all"}>
                <span className="vs-lbl">{group.work || "Sections"}</span>
                {group.sections.map((entry) => {
                  const index = chant.anuvakas.indexOf(entry);
                  const here = index === sectionIndex;
                  const label =
                    entry.kind === "anuvaka" && entry.number
                      ? ROMAN[entry.number]
                      : entry.kind === "rudra-mantras"
                        ? "Rudra"
                        : "Śānti";
                  return (
                    <button
                      type="button"
                      key={entry.id}
                      onClick={() => selectLine(sectionStart[index])}
                      className={here ? "vs-here" : ""}
                      data-on={here}
                      title={entry.title.english}
                    >
                      {label}
                    </button>
                  );
                })}
              </NavRow>
            ))}
          </div>
        </div>

        {/* Every state is in the DOM at once, stacked in a single grid cell.
            The block is therefore always the height of the tallest and NOTHING
            below it moves — which was the actual complaint. The control used to
            travel 44 px between states, and no easing curve rescues a button
            that relocates out from under the hand reaching for it. */}
        <div className="vs-state" data-shows={shows}>
          <InkWell shows={shows} level={session.level} />
          <div className="vs-txt">
            <div className="vs-says">
              {SHOWN.map((key) => (
                <div
                  className="vs-say"
                  key={key}
                  data-on={key === shows}
                  aria-hidden={key !== shows}
                >
                  <div className="vs-word">{STATE_WORDS[key].word}</div>
                  <div className="vs-sub">{STATE_WORDS[key].sub}</div>
                </div>
              ))}
            </div>
            {/* The stack is hidden from assistive tech; this is the one voice
                that speaks, and only when the state actually changes. */}
            <p className="vs-sr" role="status">
              {STATE_WORDS[shows].word} {STATE_WORDS[shows].sub}
            </p>
            <button
              type="button"
              className="vs-key"
              data-live={running}
              disabled={starting}
              onClick={
                running || starting
                  ? () => void session.stop()
                  : () => void session.start("mic", { deviceId: deviceId || undefined })
              }
            >
              <span className="vs-says vs-labels">
                <span className="vs-say" data-on={!running} aria-hidden={running}>
                  Begin listening
                </span>
                <span className="vs-say" data-on={running} aria-hidden={!running}>
                  Pause listening
                </span>
              </span>
            </button>
          </div>
        </div>
      </header>

      {starting && session.progress ? (
        <div className="vs-loading">
          <span>
            Bringing the voice model onto this device
            {session.progress.fraction !== null
              ? ` — ${Math.round(session.progress.fraction * 100)}%`
              : "…"}
          </span>
          <div className="vs-bar">
            <i
              style={{
                width:
                  session.progress.fraction === null
                    ? "33%"
                    : `${session.progress.fraction * 100}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {session.phase.kind === "failed" ? (
        <p className="vs-failed">{session.phase.message}</p>
      ) : null}

      {/* --- measure | vessel | margin ------------------------------------ */}
      <div className="vs-middle">
        <nav className="vs-measure" aria-label={`Position in ${section.title.english}`}>
          <div className="vs-cap">{withinSection + 1}</div>
          <div className="vs-stack">
            {measureLines.map((index) => (
              <button
                type="button"
                key={index}
                className={`vs-trow ${index === active ? "vs-now" : index < active ? "vs-done" : ""}`}
                onClick={() => selectLine(index)}
                title={`Line ${lines[index].sequence}`}
                aria-label={`Line ${lines[index].sequence}`}
              >
                <span className="vs-tick" />
              </button>
            ))}
          </div>
          <div className="vs-foot">{section.lines.length}</div>
        </nav>

        <section className="vs-vessel">
          <div className="vs-hr" />
          <div className="vs-window">
            <div className="vs-clip" ref={clipRef} tabIndex={0}>
              <div className="vs-scroll" ref={stackRef}>
                {units.map((group) => {
                  // The unit is what goes big, not the single line. A couplet
                  // is chanted as one thing, so showing half of it large and
                  // half small breaks the object the reader is holding.
                  const here = group.indices.includes(active);
                  const opening =
                    group.opens === null ? null : chant.anuvakas[group.opens];
                  return (
                    <div key={`w-${group.key}`}>
                    {opening ? (
                      <div
                        className="vs-divider"
                        data-work-start={
                          opening.kind !== "anuvaka" || opening.number === 1
                            ? "yes"
                            : "no"
                        }
                      >
                        <span>{opening.title.english}</span>
                      </div>
                    ) : null}
                    <div
                      className={`vs-unit ${here ? "vs-open" : ""}`}
                      data-lines={group.indices.length}
                      key={group.key}
                    >
                      {group.indices.map((index) => (
                        <Line
                          key={lines[index].sequence}
                          line={lines[index]}
                          lead={lead}
                          big={here}
                          current={index === active}
                          near={!here && Math.abs(index - active) <= 3}
                          inked={index === active ? inked : 0}
                          onSelect={() => selectLine(index)}
                          register={(node) => {
                            lineRefs.current[index] = node;
                          }}
                        />
                      ))}
                    </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="vs-hr" />
        </section>

        <aside className="vs-margin">
          {showGloss && glossVerse ? (
            <div className="vs-gloss">
              <div className="vs-ref">
                {section.title.english} · Verse {ROMAN[current?.verse ?? 0] ?? current?.verse}
                {" · "}
                {glossVerse.first === glossVerse.last
                  ? `Line ${glossVerse.first}`
                  : `Lines ${glossVerse.first}–${glossVerse.last}`}
              </div>
              {glossVerse.meaning ? (
                <div className="vs-en">{glossVerse.meaning}</div>
              ) : (
                <div className="vs-none">
                  No translation is loaded. A translation is an interpretation
                  rather than a transcription — it needs a named edition rather
                  than being filled in from memory.
                </div>
              )}
            </div>
          ) : null}

          <div className="vs-seal">
            <div className="vs-sealrow">
              <div className="vs-who">
                Sri Sathya Sai
                <br />
                International Organisation
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/ssio-logo.png" alt="" width={62} height={62} />
            </div>
            <div className="vs-values">
              Truth · Right Conduct · Peace · Love · Non-violence
            </div>
          </div>
        </aside>
      </div>

      {/* Honest about a feature that is not built rather than a dead label.
          The constraint is real: section splitting is solved for the editions
          we control and not in general, so a long multi-section upload would
          be silently mis-chunked — which looks like a working import until
          someone chants from it. */}
      {showImport ? (
        <div className="vs-import">
          <div>
            <strong>Adding your own chant is not ready yet.</strong> When it
            arrives it will be a beta: one section at a time, a short PDF, and
            text you can check before you chant from it. Splitting a long
            recitation into its sections reliably is the unsolved part — a
            wrongly split chant reads as a working one until you are mid-verse
            and the screen is somewhere else.
          </div>
          <button type="button" onClick={() => setShowImport(false)}>
            Close
          </button>
        </div>
      ) : null}

      {/* --- colophon ------------------------------------------------------ */}
      <footer className="vs-colophon">
        <div className="vs-ctrls">
          <Control label="Script leads">
            <Choice on={lead === "dev"} onClick={() => setLead("dev")} devanagari>
              देवनागरी
            </Choice>
            <Choice on={lead === "ia"} onClick={() => setLead("ia")}>
              IAST
            </Choice>
          </Control>

          <Control label="Meaning">
            <Choice on={showGloss} onClick={() => setShowGloss(true)}>
              In margin
            </Choice>
            <Choice on={!showGloss} onClick={() => setShowGloss(false)}>
              Hidden
            </Choice>
          </Control>

          <Control label="Text size">
            {SIZE_NAMES.map((name, index) => (
              <Choice key={name} on={size === index} onClick={() => setSize(index)}>
                {name}
              </Choice>
            ))}
          </Control>

          {/* Named for what a reader already knows rather than for the scene
              they are in. "Lamp" and "Before dawn" described the hour; these
              describe the setting, which is the thing being chosen. */}
          <Control label="Appearance">
            {(["lamp", "dawn"] as const).map((name) => (
              <Choice key={name} on={light === name} onClick={() => setLight(name)}>
                {name === "dawn" ? "Dark mode" : "Light mode"}
              </Choice>
            ))}
          </Control>

          <Control label="Scrolling">
            <Choice on={autoScroll} onClick={() => setAutoScroll(true)}>
              Auto
            </Choice>
            <Choice on={!autoScroll} onClick={() => setAutoScroll(false)}>
              By hand
            </Choice>
          </Control>

          <Control label="Microphone">
            {devices.length > 0 ? (
              <select
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                disabled={running || starting}
                className="vs-select"
              >
                <option value="">System default</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            ) : (
              <span>System default</span>
            )}
          </Control>

          <Control label="Full screen">
            <Choice on={false} onClick={toggleFullScreen}>
              Enter
            </Choice>
          </Control>

          <Control label="Library" note="Coming soon">
            <Choice on={showImport} onClick={() => setShowImport((on) => !on)}>
              Add a chant · PDF
            </Choice>
          </Control>
        </div>

        <div className="vs-model">
          Voice model · downloaded once, then kept on this device
          <div className="vs-modelnote">
            {running && session.phase.kind === "running"
              ? `Listening · ${session.phase.device}. No audio leaves this device.`
              : "No audio leaves this device."}
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Drive the ink from the glide, one animation frame at a time.
 *
 * The arithmetic and every governor live in lib/chant/glide.ts, tested there
 * without React or a DOM, because the safety argument for extrapolating at all
 * is those governors and it should be provable rather than merely watched.
 *
 * This is only the plumbing: hold an anchor, re-anchor when a real reading
 * lands, and publish the result. The smooth value goes straight to a CSS
 * custom property — the progress rule is a pure width and never re-renders —
 * while the word count is state, because a word appearing is a real visual
 * change and words arrive a few times a second, not sixty.
 */
function useGlide({
  progress,
  updatedAt,
  line,
  words,
  intervalMs,
  live,
}: {
  progress: number;
  updatedAt: number;
  line: number;
  words: number;
  intervalMs: number;
  live: boolean;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [inked, setInked] = useState(0);

  const anchor = useRef<Anchor & { line: number }>({
    progress: 0,
    at: 0,
    rate: 0,
    line: -1,
  });
  const latest = useRef({ progress, updatedAt, line, words, intervalMs, live });
  // Refreshed in an effect rather than during render, so the frame loop sees
  // the newest values without being torn down to get them.
  useEffect(() => {
    latest.current = { progress, updatedAt, line, words, intervalMs, live };
  }, [progress, updatedAt, line, words, intervalMs, live]);

  useEffect(() => {
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const stage = stageRef.current;
      const now = latest.current;
      if (!stage) return;

      if (now.line !== anchor.current.line) {
        // A new line is a jump, not a journey: snap, and forget the old pace.
        anchor.current = {
          progress: now.progress,
          at: now.updatedAt,
          rate: 0,
          line: now.line,
        };
      } else if (now.updatedAt !== anchor.current.at) {
        anchor.current = {
          ...anchorFrom(anchor.current, now.progress, now.updatedAt),
          line: now.line,
        };
      }

      const shown = reduced
        ? anchor.current.progress
        : glide(anchor.current, performance.now(), now.intervalMs, now.live);

      stage.style.setProperty("--glide", shown.toFixed(4));
      const reach = now.words > 0 ? Math.floor(shown * now.words) : 0;
      setInked((was) => (was === reach ? was : reach));
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return { stageRef, inked };
}

/**
 * One underline per group of choices, that travels instead of teleporting.
 *
 * It used to be a `border-bottom` on whichever button was selected — and a
 * border belongs to one element, so when the choice changed the line did not
 * move, it simply appeared somewhere else. There was nothing to animate. The
 * only fix is a single mark that outlives the selection.
 *
 * This measures the active child and publishes its box to the container as
 * custom properties; one `::after` per group reads them and eases across.
 *
 * Positioned with translate on BOTH axes rather than `left`/`bottom`, because
 * these rows wrap: on a narrow screen the numerals run onto a second line, and
 * an underline pinned to the bottom of the container would sit under the wrong
 * row entirely.
 *
 * The mark travels only WITHIN a row. A row that is gaining it places it
 * outright, because it still holds the transform from the last time it was
 * selected — so animating the arrival meant fading in and sliding across from
 * a stale position at once, two motions with no cause the reader could see.
 * Namakam to Chamakam is a change of line, not a journey along one.
 *
 * Deliberately no dependency array. Any selection change re-renders this
 * subtree anyway, and enumerating the inputs is the bug I already shipped once
 * on the scroll placement — the list looks complete and silently rots. Reading
 * two offsets off a handful of small nodes is far cheaper than being wrong.
 */
function useSlider() {
  const ref = useRef<HTMLElement | null>(null);
  /** Did this group hold the mark on the previous measure? */
  const held = useRef(false);

  const measure = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const on = box.querySelector<HTMLElement>('[data-on="true"]');

    // No selection here — the other row owns the mark. Gone, not faded.
    if (!on) {
      box.setAttribute("data-jump", "");
      box.style.setProperty("--o", "0");
      held.current = false;
      return;
    }

    // Arriving in a row that did not have it: place the mark, do not fly it in.
    const arriving = !held.current;
    if (arriving) box.setAttribute("data-jump", "");

    box.style.setProperty("--o", "1");
    box.style.setProperty("--x", `${on.offsetLeft}px`);
    box.style.setProperty("--y", `${on.offsetTop + on.offsetHeight}px`);
    box.style.setProperty("--w", `${on.offsetWidth}px`);

    if (arriving) {
      // Commit the placement while transitions are still off, so the next
      // move inside this row animates from where the mark actually is.
      void box.offsetWidth;
      box.removeAttribute("data-jump");
      held.current = true;
    }
  }, []);

  useLayoutEffect(measure);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    // A webfont landing after first paint changes every width underneath it.
    void document.fonts?.ready.then(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  return ref;
}

/** A row of anuvaka numerals, with the travelling underline. */
function NavRow({ children }: { children: React.ReactNode }) {
  const ref = useSlider();
  return (
    <div className="vs-navrow" ref={ref as React.RefObject<HTMLDivElement>}>
      {children}
    </div>
  );
}

/**
 * The state mark: a well that the voice fills with ink.
 *
 * It replaced four unrelated CSS rules — two drawing a border, two a background
 * — with nothing interpolating between them, which is why pressing the control
 * felt like something breaking rather than something starting.
 *
 * Each condition is now a state of one material. Idle is a dry ring. Starting
 * draws a stroke once around the rim, and that stroke is honest: the model
 * really is arriving. Following floods the well and then lets the level ride
 * the microphone. Holding pales the ink and lets it recede to a stain at the
 * rim — the voice has stopped but the position is kept, which is exactly what
 * that state means.
 *
 * The level is written straight to a CSS custom property from an animation
 * frame. It never passes through React: a setState at fifteen hertz would
 * re-render three hundred lines of scripture to move a mark twenty-one pixels
 * across.
 */
function InkWell({
  shows,
  level,
}: {
  shows: Condition;
  level: { current: number };
}) {
  const condition = shows === "starting" ? "locating" : shows;
  const inkRef = useRef<SVGRectElement | null>(null);

  useEffect(() => {
    const node = inkRef.current;
    if (!node) return;

    // Only while there is something to show, and never while the tab is
    // hidden — an unwatched loop is just heat.
    if (condition !== "following" && condition !== "holding") {
      node.style.setProperty("--ink", "0");
      return;
    }

    // The bowl is 23 px across, so the bottom fifth of it is a sliver a few
    // pixels tall — a true 0..1 mapping spends most of its range where nothing
    // can be read. Listening therefore starts at a floor rather than at empty,
    // which is also the honest reading: the instrument IS attending, even in a
    // silence, and the voice rides above that rather than creating it.
    const FLOOR = 0.3;
    let frame = 0;
    const draw = () => {
      if (!document.hidden) {
        const ink = FLOOR + level.current * (1 - FLOOR);
        node.style.setProperty("--ink", ink.toFixed(3));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [condition, level]);

  return (
    <span className="vs-mark" data-condition={condition} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="vs-well">
        <defs>
          <clipPath id="vs-bowl">
            <circle cx="12" cy="12" r="9.4" />
          </clipPath>
        </defs>
        {/* The ink, clipped to the bowl and rising from its floor.
            The clip must live on a parent that does NOT move: a transform on
            the clipped element takes its clip with it, so translating the same
            node that carries clipPath slides the ink straight out of the bowl
            and leaves a blob hanging below the rim. */}
        <g clipPath="url(#vs-bowl)">
          <rect ref={inkRef} className="vs-ink" x="0" y="0" width="24" height="24" />
        </g>
        {/* the rim */}
        <circle className="vs-rim" cx="12" cy="12" r="9.4" />
        {/* the stroke that draws itself while the model arrives */}
        <circle className="vs-draw" cx="12" cy="12" r="9.4" />
      </svg>
    </span>
  );
}

/** One line of the received text. */
function Line({
  line,
  lead,
  big,
  current,
  near,
  inked,
  onSelect,
  register,
}: {
  line: ChantLine;
  lead: Lead;
  /** This line's unit is the one being chanted — set large. */
  big: boolean;
  /** This exact line is where the tracker says the voice is — carries the ink. */
  current: boolean;
  near: boolean;
  /** How many words the voice has reached, glided between windows. */
  inked: number;
  onSelect: () => void;
  register: (node: HTMLDivElement | null) => void;
}) {
  const primary = lead === "dev" ? line.devanagari : line.transliteration;
  const secondary = lead === "dev" ? line.transliteration : line.devanagari;

  // The ink is laid word by word, never glyph by glyph: a Devanagari cluster
  // must not be cut in half, and the word boundary is the only joint that is
  // safe in both scripts. It also survives a line that wraps.
  // The word index is worked out up front rather than counted during the map.
  // A counter mutated inside render is a different value on every pass, which
  // React now rejects outright — and rightly, since the ink would drift.
  const words = useMemo(
    () =>
      primary
        .split(/(\s+)/)
        .reduce<{ text: string; gap: boolean; spoken: number }[]>((sofar, text) => {
          const gap = /^\s*$/.test(text);
          const previous = sofar.length ? sofar[sofar.length - 1].spoken : -1;
          return [...sofar, { text, gap, spoken: gap ? previous : previous + 1 }];
        }, []),
    [primary],
  );

  const total = words.filter((w) => !w.gap).length;
  const reached = Math.max(0, Math.min(total - 1, inked));

  return (
    <div
      ref={register}
      className={`vs-ln ${big ? "vs-big" : ""} ${current ? "vs-current" : ""} ${near ? "vs-near" : ""}`}
      onClick={onSelect}
    >
      <div
        className="vs-leadtext"
        data-lead-text=""
        lang={lead === "dev" ? "sa" : "sa-Latn"}
      >
        {words.map((word, index) => {
          if (word.gap) return word.text;
          if (!current) return <span key={index}>{word.text}</span>;
          const inked = word.spoken < reached;
          const now = word.spoken === reached;
          return (
            <span
              key={index}
              className={inked ? "vs-inked" : now ? "vs-nowword" : undefined}
              // The word being spoken carries a wet edge rather than a hard
              // cut. Its position rides --glide, so it moves every frame
              // instead of once per window.
              style={
                now
                  ? ({
                      "--wp": `calc((var(--glide, 0) * ${total} - ${reached}) * 100%)`,
                    } as unknown as React.CSSProperties)
                  : undefined
              }
            >
              {word.text}
            </span>
          );
        })}
      </div>

      {/* The second script is shown for the whole unit — reading half a couplet
          romanised and half not would be worse than showing neither. The
          progress rule belongs only to the line actually being chanted. */}
      {big ? (
        <div className="vs-second" lang={lead === "dev" ? "sa-Latn" : "sa"}>
          {secondary}
        </div>
      ) : null}
      {/* The rule under the line is a pure width, so it is driven straight
          from --glide at frame rate and never re-renders at all. */}
      {current ? (
        <div className="vs-prog">
          <i />
        </div>
      ) : null}
    </div>
  );
}

function Control({
  label,
  note,
  children,
}: {
  label: string;
  /** Set when the control is present but the thing behind it is not yet. */
  note?: string;
  children: React.ReactNode;
}) {
  const ref = useSlider();
  return (
    <div className="vs-ctrl">
      <span className="vs-k">{label}</span>
      <span className="vs-v" ref={ref as React.RefObject<HTMLSpanElement>}>
        {children}
      </span>
      {note ? <span className="vs-note">{note}</span> : null}
    </div>
  );
}

function Choice({
  on,
  onClick,
  devanagari,
  children,
}: {
  on: boolean;
  onClick: () => void;
  devanagari?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-on={on}
      className={`${on ? "vs-on" : ""} ${devanagari ? "vs-dev" : ""}`}
    >
      {children}
    </button>
  );
}

// Kept beside the markup rather than in globals.css: this is one page's
// composition, not a site-wide system, and the palette is driven by inline
// custom properties above so nothing here needs to know which light is on.
const CSS = `
.vs-stage{
  --dev: var(--font-devanagari, "Kohinoor Devanagari","ITF Devanagari","Devanagari Sangam MN","Devanagari MT","Noto Serif Devanagari",serif);
  --book: "Iowan Old Style","Palatino","Palatino Linotype","Hoefler Text",Charter,Georgia,serif;
  /* Marginalia are set in the text family, as they are in a book. There is no
     sans on this page: hierarchy comes from size, italic and colour, which is
     how a printed page has always done it. */
  --marg: var(--book);
  height:100dvh; min-height:640px; display:flex; flex-direction:column;
  padding:22px 60px 18px; gap:0;
  background:var(--page); color:var(--ink);
  font-family:var(--marg); font-size:16px;
  transition:background .5s ease, color .5s ease;
  overflow:hidden;
}
.vs-stage button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;text-align:left;padding:0}

.vs-head{display:flex; align-items:flex-start; gap:48px; padding-bottom:10px; border-bottom:1px solid var(--rule)}
.vs-work{flex:1; min-width:0}
.vs-lib{display:inline-flex; align-items:center; gap:7px; font-size:15px; font-style:italic; color:var(--blue); margin-bottom:5px; opacity:.9}
.vs-lib svg{width:13px; height:9px; flex:none; overflow:visible}
.vs-lib:hover{opacity:1}
.vs-title{display:flex; align-items:baseline; gap:14px; flex-wrap:wrap}
.vs-sa{font-family:var(--dev); font-size:21px; line-height:1.5}
.vs-ia{font-family:var(--book); font-size:17px; font-style:italic; color:var(--ink2)}
.vs-nav{margin-top:6px; display:flex; flex-direction:column; gap:2px}
.vs-navrow{display:flex; align-items:baseline; gap:0; font-size:14px; flex-wrap:wrap; position:relative}
.vs-lbl{font-size:14px; font-style:italic; color:var(--ink2); margin-right:14px; min-width:80px}
.vs-navrow button{color:var(--blue); opacity:.5; padding:0 7px 2px}
.vs-navrow button:hover{opacity:.9}
.vs-navrow button.vs-here{color:var(--ink); opacity:1; font-weight:600}
.vs-navrow button[data-on="true"]{opacity:1}

.vs-state{width:290px; flex:none; display:flex; gap:13px; align-items:flex-start}
/* ---- the ink well -------------------------------------------------------
   One material in four states, where there used to be four unrelated rules
   with nothing between them. Everything below interpolates, so no change is
   ever a cut. --------------------------------------------------------------- */
.vs-mark{width:23px;height:23px;flex:none;margin-top:2px;display:block}
.vs-well{width:100%;height:100%;overflow:visible;display:block;
  transition:transform 420ms var(--ease)}
.vs-rim{fill:none; stroke:var(--ink3); stroke-width:1.5;
  transition:stroke 520ms var(--ease), opacity 520ms var(--ease)}

/* The ink. --ink is written from an animation frame, 0 at the floor of the
   bowl and 1 at its lip; the fill is a full square clipped to the circle, so
   the surface of the ink is always a straight line across a round vessel. */
.vs-ink{--ink:0; fill:var(--saffron-full);
  transform-box:view-box;
  transform:translateY(calc((1 - var(--ink)) * 100%));
  transition:fill 520ms var(--ease), opacity 520ms var(--ease)}
.vs-draw{fill:none; stroke:var(--blue); stroke-width:1.6; stroke-linecap:round;
  /* 2πr, so the dash is the circumference and the offset is a full lap */
  stroke-dasharray:59; stroke-dashoffset:59; opacity:0;
  transform-origin:50% 50%}

[data-condition="idle"] .vs-ink{opacity:0}
[data-condition="idle"] .vs-rim{stroke:var(--ink3)}

/* Arriving. The stroke is real progress — the model genuinely is loading —
   so it laps rather than pulses, and it stops the instant listening begins. */
[data-condition="locating"] .vs-rim{stroke:var(--blue); opacity:.35}
[data-condition="locating"] .vs-ink{opacity:0}
[data-condition="locating"] .vs-draw{opacity:1;
  animation:vs-lap 1.5s cubic-bezier(.62,0,.38,1) infinite, vsturn 3s linear infinite}

/* Listening. The ink is at the level the room actually is, and the whole well
   breathes underneath it so the mark is alive even in a silence. */
[data-condition="following"] .vs-rim{stroke:var(--saffron-full)}
[data-condition="following"] .vs-ink{opacity:1}
[data-condition="following"] .vs-well{animation:vsbreathe 4.4s ease-in-out infinite}

/* Held. The ink pales and settles: the voice stopped, the place is kept. */
[data-condition="holding"] .vs-rim{stroke:var(--saffron-full); opacity:.75}
[data-condition="holding"] .vs-ink{opacity:.34; fill:var(--saffron-full)}

@keyframes vsturn{to{transform:rotate(360deg)}}
@keyframes vsbreathe{0%,100%{transform:scale(.93)}50%{transform:scale(1)}}
@keyframes vs-lap{
  0%{stroke-dashoffset:59}
  55%{stroke-dashoffset:0}
  100%{stroke-dashoffset:-59}
}

/* Pressing it. The nib is put to the paper before any ink moves — 90 ms, the
   shortest thing on the page, because acknowledgement that arrives late reads
   as latency rather than as response. */
/* ---- the key --------------------------------------------------------------
   It read as a line of text before, and the one thing a first-time visitor
   has to do was the quietest thing on the screen.

   It is a key now, and a latching one: UP when nothing is being heard, and
   held DOWN for as long as it is listening. The state of the app is the
   physical state of the object, the way it is on a tape recorder — you can
   tell across a room whether it is running without reading a word.

   The depth is the side of a solid thing rather than a decorative offset
   shadow, so it collapses when the key goes down; the soft shadow under it is
   the light, and that is what carries blur. Pressing costs 90 ms, the fastest
   thing on the page, because acknowledgement arriving late reads as latency.
   -------------------------------------------------------------------------- */
.vs-stage .vs-key{
  --depth:5px;
  position:relative; display:inline-block; margin-top:11px;
  padding:9px 17px 10px; border-radius:3px;
  font-family:var(--book); font-size:16px; letter-spacing:.01em;
  color:var(--key-face); background:var(--saffron-full);
  box-shadow:0 var(--depth) 0 var(--key-side), 0 calc(var(--depth) + 3px) 9px var(--key-well);
  transition:transform 90ms var(--ease), box-shadow 90ms var(--ease),
             background 320ms var(--ease), color 320ms var(--ease);
}
.vs-stage .vs-key:hover:not(:disabled){--depth:6px}
.vs-stage .vs-key:active:not(:disabled){
  transform:translateY(var(--depth));
  box-shadow:0 0 0 var(--key-side), 0 1px 3px var(--key-well);
}
.vs-stage .vs-key:focus-visible{outline:2px solid var(--blue); outline-offset:3px}
/* Held down for as long as it is listening. */
.vs-stage .vs-key[data-live="true"]{
  background:var(--saffron-pale); color:var(--ink);
  transform:translateY(var(--depth));
  box-shadow:0 0 0 var(--key-side), inset 0 1px 3px var(--key-well);
}
.vs-stage .vs-key[data-live="true"]:active:not(:disabled){transform:translateY(calc(var(--depth) + 1px))}
.vs-stage .vs-key:disabled{opacity:.6; cursor:default}
.vs-state:has(.vs-key:active) .vs-well{transform:scale(.86)}

/* ---- the words -----------------------------------------------------------
   Every state is rendered and stacked in one grid cell, and only opacity and
   transform change between them. Two consequences, and the first is the whole
   point:

   The cell is sized by the tallest state, so the block never reflows and the
   control below it never moves. Cross-fading text that also changes the height
   of its container is not a cross-fade, it is a jump with a fade painted over
   it — the eye tracks the movement and ignores the opacity entirely.

   And because nothing remounts, an interrupted change reverses from wherever
   it had reached rather than restarting. Pressing the control twice quickly
   used to fight itself.
   -------------------------------------------------------------------------- */
.vs-txt{flex:1; min-width:0}
.vs-says{display:grid}
.vs-say{
  grid-area:1 / 1; opacity:0; transform:translateY(-5px);
  transition:opacity 400ms var(--ease), transform 400ms var(--ease);
  pointer-events:none;
}
.vs-say[data-on="true"]{opacity:1; transform:none; pointer-events:auto}
/* Leaving is quicker than arriving, so the two never read as a dissolve
   between two equally-present things. */
.vs-say:not([data-on="true"]){transition-duration:220ms}
.vs-labels{justify-items:start}
.vs-stage .vs-key .vs-say{transition-duration:260ms}

/* ---- the travelling underline -------------------------------------------
   One mark per group, moved to whichever choice is active, rather than a
   border on the choice itself. A border cannot travel between elements; it
   can only stop being drawn on one and start on another, which is exactly
   what "it instantly transports" was.

   Width eases a touch faster than position, so the line settles into its new
   length just after it arrives rather than stretching the whole way — a rule
   that resizes while travelling reads as rubber, and this world is ink.

   It travels only within a row. Moving between Namakam and Chamakam is a
   change of line rather than a journey along one, so the mark is simply
   somewhere else: data-jump suppresses the transition for exactly that
   frame. --------------------------------------------------------------- */
.vs-navrow::after, .vs-v::after{
  content:""; position:absolute; left:0; top:0;
  width:var(--w,0); height:2px; background:var(--saffron-full);
  opacity:var(--o,0);
  transform:translate(var(--x,0), var(--y,0));
  transition:transform 420ms var(--ease), width 340ms var(--ease);
  pointer-events:none;
}
.vs-navrow[data-jump]::after, .vs-v[data-jump]::after{transition:none}
.vs-v::after{height:1.5px}

/* Spoken, not shown — the stack above is hidden from assistive tech. */
.vs-sr{position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0}
.vs-word{font-family:var(--book); font-size:20px; line-height:1.25}
.vs-sub{font-size:13px; color:var(--ink2); margin-top:4px; line-height:1.5}

.vs-loading{padding:10px 0 0; font-size:13px; color:var(--ink2)}
.vs-bar{height:1.5px; background:var(--rule-soft); margin-top:6px; position:relative}
.vs-bar i{position:absolute; left:0; top:0; bottom:0; background:var(--blue); opacity:.6; transition:width .3s}
.vs-failed{padding:10px 0 0; font-size:13px; color:#B3261E}

.vs-middle{flex:1; min-height:0; display:grid; grid-template-columns:70px 1fr 290px; gap:40px; padding:14px 0 0}

.vs-measure{display:flex; flex-direction:column; min-height:0}
.vs-cap{font-size:13px; color:var(--ink2); text-align:right; margin-bottom:10px; font-variant-numeric:oldstyle-nums}
.vs-stack{flex:1; display:flex; flex-direction:column; gap:5px; min-height:0}
.vs-trow{flex:1; display:flex; align-items:center; justify-content:flex-end; min-height:5px}
.vs-tick{height:1.5px; background:var(--blue); opacity:.38; width:12px; transition:width .3s, opacity .3s, background .3s; display:block}
.vs-trow.vs-done .vs-tick{opacity:.72; width:18px}
.vs-trow.vs-now .vs-tick{opacity:1; width:40px; height:2.5px; background:var(--saffron-full)}
.vs-trow:hover .vs-tick{opacity:.9; width:24px}
.vs-foot{font-size:13px; color:var(--ink2); text-align:right; margin-top:10px; font-variant-numeric:oldstyle-nums}

.vs-vessel{display:flex; flex-direction:column; min-width:0}
.vs-hr{height:1px; background:var(--rule); flex:none}
.vs-window{flex:1; min-height:0; position:relative; background:var(--paper); transition:background .5s ease}
/* A real scroll container. It was a transform under a fixed window, which
   could not be scrolled by hand at all — no wheel, no trackpad, no touch, no
   keyboard, no scrollbar. Native overflow gets every one of those free. */
.vs-clip{position:absolute; inset:0; overflow-y:auto; overscroll-behavior:contain;
  scroll-behavior:smooth;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 88%,transparent 100%);
          mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 88%,transparent 100%)}
.vs-clip:focus-visible{outline:1px solid var(--blue); outline-offset:-1px}
.vs-clip::-webkit-scrollbar{width:9px}
.vs-clip::-webkit-scrollbar-track{background:transparent}
.vs-clip::-webkit-scrollbar-thumb{background:var(--rule); border-radius:5px}
/* the tail of padding is what lets the last line reach the anchor */
.vs-scroll{padding:18px 30px 46vh}
.vs-unit{padding:11px 0}
/* Where one section ends and the next begins. A rule the full width of the
   paper, so it cannot be mistaken for the thin progress rule under a line,
   with the section named on it — scrolling through 303 lines otherwise gives
   no sense of having crossed anything. A new WORK is a heavier statement than
   a new anuvaka within one, so it gets weight and space rather than a
   different colour. */
/* The RULE carries the weight, not the words.
   A section head that shouts competes with the scripture it introduces, and
   the reader needs it in peripheral vision while scrolling, not in the centre
   of attention while chanting. So the label stays quiet and italic in the text
   colour, and a new work is marked by a heavier, wider rule instead of louder
   type. */
.vs-divider{
  display:flex; align-items:center; gap:13px;
  margin:30px 0 20px; color:var(--ink2);
  font-size:14px; font-style:italic; letter-spacing:.01em;
}
.vs-divider::before, .vs-divider::after{content:""; height:1px; background:var(--rule-soft); flex:1}
.vs-divider::before{flex:0 0 18px}
.vs-divider span{flex:none}
.vs-divider[data-work-start="yes"]{margin:46px 0 28px; color:var(--ink)}
.vs-divider[data-work-start="yes"]::before,
.vs-divider[data-work-start="yes"]::after{height:1px; background:var(--rule)}
.vs-divider[data-work-start="yes"]::before{flex:0 0 44px}
/* The first section is already named by the running head two inches above it.
   Printing it again is the page captioning itself. */
.vs-scroll > div:first-child .vs-divider{display:none}
.vs-ln{cursor:pointer; padding:2px 0}
.vs-leadtext{font-size:calc(25px * var(--scale)); line-height:1.9; color:var(--ink3); transition:color .45s ease, font-size .3s ease}
.vs-ln.vs-near .vs-leadtext{color:var(--ink2)}
[data-lead="dev"] .vs-leadtext{font-family:var(--dev)}
[data-lead="ia"]  .vs-leadtext{font-family:var(--book); line-height:1.6}
[data-lead="dev"] .vs-second{font-family:var(--book); font-style:italic}
[data-lead="ia"]  .vs-second{font-family:var(--dev)}

/* The UNIT goes big, not the line. A couplet is chanted as one thing, so
   setting half of it large and half small breaks the object being read. */
.vs-ln.vs-big{padding:6px 0 0}
.vs-ln.vs-big .vs-leadtext{font-size:calc(44px * var(--scale)); line-height:1.85; color:var(--ink)}
[data-lead="ia"] .vs-ln.vs-big .vs-leadtext{font-size:calc(41px * var(--scale)); line-height:1.55}
/* A group held together because it is one breath — the closing salutation runs
   to four lines — is set smaller so the whole of it is on the paper at once.
   Sized by how many lines it has rather than by measuring after layout, which
   is deterministic and cannot disagree with itself between renders. */
.vs-unit[data-lines="3"] .vs-ln.vs-big .vs-leadtext{font-size:calc(35px * var(--scale))}
.vs-unit[data-lines="4"] .vs-ln.vs-big .vs-leadtext{font-size:calc(29px * var(--scale)); line-height:1.75}

.vs-inked{color:var(--saffron)}
.vs-nowword{
  background-image:linear-gradient(90deg,
    var(--saffron) 0 calc(var(--wp,0%) - 4px),
    var(--ink) calc(var(--wp,0%) + 9px) 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.vs-second{display:block; margin-top:6px; font-size:calc(19px * var(--scale)); line-height:1.9; color:var(--ink2)}
.vs-prog{display:block; margin-top:11px; height:2px; background:var(--rule-soft); position:relative}
.vs-prog i{position:absolute; left:0; top:0; bottom:0; background:var(--saffron-full);
  width:calc(var(--glide, 0) * 100%)}

.vs-margin{min-height:0; position:relative; display:flex; flex-direction:column}
.vs-gloss{flex:1; min-height:0}
.vs-gloss .vs-lbl{display:block; margin-bottom:9px; min-width:0}
.vs-ref{font-family:var(--book); font-size:16px; color:var(--ink2); margin-bottom:9px}
.vs-en{font-family:var(--book); font-size:18px; line-height:1.62}
.vs-none{font-family:var(--book); font-size:15px; line-height:1.6; color:var(--ink2); font-style:italic}
.vs-seal{margin-top:auto; text-align:right}
.vs-sealrow{display:flex; align-items:center; gap:14px; justify-content:flex-end}
.vs-seal img{width:62px;height:62px;display:block;flex:none}
.vs-who{font-size:12px; line-height:1.7; letter-spacing:.11em; text-transform:uppercase; color:var(--blue); font-variant-numeric:oldstyle-nums}
.vs-values{margin-top:9px; font-family:var(--book); font-style:italic; font-size:13px; color:var(--ink2)}

.vs-import{
  flex:none; margin-top:14px; padding:13px 16px;
  border:1px solid var(--rule); background:var(--paper);
  display:flex; gap:20px; align-items:flex-start; justify-content:space-between;
  font-family:var(--book); font-size:15px; line-height:1.6; color:var(--ink2);
}
.vs-import strong{color:var(--ink); font-weight:600}
.vs-import button{
  flex:none; font-size:15px; font-style:italic; color:var(--blue);
}
.vs-colophon{flex:none; margin-top:12px; padding-top:10px; border-top:1px solid var(--rule);
  display:grid; grid-template-columns:1fr 290px; gap:40px; align-items:end;
  transition:opacity .45s ease, transform .45s ease}
[data-still="yes"] .vs-colophon{opacity:0; transform:translateY(6px); pointer-events:none}
.vs-ctrls{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px 26px}
.vs-ctrl{font-size:13px; line-height:1.5}
.vs-note{display:block; font-size:12px; font-style:italic; color:var(--ink3); margin-top:2px}
.vs-k{display:block; color:var(--ink2); margin-bottom:2px; font-size:13px; font-style:italic}
.vs-v{display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; position:relative}
.vs-v button, .vs-v span{font-size:15px; color:var(--ink2)}
.vs-v button:hover{color:var(--ink)}
.vs-v button.vs-on{color:var(--ink)}
.vs-v .vs-dev{font-family:var(--dev)}
.vs-select{font:inherit; font-size:15px; color:var(--ink2); background:none; border:0; border-bottom:1px solid var(--rule); max-width:150px}
.vs-model{font-size:13px; line-height:1.65; color:var(--ink2); text-align:right; font-style:italic}
.vs-modelnote{margin-top:4px}

/* ---------------------------------------------------------------------------
   THE PAGE BEING SET

   One authored moment, and it belongs to this world rather than to the web's:
   a page is composed text-block first and apparatus after. The sheet is laid,
   the impression lands on it, and only then do the margins compose around the
   text — measure drawing in from the spine edge, gloss and seal from the outer
   edge, colophon last.

   That order is the argument. Most pages animate their chrome in first and let
   the content arrive last; here the scripture IS the page and everything else
   is marginalia, so the marginalia wait.

   Blur is doing real work rather than decorating: type resolving out of a soft
   field is how an impression looks as it meets paper, and it is the one
   material that says "printed" instead of "moved". It is bounded to one region
   and 560 ms, and it never runs again.

   Nothing here gates on JavaScript and no animation fills forwards, so a sheet
   that fails to load leaves every element at its ordinary visible value rather
   than hiding the page. 820 ms end to end, and the Listen control is live from
   the first frame — this is an Operate surface and no one waits on it.
   --------------------------------------------------------------------------- */
@keyframes vs-sheet{from{opacity:0; transform:scaleX(.86)} to{opacity:1; transform:scaleX(1)}}
@keyframes vs-lay{from{background:var(--page)} to{background:var(--paper)}}
@keyframes vs-impress{
  from{opacity:0; transform:translateY(8px); filter:blur(3px)}
  to{opacity:1; transform:none; filter:blur(0)}
}
@keyframes vs-compose-in{from{opacity:0; transform:translateX(-7px)} to{opacity:1; transform:none}}
@keyframes vs-compose-out{from{opacity:0; transform:translateX(7px)} to{opacity:1; transform:none}}
@keyframes vs-settle{from{opacity:0; transform:translateY(5px)} to{opacity:1; transform:none}}

.vs-stage{--ease:cubic-bezier(.16,1,.3,1)}
.vs-hr{animation:vs-sheet 460ms var(--ease) backwards}
.vs-window{animation:vs-lay 460ms var(--ease) backwards}
.vs-scroll{animation:vs-impress 560ms var(--ease) 140ms backwards}
.vs-head{animation:vs-settle 420ms var(--ease) 260ms backwards}
.vs-measure{animation:vs-compose-in 420ms var(--ease) 320ms backwards}
.vs-margin{animation:vs-compose-out 420ms var(--ease) 360ms backwards}
.vs-colophon{animation:vs-settle 420ms var(--ease) 400ms backwards}

/* The audience skews older and this is a devotional instrument, so the
   preference is honoured completely — not softened to a shorter version of the
   same movement. The state disc stops breathing too; a pulse someone did not
   ask for is the thing this setting exists to turn off. */
@media (prefers-reduced-motion: reduce){
  .vs-hr, .vs-window, .vs-scroll, .vs-head,
  .vs-measure, .vs-margin, .vs-colophon{animation:none}
  .vs-well, .vs-draw{animation:none !important}
  .vs-say{transition:opacity 200ms linear}
  .vs-navrow::after, .vs-v::after{transition:opacity 200ms linear}
  /* The key keeps its travel: it is the state of the app, not an effect. */
  .vs-stage .vs-key{transition:transform 90ms linear, box-shadow 90ms linear}
  .vs-draw{opacity:1; stroke-dashoffset:15}
  .vs-clip{scroll-behavior:auto}
  .vs-scroll, .vs-prog i, .vs-tick, .vs-leadtext{transition:none}
}

@media (max-width:1240px){
  .vs-stage{padding:26px 32px 22px}
  .vs-middle{grid-template-columns:58px 1fr 250px; gap:26px}
  .vs-ctrls{grid-template-columns:repeat(3,minmax(0,1fr))}
  .vs-colophon{grid-template-columns:1fr 250px; gap:26px}
}
@media (max-width:960px){
  .vs-stage{height:auto; min-height:100dvh; overflow:auto; padding:20px 16px 26px}
  .vs-head{flex-direction:column; gap:18px}
  .vs-state{width:auto}
  .vs-middle{display:block; padding-top:18px}
  .vs-measure{display:none}
  .vs-window{height:46dvh; min-height:290px}
  .vs-scroll{padding:0 14px}
  .vs-leadtext{font-size:calc(20px * var(--scale)) !important}
  .vs-ln.vs-big .vs-leadtext{font-size:calc(30px * var(--scale)) !important}
  .vs-margin{margin-top:22px}
  .vs-seal{text-align:left}
  .vs-sealrow{justify-content:flex-start}
  .vs-colophon{grid-template-columns:1fr; gap:18px}
  .vs-ctrls{grid-template-columns:repeat(2,minmax(0,1fr))}
  .vs-model{text-align:left}
}
`;

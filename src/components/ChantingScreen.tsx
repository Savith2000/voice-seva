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
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
    "--well-sheen": "rgba(255,255,255,.55)",
  },
  dawn: {
    "--page": "#131110", "--paper": "#1C1917",
    "--ink": "#EDE6D8", "--ink2": "#A99C88", "--ink3": "#9C907D",
    "--blue": "#8FB3DC", "--rule": "rgba(143,179,220,.34)", "--rule-soft": "rgba(143,179,220,.18)",
    "--saffron": "#EE9A45", "--saffron-full": "#EE7900", "--saffron-pale": "rgba(238,154,69,.24)",
    "--key-side": "#7E3D00", "--key-face": "#20180F", "--key-well": "rgba(0,0,0,.42)",
    "--well-sheen": "rgba(255,255,255,.07)",
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

  const phone = usePhone();
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
  /**
   * Cadence the device actually achieved, whatever backend won the ladder.
   *
   * A ref rather than state: it is read once per animation frame by the glide
   * and its drift is gradual, so re-rendering three hundred lines to update it
   * would buy nothing. It carries the tracker's own pacing number — the first
   * version recomputed an approximation here (inferenceMs x 2, floored at a
   * different value than the tracker's) and the two could disagree; one
   * source, no drift.
   */
  const cadenceRef = useRef(250);

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
          // This is what makes the glide device-aware: a machine that found
          // an NPU reports a short interval and needs little filling in; one
          // on a single CPU thread reports a long one and needs a lot.
          cadenceRef.current = tick.intervalMs;
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
    cadenceRef,
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
      // The anchor sits higher on a phone. Centring works on a wide page
      // because the eye takes in the whole block at once; on a tall narrow
      // one the line being chanted wants the upper third, with what is coming
      // next below it — a reader needs to see forward, not behind.
      //
      // Math.max(0) is what lets the top of the chant sit at the top of the
      // paper: there is no phantom padding above the first line, so the paper
      // simply does not glide until there is something above it to glide.
      const anchor = phone ? 0.36 : 0.5;
      const target =
        unit.offsetTop + unit.offsetHeight / 2 - clip.clientHeight * anchor;
      clip.scrollTo({
        top: Math.max(0, target),
        behavior: smooth ? "smooth" : "auto",
      });
    },
    [active, autoScroll, phone],
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

  // Stable across renders so the memo on Line holds: an inline closure here
  // would hand every line a fresh prop and re-render all three hundred of
  // them each time the word-ink advances.
  const registerLine = useCallback((index: number, node: HTMLDivElement | null) => {
    lineRefs.current[index] = node;
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

  // --- the pieces both compositions are made of ----------------------------
  //
  // Named here rather than written inline twice, because the phone and the
  // page are the same instrument arranged differently: on the page the
  // sections sit under the running head, the gloss and the well in the margin,
  // and the controls along the foot; on a phone all of them live in the sheet.
  // Two copies of this markup is how the two would drift into behaving
  // differently, and only one of them would ever be tested.

  const navBlock = (
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
  );

  const crestBlock = (
    <div className="vs-crest">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/sssgc-usa.png"
        alt="Sri Sathya Sai Global Council, U.S.A."
        width={92}
        height={92}
      />
    </div>
  );

  const glossBlock =
    showGloss && glossVerse ? (
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
            No translation is loaded. A translation is an interpretation rather
            than a transcription — it needs a named edition rather than being
            filled in from memory.
          </div>
        )}
      </div>
    ) : null;

  // Every state is in the DOM at once, stacked in a single grid cell, so the
  // block is always the height of the tallest and nothing around it ever
  // moves — a control that relocates out from under the hand reaching for it
  // is the bug this construction exists to prevent.
  const stateBlock = (
    <div className="vs-state" data-shows={shows}>
      <WellButton
        shows={shows}
        level={session.level}
        live={running}
        busy={starting}
        onToggle={
          running || starting
            ? () => void session.stop()
            : () => void session.start("mic", { deviceId: deviceId || undefined })
        }
      />
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
        {/* The stack is hidden from assistive tech; this is the one voice that
            speaks, and only when the state actually changes. */}
        <p className="vs-sr" role="status">
          {STATE_WORDS[shows].word} {STATE_WORDS[shows].sub}
        </p>
      </div>
    </div>
  );

  const controlsBlock = (
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
          {phone ? "Shown" : "In margin"}
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

      {/* Named for what a reader already knows rather than for the scene they
          are in. "Lamp" and "Before dawn" described the hour; these describe
          the setting, which is the thing being chosen. */}
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

      {/* A phone has no window to fill and iOS has no Fullscreen API on
          iPhone at all, so the control is not offered where it cannot work. */}
      {phone ? null : (
        <Control label="Full screen">
          <Choice on={false} onClick={toggleFullScreen}>
            Enter
          </Choice>
        </Control>
      )}

      <Control label="Library" note="Coming soon">
        <Choice on={showImport} onClick={() => setShowImport((on) => !on)}>
          Add a chant · PDF
        </Choice>
      </Control>
    </div>
  );

  return (
    <div
      ref={stageRef}
      className="vs-stage"
      data-light={light}
      data-lead={lead}
      data-phone={phone ? "yes" : "no"}
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

          {/* The sections live in the sheet on a phone. */}
          {phone ? null : navBlock}
        </div>

        {/* The council's emblem, set at the head of the page like a crest on
            letterhead. The listening instrument that sat here now lives at the
            foot of the margin, where the printer's seal used to be — the owner
            swapped them. The emblem carries its own name and values in its
            ring, so no caption repeats them. */}
        {phone ? null : crestBlock}
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
              style={
                {
                  "--fill":
                    session.progress.fraction === null
                      ? 0.33
                      : session.progress.fraction,
                } as unknown as React.CSSProperties
              }
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
                          index={index}
                          lead={lead}
                          big={here}
                          current={index === active}
                          near={!here && Math.abs(index - active) <= 3}
                          inked={index === active ? inked : 0}
                          onSelect={selectLine}
                          register={registerLine}
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

        {/* On a phone the margin has nowhere to be: its gloss and its
            instrument are in the sheet, and the reading surface takes the
            whole width. */}
        {phone ? null : (
          <aside className="vs-margin">
            {glossBlock}
            {stateBlock}
          </aside>
        )}
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
      {phone ? (
        <PhoneSheet peek={stateBlock}>
          {navBlock}
          {glossBlock}
          {controlsBlock}
          <div className="vs-sfoot">
            {crestBlock}
            <div className="vs-model">
              Voice model · downloaded once, then kept on this device
              <div className="vs-modelnote">
                {running && session.phase.kind === "running"
                  ? `Listening · ${session.phase.device}. No audio leaves this device.`
                  : "No audio leaves this device."}
              </div>
            </div>
          </div>
        </PhoneSheet>
      ) : (
      <footer className="vs-colophon">
        {controlsBlock}

        <div className="vs-model">
          Voice model · downloaded once, then kept on this device
          <div className="vs-modelnote">
            {running && session.phase.kind === "running"
              ? `Listening · ${session.phase.device}. No audio leaves this device.`
              : "No audio leaves this device."}
          </div>
        </div>
      </footer>
      )}
    </div>
  );
}

/**
 * Is this a phone?
 *
 * Asked in JavaScript rather than answered in CSS because the two layouts are
 * not the same composition at different widths — on a phone the controls, the
 * section navigation, the gloss and the crest all live inside a sheet that
 * does not exist on the desktop page, and CSS cannot move a node to a new
 * parent. So the phone renders its own chrome and the desktop's is not
 * rendered at all: one well, one set of controls, one animation frame loop.
 *
 * 760px rather than the old 960: a tablet in landscape is a small desktop and
 * should keep the margin and the measure.
 */
const PHONE = "(max-width: 760px)";

/**
 * Read synchronously during render, not set from an effect.
 *
 * The first version held this in state and filled it in from an effect, and
 * on the owner's iPhone the page came up as the desktop composition squeezed
 * into 390 px — the media queries had plainly worked, because the controls
 * were in their narrow arrangement, but the attribute this branch keys on was
 * still "no". An effect that does not run, runs late, or runs after a failed
 * hydration leaves the layout permanently wrong, and there is no way for the
 * page to notice.
 *
 * useSyncExternalStore reads the match during render on the client, so the
 * first painted frame is already right and no effect has to arrive to rescue
 * it. The server snapshot is false because a server has no viewport; that is
 * also why the stylesheet carries a narrow-width floor (see the CSS), so the
 * markup rendered before JavaScript is readable rather than a heap.
 */
function usePhone(): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const query = window.matchMedia(PHONE);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/**
 * The sheet: the foot of the page, and everything the page keeps under it.
 *
 * Collapsed it is not a card floating over the reading surface — it IS the
 * foot of the paper, the same stock, parted by the same hairline rule that
 * parts everything else in this book, holding exactly the instrument and the
 * state words. The sheet grammar arrives only as it rises: `--lift` runs 0→1
 * with the drag, and the corners round and the shadow grows out of it. A
 * rounded card at rest leaves two wedges of not-paper at its top corners,
 * which is the thing an eye catches and calls unfinished.
 *
 * The travel is a transform on a fixed element, so the reading surface never
 * reflows while it moves, and the drag writes straight to the DOM rather than
 * through React — a finger moves far more often than sixty times a second and
 * none of it is worth re-rendering three hundred lines of scripture.
 */
function PhoneSheet({
  peek,
  children,
}: {
  peek: React.ReactNode;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const peekRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef<HTMLButtonElement | null>(null);

  /** How far down the sheet sits when collapsed. Measured, never assumed. */
  const shut = useRef(0);
  const at = useRef(0);
  /** Velocity, px per second. Carried across a flick into the settle. */
  const vel = useRef(0);
  const drag = useRef({ active: false, from: 0, base: 0, moved: 0, at: 0, vel: 0 });
  const raf = useRef(0);
  /**
   * Whether the sheet is up — a ref, and deliberately not React state.
   *
   * Two separate faults came from holding it in state, and together they were
   * the whole of "it just jumps up rather than moving smoothly".
   *
   * The first: the measurement effect listed it as a dependency, so every
   * toggle re-ran the measurement, which ends by PLACING the sheet at its
   * target. The sheet arrived instantly and the settle had nothing left to
   * animate.
   *
   * The second outlived that fix and was the larger one. Setting state here
   * re-renders a component holding three hundred lines of scripture, and that
   * reconciliation takes long enough to push out the first animation frame —
   * measured at about 55 ms, so the spring's opening step covered a fifth of
   * the travel in one go and the movement began with a lurch. Nothing about
   * raising a sheet requires React to re-render anything: the position is a
   * transform, the label is one attribute, and both are written straight to
   * the DOM.
   */
  const openRef = useRef(false);

  const put = useCallback((y: number) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const clamped = Math.max(0, Math.min(shut.current, y));
    at.current = clamped;
    sheet.style.transform = `translateY(${clamped.toFixed(1)}px)`;
    const lift = shut.current > 0 ? 1 - clamped / shut.current : 0;
    sheet.style.setProperty("--lift", lift.toFixed(3));
    if (scrimRef.current) {
      scrimRef.current.style.opacity = (0.42 * lift).toFixed(3);
      scrimRef.current.style.pointerEvents = lift > 0.4 ? "auto" : "none";
    }
    if (bodyRef.current) {
      // The contents fade in behind the movement rather than with it, so a
      // half-open sheet reads as a sheet arriving, not as text sliding.
      bodyRef.current.style.opacity = Math.max(0, (lift - 0.15) / 0.85).toFixed(3);
      bodyRef.current.style.pointerEvents = lift > 0.85 ? "auto" : "none";
    }
  }, []);

  /**
   * Settle to a position — critically damped, and it carries the flick.
   *
   * This was an exponential lag (`x += (target - x) * k`), which is the reflex
   * and is wrong for a drawer: exponential decay leaves rest at its highest
   * speed and only ever slows down, so the sheet snapped away from the finger
   * and crept the last few pixels. A drawer accelerates out of rest.
   *
   * A critically damped spring does both — it eases out of rest and into the
   * stop — and critically damped means exactly zero overshoot, so it settles
   * rather than bounces. That distinction is the page's own rule and it is not
   * a matter of taste here: this is a screen someone is looking at mid-prayer,
   * and a bounce is a flourish they did not ask for.
   *
   * Because it is a spring rather than a curve, an interrupted movement is
   * simply the same spring with the velocity it already had, and a flick hands
   * its own speed to the settle instead of being thrown away and restarted.
   */
  const glideTo = useCallback(
    (target: number) => {
      cancelAnimationFrame(raf.current);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      if (reduced) {
        vel.current = 0;
        put(target);
        return;
      }
      // Natural frequency, radians per second. ~13 settles a full-height sheet
      // in a little over 400 ms, the band this page uses for a layout change.
      const OMEGA = 13;
      // Established on the first frame rather than now, and this is the
      // difference between a movement and a lurch.
      //
      // The frame that first reveals the sheet is expensive: everything under
      // it — twenty-four section buttons, the controls, the gloss — has been
      // sitting off the bottom of the screen unpainted, and it all has to be
      // rasterised before anything can move. Measured here at about 55 ms. A
      // spring told that 55 ms had passed does the honest thing and covers a
      // fifth of the travel in that one step, which is precisely the jump this
      // was reported as. So the first frame only starts the clock; the spring
      // begins on the second, when the browser is actually able to animate.
      let last = 0;
      const step = (now: number) => {
        if (last === 0) {
          last = now;
          raf.current = requestAnimationFrame(step);
          return;
        }
        // And a later hitch stretches the settle rather than teleporting
        // through it: at most a frame and a half of travel in any one frame.
        const dt = Math.min(0.025, (now - last) / 1000);
        last = now;

        // Advanced along the spring's exact solution rather than by stepping
        // its acceleration. Integrating the acceleration is the obvious way
        // and it is unstable here: a dropped frame makes omega*dt approach 1,
        // the step overshoots the target, and the sheet visibly stutters
        // backwards on its way — which is what the first attempt did, and it
        // looked worse than the jump it was written to fix. The closed form
        // for a critically damped spring is stable at any timestep and can
        // never overshoot, so a slow frame costs smoothness and nothing else.
        const x0 = at.current - target;
        const c = vel.current + OMEGA * x0;
        const decay = Math.exp(-OMEGA * dt);
        const offset = (x0 + c * dt) * decay;
        vel.current = (c - OMEGA * (x0 + c * dt)) * decay;

        const next = target + offset;
        // Settled: near enough and slow enough that another frame would move
        // it less than a pixel.
        if (Math.abs(offset) < 0.4 && Math.abs(vel.current) < 14) {
          vel.current = 0;
          put(target);
          return;
        }
        put(next);
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [put],
  );

  // Measured from the real peek, so a taller status line or a safe-area inset
  // can never strand the bar off the bottom of the screen.
  useEffect(() => {
    const measure = () => {
      const sheet = sheetRef.current;
      const peekEl = peekRef.current;
      if (!sheet || !peekEl) return;
      shut.current = Math.max(0, sheet.offsetHeight - peekEl.offsetHeight);
      // Published on the STAGE, not on the sheet: the reading surface is not a
      // descendant of the sheet, so a property set here would never reach it
      // and the paper would end at a guessed height instead of the real one.
      sheet
        .closest<HTMLElement>(".vs-stage")
        ?.style.setProperty("--peek", `${peekEl.offsetHeight}px`);
      // Placed without animating, because this runs when the SIZE changed —
      // a rotation, a keyboard, a safe-area shift — and re-deriving where the
      // sheet sits is not a movement anyone asked to watch.
      put(openRef.current ? 0 : shut.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (peekRef.current) observer.observe(peekRef.current);
    if (sheetRef.current) observer.observe(sheetRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(raf.current);
    };
  }, [put]);

  const toggle = useCallback(
    (next: boolean) => {
      openRef.current = next;
      grabRef.current?.setAttribute("aria-expanded", String(next));
      grabRef.current?.setAttribute(
        "aria-label",
        next ? "Close settings" : "Open settings",
      );
      glideTo(next ? 0 : shut.current);
    },
    [glideTo],
  );

  const down = (event: React.PointerEvent) => {
    // A control inside the peek is a control, not a handle.
    //
    // The whole peek listens for the drag, so that the bar can be pulled from
    // anywhere along it. That swallowed the one thing the bar exists to hold:
    // pressing the well started a drag, the release was read as a tap on the
    // bar, and the sheet opened instead of the session starting. The button a
    // reader came to press must always win over the surface it sits on.
    const target = event.target as HTMLElement;
    if (target.closest("button, select, a, input, label") && !target.closest(".vs-grab")) {
      return;
    }
    cancelAnimationFrame(raf.current);
    vel.current = 0;
    drag.current = {
      active: true,
      from: event.clientY,
      base: at.current,
      moved: 0,
      at: event.timeStamp,
      vel: 0,
    };
    try {
      // Throws if the pointer is already gone — a fast tap, or a touch the
      // browser cancelled out from under us. Capturing is an optimisation for
      // the drag, not a precondition for it, so it must never take the
      // handler down with it.
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      /* the drag still tracks through the move handler */
    }
  };

  const move = (event: React.PointerEvent) => {
    if (!drag.current.active) return;
    const dy = event.clientY - drag.current.from;
    // Pixels per second, so the flick can be handed to the spring in the units
    // the spring thinks in.
    const elapsed = Math.max(1, event.timeStamp - drag.current.at);
    drag.current.vel = ((drag.current.base + dy - at.current) / elapsed) * 1000;
    drag.current.at = event.timeStamp;
    drag.current.moved = dy;
    put(drag.current.base + dy);
  };

  const up = () => {
    if (!drag.current.active) return;
    const { moved, vel: thrown } = drag.current;
    drag.current.active = false;
    // A tap counts. So does a flick, in the direction it was flicked — and the
    // speed it was flicked at is handed to the settle rather than discarded,
    // so a fast pull arrives fast and a slow one drifts home.
    vel.current = Math.max(-4000, Math.min(4000, thrown));
    if (Math.abs(moved) < 5) {
      vel.current = 0;
      toggle(at.current > shut.current / 2);
      return;
    }
    if (Math.abs(thrown) > 320) {
      toggle(thrown < 0);
      return;
    }
    toggle(at.current < shut.current / 2);
  };

  return (
    <>
      <div
        className="vs-scrim"
        ref={scrimRef}
        onClick={() => toggle(false)}
        aria-hidden="true"
      />
      <div className="vs-sheet" ref={sheetRef}>
        <div
          className="vs-peek"
          ref={peekRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <button
            type="button"
            className="vs-grab"
            ref={grabRef}
            aria-expanded={false}
            aria-label="Open settings"
            onClick={(event) => {
              // The pointer handlers above already decided a tap; this exists
              // so a keyboard reaches the same place. `detail === 0` is how a
              // keyboard-generated click identifies itself.
              if (event.detail === 0) toggle(!openRef.current);
            }}
          >
            <i />
          </button>
          {peek}
        </div>
        <div className="vs-sbody" ref={bodyRef}>
          {children}
        </div>
      </div>
    </>
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
  cadenceRef,
  live,
}: {
  progress: number;
  updatedAt: number;
  line: number;
  words: number;
  /** The tracker's own pacing, read once per frame. See where it is set. */
  cadenceRef: React.RefObject<number>;
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
  /** What was actually rendered last frame — the glide chases from here. */
  const shownRef = useRef(0);
  const latest = useRef({ progress, updatedAt, line, words, live });
  // Refreshed in an effect rather than during render, so the frame loop sees
  // the newest values without being torn down to get them.
  useEffect(() => {
    latest.current = { progress, updatedAt, line, words, live };
  }, [progress, updatedAt, line, words, live]);

  useEffect(() => {
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;

    let frame = 0;
    let lastFrameAt = 0;
    const tick = (frameAt: number) => {
      frame = requestAnimationFrame(tick);
      const stage = stageRef.current;
      const now = latest.current;
      const frameMs = lastFrameAt ? frameAt - lastFrameAt : 0;
      lastFrameAt = frameAt;
      if (!stage) return;

      if (now.line !== anchor.current.line) {
        // A new line is a jump, not a journey: snap, and forget the old pace.
        // The ink starts over with it — the rule under a freshly-arrived line
        // appearing at its reading is not motion, so nothing eases here.
        anchor.current = {
          progress: now.progress,
          at: now.updatedAt,
          rate: 0,
          line: now.line,
        };
        shownRef.current = now.progress;
      } else if (now.updatedAt !== anchor.current.at) {
        anchor.current = {
          ...anchorFrom(anchor.current, now.progress, now.updatedAt),
          line: now.line,
        };
      }

      const shown = reduced
        ? anchor.current.progress
        : glide(
            anchor.current,
            shownRef.current,
            frameAt,
            frameMs,
            cadenceRef.current ?? 250,
            now.live,
          );
      shownRef.current = shown;

      stage.style.setProperty("--glide", shown.toFixed(4));
      const reach = now.words > 0 ? Math.floor(shown * now.words) : 0;
      setInked((was) => (was === reach ? was : reach));
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // cadenceRef is a ref: stable identity, read per frame by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Unitless: this feeds scaleX, not a width.
    box.style.setProperty("--w", `${on.offsetWidth}`);

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
 * The living well: the state mark and the control, fused into one instrument.
 *
 * The page used to carry two objects for one idea — a 23 px well that showed
 * the voice, and beside it a control to start the voice (a text line nobody
 * found, then a saffron slab that shouted, then a ribbon whose drag never
 * felt right on a real machine). Each attempt failed a different way, and the
 * fix is not a fourth style of button; it is fewer objects. The well IS the
 * button now.
 *
 * Press it and it sinks into the paper and stays sunk while listening, the
 * way a tape recorder key latches — depth is the state, readable across a
 * hall without reading a word. Press it again and it rises, dry. While it is
 * down, your own voice holds the ink up inside it: the level rides the
 * microphone from an animation frame, never through React, because a setState
 * at fifteen hertz would re-render three hundred lines of scripture to move
 * a mark.
 *
 * Each condition is a state of one material, everything interpolates, and no
 * change is a cut. Idle is a dry raised well; hovering it wets the floor with
 * a drop — the invitation is a taste of the result. Starting draws a stroke
 * around the rim, and the stroke is honest: the model really is arriving.
 * Following floods the bowl and lets the level breathe. Holding pales the
 * ink: the voice has stopped, the place is kept.
 *
 * The bowl of full-chroma saffron is allowed by the palette's own reasoning:
 * brand-spec.md names orange "presence and the living voice", and this is the
 * one mark on the page that literally is the living voice. It earns the
 * colour by being made of it.
 */
function WellButton({
  shows,
  level,
  live,
  busy,
  onToggle,
}: {
  shows: Condition;
  level: { current: number };
  live: boolean;
  busy: boolean;
  onToggle: () => void;
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

    // A true 0..1 mapping spends most of its range where nothing can be
    // read, because chanting sits well below full scale. Listening therefore
    // starts at a floor rather than at empty, which is also the honest
    // reading: the instrument IS attending, even in a silence, and the voice
    // rides above that rather than creating it.
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
    <div className="vs-press">
      <button
        type="button"
        className="vs-wellbtn"
        data-condition={condition}
        data-live={live}
        data-busy={busy}
        disabled={busy}
        aria-pressed={live}
        aria-label={live ? "Pause listening" : "Begin listening"}
        onClick={onToggle}
      >
        <svg viewBox="0 0 56 56" className="vs-well" aria-hidden="true">
          <defs>
            <clipPath id="vs-bowl">
              <circle cx="28" cy="28" r="23" />
            </clipPath>
          </defs>
          {/* The ink, clipped to the bowl and rising from its floor.
              The clip must live on a parent that does NOT move: a transform on
              the clipped element takes its clip with it, so translating the
              same node that carries clipPath slides the ink straight out of
              the bowl and leaves a blob hanging below the rim. */}
          <g clipPath="url(#vs-bowl)">
            <rect ref={inkRef} className="vs-ink" x="0" y="0" width="56" height="56" />
            {/* the drop at the heart of the well on hover — the invitation.
                Centred, not at the floor: at the floor it read as sediment. */}
            <circle className="vs-drop" cx="28" cy="28" r="9" />
          </g>
          {/* the rim */}
          <circle className="vs-rim" cx="28" cy="28" r="23" />
          {/* the stroke that draws itself while the model arrives */}
          <circle className="vs-draw" cx="28" cy="28" r="23" />
        </svg>
      </button>
      <span className="vs-pressword">
        <span className="vs-says">
          <span className="vs-say" data-on={!live} aria-hidden={live}>
            Press to begin
          </span>
          <span className="vs-say" data-on={live} aria-hidden={!live}>
            Press to pause
          </span>
        </span>
      </span>
    </div>
  );
}

/** One line of the received text. */
/**
 * A line split at its word boundaries, gaps kept, each word numbered.
 * Whitespace runs carry the number of the word before them so the map can
 * hand them straight back without breaking the count.
 */
function toWords(text: string): { text: string; gap: boolean; spoken: number }[] {
  return text
    .split(/(\s+)/)
    .reduce<{ text: string; gap: boolean; spoken: number }[]>((sofar, part) => {
      const gap = /^\s*$/.test(part);
      const previous = sofar.length ? sofar[sofar.length - 1].spoken : -1;
      return [...sofar, { text: part, gap, spoken: gap ? previous : previous + 1 }];
    }, []);
}

/**
 * Memoised, and the reason is arithmetic: the word-ink advances a few times a
 * second while someone chants, and each advance is a state change in the
 * parent. Without the memo that re-rendered all three hundred lines to move
 * one word's worth of ink on one of them. The callbacks are index-taking and
 * stable for the same reason — an inline closure would defeat the memo.
 */
const Line = memo(function Line({
  line,
  index,
  lead,
  big,
  current,
  near,
  inked,
  onSelect,
  register,
}: {
  line: ChantLine;
  /** Position in the flattened chant, handed back to the stable callbacks. */
  index: number;
  lead: Lead;
  /** This line's unit is the one being chanted — set large. */
  big: boolean;
  /** This exact line is where the tracker says the voice is — carries the ink. */
  current: boolean;
  near: boolean;
  /** How many words the voice has reached, glided between windows. */
  inked: number;
  onSelect: (index: number) => void;
  register: (index: number, node: HTMLDivElement | null) => void;
}) {
  const primary = lead === "dev" ? line.devanagari : line.transliteration;
  const secondary = lead === "dev" ? line.transliteration : line.devanagari;

  // The ink is laid word by word, never glyph by glyph: a Devanagari cluster
  // must not be cut in half, and the word boundary is the only joint that is
  // safe in both scripts. It also survives a line that wraps.
  // The word index is worked out up front rather than counted during the map.
  // A counter mutated inside render is a different value on every pass, which
  // React now rejects outright — and rightly, since the ink would drift.
  const words = useMemo(() => toWords(primary), [primary]);
  const secondaryWords = useMemo(() => toWords(secondary), [secondary]);

  const total = words.filter((w) => !w.gap).length;
  const reached = Math.max(0, Math.min(total - 1, inked));
  // The second script inks in step with the first. PRODUCT.md says a large
  // share of reciters read from the romanised line, and for them an ink that
  // touches only the leading script is an ink that does not exist. The two
  // scripts transliterate word for word almost everywhere, so the proportion
  // is nearly always the identity; where the counts do differ, proportion is
  // the honest mapping available without an alignment table.
  const secondaryTotal = secondaryWords.filter((w) => !w.gap).length;
  const secondaryReached =
    total > 0 ? Math.floor((reached * secondaryTotal) / total) : 0;

  return (
    <div
      ref={(node) => register(index, node)}
      className={`vs-ln ${big ? "vs-big" : ""} ${current ? "vs-current" : ""} ${near ? "vs-near" : ""}`}
      onClick={() => onSelect(index)}
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
          {current
            ? secondaryWords.map((word, at) =>
                word.gap ? (
                  word.text
                ) : (
                  <span
                    key={at}
                    className={word.spoken < secondaryReached ? "vs-inked" : undefined}
                  >
                    {word.text}
                  </span>
                ),
              )
            : secondary}
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
});

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

/* At the foot of the margin, pinned there by the auto margin exactly as the
   printer's seal it replaced was. The words sit beside the well and wrap in
   the column's own width. */
.vs-state{margin-top:auto; display:flex; gap:16px; align-items:flex-start}
.vs-crest{flex:none; margin-top:4px}
.vs-crest img{width:92px; height:92px; display:block}
/* ---- the living well ----------------------------------------------------
   One material in four states, and now one instrument instead of two: the
   well is the button. Everything below interpolates, so no change is ever a
   cut — and depth is the state. Up and dry: not listening. Sunk and inked:
   listening. The travel is 3 px of translate plus the shadows trading
   places, which is a thing a thumb and an eye both understand at once. */
.vs-press{flex:none; width:88px; display:flex; flex-direction:column;
  align-items:center; gap:8px; margin-top:1px}
.vs-stage .vs-wellbtn{
  display:block; width:56px; height:56px; padding:0; border:0;
  border-radius:50%; cursor:pointer; background:var(--paper);
  /* Raised off the page: a real offset and a soft blur underneath, and a
     hairline of light along the top edge, which is how paper actually sits
     proud of paper under a lamp. */
  box-shadow:0 2px 0 var(--key-well), 0 6px 14px var(--key-well),
    inset 0 1px 0 var(--well-sheen);
  transition:transform 90ms var(--ease), box-shadow 240ms var(--ease),
    background 520ms var(--ease);
}
/* Hovering an idle well lifts it a breath — the page offering it to the
   hand. Scoped away from the live state on purpose: a control that rises
   while it is supposed to be latched down contradicts the state it reports,
   which is the exact bug the ribbon shipped with its hover. */
.vs-stage .vs-wellbtn:hover:not(:disabled):not([data-live="true"]){
  transform:translateY(-1px);
  box-shadow:0 3px 0 var(--key-well), 0 9px 18px var(--key-well),
    inset 0 1px 0 var(--well-sheen);
}
/* Pressed under the finger, or latched down while listening. The drop
   shadows collapse to nothing and an inner shadow appears at the lip: the
   same 3 px of travel the raised state promised. 90 ms, the fastest thing on
   the page, because acknowledgement that arrives late reads as latency. */
.vs-stage .vs-wellbtn:active:not(:disabled),
.vs-stage .vs-wellbtn[data-live="true"],
.vs-stage .vs-wellbtn[data-busy="true"]{
  transform:translateY(2px);
  box-shadow:0 0 0 var(--key-well), 0 1px 2px var(--key-well),
    inset 0 2px 5px var(--key-well);
}
.vs-stage .vs-wellbtn:disabled{cursor:default}
.vs-stage .vs-wellbtn:focus-visible{outline:2px solid var(--blue); outline-offset:3px}
.vs-pressword{font-size:13px; font-style:italic; color:var(--ink2);
  text-align:center; white-space:nowrap; transition:color 300ms var(--ease)}
.vs-stage .vs-wellbtn:hover:not(:disabled) ~ .vs-pressword{color:var(--ink)}
.vs-pressword .vs-says{justify-items:center}

.vs-well{width:100%;height:100%;overflow:visible;display:block;
  transform-origin:50% 50%; transition:transform 420ms var(--ease)}
.vs-rim{fill:none; stroke:var(--ink3); stroke-width:1.5;
  transition:stroke 520ms var(--ease), opacity 520ms var(--ease)}

/* The ink. --ink is written from an animation frame, 0 at the floor of the
   bowl and 1 at its lip; the fill is a full square clipped to the circle, so
   the surface of the ink is always a straight line across a round vessel. */
.vs-ink{--ink:0; fill:var(--saffron-full);
  transform-box:view-box;
  transform:translateY(calc((1 - var(--ink)) * 100%));
  transition:fill 520ms var(--ease), opacity 520ms var(--ease)}
/* The drop: a taste of ink at the floor of a dry well, shown on hover only
   while idle — an invitation that says what pressing does, not a state. */
.vs-drop{fill:var(--saffron-full); opacity:0; transition:opacity 300ms var(--ease)}
.vs-stage .vs-wellbtn:hover:not(:disabled)[data-condition="idle"] .vs-drop{opacity:.3}
.vs-draw{fill:none; stroke:var(--blue); stroke-width:1.6; stroke-linecap:round;
  /* 2πr, so the dash is the circumference and the offset is a full lap */
  stroke-dasharray:144.5; stroke-dashoffset:144.5; opacity:0;
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
   breathes underneath it so the mark is alive even in a silence. Gentler than
   it was at 23 px: the same fraction of a bigger bowl is a bigger movement. */
[data-condition="following"] .vs-rim{stroke:var(--saffron-full)}
[data-condition="following"] .vs-ink{opacity:1}
[data-condition="following"] .vs-well{animation:vsbreathe 4.4s ease-in-out infinite}

/* Held. The ink pales and settles: the voice stopped, the place is kept. */
[data-condition="holding"] .vs-rim{stroke:var(--saffron-full); opacity:.75}
[data-condition="holding"] .vs-ink{opacity:.34; fill:var(--saffron-full)}

@keyframes vsturn{to{transform:rotate(360deg)}}
@keyframes vsbreathe{0%,100%{transform:scale(.97)}50%{transform:scale(1)}}
@keyframes vs-lap{
  0%{stroke-dashoffset:144.5}
  55%{stroke-dashoffset:0}
  100%{stroke-dashoffset:-144.5}
}

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
.vs-pressword .vs-say{transition-duration:260ms}

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
  width:1px; height:2px; background:var(--saffron-full);
  opacity:var(--o,0);
  /* Width rides scaleX off a 1 px base rather than being animated directly.
     Animating width relayouts the row on every frame of a 420 ms move; a
     transform is composited and never touches layout at all. It matters here
     more than the pixels suggest — the machines this is being tuned for are
     running speech inference and three hundred lines of React on the same
     main thread. */
  transform:translate(var(--x,0), var(--y,0)) scaleX(var(--w,0));
  transform-origin:0 0;
  transition:transform 420ms var(--ease);
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
.vs-bar i{position:absolute; left:0; right:0; top:0; bottom:0; background:var(--blue); opacity:.6;
  transform:scaleX(var(--fill,0)); transform-origin:0 50%; transition:transform .3s}
.vs-failed{padding:10px 0 0; font-size:13px; color:#B3261E}

.vs-middle{flex:1; min-height:0; display:grid; grid-template-columns:70px 1fr 290px; gap:40px; padding:14px 0 0}

.vs-measure{display:flex; flex-direction:column; min-height:0}
.vs-cap{font-size:13px; color:var(--ink2); text-align:right; margin-bottom:10px; font-variant-numeric:oldstyle-nums}
.vs-stack{flex:1; display:flex; flex-direction:column; gap:5px; min-height:0}
.vs-trow{flex:1; display:flex; align-items:center; justify-content:flex-end; min-height:5px}
/* One box, 40 px wide, right-aligned in the row; the visible length is a
   scale. Thirty-six of these share a column and the hover and the position
   change animate two at once, so keeping them off the layout path is worth
   more than the four bytes it costs. */
.vs-tick{height:1.5px; background:var(--blue); opacity:.38; width:40px; display:block;
  transform:scaleX(.3); transform-origin:100% 50%;
  transition:transform .3s, opacity .3s, background .3s}
.vs-trow.vs-done .vs-tick{opacity:.72; transform:scaleX(.45)}
.vs-trow.vs-now .vs-tick{opacity:1; transform:scaleX(1); height:2.5px; background:var(--saffron-full)}
.vs-trow:hover .vs-tick{opacity:.9; transform:scaleX(.6)}
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
  /* The well keeps its travel: how deep it sits IS the state of the app,
     not an effect. Only the ease of the journey is shortened. */
  .vs-stage .vs-wellbtn{transition:transform 90ms linear, box-shadow 90ms linear}
  .vs-draw{opacity:1; stroke-dashoffset:37}
  .vs-clip{scroll-behavior:auto}
  .vs-scroll, .vs-prog i, .vs-tick, .vs-leadtext{transition:none}
}

@media (max-width:1240px){
  .vs-stage{padding:26px 32px 22px}
  .vs-middle{grid-template-columns:58px 1fr 250px; gap:26px}
  .vs-ctrls{grid-template-columns:repeat(3,minmax(0,1fr))}
  .vs-colophon{grid-template-columns:1fr 250px; gap:26px}
}
/* Between a phone and the page: a small laptop or a tablet still gets the
   page's composition, only tighter. */
@media (max-width:960px){
  .vs-stage{padding:20px 20px 22px}
  .vs-middle{grid-template-columns:1fr 250px; gap:22px}
  .vs-measure{display:none}
  .vs-colophon{grid-template-columns:1fr; gap:18px}
  .vs-ctrls{grid-template-columns:repeat(2,minmax(0,1fr))}
  .vs-model{text-align:left}
  .vs-crest img{width:72px; height:72px}
}

/* The floor under a narrow screen.
   ------------------------------------------------------------------------
   These rules apply to the PAGE composition at phone width, and they exist
   because that composition can still be what is on screen there: it is what
   the server renders before any JavaScript has run, and it is what remains if
   hydration is slow or fails. Without them a phone showing the page gets
   three columns of a 1440 px design heaped on top of each other — which is
   exactly what the owner photographed. The phone rules below outspecify every
   one of these, so this is a floor and never a ceiling. */
@media (max-width:760px){
  .vs-stage{height:auto; min-height:100dvh; overflow:auto; padding:18px 16px 24px}
  .vs-head{flex-direction:column; gap:16px}
  .vs-crest{align-self:flex-start; margin-top:0}
  .vs-crest img{width:64px; height:64px}
  .vs-middle{display:block; padding-top:16px}
  .vs-measure{display:none}
  .vs-window{height:52dvh; min-height:300px}
  .vs-scroll{padding:0 14px}
  .vs-leadtext{font-size:calc(19px * var(--scale))}
  .vs-ln.vs-big .vs-leadtext{font-size:calc(26px * var(--scale))}
  .vs-margin{margin-top:20px}
  .vs-state{margin-top:20px}
  .vs-colophon{grid-template-columns:1fr; gap:16px}
  .vs-ctrls{grid-template-columns:repeat(2,minmax(0,1fr))}
  .vs-model{text-align:left}
}

/* ==========================================================================
   THE PHONE
   ==========================================================================
   Not the page squeezed: a different composition of the same instrument,
   chosen from three built and tried on the owner's own phone
   (design/direction-approved-mobile.md — "the unrolling scroll").

   The text fills the screen and is read top to bottom. The line being
   chanted rides a fixed anchor about a third down and the paper glides
   beneath it. Everything else — the sections, the gloss, the controls, the
   crest — lives under a sheet at the foot, which at rest shows only the
   instrument and what it honestly knows.

   The stage stops scrolling as a document here and becomes a fixed frame:
   a running head, a reading surface that owns the rest, and the sheet over
   it. Nothing but the paper moves. -------------------------------------- */
[data-phone="yes"].vs-stage{
  height:100dvh; overflow:hidden;
  padding:0; display:flex; flex-direction:column;
}

[data-phone="yes"] .vs-head{
  flex:none; padding:calc(env(safe-area-inset-top) + 10px) 18px 8px;
  border-bottom:1px solid var(--rule);
  flex-direction:row; align-items:baseline; gap:12px;
}
[data-phone="yes"] .vs-work{display:flex; align-items:baseline; gap:12px; min-width:0}
/* The library link keeps its target size while reading as a mark, not a row
   of words competing with the chant's own title. */
[data-phone="yes"] .vs-lib{flex:none; font-size:0; padding:6px 6px 6px 0; margin:0}
[data-phone="yes"] .vs-lib svg{width:15px; height:11px}
[data-phone="yes"] .vs-title{
  display:flex; align-items:baseline; gap:9px; min-width:0;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
[data-phone="yes"] .vs-sa{font-size:20px}
[data-phone="yes"] .vs-ia{font-size:14px; overflow:hidden; text-overflow:ellipsis}

/* The reading surface takes everything the head and the sheet do not.
   --peek is published by the sheet from its own measured height, so the
   paper ends exactly where the bar begins and never behind it. */
[data-phone="yes"] .vs-middle{
  flex:1; min-height:0; display:block; padding:0; gap:0;
  margin-bottom:var(--peek,116px);
}
[data-phone="yes"] .vs-vessel{height:100%}
[data-phone="yes"] .vs-vessel > .vs-hr{display:none}
[data-phone="yes"] .vs-window{height:100%; min-height:0}
/* The head of the chant sits at the head of the paper. No phantom padding
   above the first line: the anchor clamps at zero, so the paper simply does
   not glide until there is something above it to glide. Anything else opens
   the app on a void. */
[data-phone="yes"] .vs-scroll{padding:18px 20px 62dvh}
[data-phone="yes"] .vs-clip{
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 7%,#000 93%,transparent 100%);
          mask-image:linear-gradient(to bottom,transparent 0,#000 7%,#000 93%,transparent 100%);
}
/* Type for a hand at 40 cm, not for a hall at three metres. The active unit
   still steps up, and it is never the only signal: it also takes full ink,
   its second script, and the saffron rule. */
[data-phone="yes"] .vs-leadtext{font-size:calc(19px * var(--scale)); line-height:1.95}
[data-phone="yes"] [data-lead="ia"] .vs-leadtext{line-height:1.7}
[data-phone="yes"] .vs-ln.vs-big .vs-leadtext{font-size:calc(26px * var(--scale)); line-height:1.9}
[data-phone="yes"] [data-lead="ia"] .vs-ln.vs-big .vs-leadtext{font-size:calc(24px * var(--scale)); line-height:1.6}
[data-phone="yes"] .vs-unit[data-lines="3"] .vs-ln.vs-big .vs-leadtext{font-size:calc(23px * var(--scale))}
[data-phone="yes"] .vs-unit[data-lines="4"] .vs-ln.vs-big .vs-leadtext{font-size:calc(21px * var(--scale)); line-height:1.8}
[data-phone="yes"] .vs-second{font-size:calc(15px * var(--scale)); line-height:1.85}
[data-phone="yes"] .vs-ln{padding:4px 0}
[data-phone="yes"] .vs-divider{margin:30px 0 18px; font-size:13px}

/* ---- the scrim behind the raised sheet --------------------------------- */
[data-phone="yes"] .vs-scrim{
  position:fixed; inset:0; z-index:20; background:#0A0806;
  opacity:0; pointer-events:none;
}

/* ---- the sheet ---------------------------------------------------------
   At rest it is the FOOT of the page: the same paper, parted by the same
   hairline rule that parts everything else in this book, square to the
   edges. The sheet grammar arrives only as it rises — --lift runs 0→1 with
   the drag, and the corners round and the shadow grows out of it. A rounded
   card at rest leaves two wedges of not-paper at its top corners, which is
   what an eye catches and calls unfinished. ----------------------------- */
[data-phone="yes"] .vs-sheet{
  --lift:0;
  position:fixed; left:0; right:0; bottom:0; z-index:30;
  height:min(88dvh,760px);
  background:var(--paper);
  border-radius:calc(18px * var(--lift)) calc(18px * var(--lift)) 0 0;
  box-shadow:0 -1px 0 var(--rule),
    0 calc(-14px * var(--lift)) calc(34px * var(--lift)) var(--key-well);
  display:flex; flex-direction:column;
  will-change:transform;
  transition:background .5s ease;
}
[data-phone="yes"] .vs-peek{
  flex:none; padding:0 18px calc(14px + env(safe-area-inset-bottom));
  touch-action:none;
}
/* The handle carries the air above the instrument as well as its own.
   Unpadded, the well and the state words sat hard against the top edge of the
   sheet and the bar read as crowded — the paper needs a margin at its head
   exactly as the page above it does.

   Scoped under .vs-stage, and it has to be: the stage's own button reset sets
   padding to zero at (0,1,1), which silently beats a bare .vs-grab at (0,1,0).
   The first version of this rule was written unscoped and did nothing at all
   — the same specificity trap this file has fallen into before. */
.vs-stage .vs-grab{display:block; width:100%; padding:13px 0 20px; cursor:grab}
.vs-grab i{display:block; width:40px; height:4px; border-radius:2px;
  background:var(--rule); margin:0 auto}
[data-phone="yes"] .vs-sbody{
  flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain;
  padding:2px 18px calc(24px + env(safe-area-inset-bottom));
  opacity:0;
}

/* The instrument and its words, side by side in the peek. */
[data-phone="yes"] .vs-state{margin-top:0; gap:15px; align-items:flex-start}
[data-phone="yes"] .vs-press{width:76px}
[data-phone="yes"] .vs-word{font-size:19px}
[data-phone="yes"] .vs-sub{font-size:13px}

/* Everything under the sheet reads as one column of settings. */
[data-phone="yes"] .vs-sheet .vs-nav{margin-top:4px; gap:6px}
[data-phone="yes"] .vs-sheet .vs-navrow{padding-bottom:9px}
[data-phone="yes"] .vs-sheet .vs-lbl{min-width:74px; font-size:13px; margin-right:8px}
[data-phone="yes"] .vs-sheet .vs-navrow button{padding:7px 9px; min-height:38px}
[data-phone="yes"] .vs-sheet .vs-gloss{
  margin:14px 0 4px; padding-top:14px; border-top:1px solid var(--rule-soft); flex:none;
}
[data-phone="yes"] .vs-sheet .vs-en{font-size:16px}
[data-phone="yes"] .vs-ctrls{
  grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 18px;
  margin-top:16px; padding-top:16px; border-top:1px solid var(--rule-soft);
}
[data-phone="yes"] .vs-ctrl button{min-height:40px}
[data-phone="yes"] .vs-sfoot{
  display:flex; align-items:center; gap:14px;
  margin-top:20px; padding-top:16px; border-top:1px solid var(--rule-soft);
}
[data-phone="yes"] .vs-sfoot .vs-crest{margin:0}
[data-phone="yes"] .vs-sfoot .vs-crest img{width:56px; height:56px}
[data-phone="yes"] .vs-model{text-align:left; margin:0; flex:1; min-width:0}

/* The loading line and the failure line belong over the paper, not squeezed
   into the head, so neither can push the reading surface around. */
[data-phone="yes"] .vs-loading,
[data-phone="yes"] .vs-failed{
  position:fixed; left:0; right:0; bottom:var(--peek,116px); z-index:25;
  padding:9px 18px; background:var(--paper);
  border-top:1px solid var(--rule-soft);
}
[data-phone="yes"] .vs-import{
  position:fixed; left:12px; right:12px; bottom:calc(var(--peek,116px) + 12px);
  z-index:26; flex-direction:column; gap:12px; margin:0;
}

@media (max-width:380px){
  /* The English title wraps the running head onto a second line and costs a
     line of scripture to say what the Devanagari beside it already says. */
  [data-phone="yes"] .vs-ia{display:none}
}
@media (max-width:360px){
  [data-phone="yes"] .vs-scroll{padding-left:15px; padding-right:15px}
  [data-phone="yes"] .vs-peek{padding-left:14px; padding-right:14px}
  [data-phone="yes"] .vs-sbody{padding-left:14px; padding-right:14px}
  [data-phone="yes"] .vs-ctrls{grid-template-columns:1fr}
}
`;

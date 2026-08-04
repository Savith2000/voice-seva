# design-spec · Voice Seva

**The single shared input for all three design directions.** Read it fully. Do
not read the other directions' output.

---

## 1. What the product actually is

**Voice Seva listens to someone chanting Sanskrit scripture through the
microphone and scrolls the script to keep pace with them.** Everything runs in
the browser — no backend, no accounts, no audio ever leaves the device.

It is currently a working proof of concept for **Sri Rudram Namakam, Anuvaka 1**
(33 lines). A speech model transcribes a rolling 5-second window of audio about
four times a second, a fuzzy matcher finds where in the script that lands, and a
deliberately reluctant state machine decides whether the screen may move.

That reluctance is the product's soul: **following is cheap, jumping is
expensive.** A screen that twitches during a recitation is worse than one that
lags, because a wrong line pulls someone out of the chant and a stale one does
not. The app would rather admit it is lost than guess.

## 2. Who is looking at it, and from where

Someone **mid-recitation, reciting out loud, hands not free, unable to stop and
interpret the screen.** Three viewing distances, all real:

- **~40 cm** — phone propped up, chanting alone at home
- **~70 cm** — laptop on a table, the most common case
- **~3 m+** — a screen or projector in a temple hall or centre, a group
  chanting together. Type must survive this.

Common conditions: **early morning, before dawn, in a dim room.** Sessions run
**20–45 minutes**. Users span every age, many are 60+, many are not fluent
readers of Devanagari and read from the romanised line instead.

**Design implication:** legibility at distance is the highest-order requirement,
above novelty. Body type may not go below 16px, and the active line should be
enormous — think 40–72px, not 20px. A dim-room-friendly default is a real
functional argument, not a style preference.

## 3. What must appear on screen

### The reading surface (the heart of it — spend your effort here)

- The chant, line by line. Each line exists in **three forms**: Devanagari
  (`ॐ नम॑स्ते रुद्र म॒न्यव॑`), romanised IAST (`oṃ namaste rudra manyava`),
  and — newly available — an **English meaning**. Either script can be the large
  one; the user chooses, because roughly half read from each.
- **One line is the active line.** It is the most important element in the
  entire product. Everything else is quieter than it.
- **Progress through the active line** — the app knows how far into the line the
  chanter is, 0 to 1.
- Lines group into **verses** (usually two half-lines split by a danda `।`).
  The verse is the visual unit; the line is the position.
- Tapping any line sets the position by hand — the user can always correct the app.

### State, said in words not numbers

Four states, and the design must make them distinguishable **at a glance, from
across a room, without reading**:

| state | what it means | current wording |
|---|---|---|
| idle | not listening | "Not listening." |
| searching | hearing chanting, no position worth committing to | "Locating chanting position…" |
| locked + following | tracking, confident | "Following." |
| locked + holding | tracking, but living off an older result | "Holding position…" |

"Searching" is **not an error state.** The app is doing what it was asked to do.
Do not paint it red.

### Controls

Listen/pause · microphone picker · which script leads (Devanagari ↔ romanised) ·
auto-scroll toggle · show/hide meaning · text size · fullscreen · search-to-jump.

These are **secondary**. Today they are a crowded row of pills in the header and
that is the single weakest part of the current design. Solving their placement —
present when wanted, invisible while chanting — is a real design problem worth
your attention.

### First-run

The speech model is a **190 MB one-time download**. There must be an honest,
calm progress state. It happens once, then it is cached forever.

## 4. What is coming — design for this, not just for today

The current screen handles one anuvaka of 33 lines. It is about to handle far
more, and **a design that only works at today's scale is the wrong design:**

1. **11 anuvakas of Namakam**, several hundred lines. Needs a way to see where
   you are in the whole work and move between sections.
2. **A chant library** — multiple different chants, not just Sri Rudram.
3. **User-imported chants**: upload a PDF, the app extracts the text, you chant
   along with it. Needs an import flow and a place for "my chants" to live.
4. **English meanings**, now that a translation source exists.

You do not need to design all of these in full. But the **information
architecture must have a believable place for each** — if your design cannot
answer "where would the anuvaka navigation go?", it is not finished.

## 5. Brand

Read `design/brand-spec.md`. Non-negotiable: the **SSIO emblem must appear**
in the product, and the palette is built from **blue `#0C5098`, orange
`#EE7900`, light orange `#FBBA74`.**

Embed the logo as base64 from `design/assets/ssio-logo-sm.b64` (33 KB) — the file
already contains a complete `data:image/png;base64,…` URI, ready to drop into a
`src`. **A relative path will break when the file is moved; you must inline it.**

## 6. Real content — use it, never lorem

`design/assets/chant-lines.json` holds all **33 real lines** of Anuvaka 1, each
with `sequence`, `verse`, `devanagari`, `transliteration`. Use the real text.

Two real English meanings from the source edition, for the meaning row:

- Line 1 — "Prostrations to Lord Rudra, who is the destroyer of sin and sorrow."
- Lines 2–3 — "Oh Rudra Deva! My salutations to your anger and also to your
  arrows. My salutations to your bow and to the pair of your hands."

**Devanagari rendering matters.** Set `lang="sa"` and use a font stack with real
Devanagari coverage, or the accent marks will render as dotted circles:
`"Noto Sans Devanagari", "Noto Serif Devanagari", "Adobe Devanagari", "Kohinoor Devanagari", "Devanagari MT", sans-serif`.
Devanagari with Vedic accent marks needs **generous line-height (≥1.9)** — the
svara marks sit above and below the glyph and will collide otherwise.

## 7. Output requirements

- **One self-contained HTML file.** No build step, no external requests — a
  strict offline page. Inline all CSS. Google Fonts links will not load; use
  system/local font stacks.
- Viewport **1440×900**. It should not break at 390px wide, but desktop is what
  gets screenshotted.
- Show the app **in its living state**: a real active line mid-chant, real
  status, real surrounding lines. Not an empty shell, not a marketing landing
  page. This is the *instrument*, not a site about the instrument.
- Make at least one interaction real (script toggle, or tapping a line to move
  the highlight) so the feel can be judged.
- Put an HTML comment block at the top with your assumptions and your reasoning.

## 8. Hard floors

- Body ≥16px; secondary/label text ≥13px; contrast ≥4.5:1 for anything readable.
- Whitespace must be **composition**, not absence — there must be a clear
  visual anchor on first paint. A near-empty page with tiny type reads as a
  broken render, not as elegance.
- No purple gradients, no emoji as icons, no generic dark-SaaS neon glow, no
  rounded-card-with-left-colour-border, no invented statistics or fake data.
- Every element earns its place. No filler.

## 9. The one question you must be able to answer

**"Where does the form come from in the content itself?"** Write your answer as
a comment in your file. If the answer is a style label rather than something
specific to *this* — sacred recitation, a known finite text, a voice being
followed, an organisation of five values — go back and think again.

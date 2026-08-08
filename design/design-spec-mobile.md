# design-spec-mobile · Voice Seva on the phone

**The single shared input for all three mobile design directions.** Read it
fully. Do not read the other directions' output.

This is the second design round. The first round chose and built a visual
world — Direction C, "the Hara book page" — and it shipped. **That world is
now the law, not a suggestion.** You are not inventing an aesthetic; you are
composing an existing one for a 390 px-wide screen held in one hand. The
authority for every material question is the built app itself:
`src/components/ChantingScreen.tsx` (read its CSS-in-JS `LIGHTS` tokens and
the `.vs-wellbtn` construction) and `design/direction-approved.md`.

---

## 1. What the product is (unchanged)

Voice Seva listens to someone chanting Sri Rudram through the microphone and
keeps the script in step with them. Everything runs in the browser; no audio
leaves the device. A deliberately reluctant state machine decides when the
screen may move: **following is cheap, jumping is expensive**, and the app
would rather admit it is lost than guess. It now carries the whole of Sri
Rudram — 24 sections, 303 lines.

## 2. The phone scene

One person, **alone**, phone in hand or propped at ~40 cm, often before dawn
in a dim room, chanting out loud for 20–45 minutes, hands mostly not free.
Age skews old; a large share read the romanised line, not the Devanagari.
They cannot stop to interpret an interface.

Two phones must both work: **iPhone Safari** (dynamic toolbars — use `dvh`,
respect `env(safe-area-inset-bottom)` for the home indicator) and **Android
Chrome**. Portrait only. Design at **390 × 844**; must survive 360 px wide.

## 3. The owner's brief — fixed, not up for debate

1. **The text fills the screen.** Read top to bottom, line by line. The
   reading surface is the whole phone above the bar.
2. **One collapsible bottom bar** in the iOS-sheet grammar. Collapsed (the
   normal chanting state) it shows exactly: **the well button + the status
   words** ("Not listening. / Following. / Holding your place…") and the
   affordance to expand. Nothing else.
3. **Expanded**, the sheet holds everything secondary: section navigation
   (Namakam I–XI · Rudra · Chamakam I–XI · Śānti), script-leads toggle,
   text size, light (Day / Before dawn), microphone picker, the verse
   reference + meaning note, and the crest.
4. **The well button is the same instrument as on desktop**: a ~56 px round
   well, raised off the paper when idle, sinks in and latches while
   listening, ink inside riding the live voice level, "Press to begin /
   Press to pause". Same look, same reaction. Do not redesign it; re-house it.
5. No download-warning UI. Out of scope by the owner's word.

## 4. What each direction decides — this is the comparison

Each direction is assigned a **reading topology**: how the text moves under a
voice. Build yours, fully committed. Everything in §3 is shared.

- **M-A — the unrolling scroll** (`M-A-scroll.html`): the text is one
  continuous column; the active line rides a fixed reading anchor about a
  third down the screen and the paper glides beneath it. The desktop
  behavior, recomposed for a hand. Decide: how section boundaries pass, how
  a hand-scroll coexists with the following (and how the reader gets back).
- **M-B — the turned page** (`M-B-page.html`): the text is paginated into
  true screens; the voice inks lines down the page, and the page turns when
  the voice crosses its last line. Decide: the page-turn itself (calm, not
  showy), where the page number / place-in-work lives, what tapping a line
  does.
- **M-C — the breath** (`M-C-breath.html`): the current verse-unit alone,
  large and centred; the previous and next units ghosted above and below;
  advance is replacement, not scrolling — the synced-lyrics topology, in
  this world's materials. Decide: type scale at unit level, how a wrong
  jump is corrected by touch, how not to feel like a karaoke app during
  scripture.

Also yours to decide, within your topology: how the active line is
emphasised at 390 px (the desktop's 25→35 px jump may not survive wrapping),
where the word-ink lives, and the collapsed bar's exact proportions.

## 5. Materials — inherit, do not invent

From the built app (`LIGHTS` in ChantingScreen.tsx):

- Lamp (light): page `#E8E1D3`, paper `#F1EBDE`, ink `#221B12`, ink2
  `#5C5245`, blue `#0C5098`, saffron `#9C4A05`, saffron-full `#EE7900`.
- Dawn (dark): page `#131110`, paper `#1C1917`, ink `#EDE6D8`, ink2
  `#A99C88`, blue `#8FB3DC`, saffron `#EE9A45`, saffron-full `#EE7900`.
- Full-chroma saffron is for **marks and the living voice only**, never
  fields. The word-ink and the well's pool are the earned places.
- Serif book face for Latin (Iowan Old Style / Palatino / Georgia stack);
  Devanagari needs a real stack (`"Noto Sans Devanagari", "Noto Serif
  Devanagari", "Kohinoor Devanagari", "Devanagari MT", sans-serif`),
  `lang="sa"`, and **line-height ≥ 1.9** or the svara marks collide.
- The emblem is `design/assets/sssgc-usa-sm.b64` (a complete data URI —
  inline it). It carries its own name and values; never caption it.
- Default polarity: pick from the scene (pre-dawn dim room) and say so in
  your header comment. Both polarities must exist behind the light control.

## 6. Real content — use it, never lorem

`design/assets/chant-lines.json`: all 33 real lines of Namakam Anuvaka 1
(`sequence`, `verse`, `devanagari`, `transliteration`). The app now spans 24
sections — your section navigation must show the full list (Namakam I–XI,
Rudra, Chamakam I–XI, Śānti) even though only Anuvaka 1's text is in the
JSON. One real meaning, for the sheet's meaning slot: line 1 — "Prostrations
to Lord Rudra, who is the destroyer of sin and sorrow."

## 7. Make it live

Simulate a session so the feel can be judged on a phone:

- Pressing the well starts a fake "Following." session: position advances
  through the lines at a chanting pace (~4–6 s a line), word-ink fills the
  active line word by word in **both scripts**, the well sinks and its ink
  breathes as if a voice were feeding it.
- The bar expands and collapses by tap and by drag, with the sheet's own
  spring-less settle (this page's motion grammar: exponential ease-out,
  nothing bounces — it is a screen for someone mid-prayer).
- Tapping a line moves the position there. State words change honestly.

## 8. Output requirements

- **One self-contained HTML file** in `design/design-demos/`, named as in §4.
  No build step, no external requests, all CSS and JS inline, emblem inlined
  from the b64 file.
- Put an HTML comment block at the top: your assumptions, your reasoning,
  and the answer to §9.
- Body ≥ 16 px, secondary ≥ 13 px, contrast ≥ 4.5:1, touch targets ≥ 44 px.
- No purple gradients, no emoji icons, no neon, no invented statistics.

## 9. The one question you must answer in your header comment

**"Why is this topology the right way for a phone to carry a voice through
scripture?"** If your answer could caption a music player instead, think
again.

# HANDOFF

**To: the next Claude Code session on Voice Seva.**
**From: the one that imported the full Rudram and built the book page.**

Read this before touching anything.

- `README.md` explains **why the app is the way it is** — the pipeline, the
  model bake-off, the matcher. Still largely accurate and worth reading.
- `PRODUCT.md` is **product truth** — who it is for, what must not be invented.
  Written this session. Read it before any design work.
- This file explains **where you are standing and what will bite you.**

A previous version of this file described Anuvaka 1, 33 lines, and weights
served out of `public/models/`. All three are now wrong. Assume any document
older than this one may have rotted the same way.

---

## 0. The sixty-second version

Voice Seva listens to someone chanting **Sri Rudram** through the microphone
and scrolls the script to keep pace with them. Everything runs in the browser.
No backend, no accounts, no audio leaves the device.

**The single most important idea in the project:**

> This is a **matching** problem, not a transcription problem.

The script is known and finite, and nobody ever sees the transcript. So the
speech model is *allowed to be wrong* — it only has to be wrong **consistently**,
because systematic errors get normalised away. That is why a 94 M-parameter
model is enough. If you catch yourself trying to improve transcription accuracy,
stop: you are solving the wrong problem.

The app works. It has never been chanted into at its current size.

---

## 1. State of play

| | |
|---|---|
| Branch | `full-rudram-and-the-book-page` |
| HEAD | `1e9e209` "Let the ribbon settle instead of springing" |
| Working tree | clean except 7 untracked files (§8 D) |
| `npm test` | **145 pass, 0 fail** |
| `npm run typecheck` / `lint` / `build` | all clean |

### ⚠️ Six commits are unpushed

`origin/full-rudram-and-the-book-page` is at **`f15d00a`**. Local is at
`1e9e209`. `origin/main` (`bb85ef4`, PR #4) contains everything **up to
f15d00a and no further.**

So these six exist **only on this machine**:

```
1e9e209  Let the ribbon settle instead of springing
68668f3  Replace the listening button with the book's own ribbon
f3a07a8  Animate the small marks with transforms instead of widths
6d7119d  Draw a continuous line through the windows
4d65340  Try every accelerator the device has, best first
ac991a6  Add a page that says what the device can actually do
```

**If the user has deployed, none of that is live.** Confirm before diagnosing
anything they report. Ask before pushing — they merge via PR themselves.

---

## 2. First five minutes

```bash
npm install
npm run dev          # http://localhost:3000
```

| route | what it is |
|---|---|
| `/` | **the app.** The chanting screen is the front door now. |
| `/chant` | 307 → `/`. Kept because the link was shared. |
| `/capabilities` | what this browser can actually do. Always available. |
| `/harness` | the instruments. **404s in production** unless `VOICE_SEVA_HARNESS=1`. |

**The model no longer lives in the repo.** It is fetched from
**`Savith/vak-san-onnx`** on Hugging Face. `public/models/` may still exist on
the user's machine; it is unused and gitignored. A fresh clone works.

`/harness` shows the matcher's **raw** answer with no state machine in the way,
which is how you tell "the matcher was wrong" from "the matcher was right and
the state machine was being sensible". **Debug there first.**

---

## 3. How it actually works

```
 AUDIO THREAD          MAIN THREAD                      WORKER THREAD
 AudioWorklet          tracker · matcher · follow · UI   wav2vec2 CTC
 ──────────────        ────────────────────────────      ──────────────────
 mic 48k → 16k    ──▶  RingBuffer (5 s)                  best of:
 mono, ~15 fps         decides when to fire        ──▶     webgpu (fp16)
                                                           webnn-npu (int8)
                       fuzzy match  ◀───────────────       webnn-gpu (int8)
                       follow.ts (pure reducer)            wasm (int8)
                       glide.ts (fills the gaps)
                       highlight + scroll
```

**Felt lag = `inference + cadence/2`, and cadence *is* inference** — a window
only starts once the last returns. ~190 ms on WebGPU. **~2.1 s on WASM.**

---

## 4. Code map

Every file has a header comment explaining its reason for existing. Those are
load-bearing documentation. Do not delete them when editing.

### The pipeline

| file | job | watch out |
|---|---|---|
| `src/lib/audio/capture.ts` | mic → 16 kHz mono | `AudioContext` is *constructed* at 16 kHz so the browser resamples natively |
| `public/worklets/capture-processor.js` | the AudioWorklet | plain JS, loaded by URL, not bundled |
| `src/lib/audio/ring-buffer.ts` | rolling 5 s | trivial, well tested |
| `src/lib/chant/tracker.ts` | the loop, and its refusals | §5 |
| `src/workers/asr.worker.ts` | backend ladder, inference, CTC decode | §6.1, §6.2 |
| `src/lib/chant/normalize.ts` | nine destructive rules | **exists twice.** §6.3 |
| `src/lib/chant/matcher.ts` | Sellers fuzzy substring search | margin excludes neighbours on purpose |
| `src/lib/chant/follow.ts` | pure reducer: what the screen shows | "following is cheap, jumping is expensive" |
| `src/lib/chant/glide.ts` | fills gaps between windows | **new.** §7 boundary |
| `src/lib/chant/closest-pair.ts` | which two lines are hardest to tell apart | filtered similarity join |
| `src/lib/chant/use-asr-session.ts` | plumbing both pages share | one copy on purpose |
| `src/components/ChantingScreen.tsx` | **1770 lines.** The whole UI. | the only big file |

### Data

| file | |
|---|---|
| `src/data/chants/sri-rudram-saiveda.json` | **generated.** 24 sections, 303 lines. Never hand-edit. |
| `src/data/chants/sri-rudram-namakam-anuvaka-1.json` | the **old Trust-edition** Anuvaka 1. Not shipped — it is the verified fixture the tests and the import gate compare against. **Keep it.** |
| `src/lib/chant/chant.ts` | types + `flatten()`. Imports no JSON, deliberately. |
| `src/lib/chant/chant-data.ts` | the one place the JSON is imported |

### Offline tools

| dir | |
|---|---|
| `tools/chant-import/import_saiveda.py` | **the current importer.** §6.4 |
| `tools/chant-import/decode_pdf.py` | the *old* Trust-edition importer. Different publisher, different technique. Still valid, still used for that PDF. |
| `tools/asr-bakeoff/` | model bake-off, ONNX export, the consistency gate |

### Design

`design/` holds `PRODUCT.md`'s visual counterpart: `brand-spec.md`,
`design-spec.md`, `direction-approved.md`, and **three complete interactive
design directions** in `design/design-demos/`. Direction C was chosen and built.
Read `direction-approved.md` before reshaping the UI — it records what the two
rejected directions got right and why they were rejected.

---

## 5. Every tunable number

**`src/lib/chant/tracker.ts`** — `WINDOW_SECONDS` 5, `DEFAULT_INTERVAL_MS` 250,
`DUTY_FACTOR` 2, `MAX_INTERVAL_MS` 1500, `silenceRms` 0.005, `minFillRatio` 0.6.

**`src/lib/chant/follow.ts`** — `THRESHOLDS.high` 0.7/0.2, `.medium` 0.5/0.08,
`CONTINUES` back 1 forward 2, `CORROBORATION` 2 **and** 800 ms, `PATIENCE` 4
**and** 2000 ms, `IDLE_AFTER_SILENT_MS` 8000.

**`src/lib/chant/matcher.ts`** — `TIE_WITHIN` 0.08.

**`src/lib/chant/glide.ts`** — `MAX_RATE` 0.004, `OVERRUN` 1.15.

> **The count-and-clock pairs are not redundant.** Every evidence threshold is
> `count >= N && elapsed >= MS` so that making the model faster can never make
> the app twitchier. **If you speed up inference, you do not need to retune
> these.** That is the point.

---

## 6. Landmines — things that fail *silently*

### 6.1 The CTC blank token is not the one the model's repo declares
Get it wrong and you get `न<s>म<s>स<s>्<s>` — which looks *almost* like a
transcript. `export_onnx.py` writes the corrected token; `loadVocab()` reads it
back. One place, no drift.

### 6.2 CTC decode order
Collapse runs of identical tokens **first**, *then* drop the blank. Reverse it
and `अअ` silently becomes `अ`.

### 6.3 The normaliser exists twice
`src/lib/chant/normalize.ts` and `tools/asr-bakeoff/normalize.py`. **The gate
was measured with the Python one.** If they drift, the browser matches against
numbers nobody measured and *nothing fails*. `normalize.test.ts` replays a
fixture character for character.

### 6.4 Unicode svara ordering — and its inverse
The accent must come **after** every matra/virama/anusvara/visarga. NFC will
**not** fix this: visarga is a spacing mark of combining class 0. Wrong order →
orphaned visarga → dotted circle. Renders wrong, tests pass.

`import_saiveda.py` meets the same thing from the other side and carries two
related traps, both of which produced perfectly well-formed wrong Sanskrit:

- **Stripping accents with a character *range*** swallows the marks that carry
  meaning as well as pitch. U+030D sits beside U+0304 (the ā in *rudrāya*);
  U+0331 beside U+0323 (the ṣ ṛ ḍ ḥ). Use the exact set, never a range.
- **Compose before substituting sentinels.** Canonical ordering sorts combining
  marks by class, so `ā̱` decomposes to `a` + anudatta + macron; substitute
  first and the sentinel lands between the `a` and its own macron.

### 6.5 Fonts do not have the Vedic Extensions block
U+1CDA (double svarita) appears in the text and **no macOS system Devanagari
font has it.** It rendered as an empty box and nothing errored. Shobhika is
self-hosted in `public/fonts/` and `--font-devanagari` in `globals.css` is the
one place the stack is defined. Consume that variable; do not hardcode a stack.

### 6.6 `npm test` runs the TypeScript sources directly
Node type-stripping. Constructor **parameter properties** cannot be erased —
`erasableSyntaxOnly` in tsconfig catches relapses. No `@/` alias in tests, which
is why `chant.ts` imports no JSON.

### 6.7 Never pipe a check that gates a commit
`npm run typecheck | tail` swallows the exit code. Run it bare.

### 6.8 Backticks inside the stylesheet comments
`ChantingScreen.tsx` holds its CSS in a **template literal**. A backtick in a
comment inside it closes the string. **This happened twice in one session.**
Write `--glide` or "the forwards fill", never in backticks.

### 6.9 CSS specificity in that same file
Two real bugs, both of which rendered *almost* correctly:

- `.vs-stage button` (0,1,1) silently beat a bare `.vs-key` (0,1,0) and took
  its colour, background and padding.
- `:hover` outspecifies `[data-live]`, so hovering a *listening* ribbon
  retracted it — the mark contradicting the state it exists to report.

Scope new component rules under `.vs-stage`, and scope hover per state.

### 6.10 Microphone needs a secure context
`localhost` counts. `192.168.x.x` over plain HTTP does not.

### 6.11 This is not the Next.js in your training data
See `AGENTS.md`. Read `node_modules/next/dist/docs/` before writing App Router
code. It was right every time this session.

---

## 7. The graveyard — tried, measured, removed

**Do not re-propose these without new evidence of the kind named.**

### Predicting ahead (removed, `31d4d79`)
Extrapolating the **line** forward worked and did not *feel* better: a
prediction that is right most of the time still moves the highlight for reasons
the reader cannot see.

> **`glide.ts` deliberately stays on the right side of this.** It interpolates
> progress *within a line the tracker has already committed to*, never which
> line. Worst case is ink slightly ahead of a voice on a line it is
> demonstrably on. Do not extend it to lines.

### Matching the recent tail of the transcript (removed, `668b8eb`)
Too jumpy to chant with at both 40% and 30%. **The lesson is about the sweep,
not the tail:** a synthetic degradation is nothing like what reaches a matcher
at a line boundary. **This is the second time a synthetic proxy pointed the
wrong way.** Attack jump latency with a real recording of someone jumping lines.

### Whisper (rejected in Chunk 3)
Its decoder is a language model; the encoder pads 5 s out to 30 s and it
transcribes the silence. CTC structurally cannot invent filler.

### int8 on the GPU (replaced, `8287f06`)
fp16/webgpu 48 ms vs int8/webgpu 887 ms. The download follows the backend.

### Cross-origin isolation (turned off by default, `f15d00a`) — **this session**
COOP/COEP were added to unpin the WASM backend from one thread. **They broke the
worker on every real machine** — a Surface and a Mac — while every test passed.

> **The tests passed because headless Chromium has no GPU adapter, so all of
> them fell back to the WASM path. The WebGPU path — the one real machines take
> — was never run with those headers even once.** If you test anything
> backend-related in headless, you are testing the fallback. Assume it.

The mechanism is still real (§8 B2). Kept behind `VOICE_SEVA_ISOLATE=1`.

### The adaptive window (never shipped, on purpose)
Shortening 5 s → 3 s on slow devices buys real compute. But score is
`1 − distance / query length`, so a shorter query makes every error cost
proportionally more, and **every threshold in `follow.ts` was derived at five
seconds.** This is exactly the class of change the graveyard says needs a real
recording.

---

## 8. Open work

### A. Blocked on the user — ask, do not guess

1. **`/capabilities` on the Surface.** Decides everything about performance
   work: whether there is an NPU to switch on, a WebGPU driver problem to
   attack, or a genuinely CPU-only device. **Two sessions have now guessed at
   this hardware and been wrong both times.**
2. **Chant into it at 303 lines.** Every threshold in `follow.ts` still comes
   from **one chanter, one session, fifteen windows** — against nine times the
   text it was measured on. `glide.ts` has never run against a real voice,
   because it only engages once the tracker is genuinely following and a fake
   microphone never gets there.
3. **A group / second recording.** Flagged since the first handoff, never
   delivered. Still the highest-value input available.

### B. Known-unfinished

4. **Mobile is completely unverified.** Every screenshot ever taken of this app
   is 1440×900. `PRODUCT.md` says the audience is SSIO devotees broadly on a
   public site — that is mostly phones. There is a breakpoint at 960px that
   hides the measure entirely and **nobody has ever looked at what it does.**
   This is the largest untested surface in the project.
5. **WASM is pinned to one thread.** ONNX Runtime sets `numThreads = 1` without
   cross-origin isolation, by its own explicit rule. Microsoft's benchmark says
   ~3.4× from two threads plus SIMD. The fix is to **self-host ORT's WASM
   binaries** (~36 MB into `public/`) so isolation does not break the
   CDN-hosted backend, then verify on a **GPU-capable** browser — the step that
   was skipped and caused the outage.
6. **The 190 MB download on mobile data** is a product problem, not a technical
   one. Nobody is warned what they are about to spend.
7. **UI preferences do not persist** across reloads (script, size, light).
8. **Jump latency ~3.5 s median.** See the graveyard.

### C. Not started

9. Chamakam beyond import — **only Anuvaka 1 of Namakam is independently
   verified** (0.0208 CER after normalisation against the Trust edition). The
   other 23 sections passed the shape gate and the round trip, nothing more.
10. Translations. `meaning` is null everywhere, on purpose. The saiveda PDF
    *does* contain English; the owner said not to ship it for now.
11. `/harness` is unreachable in production but **still compiled into the
    bundle.** Fine for a test deploy, not "absent".

### D. Untracked files to decide about

`tools/chant-import/{decode,verify,build_chant,derive_saiveda_maps}_saiveda.py`
and friends — the **abandoned** glyph-map approach from a killed agent. It never
finished verification. Left untracked deliberately so unverified decoding of
scripture does not sit in the history beside the verified path. Delete or commit
clearly labelled; do not quietly adopt.

---

## 9. How the user works

**They test by chanting into it.** They are not reading your test output. When
they say something is "too sensitive", "clunky", or "harsh on the eyes", that is
a **measurement** and it outranks any simulation you have run. It has been right
every single time this session, including twice when I had evidence saying
otherwise.

**Explain in plain language.** They have asked to be told things "as if i am
really ndumb". They ask excellent questions about internals and want analogies
and concrete numbers, not jargon.

**They will push back on "that's impossible."** They did, and they were right —
it produced the WebNN finding. Take it seriously and go research properly.

**Commit messages here are essays.** Subject line is a sentence in the
imperative about *what changed for the user*. The body explains the reasoning,
the measurement, and — critically — **what was wrong and why**. Look at
`git log -3 --format='%B'`. Do not degrade to "fix: update button".

**Be blunt about your own mistakes.** This session shipped a change that broke
the app on every real machine, and the commit reverting it says so plainly. Keep
that standard.

**Do not spawn subagents or run workflows unless asked.**

**Two design skills are installed** (`.claude/skills/`, gitignored):
`impeccable` (with a hook that scans UI edits automatically) and
`huashu-design`. `/impeccable` owns design work; it demands proposing options
before `overdrive` and it has caught real defects. Respect its findings or
classify them explicitly — do not silence them.

---

## 10. Facts worth not re-deriving

- **The model**: `vakyansh-wav2vec2-sanskrit-sam-60`, 94 M params, CTC,
  vocabulary of 67 pure-Devanagari tokens. Exported to ONNX by us; the export
  lives at **`Savith/vak-san-onnx`** on the Hub. Public, free — Hugging Face
  bills for *storage*, not bandwidth, and downloads count in your favour.
- **Language match beat data volume.** 4,200 h of Hindi lost to 60 h of Sanskrit.
- **Size did not matter.** 94 M beat 316 M beat 965 M.
- **The gate**: stability 0.095, discriminability 0.798. **GO.**
- **Separability at full scale holds.** Chamakam's *ca me* litany was expected
  to collapse it and did not: closest pair **0.184**. The only sub-0.10 pair in
  303 lines is Namakam anuvaka 11's refrain, sung verbatim twice — CER **0.000**,
  genuinely inseparable, handled by the viewport tie-break and by the 5 s window
  being longer than a line.
- **Both models exceed GitHub's 100 MiB per-file limit** (190 MB and 123 MB) and
  Vercel Hobby's 100 MB deployment cap. They can never live in the repo. This is
  why the Hub is not optional.
- **Everything after the model is under 5 ms combined.**
- Node v25.8.2, `npm test` is `node --test 'src/**/*.test.ts'`, no build step
  between source and tests.

---

## 11. If the user asks you to…

| ask | start here |
|---|---|
| "it's slow" | **Get `/capabilities` first.** Then §8 B5. Do not guess at their hardware. |
| "make line switching faster" | §7 graveyard, then get a real jump recording. |
| "it's too jumpy" | `follow.ts` `THRESHOLDS`, `CORROBORATION_MS`. Raise, don't lower. |
| anything about the UI | `/impeccable`, and read `design/direction-approved.md` first. |
| "add another chant" | `tools/chant-import/`. Run the gate and **read what it says.** |
| "add translations" | `meaning: null` is a decision. Ask for the source edition. |
| "make it work on my phone" | §8 B4 — genuinely unexplored. Expect real work. |
| "deploy it" | Vercel, production branch `main`. Every other branch gets a free preview URL. |
| "why is X like this" | `README.md` or the file's header comment almost certainly says. |

---

## 12. Where the writing already is

| file | |
|---|---|
| `PRODUCT.md` | product truth. Users, constraints, what must not be invented. |
| `README.md` | the reasoning behind every design decision, in prose. |
| `design/direction-approved.md` | why the UI looks like this, and what was rejected. |
| `design/brand-spec.md` | the palette, sampled from the emblem. **Full-chroma saffron is for marks, never fields** — breaking that is what made the old button look harsh. |
| `AI_Chant_Synchronization_Requirements.md` | the original numbered requirements. |
| `tools/chant-import/README.md` | why decoding a PDF is a program. |
| header comments in `src/lib/chant/*.ts` | load-bearing. |

---

**The app works and it is prettier than it has ever been. It has also never
been chanted into at this size, on the device that matters, by the person who
will actually use it. Everything in §8 A is worth more than anything in §8 B.**

**Good luck. Chant into it before you change anything.**

# HANDOFF

**To: the next Claude Code session on Voice Seva.**
**From: the one that built Chunks 0–10.**

Read this before touching anything. `README.md` explains *why the app is the way
it is*; this file explains *where you are standing, what will bite you, and what
to do next*. They do not overlap much on purpose.

---

## 0. The sixty-second version

Voice Seva listens to someone chanting **Sri Rudram Namakam, Anuvaka 1** through
the microphone and scrolls the script to keep pace with them. Everything runs in
the browser. No backend, no API keys, no audio leaves the device.

**The single most important idea in the project:**

> This is a **matching** problem, not a transcription problem.

The chant is a known, finite, 33-line script. Nobody ever sees the transcript.
So the speech model is *allowed to be wrong* — it only has to be wrong
**consistently**, because systematic errors get normalised away. That reframing
is the entire reason a 94 M-parameter model on a laptop GPU is enough. If you
ever catch yourself trying to improve transcription accuracy, stop: you are
solving the wrong problem.

The app works today. It is not finished.

---

## 1. State of play, as of the last commit

| | |
|---|---|
| Branch | `mic-capture-and-model-gate` |
| HEAD | `e601052` "Let what is on screen settle ties the audio cannot" |
| Working tree | clean |
| Pushed? | **No.** `main` is still at `ccfa602` "Initial commit". 19 commits are local-only. |
| `npm test` | **125 pass, 0 fail** (verified at handoff time) |
| `npm run typecheck` | clean, exit 0 |
| `npm run lint` | clean, exit 0 |
| Build order | Chunks 0–10 done; Chunk 7 (calibration) deliberately skipped |

The 19 unpushed commits are the whole project. Ask the user before pushing —
they have not asked for it and there is a licence question open (§8).

---

## 2. First five minutes

```bash
npm install
npm run dev          # http://localhost:3000
```

Three routes:

| route | what it is |
|---|---|
| `/` | the front door |
| `/chant` | **the app** — listen, follow, scroll |
| `/harness` | the instruments, one panel per chunk |

**`/chant` will not work until the model weights exist.** They are ~190 MB of
derived artefact and are gitignored. Regenerate:

```bash
cd tools/asr-bakeoff && uv sync && uv run python export_onnx.py
```

That writes `public/models/vak-san/` and verifies the export against PyTorch
before declaring success. At handoff time this directory **exists on the user's
machine** but will not exist on a fresh clone.

`/harness` is not a worse copy of `/chant`. It shows the matcher's **raw**
answer with no state machine in the way, which is how you tell "the matcher was
wrong" from "the matcher was right and the state machine was being sensible".
Both drive the same pipeline through the same `useAsrSession`, so they cannot
drift into reproducing different bugs. **Debug on `/harness` first, always.**

---

## 3. How it actually works

```
 AUDIO THREAD              MAIN THREAD                    WORKER THREAD
 AudioWorklet              tracker + matcher + UI         wav2vec2 CTC / WebGPU
 ────────────────          ──────────────────────         ─────────────────────
 mic 48 kHz → 16 kHz  ──▶  RingBuffer (5 s)
 mono, ~15 frames/s        decides when to fire     ──▶   transcribe 5 s window
                                                          ~48 ms on fp16/WebGPU
                           fuzzy match ◀──────────────    Devanagari text
                           state machine (follow.ts)
                           highlight + scroll
```

The main thread is in the middle **twice**: it holds the rolling buffer and
decides when to send a window, and then it takes the text back and decides what
the screen should do about it. The worker only transcribes. The audio thread
only captures.

**Felt lag = `inference + cadence/2`, and cadence *is* inference** (a window
only starts once the last one returns), so every millisecond off inference comes
off twice. Currently ~190 ms end to end on an M-series Mac.

---

## 4. Code map

Read in this order if you are new. Every one of these files has a header comment
explaining its reason for existing — those comments are load-bearing
documentation, not decoration. Do not delete them when editing.

### The pipeline, in order

| file | job | watch out |
|---|---|---|
| `src/lib/audio/capture.ts` | mic → 16 kHz mono frames | `AudioContext` is *constructed* at 16 kHz so the browser resamples natively. Do not hand-roll a decimator. |
| `public/worklets/capture-processor.js` | the AudioWorklet itself | plain JS, not TS — it is loaded by URL, not bundled |
| `src/lib/audio/ring-buffer.ts` | rolling 5 s of samples | trivial, well tested |
| `src/lib/chant/tracker.ts` | **the loop, and its refusals** | the hard part of the whole app. §5. |
| `src/workers/asr.worker.ts` | model load, inference, CTC decode | the blank-token trap. §6. |
| `src/lib/chant/normalize.ts` | nine destructive normalisation rules | **exists twice.** §6. |
| `src/lib/chant/matcher.ts` | Sellers/Levenshtein fuzzy substring search | score vs margin vs viewport tie-break |
| `src/lib/chant/follow.ts` | pure reducer: what the screen shows | "following is cheap, jumping is expensive" |
| `src/lib/chant/use-asr-session.ts` | the plumbing both pages share | one copy on purpose |
| `src/components/ChantingScreen.tsx` | `/chant` — 649 lines, the whole UI | the only big file |

### Data

| file | |
|---|---|
| `src/data/chants/sri-rudram-namakam-anuvaka-1.json` | **generated.** 33 lines, 18 verses. Never hand-edit — edit the importer and re-run. |
| `src/lib/chant/chant.ts` | types + `flatten()`. Imports **no** JSON, deliberately, so `npm test` works without the `@/` alias. |
| `src/lib/chant/chant-data.ts` | the one place the JSON is imported |
| `src/lib/chant/normalize-vectors.json` | fixture written by Python, replayed by the TS test |

### Offline tools (Python, via `uv`)

| dir | |
|---|---|
| `tools/asr-bakeoff/` | the model bake-off, the ONNX export, the consistency gate. `results-ctc.txt` holds **the fifteen real transcripts** every threshold in the app was derived from. |
| `tools/chant-import/` | decodes the source PDF's two legacy 8-bit font layers and cross-checks them against each other |

### Harness panels (`/harness`)

`MlSmokeTest` (WebGPU adapter) → `MicCaptureTest` (Chunk 1) → `AsrTest`
(Chunk 2) → `BenchPanel` (dtype × device × window sweep) → `TrackingTest`
(Chunk 6, raw matcher on live audio) → `MatcherTest` (Chunk 5, type text, no
audio) → `ChantScript` (Chunk 4, renders the JSON).

---

## 5. Every tunable number, and where it lives

If you are asked to "make it snappier" or "make it less jumpy", the answer is
almost certainly one of these. They were put in named constants specifically so
a future session would not have to hunt.

**`src/lib/chant/tracker.ts`**

| constant | value | meaning |
|---|---|---|
| `WINDOW_SECONDS` | 5 | swept against real chanting: 3 s jitters, 8 s blurs lines |
| `DEFAULT_INTERVAL_MS` | 250 | floor between window *starts* |
| `DUTY_FACTOR` | 2 | pacing = `2 × measured inference`, so the machine keeps half of itself |
| `MAX_INTERVAL_MS` | 1500 | ceiling, so a WASM-only machine is not stretched to 2.8 s |
| `PACING_SMOOTHING` | 0.3 | one slow window is not a trend |
| `silenceRms` (option) | 0.005 | below this, refuse the window |
| `minFillRatio` (option) | 0.6 | first window fires at 3 s, not 5 s |

**`src/lib/chant/follow.ts`**

| constant | value | meaning |
|---|---|---|
| `THRESHOLDS.high` | score 0.7 / margin 0.2 | jump automatically |
| `THRESHOLDS.medium` | score 0.5 / margin 0.08 | jump only with corroboration |
| `CONTINUES` | back 1, forward 2 | what counts as "carrying on" |
| `CORROBORATION` / `_MS` | 2 windows **and** 800 ms | before jumping somewhere distant |
| `PATIENCE` / `_MS` | 4 windows **and** 2000 ms | before giving up a lock |
| `IDLE_AFTER_SILENT_MS` | 8000 | quiet this long ends the session |

**`src/lib/chant/matcher.ts`**

| constant | value | meaning |
|---|---|---|
| `TIE_WITHIN` | 0.08 | how close a rival must be before the viewport may decide |

> **The count-and-clock pairs are not redundant.** When the loop ran once a
> second, "two agreeing windows" meant 2.4 s of evidence. At 250 ms it would
> mean 0.5 s — the same code silently four times more willing to move the
> screen. Every evidence threshold is `count >= N && elapsed >= MS` so that
> making the model faster can never make the app twitchier. **If you speed up
> inference again, you do not need to retune these.** That is the point.

---

## 6. Landmines — things that fail *silently*

This project has an unusual number of failure modes that produce plausible
output rather than an error. Every one of these was found the hard way.

1. **The CTC blank token is not the one the model's own repo declares.** The
   repo labels index 0 `<s>` and names `<pad>` at index 1 as the pad token —
   and index 1 never appears in the output at all. Get it wrong and you get
   `न<s>म<s>स<s>्<s>त<s>े…`, which looks *almost* like a transcript.
   `export_onnx.py` writes the corrected token into the exported
   `tokenizer_config.json`; `loadVocab()` reads it back. One place, no drift.

2. **CTC decode order.** Collapse runs of identical tokens **first**, *then*
   drop the blank. A blank between two identical letters is how CTC represents
   a genuine double letter. Reverse the order and `अअ` silently becomes `अ`.

3. **The normaliser exists twice** — `src/lib/chant/normalize.ts` (browser) and
   `tools/asr-bakeoff/normalize.py` (harness). **The go/no-go gate was measured
   with the Python one.** If they drift, the browser matches against numbers
   nobody measured and *nothing fails*. `dump_vectors.py` writes a fixture and
   `normalize.test.ts` replays it character for character. Never change one
   without the other.

4. **Unicode svara ordering.** The accent mark must come *after* every
   matra/virama/anusvara/visarga. NFC will **not** fix this, because visarga is
   a spacing mark of combining class 0. Wrong order → orphaned visarga →
   HarfBuzz renders a dotted circle. Tests, typecheck and build all passed; it
   was only visible on screen. `decode_pdf.py` has a `MISORDERED_SVARA` reorder
   pass and there is a regression test.

5. **`npm test` runs the TypeScript sources directly** through Node's type
   stripping. The one syntax that cannot be erased is a constructor **parameter
   property** (`constructor(private x: T)`) — it generates an assignment.
   `erasableSyntaxOnly` is on in `tsconfig.json` so `tsc` catches it, rather
   than it surfacing later as an unrunnable test file.

6. **Never pipe a check that gates a commit.** `npm run typecheck | tail`
   swallows the exit code and a type error got committed that way once. Run it
   bare, read the tail yourself.

7. **`erasableSyntaxOnly` + no `@/` alias in tests** is why `chant.ts` imports
   no JSON. If you add a JSON import to a module that tests touch, `npm test`
   breaks and the error will not obviously say why.

8. **Microphone requires a secure context.** `localhost` qualifies. Testing on a
   phone over `192.168.x.x:3000` will silently fail to get permission. Deploy or
   tunnel over HTTPS.

9. **transformers.js v4 needs no webpack aliases.** Older guides tell you to
   alias away `onnxruntime-node` and `sharp`. v4 ships proper `exports`
   conditions and resolves the web bundle itself. Do not add that config back
   without a failing build to justify it.

10. **This is not the Next.js in your training data.** See `AGENTS.md`. Read
    `node_modules/next/dist/docs/` before writing App Router code.

---

## 7. The graveyard — tried, measured, removed

**Do not re-propose these without new evidence of the kind named.** Each was
built, tested, and taken out for a reason that is written down.

### Predicting ahead (removed, `31d4d79`)
The highlight always trails slightly. Extrapolating forward at the measured
tempo was implemented and worked. It did not *feel* better: a prediction that is
right most of the time still moves the highlight for reasons the reader cannot
see, and an unexplained move costs more attention than a highlight that is
honestly a little late. Attack the lag at the source, not with a guess.

### Matching the recent tail of the transcript (removed, `668b8eb`)
After a jump the 5 s window is still mostly the *old* line, so the position
cannot move until the window flushes — a **3.5 s median**, which is the single
worst number in the app. Matching just the last 30–40% notices a jump in ~1 s.
A sweep of the whole anuvaka at up to double the model's error rate found
**zero** wrong landings at both 40% and 30%.

It was still too jumpy to chant with, at both settings, and it is gone.

> **The lesson is about the sweep, not the tail.** It degrades clean reference
> text with uniform substitutions — nothing like what actually reaches a matcher
> at a line boundary: breath, silence, a half-swallowed final syllable, and a
> CTC model that answers confidently when handed any of them. A shorter window
> is a larger fraction of exactly that material.
>
> **This is the second time a synthetic proxy pointed the wrong way here.** The
> first was TTS audio ranking Whisper above every CTC model in Chunk 3, which
> would have cost three chunks. If you attack jump latency again, do it with **a
> real recording of someone actually jumping lines**, not a simulation.

### Whisper (rejected in Chunk 3)
Its decoder is a language model — its superpower on ordinary speech and its
downfall here. The encoder pads a 5 s window out to 30 s and the decoder
dutifully transcribes the silence, producing runaway loops (`आप आप आप आप …`).
CTC has no language model and no generation loop, so it *structurally cannot*
invent filler or switch alphabet.

### int8 on the GPU (replaced, `8287f06`)
int8 is the smallest download, which is not the same as the fastest thing to
execute.

| | webgpu | wasm |
|---|---|---|
| int8 (123 MB) | 887 ms | 1405 ms |
| **fp16 (190 MB)** | **48 ms** | 1411 ms |

Where onnxruntime-web has no WebGPU kernel for a quantised MatMul it dequantises
or falls back per node, paying a copy across the GPU boundary each time — so the
int8 graph was *preventing* the GPU from being used. WASM has real int8 kernels,
which is why nothing changes there and why the gap is diagnostic rather than
mysterious. **The download now follows the backend.**

### Chunk 7, calibration (skipped, not failed)
It exists to tune the reference text toward what the model actually says. Real
windows score 0.9+ against the text as printed, so there is nothing to tune.
Revisit only if a longer or group recording says otherwise.

---

## 8. Open work, roughly in priority order

### A. Things the user owes the project (blocked on them, not on you)

1. **A longer / group recording.** Every threshold in `follow.ts` comes from
   *one recording by one chanter* — the fifteen transcripts in
   `tools/asr-bakeoff/results-ctc.txt`. This has been flagged repeatedly and
   never delivered. It is the highest-value input available and it unblocks
   almost everything else in this list.
2. **The ear check on Chunk 1** — download the WAV from `/harness` and confirm
   the resampling actually *sounds* right. Task #2 is still `in_progress` for
   this reason alone.
3. **An authoritative translation source.** Every `meaning` field in the chant
   JSON is `null`, on purpose — a translation without a named source is worse
   than none. Requirement 1.4 wants meanings.
4. **Confirm the model licence** on the Hugging Face page for
   `vakyansh-wav2vec2-sanskrit-sam-60` before anything is published. This could
   not be verified locally. **Flag it again if publishing comes up.**

### B. Known-unfinished code

5. **UI preferences do not persist across reloads** — script order
   (`devanagariLeads`), font size (`fontStep`), auto-scroll. Deferred because
   `localStorage` in an effect trips `react-hooks/set-state-in-effect` and a
   lazy initialiser breaks hydration. The clean fix is probably reading it in a
   `useSyncExternalStore` or accepting a one-frame flash behind a
   `suppressHydrationWarning`. Small, annoying, visible every session.
6. **Jump latency is ~3.5 s median and unfixed.** See the graveyard. This is the
   worst remaining number in the app.

### C. Scope not yet started

7. Anuvakas 2–11 (the importer handles one PDF at a time; the pipeline is ready)
8. Other chants; the JSON builder (Requirement 1.6)
9. Mobile; 45-minute sessions; group chanting
10. Deploy (needs HTTPS for the mic — see landmine 8)

---

## 9. How the user works, and what they expect

This matters as much as the code. Getting it wrong wastes their time.

**They test the app themselves, by chanting into it.** They are not reading your
test output — they are reading the screen while reciting. When they say
something is "too sensitive" or "pretty slow", that is a *measurement*, and it
outranks any simulation you have run. Twice now the simulation has been wrong
and they have been right.

**Explain things in plain language.** They have said, more than once, to explain
"as if i am really ndumb". They ask good questions about the internals — the
model, threading, the GPU, ONNX, the tie-break — and they want analogies and
concrete numbers, not jargon. This is a standing preference; it applies to every
explanation unless they say otherwise.

**Commit messages here are essays, and that is deliberate.** Look at
`git log -3 --format='%B'`. The subject line is a sentence in the imperative
about *what changed for the user* ("Let what is on screen settle ties the audio
cannot", "Make it 8x less laggy by shipping fp16 to the GPU"). The body explains
the reasoning, the measurement, and — critically — **what was wrong and why**
when something is reverted. Match this. Do not degrade to
"fix: update matcher threshold".

**Be blunt about your own mistakes.** There is a commit body that says the
measurement "was not noisy or marginal, it was answering a different question
than the one that mattered." Earlier in the project a commit message wrongly
described a bug as pre-existing when it had been introduced in that same change;
that was corrected to the user directly. Keep that standard.

**Record reversals in the README.** The graveyard entries in §7 all live in
`README.md` next to the feature they replaced, so the reasoning survives the
commit log. Do the same for anything you remove.

**Do not spawn subagents or run workflows unless asked.** Standing instruction.

---

## 10. Facts worth not re-deriving

- **The model**: `vakyansh-wav2vec2-sanskrit-sam-60`, 94 M params, 60 h of
  Sanskrit, CTC. Vocabulary is 67 tokens of **pure Devanagari**, so the output
  script cannot drift — script instability was the largest single source of
  inconsistency in the Whisper tests and normalisation cannot repair it.
- **Language match beat data volume.** The same architecture on 4,200 h of Hindi
  lost to 60 h of Sanskrit. 70× the audio in the wrong language was worth less
  than a little in the right one.
- **Size did not matter.** 94 M beat 316 M beat 965 M, in that order.
- **The gate**: stability **0.095**, discriminability **0.798** on real
  chanting, corroborated on a second recording under a second protocol.
  **Answer: GO.**
- **The chant is separable**: the two most similar of the 33 lines differ by
  **0.516** — five times the model's own 0.095 instability.
- **The int8 graph is 123 MB, not 94 MB**, because wav2vec2's positional
  convolution is weight-normalised — its weight is computed at runtime rather
  than stored — so those layers cannot be quantised and stay fp32.
- **Everything after the model is under 5 ms combined** — match, state machine,
  React. There has never been anything else worth optimising.
- **Margin ≠ second-best score.** Lines are concatenated with *no separator*, so
  an alignment ending one character into the next line costs one edit and scores
  almost identically. Counting that as a rival made a verbatim line 2 look
  ambiguous at 0.04; excluding the neighbours a 5 s window may legally straddle
  takes it to 0.58, while correctly leaving the genuinely-ambiguous line 4/27
  case at 0.00.
- **Duty cycle is ~25%** on an M-series Mac. The real risks on a weak machine
  are memory (190 MB of weights, shared with system RAM on integrated graphics)
  and heat over a long session — which is what `DUTY_FACTOR` is for.
- **`erasableSyntaxOnly` is on**, `npm test` is `node --test 'src/**/*.test.ts'`,
  Node is v25.8.2, and there is no build step between source and tests.

---

## 11. If the user asks you to…

| ask | start here |
|---|---|
| "make the line switching faster" | §7 graveyard first — then get a real jump recording. Do not simulate. |
| "it's too jumpy / too sensitive" | `follow.ts` `THRESHOLDS` and `CORROBORATION_MS`. Raise, don't lower. |
| "it's too slow to react" | `tracker.ts` `DEFAULT_INTERVAL_MS`, then `WINDOW_SECONDS`. Remember lag = `inference + cadence/2`. |
| "add another anuvaka" | `tools/chant-import/README.md`. Put the PDF at the repo root. Run `verify.py` and **read what it says** — it is not optional. |
| "add translations" | ask for the source edition first. `meaning: null` is a decision, not an oversight. |
| "make it work on my phone" | landmine 8 — HTTPS first, then everything else. |
| "why is X the way it is" | `README.md` almost certainly answers it, in prose, already. |
| "ship it" | §8 A4 — the licence is unverified. Say so. |

---

## 12. Where the writing already is

Do not duplicate these. Extend them.

| file | |
|---|---|
| `README.md` | the reasoning behind every design decision, in prose. **375 lines and worth reading in full.** |
| `AI_Chant_Synchronization_Requirements.md` | the original requirements, numbered. `follow.ts` cites 1.7 by number. |
| `AGENTS.md` / `CLAUDE.md` | "This is NOT the Next.js you know." Read the local docs. |
| `tools/asr-bakeoff/README.md` | 391 lines: the bake-off protocol, every number, the two duplicate-model traps |
| `tools/chant-import/README.md` | why decoding the PDF is a program and not a copy-paste |
| header comments in every `src/lib/chant/*.ts` | the reason each module exists. Load-bearing. |

---

**Good luck. The app works — chant into it before you change anything.**

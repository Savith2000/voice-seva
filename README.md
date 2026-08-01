# Voice Seva

Live chant recognition and script following. The app listens to chanting through
the microphone, identifies which line of a known chant is being recited, and
highlights and scrolls the script to keep pace — recovering when the chanting
jumps to a different anuvaka.

Full requirements: [`AI_Chant_Synchronization_Requirements.md`](./AI_Chant_Synchronization_Requirements.md)

## The core idea

This is a **matching** problem, not a transcription problem.

There is no need for accurate Sanskrit speech-to-text. The chant is a known,
finite, structured script — the only job is locating the current position within
it. So the speech model is allowed to be wrong, as long as it is wrong
*consistently*: systematic errors get normalised away, and the reference text is
calibrated against what the model actually outputs rather than what is correct.

That reframing is what makes the project tractable on a small on-device model.

## Architecture

Everything runs in the browser. There is no backend, and no audio ever leaves
the device.

```
AUDIO THREAD            WORKER THREAD             MAIN THREAD
AudioWorklet            wav2vec2 CTC (WebGPU)     matcher, UI
──────────────          ─────────────────────     ────────────
mic → mono         →    sliding window       →    fuzzy match → line
48k → 16k               transcribe ~1/sec         highlight + scroll
```

- **The model is a CTC model, not Whisper.** This was measured, and the
  measurement reversed the original choice — twice. Whisper's decoder is a
  language model, which is its superpower on ordinary speech and its downfall
  here: its encoder pads a 5-second window out to 30 seconds, and the decoder
  dutifully transcribes the silence, producing runaway loops
  (`आप आप आप आप …`). CTC has no language model and no generation loop, so it
  *structurally cannot* invent filler or switch alphabet — it reports the sounds
  it heard and stops.
  **`vakyansh-wav2vec2-sanskrit-sam-60`** is the pick: 94 M parameters,
  trained on 60 hours of actual Sanskrit, and it scored better than a model
  ten times its size. Full numbers in
  [`tools/asr-bakeoff`](./tools/asr-bakeoff).
- **The model is converted locally, not downloaded from the Hub.** No ONNX build
  of it exists — not for this model, not for any vakyansh model — so
  `tools/asr-bakeoff/export_onnx.py` produces one and verifies it: fp32 ONNX
  matches PyTorch at **CER 0.000**, int8 at **0.017**, an order of magnitude
  under the model's own 0.095 stability, so quantisation does not undermine the
  gate. The int8 graph is 123 MB rather than the 94 MB that one-byte-per-weight
  suggests, because
  wav2vec2's positional convolution is weight-normalised — its weight is
  computed at runtime rather than stored — so those layers cannot be quantised
  and stay fp32.
- **The download follows the backend, and the reason is an 18x speedup.**
  Per-window inference on a 5-second window, measured in the browser:

  | | webgpu | wasm |
  |---|---|---|
  | int8 (123 MB) | 887 ms | 1405 ms |
  | **fp16 (190 MB)** | **48 ms** | 1411 ms |

  int8 is the smallest download, which is not the same as the fastest thing to
  execute. Where onnxruntime-web has no WebGPU kernel for a quantised MatMul it
  dequantises or falls back per node, paying a copy across the GPU boundary
  each time — so the int8 graph was *preventing* the GPU from being used. WASM
  has real int8 kernels, which is why nothing changes there and why the gap is
  diagnostic rather than mysterious. fp16 also has better fidelity than int8
  (CER 0.000 vs 0.017 against PyTorch), so the 67 MB buys accuracy as well as
  speed. Machines without WebGPU still get the 123 MB int8 graph, where the
  extra download would buy nothing at all.
- **Language match beat data volume, and size didn't matter.** The same
  architecture trained on 4,200 hours of Hindi lost to one trained on 60 hours of
  Sanskrit — 70× the audio in the wrong language was worth less than a little in
  the right one. Meanwhile 94 M beat 316 M beat 965 M, in that order.
- **The output script can't drift, by construction.** The model's vocabulary is
  67 tokens of pure Devanagari, so there is no Latin or Arabic to slip into.
  This matters because script instability — the same audio rendered in Latin on
  one take and Arabic on the next, scoring ~1.0 against itself — was the single
  largest source of inconsistency in the Whisper tests, and normalisation cannot
  repair it. With Whisper it had to be suppressed by pinning the language; here
  it cannot happen.
- **The window is 5 seconds.** Swept 3 / 5 / 8 s against real chanting, and
  independently re-swept after the model changed: 3 s is too jittery to be
  stable, 8 s makes different positions in the chant look alike.
- **Resampling.** The model requires 16 kHz; microphones deliver 48 kHz. Rather
  than hand-rolling a decimator, the `AudioContext` is *constructed* at 16 kHz
  and the browser resamples the stream in native code, anti-aliasing filter
  included. Naive decimation would fold everything above 8 kHz back into the
  speech band and quietly corrupt every transcript.
- **Browser DSP is off by default.** Echo cancellation, noise suppression and
  auto gain are tuned for one person on a call. Chanting is sustained, tonal and
  often collective — noise suppression can read a held note as stationary noise
  and gate it. Left as a toggle so Chunk 3 can measure rather than guess.
- **Sliding window.** These are batch models with no streaming mode, so
  real-time output is faked by re-transcribing an overlapping window. Because
  the text is never shown to a user, unstable hypotheses can be consumed
  directly — no need to wait for confirmed tokens.
- **The loop's real job is refusing to run.** Frames arrive ~15 times a second,
  so anything that fires per frame — or on a fixed timer that ignores whether
  the last request finished — builds a queue that never drains, and every
  result then describes older and older audio while looking perfectly healthy.
  Exactly one request is in flight and everything arriving meanwhile is
  dropped. Falling behind by design beats falling behind by accident. Silence
  and a half-empty buffer are refused too — CTC on silence does not return an
  empty string, it returns whatever the blank collapses to, and the matcher
  would place that somewhere with a straight face.
- **The felt delay is `inference + cadence/2`, and cadence *is* inference.**
  Because a window only starts once the last one returns, every millisecond
  off inference comes off twice. On the test recording: **0.81 windows/second
  and ~1.5 s of lag on int8, 3.25 windows/second and ~190 ms on fp16** — the
  same transcript, byte for byte, arriving eight times sooner. Everything
  after the model (match, state machine, React) is under 5 ms combined, so
  there was never anything else worth optimising.
- **The loop leaves the machine at least half of itself.** Pacing on
  `max(floor, inference)` means the duty cycle *rises* as the hardware gets
  weaker: 48 ms of work every 250 ms is 25% busy, but 400 ms of work every
  400 ms is 100% busy — the faster the machine, the gentler the loop was
  being, which is exactly backwards. A laptop pinned flat for a 45-minute
  session gets hot, thermally throttles, and so gets slower still. The
  interval is now `clamp(2 × measured inference, 250 ms, 1500 ms)`, so a slow
  device updates less often rather than melting, and a fast one is unaffected.
  The ceiling exists because a machine without WebGPU is inference-bound at
  ~1400 ms anyway — stretching it to 2.8 s would protect nothing and cost a
  lot. Measured at **25% busy** on an M-series Mac.
- **Evidence is counted in seconds, not in windows.** When the loop ran once
  a second, "two agreeing windows before jumping" meant 2.4 s of evidence. At
  250 ms it would have meant 0.5 s — the same code silently four times more
  willing to move the screen. Corroboration and patience are both wall-clock
  thresholds now, so making the model faster cannot make the app twitchier.
- **The chant text is decoded from the source PDF, not retyped.** The Sai Trust
  edition carries its text twice — Devanagari and transliteration — and both
  are in legacy 8-bit font encodings with no `ToUnicode` map, so a plain
  extraction yields `nm?Ste éÔ m/Nyv?`. `tools/chant-import` reads the maps off
  the embedded fonts' own glyph outlines, then **checks the two layers against
  each other**: transliterate the Devanagari and it must reproduce the roman
  layer. That caught two glyphs that decode to something other than they look
  like, and reph landing inside conjuncts. Svara marks are pitch notation and
  easy to get subtly wrong, which is why none of this was done by hand.
- **Matcher.** The chant is flattened into one normalised string with a
  character → line index map, reducing "where are we?" to a fuzzy substring
  search — Sellers' variant of Levenshtein, where the first row is all zeros so
  a match may start anywhere for free. Line boundaries and partial lines fall
  out of that, and it runs in well under a millisecond against the ~885 ms the
  model takes. The 33 lines of Anuvaka 1 are separable: the two most similar
  differ by **0.516**, five times the model's own 0.095 stability.
- **A score is not enough; the matcher also reports a margin.** `बभूव ते धनुः`
  ends both line 4 and line 27, so it scores a perfect 1.00 in two places at
  once — confident and a coin flip. Margin is the gap to the best match
  *somewhere a jump would be visible*, which is not the same as the
  second-best position: lines are concatenated with no separator, so an
  alignment ending one character into the next line costs one edit and scores
  almost identically. Counting that as a rival made a verbatim line 2 look
  ambiguous at 0.04. Excluding the neighbours a five-second window may legally
  straddle takes it to 0.58, while leaving the line 4/27 case at 0.00 where it
  belongs.
- **The normaliser exists twice, and a test holds the two together.** Nine rules
  that deliberately destroy information — strip svara marks, collapse the three
  sibilants to स and every nasal to न, drop visarga, flatten vowel length,
  optionally de-aspirate, case-fold, delete all whitespace. They live in
  `src/lib/chant/normalize.ts` for the browser and
  `tools/asr-bakeoff/normalize.py` for the harness, and the gate was measured
  with the Python one. If they drift, the browser matches against numbers nobody
  measured and nothing fails. So `dump_vectors.py` writes a fixture from Python
  and the TypeScript test replays it character for character.
- **The screen shows verses, but tracks lines.** A verse is two half-lines
  either side of a danda, which is how the book sets it and how it is chanted,
  so grouping by verse keeps the whole unit in front of you and makes the
  scroll move once per couplet instead of twice. It groups by *verse* rather
  than by pairs because three of the eighteen genuinely are single lines — the
  opening invocation, verse 10, and the closing salutation — and blind pairs
  would box the invocation together with half of verse 2. The position is
  still a line: the active one is brighter inside its verse, and tapping
  either half sets it precisely.
- **Which script is large is a button, not a decision.** Devanagari is the
  source and the romanisation is what most people here actually read from;
  neither is obviously the right default, and it changes per person rather
  than per app.
- **Following is cheap; jumping is expensive.** That asymmetry is the whole
  confidence design. Chanting moves forward a line at a time, so a result that
  continues from where the screen already is needs only ordinary evidence,
  while one that would throw the screen elsewhere has to say so twice. It also
  changes how a result is *judged*: margin measures the risk of landing in the
  wrong place, and staying put takes no such risk — so a window that agrees
  with the current line is held to score alone. Requiring margin there froze
  the display at the end of every line, which is exactly where windows are
  weakest (the tail of the test recording scores 0.65 with a margin of 0.06
  and is entirely correct).
- **Predicting ahead was tried and removed.** The lag is real and measured
  — ~930 ms of inference plus half an update interval — so the highlight
  always trails the chanting slightly. Extrapolating forward at the measured
  tempo was implemented, tested and then taken out, because it did not feel
  better to chant with: a prediction that is right most of the time still
  moves the highlight for reasons the reader cannot see, and an unexplained
  move costs more attention than a highlight that is honestly a little late.
  The lag is better attacked at the source (faster inference, a shorter hop
  between windows) than papered over with a guess.
- **Jumps are noticed by the tail of the transcript, not the whole window.**
  Right after someone moves to a different line, the five-second window is
  still almost entirely the *old* line — and a transcript that is half one
  line and half another matches neither, because the chant is one string and
  "end of line 10 + start of line 25" does not occur in it. Roughly half the
  query counts as errors whichever way it aligns, so the score sits around 0.5
  and the state machine is right to refuse it. The position therefore cannot
  move until the window flushes: a **3.0 s median**, measured.

  The last 40% of the same transcript is already the recent audio. Matching it
  separately notices a jump in **1.25 s median** and costs nothing — no second
  inference pass, and matching is under a millisecond. End to end, following a
  jump went from **3.75 s to 2.50 s**.

  It can only ever *propose*. Over 3,177 windows of ordinary chanting the tail
  proposed a jump that was not happening once, at medium confidence, which
  corroboration refused — so unlike a high-confidence full-window match it is
  never allowed to move the screen on its own. And a proposal that has not yet
  been corroborated does not stop ordinary tracking: freezing for the
  corroboration window would let one spurious tail match stall the display for
  most of a second, which looks broken rather than careful.
- **It would rather look stale than wrong.** A bad window holds the line
  instead of blanking it; four in a row give the lock up but leave the last
  known line on screen; silence pauses without losing the place, and only
  eight seconds of it ends the session. A wrong line pulls someone out of the
  chant, and a slightly old one does not.

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS 4 |
| ML | `@huggingface/transformers` v4 (wav2vec2 CTC, ONNX, WebGPU) |
| Backend | none |

> **Bundler note:** transformers.js v4 ships proper `exports` conditions, so the
> `onnxruntime-node` / `sharp` webpack aliases that older guides recommend are
> **not** needed. The build resolves the web bundle on its own. Don't add that
> config back without a failing build to justify it.

## Running locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # node --test, runs the .ts sources directly
npm run typecheck  # tsc --noEmit
npm run lint
```

**The model weights are not in the repo.** They are 123 MB of derived artefact,
regenerated in one command:

```bash
cd tools/asr-bakeoff && uv sync && uv run python export_onnx.py
```

That writes `public/models/vak-san/` and checks the export against PyTorch
before declaring success. Without it, Chunk 2's panel reports a 404.

**The chant JSON is checked in; the PDF it came from is not.** Source editions
are publishers' work, and whether to redistribute one is not a decision to make
as a side effect of committing an importer. To regenerate
`src/data/chants/`, put the PDF at the repo root and see
[`tools/chant-import`](./tools/chant-import).

> **No build step between the source and the tests.** `npm test` hands the
> TypeScript straight to Node, which strips the types. The one thing that breaks
> is a constructor *parameter property* (`constructor(private x: T)`) — the only
> TypeScript syntax that cannot be erased, because it generates an assignment.
> `erasableSyntaxOnly` is on in `tsconfig.json` so `tsc` reports that as an
> error rather than leaving it to surface later as an unrunnable test file.

Three routes:

| | |
|---|---|
| `/` | the front door |
| `/chant` | **the app** — listen, follow, scroll |
| `/harness` | the instruments, one per chunk, reporting numbers the app has no reason to show |

`/harness` is not a worse copy of `/chant`. It shows the matcher's **raw**
answer, with no state machine in the way, which is how you tell "the matcher
was wrong" from "the matcher was right and the state machine was being
sensible". Both drive the same pipeline through the same `useAsrSession`, so
they cannot drift into reproducing different bugs.

### What it needs from the device

| | with WebGPU | without |
|---|---|---|
| download | 190 MB fp16 | 123 MB int8 |
| per window | ~48 ms | ~1400 ms |
| updates | ~4/second | ~0.7/second |
| busy | ~25% | inference-bound |

Both work. Without WebGPU the highlight lags by a second or two instead of
about 200 ms, which is the difference between "follows you" and "catches up
with you" — usable, not pleasant. The fallback is automatic: if the fp16 graph
cannot be created, the worker retries on WASM with int8 and says so.

The GPU work is small and bursty — a 94 M-parameter encoder over five seconds
of audio, a few times a second, at a quarter duty cycle. It is not a game
loop. The things that would genuinely hurt on a weak machine are memory
(190 MB of weights, shared with system RAM on integrated graphics) and heat
over a long session, which is what the duty-cycle cap above is for.

> **Microphone requires a secure context.** `localhost` qualifies, so desktop
> development works. Testing on a phone over a LAN address (`192.168.x.x:3000`)
> will silently fail to get mic permission — deploy first, or tunnel over HTTPS.

## Build order

Each step proves one thing and ends in something observable. Ordered so the
riskiest assumption is tested first, while it is still cheap to change course.

| | Step | Proves | |
|---|---|---|---|
| 0 | Next.js skeleton | ML bundles client-side, WebGPU adapter available | ✓ |
| 1 | Mic capture at 16 kHz | resampling is correct (verified by WAV playback) | ✓ |
| 3 | **Consistency test** | **go/no-go — is the model consistently wrong?** | ✓ |
| 2 | CTC model in a worker | ONNX export matches PyTorch, transcribes a clip | ✓ |
| 4 | Anuvaka 1 as JSON | Devanagari + svara marks render correctly | ✓ |
| 5 | Matcher via text box | matching works, tested by typing (no audio) | ✓ |
| 6 | Sliding window | audio drives the matcher end to end | ✓ |
| 7 | Calibration mode | reference text tuned to model output | skipped |
| 8 | State machine | never jumps on a guess | ✓ |
| 9 | Chanting screen | highlight + scroll feels calm | ✓ |
| 10 | Demo polish | someone else can use it unaided | ✓ |

**Step 3 was the gate, and it has passed** — out of order, and deliberately so.
Accuracy is irrelevant; the question was whether the errors repeat. Consistent
errors the matcher absorbs. Random errors it cannot, and the approach would have
needed to change — a larger model, a fine-tune, or server-side inference.

It was run offline in [`tools/asr-bakeoff`](./tools/asr-bakeoff) rather than in
the browser, because swapping models there costs one line and in the browser
costs an ONNX conversion. **Answer: GO** — stability 0.095 with discriminability
0.798 on real chanting, corroborated on a second recording under a second
protocol. Step 2 now has a model worth wiring up, which is why it comes after.

Front-loading this paid for itself several times over. It reversed the model
choice twice, established the 5-second window, and turned up four bugs — a
mis-stripped CTC blank token, a missing case-fold rule, and two duplicate-model
traps — every one of which was silent, and all of which would otherwise have
been found through a browser and an ONNX conversion. It also produced the most
useful lesson available: **the synthetic proxy gave the wrong answer.** On clean
TTS, Whisper beat every CTC model. On real chanting it came last. Three chunks
would have been built on it.

## Scope of the first demo

One chant (Sri Rudram Namakam, Anuvaka 1), desktop Chrome, live microphone,
sequential tracking, jump detection, highlight and scroll.

Deliberately excluded: remaining anuvakas, other chants, the JSON builder,
admin tooling, accounts, multi-language meanings, mobile optimisation, and
tuning for group chanting or 45-minute sessions.

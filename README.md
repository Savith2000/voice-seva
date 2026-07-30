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
  **`vakyansh-wav2vec2-sanskrit-sam-60`** is the pick: 94 M parameters
  (**123 MB** shipped, see below), trained on 60 hours of actual Sanskrit, and it
  scored better than a model ten times its size. Full numbers in
  [`tools/asr-bakeoff`](./tools/asr-bakeoff).
- **The model is converted locally, not downloaded from the Hub.** No ONNX build
  of it exists — not for this model, not for any vakyansh model — so
  `tools/asr-bakeoff/export_onnx.py` produces one and verifies it: fp32 ONNX
  matches PyTorch at **CER 0.000**, int8 at **0.017**, an order of magnitude
  under the model's own 0.095 stability, so quantisation does not undermine the
  gate. 123 MB rather than the 94 MB that one-byte-per-weight suggests, because
  wav2vec2's positional convolution is weight-normalised — its weight is
  computed at runtime rather than stored — so those layers cannot be quantised
  and stay fp32.
- **WebGPU beats WASM, but not by much: 885 ms vs 1371 ms** per 5-second window,
  against ~20 ms for the same graph on CPU in Python. int8 operator coverage on
  the WebGPU execution provider is thin. Both backends return byte-identical
  text, and the harness page lets you switch between them. This is adequate for
  the ~1/second design but has little headroom; fp16 is the lever if Chunk 6
  needs one.
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
  directly — no need to wait for confirmed tokens. At 0.02 s per 5-second window
  there is a lot of headroom here.
- **Matcher.** The chant is flattened into one normalised string with a
  character → line index map, reducing "where are we?" to a fuzzy substring
  search. Line boundaries and partial lines fall out for free.
- **The normaliser exists twice, and a test holds the two together.** Nine rules
  that deliberately destroy information — strip svara marks, collapse the three
  sibilants to स and every nasal to न, drop visarga, flatten vowel length,
  optionally de-aspirate, case-fold, delete all whitespace. They live in
  `src/lib/chant/normalize.ts` for the browser and
  `tools/asr-bakeoff/normalize.py` for the harness, and the gate was measured
  with the Python one. If they drift, the browser matches against numbers nobody
  measured and nothing fails. So `dump_vectors.py` writes a fixture from Python
  and the TypeScript test replays it character for character.
- **Confidence gate.** A LOCKED / SEARCHING / IDLE state machine that would
  rather freeze the screen than jump to a wrong line.

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

> **No build step between the source and the tests.** `npm test` hands the
> TypeScript straight to Node, which strips the types. The one thing that breaks
> is a constructor *parameter property* (`constructor(private x: T)`) — the only
> TypeScript syntax that cannot be erased, because it generates an assignment.
> `erasableSyntaxOnly` is on in `tsconfig.json` so `tsc` reports that as an
> error rather than leaving it to surface later as an unrunnable test file.

The dev server serves a **development harness**, not the app — a set of
instruments for testing each piece in isolation. The real chanting interface
arrives in Chunk 9.

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
| 4 | Anuvaka 1 as JSON | Devanagari + svara marks render correctly | |
| 5 | Matcher via text box | matching works, tested by typing (no audio) | |
| 6 | Sliding window | audio drives the matcher end to end | |
| 7 | Calibration mode | reference text tuned to model output | |
| 8 | State machine | never jumps on a guess | |
| 9 | Chanting screen | highlight + scroll feels calm | |
| 10 | Demo polish | someone else can use it unaided | |

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

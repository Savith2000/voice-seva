# ASR bake-off

A standalone harness for answering one question before the web app depends on
the answer:

> Given the same line chanted several times, does the model produce **the same
> output every time?**

Accuracy is not measured and is not wanted. We match against a known script, so
a model that is wrong in the same way every time is perfectly usable. A model
that is wrong differently every time is not usable at all.

This is deliberately **outside** the Next.js app. Swapping models here costs
one line; swapping them in the browser costs an ONNX conversion.

## Running

```bash
uv sync
uv run python bakeoff.py --list-models
uv run python bakeoff.py --models vak-san,mms-hin audio/take*.wav   # repeated takes
uv run python bakeoff.py --stability --window 5 --from 4.0 \
  --models vak-san audio/continuous.m4a                            # one long take
```

There are **two protocols**, and using the wrong one produces confident nonsense:

- **repeated takes** (default, or `--split`) — the same line chanted several
  times. Reports mean pairwise CER between takes.
- **`--stability`** — one *continuous* recording. Slides the window slightly and
  asks whether the transcript survives, which is what production actually does.
  Reports stability (low is good) *and* discriminability (high is good).
  Assumes the chant moves forward; see the caveat below.

**Any audio format works** — `.m4a`, `.wav`, `.mp3`, `.aiff`. Everything is
decoded, downmixed to mono and resampled to 16 kHz by ffmpeg, on one code path,
so a phone voice memo and a WAV from the browser harness are treated identically.
If they went through different code, a difference in results might be a
difference in decoding rather than in the model.

## Recording protocol

Consistency needs repetition, so one recording tells you nothing. You need the
**same line** chanted 4–5 times. Two equally good ways:

**One recording with pauses** (easiest — a phone voice memo):

```bash
uv run python bakeoff.py --split audio/memo.m4a
```

Chant the line, pause for a second, chant it again, and so on. `--split` cuts it
into takes at the pauses. Use `--min-silence 0.3` if your pauses are short.

**Separate files:** use the Chunk 1 panel — start → chant → stop → download,
five times — and drop them in `audio/`.

Either way: chant **naturally**, don't try to perform identically. The point is
to find out whether the model survives normal variation.

Then repeat with a *different* line, to check the model doesn't collapse
different lines into the same output (which would make them indistinguishable
to the matcher).

> Lossy formats cost a little. The same four takes scored 0.064 as WAV and 0.083
> re-encoded as 96 kbps AAC. Not enough to change any decision, but if a result
> lands right on a threshold, re-run it from WAV before believing it.

## Reading the output

Two numbers per model, both mean pairwise character error rate between takes:

- **raw** — before normalisation.
- **norm** — after `normalize.py` collapses the distinctions we've decided the
  model is unreliable about. This is the number that matters.

Rough bands: `≤0.15` go, `0.15–0.35` marginal, `>0.35` no.

In `--stability` mode the columns are **stability** (same audio, window nudged —
low is good, <0.20), **discriminability** (different points in the chant — high
is good, >0.50, or the matcher has nothing to tell positions apart with), and
**params / int8**, the latter a rough browser download at one byte per weight.
Both score columns have to be right: a model that transcribes every position to
the same mush is perfectly stable and perfectly useless.

The **script(s)** column flags a failure mode invisible in CER: a model that
renders the same audio in Latin on one take and Devanagari on the next scores
~1.0 against itself while having heard the audio perfectly well. Normalisation
cannot repair that. A `!` means it happened.

## Results: small CTC models, 2026-07-29 — **this settles the model choice**

MMS won the previous round on architecture, not on size, so the question was
whether a model small enough to ship keeps the same property. It does, and the
best model here is also the smallest.

`vakyansh-wav2vec2-sanskrit-sam-60` is wav2vec2-**base** CTC fine-tuned on 60
hours of **Sanskrit** — the only model tested that was actually trained on the
language being chanted. 94 M parameters, **123 MB** as actually shipped (see
"Getting it into the browser" below; the one-byte-per-weight estimate of ~94 MB
turned out not to be achievable).

Recording 1, 16.5 s of continuous Rudram, window-shift protocol:

```bash
uv run python bakeoff.py --stability --window 5 --from 4.0 \
  --models vak-san,vak-hin,xlsr-hin,mms-hin "audio/Rudram Test 1.m4a"
```

| model | params | stability ↓ | discrim ↑ | per 5 s window | |
|---|---|---|---|---|---|
| **vak-san** (Sanskrit) | **94 M** | **0.095** | 0.798 | **0.02 s** | **GO** |
| vak-hin (Hindi, 4200 h) | 94 M | 0.134 | 0.797 | 0.02 s | GO |
| mms-hin | 965 M | 0.163 | 0.822 | 0.13 s | GO |
| xlsr-hin | 316 M | 0.180 | 0.862 | 0.05 s | GO |
| whisper-small-hi | ~240 M | 0.415 | 0.779 | 0.5–0.8 s | NO |

Recording 2, 24 s, the same line chanted 4× with pauses, repeated-take protocol
(`--split --min-silence 0.4`) — a genuinely independent second sample:

| model | norm CER ↓ | |
|---|---|---|
| **vak-san** | **0.121** | **GO** |
| mms-hin | 0.120 | GO |
| xlsr-hin | 0.139 | GO |
| vak-hin | 0.145 | GO |
| whisper-small-hi | 0.204 | MARGINAL |

**Ten times smaller and better.** vak-san beats MMS on recording 1 (0.095 vs
0.163) and ties it on recording 2 (0.121 vs 0.120), at 94 MB against 965 MB and
6× the speed. This is what makes the no-backend browser app viable: ~94 MB is a
plausible first visit, ~1 GB is not.

### What this round taught

**Language match beats data volume, decisively.** vak-san and vak-hin are the
same architecture and the same size. vak-san saw 60 hours of Sanskrit; vak-hin
saw 4,200 hours of Hindi — 70× more audio. vak-san wins (0.095 vs 0.134). For a
Sanskrit chant, 70× the data in the wrong language is worth less than a little
data in the right one.

**Size is not the axis.** 94 M beat 316 M beat 965 M, in that order, on
recording 1. Consistent with whisper-base scoring worse than whisper-tiny in the
synthetic round. What matters is the architecture and the training language.

**Whisper is caught between two failure modes.** Without a token-budget cap the
30-second encoder padding makes it loop; with the cap it truncates instead, and
at a different point on every take — on recording 2 the four transcripts ended
at `बाहुद्य`, `ब`, `हन्द`, `अस्तू`, in exact order of clip length. Its 0.204
there is truncation, not acoustic instability. Either way the cause is the same
padding, and no CTC model has the problem.

**Still zero loops from any CTC model**, at any window position, on either
recording. The architectural claim holds up.

### Two bugs this round, both silent

**The CTC blank token was being emitted into the transcripts.** The fairseq→HF
conversion of the vakyansh models labels vocabulary index 0 as `<s>` and then
declares `pad_token` to be `<pad>` at index 1 — a token that never appears in
the output. Wav2Vec2 strips the blank by comparing against `pad_token`, so it
stripped nothing and returned `न<s>म<s>स<s>्<s>त<s>े…`: 206 of 249 frames on a
5 s clip were blank, all preserved. Nothing raised.

"The blank is index 0" is not the fix either — `theainerd`'s XLSR-Hindi was built
by the HF fine-tuning tutorial, whose vocabulary puts a real letter (न) at index
0. So `detect_ctc_blank` asks the model instead: fed two seconds of silence a CTC
head has nothing to report and emits blank on every frame. Unanimous for all
three vakyansh models and for xlsr-hin. MMS returns `|` at only 0.73, so the
probe is not clean for it and its correctly-declared token is kept — which is
also why MMS's numbers here are identical to the previous round's, confirming the
two rounds are comparable.

**`addy88/wav2vec2-sanskrit-stt` is a bit-exact re-upload** of
vakyansh-sanskrit-sam-60 — identical weights, max absolute difference 0.0, and
identical output at all 20 window positions. It looked like independent
corroboration from a second Sanskrit model and was nothing of the kind. It is
deliberately left out of the registry with a comment saying why. (Second time
this trap has appeared: two of the synthetic TTS takes were byte-identical too.)

### Caveat: don't point `--stability` at repeated takes

Recording 2 initially scored 0.24–0.33 discriminability for *every* model, which
reads as catastrophic. It isn't: that recording chants the same line four times,
so two anchors genuinely contain the same words, and `--stability` assumes the
chant moves forward. Correct answer, wrong question. Every model failing
identically is the tell. The harness now prints a warning for exactly this case;
use `--split` for repeated takes.

### Getting it into the browser

```bash
uv run python export_onnx.py            # writes public/models/vak-san/
```

No ONNX build of this model exists on the Hub — nor of any vakyansh model — so
the browser cannot load it until we make one. The script exports, quantises, and
then **verifies**, which is the part that matters: int8 is lossy, and a model
that got 10% worse would still emit plausible-looking Devanagari while quietly
invalidating everything measured above.

| graph | size | CER vs PyTorch |
|---|---|---|
| fp32 | 379.6 MB | **0.000** — the export itself is exact |
| int8 | 123.2 MB | **0.017** — what ships |

0.017 is an order of magnitude below the model's own 0.095 stability, so
quantisation is not what limits this system. The whole difference is `नमः` →
`नमह` on two of four windows.

**Why 123 MB and not 94 MB.** One byte per weight predicts ~94 MB, and that is
not reachable here. wav2vec2's positional convolution is weight-normalised — its
weight is *computed* at runtime as `weight_g · weight_v / ‖weight_v‖` rather than
stored as a constant — and onnxruntime's Conv quantiser needs an initializer, so
it raises `Expected mul_105 to be an initializer`. Those layers stay fp32.
MatMul-only is therefore the floor for this architecture, not a cautious choice.
The script still attempts the Conv variant and reports the failure rather than
hiding it.

**Two other traps the export walked into.** torch emits opset 18 and the
automatic downconvert to 17 fails on this graph while printing a stack trace as
though it had not, leaving an 18 model behind — so the default is now 18.
And current transformers writes the feature-extractor settings to
`processor_config.json` and omits `special_tokens_map.json` entirely, while
transformers.js wants `preprocessor_config.json` and looks for the other; the
script writes both explicitly.

**Verified in the browser against this harness.** Same file, same 5-second
window at 4.0 s, byte-identical output:

```
python (int8 onnx)   तेरुध्रमन्यव उत्तोत् ईशवेनमह नमस्ते
browser (webgpu)     तेरुध्रमन्यव उत्तोत् ईशवेनमह नमस्ते
```

That comparison is the reason Chunk 2's panel has a "from file" button at all. A
microphone can never hand two runs the same input, so it could never have proven
this.

Timings per 5-second window: **WebGPU 885 ms, WASM 1371 ms**, against ~20 ms for
the same graph on CPU in Python. int8 coverage on the WebGPU execution provider
is thin, which is why the gap is 1.5× rather than the usual 5–10×. Adequate for
a ~1/second sliding window, but the headroom is thin; fp16 is the obvious lever
if Chunk 6 wants one.

### Still to firm up

Two recordings, one chanter, ~37 s of audio in total. The direction is now
supported by two protocols on two recordings plus a visible mechanism, which is
much stronger than last round. What is still missing is a **longer recording**
(60 s+, so the 8 s discriminability figure isn't an overlap artefact) and a
**group recording**, which is the case the demo actually has to survive and
which nothing here tests at all.

## Results: real chanting, 2026-07-26

16.5 s of continuous Rudram, one voice, phone voice memo (AAC 48 kHz mono).
No pauses, so takes cannot be compared — instead `--stability` slides the
window slightly and asks whether the transcript survives, which is what
production actually does. The first 4 s are a quiet lead-in and are excluded;
production gates those out on level anyway.

```bash
uv run python bakeoff.py --stability --window 5 --from 4.0 \
  --models mms-hin,whisper-small-hi "audio/Rudram Test 1.m4a"
```

| model | stability ↓ | discriminability ↑ | |
|---|---|---|---|
| **mms-hin** | **0.163** | 0.822 | **GO** |
| whisper-small-hi | 0.415 | 0.779 | NO |

**This reverses the synthetic result below, and the reversal is the finding.**
On clean TTS, Whisper beat MMS 0.064 to 0.095. On real chanting, Whisper fails
and MMS passes.

The mechanism is clear from the transcripts. Whisper's encoder always processes
30 seconds, so a 5-second window is padded with 25 seconds of silence — and the
decoder's language model transcribes the silence, producing runaway loops:

```
anchor 3, +0.00s:  आप आप आप आप आप आप आप आप आप आप आप ...
anchor 2, -0.15s:  अपना अपना अपना अपना अपना अपना ...
```

Capping the token budget to the audio's real length improved it (0.503 → 0.354
at 5 s) but did not fix it. MMS produced **no loops at any window position** —
CTC has no language model and no generation loop, so it structurally cannot
invent filler. It reports the sounds it heard and stops.

Clean synthetic speech is in-distribution for Whisper's language model, so the
language model helps. Real chanting is out-of-distribution, so the same language
model hallucinates. **Synthetic audio gave the wrong answer**, which is worth
remembering before trusting any future proxy.

### Window length

| window | stability | discriminability | |
|---|---|---|---|
| 3 s | 0.179–0.267 | 0.87–0.90 | too jittery |
| **5 s** | **0.125–0.157** | **0.74–0.80** | **best** |
| 8 s | 0.160–0.166 | 0.41–0.51 | positions blur together |

5 s is the sweet spot, matching the ring buffer already built in Chunk 1. The
discriminability collapse at 8 s is partly an artefact of a short recording —
12.5 s of usable audio means 8 s windows overlap heavily. Re-check on a longer
recording before treating it as a real ceiling.

### Caveats

One recording, ~12.5 s usable, 3–5 anchors. The *direction* is well supported
because the mechanism is visible in the transcripts. The precise numbers are
noisy and 0.163 is not far under the 0.20 threshold. Worth repeating on a longer
recording, a second chanter, and a group before building on it.

### Open problem — since resolved

MMS is ~1 B parameters (~3.6 GB as downloaded, roughly 1 GB quantised). That is
a heavy first visit for a browser app. The next experiment was a smaller CTC
model with the same structural advantage. See the section above: one exists, it
is 10× smaller, and it is *better*.

## Results: synthetic TTS, 2026-07-26

**Caveat first: this is macOS `say -v Lekha` at four speech rates, not
chanting.** Clean articulation, no reverb, no svara melody, one synthetic
voice. It validates the harness and gives a preliminary ranking. It does not
predict real-world numbers, which will be worse. See `results-tts.txt`.

| model | norm | script | verdict |
|---|---|---|---|
| whisper-small, `language="hi"` | **0.064** | Devanagari | **best** |
| whisper-small, `language="sa"` | 0.076 | Latin | good, but romanised |
| mms-hin | 0.095 | Devanagari | good, ~15× the download |
| mms-mar | 0.135 | Devanagari | ok |
| whisper-tiny | 0.176 | Latin | marginal |
| whisper-base | 0.556 | ! Arabic/Latin | script-unstable |
| whisper-small, auto-detect | 0.690 | ! Latin/Sinhala | catastrophic |

### What this changed

**Pin the language to `hi`.** Not `sa`, and never auto-detect. Counterintuitive
— we are transcribing Sanskrit — but `sa` returns romanised text and
auto-detection decided the audio was Sinhala on two of four takes and emitted a
repetition loop (`කින් කින් කින්…`), which is the classic Whisper hallucination
failure. Pinning the language pins the output script, and script instability
was the single largest source of inconsistency measured.

**Case-folding is load-bearing.** `whisper-small` scored 0.505 until the
normaliser learned to case-fold, then 0.076. The model had returned the same
line as both `namasti rudra` and `NAMASTE RUDR`. Devanagari has no case, so the
rule looks pointless until Whisper declines to emit Devanagari.

**MMS is not the escape hatch I thought.** It covers 1,198 languages and
Sanskrit is not one of them — the earlier claim that it supports Sanskrit was
wrong. Its real advantage is architectural: CTC has no language model, so it
structurally cannot hallucinate a sentence or switch alphabets. But it scored
*worse* than whisper-small here while being roughly 15× the download, so
there's no reason to pursue it unless Whisper fails on real chanting.

**whisper-base is worse than whisper-tiny.** Not an acoustic failure — it heard
the line correctly every time and then wrote one take in Arabic script. Model
size is not the axis that matters here; output stability is.

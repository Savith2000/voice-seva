"""Compare speech models on the same chanting audio.

The question this answers is NOT "which model is most accurate?" Accuracy is
irrelevant to us — we are matching against a known script, not transcribing for
a reader.

The question is: **given the same line chanted several times, does the model
produce the same output every time?** Systematic errors we can absorb by
normalising and by calibrating the reference text. Random errors we cannot.

Usage:
    uv run bakeoff.py audio/*.wav
    uv run bakeoff.py --models whisper-small,mms audio/take*.wav
    uv run bakeoff.py --list-models
"""

from __future__ import annotations

import argparse
import itertools
import shutil
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from normalize import cer, normalize

TARGET_RATE = 16_000


# --- model registry ----------------------------------------------------------
# Each entry is a lazily-constructed transcriber. Nothing downloads until asked
# for by name, because MMS alone is several gigabytes.


@dataclass
class ModelSpec:
    key: str
    repo: str
    kind: str  # "whisper" | "mms" | "ctc"
    language: str | None = None
    note: str = ""
    approx_download: str = ""


MODELS: list[ModelSpec] = [
    ModelSpec("whisper-tiny", "openai/whisper-tiny", "whisper", "sa",
              "smallest, likely too crude", "~150 MB"),
    ModelSpec("whisper-base", "openai/whisper-base", "whisper", "sa",
              "plausible browser default", "~290 MB"),
    ModelSpec("whisper-small", "openai/whisper-small", "whisper", "sa",
              "likely browser sweet spot", "~970 MB"),
    ModelSpec("whisper-small-hi", "openai/whisper-small", "whisper", "hi",
              "same model, told it is Hindi", "(cached)"),
    ModelSpec("whisper-small-auto", "openai/whisper-small", "whisper", None,
              "same model, language auto-detected", "(cached)"),
    ModelSpec("whisper-medium", "openai/whisper-medium", "whisper", "sa",
              "too big to ship, useful as a ceiling", "~3 GB"),
    # MMS covers 1,198 languages and Sanskrit is NOT one of them — checked, not
    # assumed. Its interest is architectural: CTC has no language model, so it
    # cannot hallucinate a plausible sentence or switch writing system the way
    # Whisper's decoder does. It reports sounds and stops.
    ModelSpec("mms-hin", "facebook/mms-1b-all", "mms", "hin",
              "phoneme-level CTC, Hindi adapter", "~4 GB"),
    ModelSpec("mms-mar", "facebook/mms-1b-all", "mms", "mar",
              "same weights, Marathi adapter", "(cached)"),
    # --- small CTC ------------------------------------------------------------
    # MMS won the real-chanting test on architecture, not on size: CTC has no
    # language model, so it cannot invent filler. If a 94 M-parameter CTC model
    # has the same property, the app stays in the browser. MMS at 1 B does not
    # fit a first visit, so this is the experiment that decides the deployment
    # story, not just the score.
    #
    # All three vakyansh-family models are wav2vec2-BASE (768 wide, 12 layers)
    # with a 67-token pure-Devanagari vocabulary. Checked before downloading:
    # a model that emits Latin would reintroduce the script instability that
    # sank whisper-base.
    ModelSpec("vak-san", "Harveenchadha/vakyansh-wav2vec2-sanskrit-sam-60",
              "ctc", None, "60h of SANSKRIT — the only in-language model here",
              "~380 MB"),
    # addy88/wav2vec2-sanskrit-stt is deliberately absent. It looks like a
    # second, independent Sanskrit CTC model and it is not: its weights are
    # bit-identical to vakyansh-sanskrit-sam-60 (max absolute difference 0.0,
    # checked). It produced identical output at all 20 window positions. Adding
    # it back would silently turn one measurement into a fake corroborating pair.
    ModelSpec("vak-hin", "Harveenchadha/vakyansh-wav2vec2-hindi-him-4200",
              "ctc", None, "same size, 4200h of Hindi — is data volume or "
              "language match what matters?", "~380 MB"),
    # The obvious large rung, ai4bharat/indicwav2vec-hindi, is a gated repo and
    # needs an authenticated token — not worth a login in a harness meant to be
    # reproducible. This is the same wav2vec2-large size class and open.
    ModelSpec("xlsr-hin", "theainerd/Wav2Vec2-large-xlsr-hindi", "ctc", None,
              "wav2vec2-LARGE, ~315 M params — the middle rung", "~1.3 GB"),
]

MODELS_BY_KEY = {m.key: m for m in MODELS}
DEFAULT_MODELS = ["whisper-base", "whisper-small", "whisper-small-hi"]


def detect_ctc_blank(model, processor, device) -> tuple[str, float]:
    """Ask a CTC model which token it uses as the blank.

    This cannot be read off the config, and getting it wrong does not raise —
    it quietly corrupts every transcript. The fairseq→HF conversion of the
    vakyansh models labels vocabulary index 0 as "<s>" and then declares
    pad_token to be "<pad>" at index 1, a token that never appears in the
    output at all. Wav2Vec2 strips the blank by comparing against pad_token, so
    with the wrong label it strips nothing and returns "न<s>म<s>स<s>्…" — every
    blank frame preserved. Measured: 206 of 249 frames on a 5 s clip were id 0.

    "The blank is index 0" is not the rule either. theainerd's XLSR-Hindi was
    built by the HF fine-tuning tutorial, whose vocabulary puts a real letter
    (न) at index 0 and appends the pad token at the end.

    So ask the model instead. Fed silence, a CTC head has nothing to report and
    emits blank on every frame — which makes two seconds of zeros a decisive
    probe. It is also completely deterministic and independent of the clip under
    test, so the answer cannot drift between takes and contaminate a
    *consistency* measurement, which is the one thing this harness exists to do.

    Returns (token, share). MMS is the reason for the share: it emits the word
    separator "|" on silence, only 0.73 of frames, so the probe is not clean for
    it — and its declared pad_token is already correct. Unanimity is the test of
    whether to believe the probe.
    """
    import torch

    probe = np.zeros(2 * TARGET_RATE, dtype=np.float32)
    inputs = processor(probe, sampling_rate=TARGET_RATE, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        ids = torch.argmax(model(**inputs).logits, dim=-1)[0]
    values, counts = torch.unique(ids, return_counts=True)
    top = int(values[int(counts.argmax())])
    share = float(counts.max()) / ids.numel()
    return processor.tokenizer.convert_ids_to_tokens(top), share


class Transcriber:
    """Wraps one model. Loads on first use, stays warm afterwards."""

    def __init__(self, spec: ModelSpec, device: str):
        self.spec = spec
        self.device = device
        self._impl = None
        # Counted from the loaded weights rather than read off a model card,
        # because the download size is the whole reason for this comparison and
        # a wrong number here would pick the wrong model.
        self.params: int | None = None

    def _load(self):
        if self._impl is not None:
            return self._impl

        import torch

        if self.spec.kind == "whisper":
            from transformers import WhisperForConditionalGeneration, WhisperProcessor

            processor = WhisperProcessor.from_pretrained(self.spec.repo)
            model = WhisperForConditionalGeneration.from_pretrained(self.spec.repo)
            model.to(self.device).eval()
            self.params = sum(p.numel() for p in model.parameters())

            def run(audio: np.ndarray) -> str:
                features = processor(
                    audio, sampling_rate=TARGET_RATE, return_tensors="pt"
                ).input_features.to(self.device)
                kwargs = {"task": "transcribe"}
                if self.spec.language:
                    kwargs["language"] = self.spec.language
                # Whisper's encoder always processes 30 seconds. A 5-second
                # window is padded with 25 seconds of silence, and the decoder
                # cheerfully transcribes the silence — which is where the
                # runaway "आप आप आप आप" loops come from. Measured on real
                # chanting: with a flat 200-token budget, three of four window
                # positions degenerated into loops.
                #
                # Capping the budget to what the audio could plausibly contain
                # stops a loop before it can drown the real transcript. Chanting
                # is slower than speech, so 12 tokens/second is already generous.
                seconds = len(audio) / TARGET_RATE
                max_new = max(16, int(seconds * 12))
                with torch.no_grad():
                    ids = model.generate(
                        features,
                        max_new_tokens=max_new,
                        # Greedy. Sampling would make the model inconsistent by
                        # construction, which is the exact property under test.
                        do_sample=False,
                        num_beams=1,
                        # Mild, deliberately. Sri Rudram genuinely repeats
                        # ("namo namah", the "cha me" cascade), so a hard
                        # no_repeat_ngram would corrupt correct transcripts.
                        repetition_penalty=1.15,
                        **kwargs,
                    )
                return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()

        elif self.spec.kind in ("mms", "ctc"):
            # Wav2Vec2Processor explicitly, NOT AutoProcessor. The Hindi
            # vakyansh repo ships a kenLM under language_model/, and AutoProcessor
            # would helpfully build a Wav2Vec2ProcessorWithLM around it — which
            # would bolt a language model onto the one architecture we chose
            # *because* it has no language model. The comparison would be
            # meaningless and the failure would look like a win.
            from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

            processor = Wav2Vec2Processor.from_pretrained(self.spec.repo)
            model = Wav2Vec2ForCTC.from_pretrained(self.spec.repo)
            if self.spec.kind == "mms":
                # MMS is one shared backbone plus a small per-language adapter.
                # Without this it decodes as English.
                processor.tokenizer.set_target_lang(self.spec.language)
                model.load_adapter(self.spec.language)
            model.to(self.device).eval()
            self.params = sum(p.numel() for p in model.parameters())

            blank, share = detect_ctc_blank(model, processor, self.device)
            declared = processor.tokenizer.pad_token
            if share >= 0.9 and blank != declared:
                # Assign pad_token rather than passing skip_special_tokens=True
                # to decode(). The order matters: convert_tokens_to_string
                # collapses repeated tokens FIRST and filters the blank second,
                # so a blank sitting between two identical letters correctly
                # keeps them apart. skip_special_tokens strips tokens before the
                # collapse, which would silently merge a genuine double letter.
                processor.tokenizer.pad_token = blank
                print(f"  CTC blank: {blank!r} (silence probe {share:.2f}), "
                      f"overriding declared {declared!r}")
            else:
                print(f"  CTC blank: {declared!r} (declared; silence probe "
                      f"returned {blank!r} at {share:.2f})")

            def run(audio: np.ndarray) -> str:
                inputs = processor(
                    audio, sampling_rate=TARGET_RATE, return_tensors="pt"
                )
                inputs = {k: v.to(self.device) for k, v in inputs.items()}
                with torch.no_grad():
                    logits = model(**inputs).logits
                # CTC: no language model, no generation loop. It reports the
                # sounds it heard and nothing more — which is why it cannot
                # hallucinate a plausible sentence the way Whisper can.
                ids = torch.argmax(logits, dim=-1)[0]
                return processor.decode(ids).strip()

        else:
            raise ValueError(f"unknown kind {self.spec.kind}")

        self._impl = run
        return run

    def transcribe(self, audio: np.ndarray) -> tuple[str, float]:
        run = self._load()
        started = time.perf_counter()
        text = run(audio)
        return text, time.perf_counter() - started


# --- audio -------------------------------------------------------------------


def load_audio(path: Path) -> np.ndarray:
    """Read any audio file as 16 kHz mono float32.

    Everything goes through ffmpeg rather than only the awkward formats: one
    code path means a .m4a voice memo and a .wav from the browser harness are
    decoded, downmixed and resampled by identical code. If they were handled
    differently, a difference in the results might be a difference in the
    decoding rather than in the model.
    """
    if not shutil.which("ffmpeg"):
        # soundfile can't read m4a/aac, so this is only a partial fallback.
        audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
        if rate != TARGET_RATE:
            raise SystemExit(
                f"{path.name} is {rate} Hz and ffmpeg is not installed.\n"
                f"Install it (brew install ffmpeg) or supply 16 kHz mono WAV."
            )
        return audio.mean(axis=1)

    result = subprocess.run(
        # f32le straight to stdout — same float format the browser produces,
        # so no intermediate quantisation to 16-bit on the way in.
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", "1", "-ar", str(TARGET_RATE), "-"],
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"{path.name}: ffmpeg failed —\n{result.stderr.decode()}")
    return np.frombuffer(result.stdout, dtype="<f4").copy()


def split_on_silence(
    audio: np.ndarray,
    *,
    drop_db: float = 35.0,
    min_silence: float = 0.6,
    min_take: float = 1.0,
    pad: float = 0.15,
) -> list[np.ndarray]:
    """Cut one long recording into takes at the pauses.

    Recording five separate files on a phone is tedious; recording once and
    pausing between repetitions is natural. This turns the second into the
    first.

    `drop_db` is relative to the recording's own loudest moment, so it adapts to
    quiet and loud recordings alike instead of assuming an absolute level.
    """
    hop = int(0.02 * TARGET_RATE)  # 20 ms
    frames = len(audio) // hop
    if frames == 0:
        return [audio]

    trimmed = audio[: frames * hop].reshape(frames, hop)
    rms = np.sqrt((trimmed.astype(np.float64) ** 2).mean(axis=1))
    peak = rms.max()
    if peak <= 0:
        return []

    db = 20 * np.log10(np.maximum(rms, 1e-12) / peak)
    voiced = db > -drop_db

    # Walk the frames, collecting runs of voiced audio and only ending a take
    # once the silence has lasted long enough to be a real pause rather than
    # the gap between two syllables.
    min_silence_frames = max(1, int(min_silence / 0.02))
    takes: list[tuple[int, int]] = []
    start: int | None = None
    silence_run = 0

    for index, is_voiced in enumerate(voiced):
        if is_voiced:
            if start is None:
                start = index
            silence_run = 0
        elif start is not None:
            silence_run += 1
            if silence_run >= min_silence_frames:
                takes.append((start, index - silence_run + 1))
                start = None
    if start is not None:
        takes.append((start, len(voiced)))

    pad_frames = int(pad / 0.02)
    out: list[np.ndarray] = []
    for begin, end in takes:
        begin = max(0, begin - pad_frames)
        end = min(frames, end + pad_frames)
        if (end - begin) * 0.02 >= min_take:
            out.append(audio[begin * hop : end * hop])
    return out


# --- reporting ---------------------------------------------------------------


@dataclass
class Result:
    model: str
    clip: str
    raw: str
    norm: str
    seconds: float


def dominant_script(text: str) -> str:
    """Which writing system this transcript is mostly in.

    Worth reporting on its own because it is a failure mode that hides inside
    the CER number. whisper-base rendered the same audio as Latin three times
    and Arabic once — acoustically consistent, but scoring ~1.0 against itself
    because the alphabets differ. Character normalisation cannot repair that;
    only pinning the language can.
    """
    counts: dict[str, int] = {}
    for char in text:
        if not char.isalpha():
            continue
        try:
            name = unicodedata.name(char).split()[0]
        except ValueError:
            continue
        counts[name] = counts.get(name, 0) + 1
    if not counts:
        return "—"
    return max(counts, key=lambda k: counts[k]).title()


@dataclass
class ModelReport:
    key: str
    results: list[Result] = field(default_factory=list)

    def scripts(self) -> list[str]:
        seen: list[str] = []
        for result in self.results:
            script = dominant_script(result.raw)
            if script not in seen:
                seen.append(script)
        return seen

    def consistency(self, normalized: bool) -> float | None:
        """Mean pairwise CER across clips. Lower is better. None if <2 clips."""
        texts = [(r.norm if normalized else r.raw) for r in self.results]
        pairs = list(itertools.combinations(texts, 2))
        if not pairs:
            return None
        return sum(cer(a, b) for a, b in pairs) / len(pairs)


def stability_report(
    audio: np.ndarray,
    transcriber: Transcriber,
    *,
    window: float,
    anchors: int,
    jitter: float,
    deaspirate: bool,
) -> tuple[float | None, float | None, list[str]]:
    """Measure window-shift stability on one continuous recording.

    Repeated takes are the obvious way to test consistency, but they are not
    what production does. Production slides a window along continuous audio, so
    the perturbation the model actually faces is *the window moving a little* —
    not the chanter starting over.

    So: pick anchor positions, transcribe the same span at several small
    offsets, and ask whether the transcript survives the shift.

    Returns (stability, discriminability, log lines).

    - stability: mean pairwise CER between jittered views of the SAME span.
      Low is good — the model ignores where we cut.
    - discriminability: mean pairwise CER between DIFFERENT spans.
      HIGH is good. Consistency alone is worthless if every part of the chant
      transcribes to the same mush; the matcher would have nothing to tell
      positions apart with. Both numbers have to be right.
    """
    total = len(audio) / TARGET_RATE
    if total < window + 2 * jitter:
        raise SystemExit(
            f"recording is {total:.1f}s, too short for a {window}s window "
            f"with {jitter}s jitter"
        )

    offsets = [-jitter, -jitter / 2, 0.0, jitter / 2, jitter]
    last_start = total - window - jitter
    span = last_start - jitter
    positions = [jitter + span * i / max(1, anchors - 1) for i in range(anchors)]

    log: list[str] = []
    per_anchor: list[list[str]] = []

    for index, start in enumerate(positions, start=1):
        views: list[str] = []
        log.append(f"\n  anchor {index}  ({start:.2f}s – {start + window:.2f}s)")
        for offset in offsets:
            begin = int((start + offset) * TARGET_RATE)
            clip = audio[begin : begin + int(window * TARGET_RATE)]
            raw, seconds = transcriber.transcribe(clip)
            norm = normalize(raw, deaspirate=deaspirate)
            views.append(norm)
            log.append(f"    {offset:+.2f}s ({seconds:4.2f}s)  {raw or '(empty)'}")
        pairs = list(itertools.combinations(views, 2))
        score = sum(cer(a, b) for a, b in pairs) / len(pairs)
        log.append(f"    -> stability within this anchor: {score:.3f}")
        per_anchor.append(views)

    within = [
        sum(cer(a, b) for a, b in itertools.combinations(views, 2))
        / len(list(itertools.combinations(views, 2)))
        for views in per_anchor
    ]
    stability = sum(within) / len(within) if within else None

    # Compare the centre view of each anchor against every other anchor's.
    centres = [views[len(offsets) // 2] for views in per_anchor]
    across = list(itertools.combinations(centres, 2))
    discriminability = (
        sum(cer(a, b) for a, b in across) / len(across) if across else None
    )

    return stability, discriminability, log


def verdict(score: float | None) -> str:
    if score is None:
        return "—"
    if score <= 0.15:
        return "GO — errors repeat, the matcher can absorb them"
    if score <= 0.35:
        return "MARGINAL — calibration (Chunk 7) may rescue it"
    return "NO — output is random, matching cannot work"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clips", nargs="*", type=Path)
    parser.add_argument(
        "--models",
        default=",".join(DEFAULT_MODELS),
        help=f"comma-separated. available: {', '.join(MODELS_BY_KEY)}",
    )
    parser.add_argument("--list-models", action="store_true")
    parser.add_argument(
        "--no-deaspirate",
        action="store_true",
        help="keep aspiration (kh/gh/th...) distinct during normalisation",
    )
    parser.add_argument(
        "--split",
        action="store_true",
        help="cut each file into takes at the pauses (for one long recording "
             "of the same line chanted several times)",
    )
    parser.add_argument(
        "--min-silence",
        type=float,
        default=0.6,
        help="seconds of quiet that separate two takes, with --split (0.6)",
    )
    parser.add_argument(
        "--stability",
        action="store_true",
        help="for ONE continuous recording: slide the window slightly and "
             "measure whether the transcript survives, which is what "
             "production actually does",
    )
    parser.add_argument("--window", type=float, default=5.0,
                        help="window length in seconds, with --stability (5.0)")
    parser.add_argument("--anchors", type=int, default=4,
                        help="positions sampled along the recording (4)")
    parser.add_argument("--jitter", type=float, default=0.3,
                        help="max window shift in seconds (0.3)")
    parser.add_argument("--from", dest="start_at", type=float, default=0.0,
                        help="ignore the first N seconds — recordings often "
                             "open with a quiet lead-in that production would "
                             "gate out on level anyway")
    parser.add_argument("--to", dest="end_at", type=float, default=None,
                        help="ignore everything after N seconds")
    args = parser.parse_args()

    if args.list_models:
        print(f"{'key':22} {'download':10} note")
        for spec in MODELS:
            print(f"{spec.key:22} {spec.approx_download:10} {spec.note}")
        return 0

    if not args.clips:
        parser.error("no audio files given")

    clips = sorted(args.clips)
    missing = [c for c in clips if not c.exists()]
    if missing:
        raise SystemExit(f"not found: {', '.join(str(m) for m in missing)}")

    keys = [k.strip() for k in args.models.split(",") if k.strip()]
    unknown = [k for k in keys if k not in MODELS_BY_KEY]
    if unknown:
        raise SystemExit(
            f"unknown model(s): {', '.join(unknown)}\n"
            f"available: {', '.join(MODELS_BY_KEY)}"
        )

    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"device: {device}   clips: {len(clips)}   models: {len(keys)}\n")

    if args.stability:
        if len(clips) != 1:
            raise SystemExit("--stability takes exactly one continuous recording")
        audio = load_audio(clips[0])
        full = len(audio) / TARGET_RATE
        end_at = args.end_at if args.end_at is not None else full
        audio = audio[
            int(args.start_at * TARGET_RATE) : int(end_at * TARGET_RATE)
        ]
        if args.start_at or args.end_at is not None:
            print(f"  {clips[0].name}  {full:.2f}s, using "
                  f"{args.start_at:.2f}s–{end_at:.2f}s")
        print(f"  {clips[0].name}  {len(audio) / TARGET_RATE:.2f}s continuous")
        print(f"  window {args.window}s, {args.anchors} anchors, "
              f"jitter ±{args.jitter}s\n")

        rows = []
        for key in keys:
            spec = MODELS_BY_KEY[key]
            print(f"\n{'=' * 78}\n{key}  (lang={spec.language})\n{'=' * 78}")
            transcriber = Transcriber(spec, device)
            stability, discriminability, log = stability_report(
                audio,
                transcriber,
                window=args.window,
                anchors=args.anchors,
                jitter=args.jitter,
                deaspirate=not args.no_deaspirate,
            )
            print("\n".join(log))
            rows.append((key, stability, discriminability, transcriber.params))

        print(f"\n\n{'=' * 78}\nWINDOW STABILITY\n{'=' * 78}")
        print("stability      — same audio, window nudged. LOW is good (<0.20).")
        print("discriminability — different points in the chant. HIGH is good")
        print("                   (>0.50), or the matcher cannot tell them apart.")
        print("int8           — rough browser download at 1 byte per weight.\n")
        print(f"{'model':22} {'stability':>10} {'discrim':>10} {'params':>9} "
              f"{'int8':>8}   verdict")
        print("-" * 96)
        for key, stability, discriminability, params in rows:
            size = f"{params / 1e6:8.0f}M" if params else "        ?"
            int8 = f"{params / 1e6:5.0f} MB" if params else "       ?"
            if stability is None or discriminability is None:
                note = "not enough data"
            elif stability > 0.35:
                note = "NO — a small shift changes the transcript"
            elif discriminability < 0.35:
                note = "NO — everything transcribes alike, nothing to match on"
            elif stability <= 0.20 and discriminability >= 0.50:
                note = "GO"
            else:
                note = "MARGINAL"
            print(f"{key:22} {stability:>10.3f} {discriminability:>10.3f} "
                  f"{size:>9} {int8:>8}   {note}")

        # A trap worth signposting, because it looks exactly like a model
        # failure and it is not. --stability assumes the chant *progresses*, so
        # that two anchors hold different text. Point it at a recording of one
        # line chanted several times and every anchor holds the same words —
        # discriminability collapses for every model at once, which is the
        # correct answer to the wrong question. Three models failing identically
        # is the tell.
        if all(
            d is not None and d < 0.35 for _, _, d, _ in rows
        ) and len(rows) > 1:
            print(
                "\nAll models scored low on discriminability. Before concluding\n"
                "anything about the models: does this recording chant the SAME\n"
                "line several times? --stability assumes the chant moves\n"
                "forward. For repeated takes use --split instead."
            )
        return 0

    if args.split:
        audio = {}
        for clip in clips:
            takes = split_on_silence(
                load_audio(clip), min_silence=args.min_silence
            )
            if not takes:
                print(f"  {clip.name}: no audio above the silence threshold")
                continue
            print(f"  {clip.name} -> {len(takes)} take(s)")
            width = len(str(len(takes)))
            for index, take in enumerate(takes, start=1):
                audio[Path(f"{clip.stem}#{index:0{width}d}")] = take
        if len(audio) < 2:
            raise SystemExit(
                "Splitting produced fewer than 2 takes. Try --min-silence 0.3 "
                "if the pauses are short, or check the recording isn't one "
                "continuous stretch of chanting."
            )
        print()
    else:
        audio = {c: load_audio(c) for c in clips}

    clips = list(audio)
    for clip, samples in audio.items():
        print(f"  {clip.name:28} {len(samples) / TARGET_RATE:6.2f}s")
    print()

    reports: list[ModelReport] = []

    for key in keys:
        spec = MODELS_BY_KEY[key]
        print(f"\n{'=' * 78}\n{key}  ({spec.repo}, lang={spec.language})\n{'=' * 78}")
        transcriber = Transcriber(spec, device)
        report = ModelReport(key)

        for clip in clips:
            try:
                raw, seconds = transcriber.transcribe(audio[clip])
            except Exception as error:  # noqa: BLE001 - one bad model must not
                print(f"  {clip.name}: FAILED — {error}")  # kill the whole run
                continue
            norm = normalize(raw, deaspirate=not args.no_deaspirate)
            report.results.append(Result(key, clip.name, raw, norm, seconds))
            print(f"\n  {clip.name}  ({seconds:.2f}s)")
            print(f"    raw   {raw or '(empty)'}")
            print(f"    norm  {norm or '(empty)'}")

        reports.append(report)

    # --- the actual answer ----------------------------------------------------
    print(f"\n\n{'=' * 78}\nCONSISTENCY  (mean pairwise character error rate between takes)")
    print(f"{'=' * 78}")
    print("Lower is better. This measures whether the model repeats itself,")
    print("NOT whether it is correct. Correctness is not required.\n")
    print(f"{'model':22} {'raw':>8} {'norm':>8}  {'script(s)':22} verdict")
    print("-" * 100)
    for report in reports:
        raw_score = report.consistency(normalized=False)
        norm_score = report.consistency(normalized=True)
        raw_text = f"{raw_score:.3f}" if raw_score is not None else "—"
        norm_text = f"{norm_score:.3f}" if norm_score is not None else "—"
        scripts = report.scripts()
        flag = "!" if len(scripts) > 1 else " "
        script_text = f"{flag}{'/'.join(scripts)}"
        print(
            f"{report.key:22} {raw_text:>8} {norm_text:>8}  {script_text:22} "
            f"{verdict(norm_score)}"
        )
    print(
        "\n! = the model changed writing system between takes. Normalisation\n"
        "    cannot fix this; pin the language instead."
    )

    if len(clips) < 2:
        print("\nOnly one clip — consistency needs at least two takes of the")
        print("same line to mean anything. Record the same line 3-5 times.")

    return 0


if __name__ == "__main__":
    sys.exit(main())

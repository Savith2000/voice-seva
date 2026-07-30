"""Export the chosen CTC model to ONNX for transformers.js, and prove it survived.

No ONNX build of this model exists — not on the Hub, not for any vakyansh
model — so the browser cannot load it until we make one. The output lands in
`public/models/<name>/` in the layout transformers.js expects.

The export itself is the easy part. The part that matters is the verification at
the end: int8 quantisation is *lossy*, and a model that got 10% worse would
still transcribe plausible-looking Devanagari. Chunk 3 cost real effort to
establish that this model is consistent; a quantisation step that quietly undoes
that would invalidate the gate without failing anything. So this script
transcribes real audio with PyTorch and with each ONNX variant and reports the
character error rate between them.

    uv run python export_onnx.py
    uv run python export_onnx.py --check "audio/Rudram Test 1.m4a"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

from bakeoff import MODELS_BY_KEY, TARGET_RATE, Transcriber, load_audio
from normalize import cer, normalize

# Where Next.js serves static files from. transformers.js will fetch
# /models/<name>/onnx/model_quantized.onnx from here.
WEB_ROOT = Path(__file__).resolve().parents[2] / "public" / "models"

# transformers.js looks for the graph under an `onnx/` subdirectory and the
# configs beside it. Anything else 404s at runtime with a confusing message.
ONNX_SUBDIR = "onnx"

# Files transformers.js reads to build the processor and tokenizer. Without
# preprocessor_config.json it will not know whether to normalise the waveform,
# which for this model is the difference between a transcript and gibberish.
CONFIG_FILES = [
    "config.json",
    "preprocessor_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
]


def export(key: str, out_dir: Path, opset: int) -> Path:
    """Trace the PyTorch model to ONNX with a dynamic time axis."""
    from transformers import Wav2Vec2ForCTC

    spec = MODELS_BY_KEY[key]
    model = Wav2Vec2ForCTC.from_pretrained(spec.repo).eval()

    onnx_dir = out_dir / ONNX_SUBDIR
    onnx_dir.mkdir(parents=True, exist_ok=True)
    target = onnx_dir / "model.onnx"

    # Two seconds of dummy audio. The length only sets the trace; the dynamic
    # axis below is what lets a 5-second window through at runtime. Without it
    # the graph would be frozen at exactly this many samples and every real
    # window would fail a shape check.
    dummy = torch.zeros(1, 2 * TARGET_RATE)

    torch.onnx.export(
        model,
        (dummy,),
        str(target),
        input_names=["input_values"],
        output_names=["logits"],
        dynamic_axes={
            "input_values": {0: "batch", 1: "samples"},
            "logits": {0: "batch", 1: "frames"},
        },
        opset_version=opset,
        do_constant_folding=True,
    )
    return target


def quantize(source: Path, target: Path, *, include_conv: bool) -> Path:
    """Dynamic int8 quantisation — the whole point of the exercise.

    fp32 is ~379 MB (and split across an external .onnx.data file, which
    transformers.js will not load), so quantising is not an optimisation here,
    it is what makes the model shippable at all. Dynamic rather than static
    quantisation needs no calibration dataset: weights are quantised ahead of
    time and activations on the fly.

    `include_conv` covers the wav2vec2 feature extractor, which reads the raw
    waveform. Intuition says leave it alone — quantising a continuous signal
    path should cost more accuracy than it saves — but intuition has been wrong
    twice already on this project, so both variants get measured.
    """
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(
        str(source),
        str(target),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Conv"] if include_conv else ["MatMul"],
    )
    return target


def write_configs(out_dir: Path, spec, processor) -> None:
    """Write the metadata files transformers.js reads, under the names it uses.

    `processor.save_pretrained` is not enough on its own, for two reasons found
    the hard way. It writes the feature-extractor settings to
    `processor_config.json` (the current transformers name), while
    transformers.js looks for `preprocessor_config.json` — and without it the
    browser does not know whether to normalise the waveform, which for this
    model is the difference between a transcript and gibberish. It also does not
    write the *model* config at all, since that belongs to the model rather than
    the processor.
    """
    from transformers import AutoConfig

    out_dir.mkdir(parents=True, exist_ok=True)
    AutoConfig.from_pretrained(spec.repo).save_pretrained(out_dir)
    # Explicitly, under the name transformers.js expects.
    processor.feature_extractor.to_json_file(out_dir / "preprocessor_config.json")
    processor.tokenizer.save_pretrained(out_dir)

    # Current transformers folds the special tokens into tokenizer_config.json
    # and no longer emits special_tokens_map.json, but transformers.js still
    # looks for it. Writing it costs four lines; finding out at runtime whether
    # its absence is tolerated costs an afternoon.
    tokenizer = processor.tokenizer
    (out_dir / "special_tokens_map.json").write_text(
        json.dumps(
            {
                name: getattr(tokenizer, name)
                for name in ("bos_token", "eos_token", "unk_token", "pad_token")
                if getattr(tokenizer, name, None)
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )


def run_onnx(path: Path, audio: np.ndarray, processor) -> str:
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inputs = processor(audio, sampling_rate=TARGET_RATE, return_tensors="np")
    logits = session.run(
        ["logits"], {"input_values": inputs["input_values"].astype(np.float32)}
    )[0]
    ids = logits.argmax(axis=-1)[0]
    return processor.decode(ids).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="vak-san",
                        help="registry key from bakeoff.py (vak-san)")
    parser.add_argument("--name", default=None,
                        help="directory name under public/models (defaults to "
                             "the registry key)")
    # 18, not 17: torch's exporter emits 18 and the automatic downconvert to 17
    # fails on this graph ("No initializer or constant input to node found"),
    # leaving an 18 model behind while printing a stack trace as if it had not.
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument("--check", type=Path, default=Path("audio/Rudram Test 1.m4a"),
                        help="audio used to verify the export did not degrade")
    parser.add_argument("--windows", type=int, default=4,
                        help="how many 5 s windows to compare (4)")
    parser.add_argument("--keep-fp32", action="store_true",
                        help="keep the fp32 graph and its 378 MB external data "
                             "file after verifying (deleted by default — it "
                             "cannot be served to transformers.js anyway)")
    args = parser.parse_args()

    if args.model not in MODELS_BY_KEY:
        raise SystemExit(f"unknown model {args.model!r}; "
                         f"available: {', '.join(MODELS_BY_KEY)}")
    spec = MODELS_BY_KEY[args.model]
    if spec.kind != "ctc":
        raise SystemExit(
            f"{args.model} is kind={spec.kind}. This exporter only handles plain "
            f"CTC models — MMS needs its adapters merged first, and Whisper is "
            f"an encoder-decoder with a different export shape entirely."
        )

    name = args.name or args.model
    out_dir = WEB_ROOT / name
    print(f"exporting {spec.repo}\n     -> {out_dir}\n")

    from transformers import Wav2Vec2Processor

    processor = Wav2Vec2Processor.from_pretrained(spec.repo)

    fp32 = export(args.model, out_dir, args.opset)
    external = fp32.with_suffix(".onnx.data")
    fp32_bytes = fp32.stat().st_size + (
        external.stat().st_size if external.exists() else 0
    )
    print(f"  fp32       {fp32_bytes / 1e6:7.1f} MB  {fp32.name}"
          f"{' + external data' if external.exists() else ''}")

    # Both quantisation scopes, so the size/fidelity trade is measured rather
    # than argued about. The shipped filename is fixed by transformers.js —
    # dtype "q8" resolves to exactly "model_quantized.onnx".
    variants: dict[str, Path] = {}
    for label, include_conv, filename in (
        ("int8", False, "model_quantized.onnx"),
        ("int8+conv", True, "model_convq.onnx"),
    ):
        try:
            path = quantize(
                fp32, fp32.with_name(filename), include_conv=include_conv
            )
        except ValueError as error:
            # Expected for include_conv on this architecture, and worth
            # reporting rather than crashing: wav2vec2's positional convolution
            # uses weight normalisation, so its weight is *computed* at runtime
            # (weight_g * weight_v / ||weight_v||) instead of being a constant.
            # onnxruntime's Conv quantiser requires an initializer, so there is
            # nothing to quantise. That makes MatMul-only the floor for this
            # model, not a conservative choice — hence ~123 MB rather than the
            # ~94 MB that one-byte-per-weight would suggest.
            print(f"  {label:9}  unavailable — {error}")
            fp32.with_name(filename).unlink(missing_ok=True)
            continue
        variants[label] = path
        print(f"  {label:9}  {path.stat().st_size / 1e6:7.1f} MB  {path.name}")

    if "int8" not in variants:
        raise SystemExit("int8 quantisation failed; nothing shippable was produced")

    write_configs(out_dir, spec, processor)

    # Bake the real CTC blank into the exported tokenizer config. The repo
    # declares pad_token "<pad>" at index 1, but the model emits index 0 ("<s>")
    # as its blank — see detect_ctc_blank in bakeoff.py. transformers.js strips
    # the blank by comparing against pad_token exactly as PyTorch does, so
    # without this the browser would produce "न<s>म<s>स<s>्..." and every
    # downstream match would fail on text that looks almost right.
    vocab = json.loads((out_dir / "vocab.json").read_text())
    blank = next(token for token, index in vocab.items() if index == 0)
    config_path = out_dir / "tokenizer_config.json"
    tokenizer_config = json.loads(config_path.read_text())
    declared = tokenizer_config.get("pad_token")
    if declared != blank:
        tokenizer_config["pad_token"] = blank
        config_path.write_text(
            json.dumps(tokenizer_config, indent=2, ensure_ascii=False) + "\n"
        )
        print(f"  pad_token  {declared!r} -> {blank!r}  (CTC blank baked in)")
    processor.tokenizer.pad_token = blank

    missing = [f for f in CONFIG_FILES if not (out_dir / f).exists()]
    if missing:
        raise SystemExit(f"processor did not write: {', '.join(missing)}")

    # --- the part that matters -------------------------------------------------
    if not args.check.exists():
        print(f"\n{args.check} not found — skipping verification. Do not ship "
              f"an unverified quantised model.")
        return 0

    print(f"\nverifying against {args.check.name}")
    audio = load_audio(args.check)
    torch_model = Transcriber(spec, "cpu")

    window = int(5.0 * TARGET_RATE)
    starts = np.linspace(
        4.0 * TARGET_RATE, max(4.0 * TARGET_RATE, len(audio) - window),
        args.windows,
    ).astype(int)

    graphs: dict[str, Path] = {"fp32": fp32, **variants}
    scores: dict[str, list[float]] = {label: [] for label in graphs}
    for index, start in enumerate(starts, start=1):
        clip = audio[start : start + window]
        reference, _ = torch_model.transcribe(clip)
        print(f"\n  window {index} ({start / TARGET_RATE:.2f}s)")
        print(f"    pytorch    {reference or '(empty)'}")
        for label, path in graphs.items():
            got = run_onnx(path, clip, processor)
            score = cer(normalize(reference), normalize(got))
            scores[label].append(score)
            flag = "" if score <= 0.05 else "   <-- DRIFT"
            print(f"    {label:10} {got or '(empty)'}")
            print(f"    {'':10} CER vs pytorch {score:.3f}{flag}")

    print(f"\n{'=' * 70}\nEXPORT FIDELITY  (CER against the PyTorch model)\n{'=' * 70}")
    print("Not accuracy. It asks whether the browser sees the same text the gate")
    print("in Chunk 3 was measured on. Above ~0.05 and the measured consistency")
    print("no longer describes what ships, without anything having failed.\n")
    for label, path in graphs.items():
        mean = sum(scores[label]) / len(scores[label])
        size = path.stat().st_size
        if label == "fp32" and external.exists():
            size += external.stat().st_size
        verdict = "ok" if mean <= 0.05 else "TOO MUCH DRIFT — do not ship"
        print(f"  {label:10} {mean:.3f}   {size / 1e6:6.1f} MB   {verdict}")

    shipped = variants["int8"]
    ok = sum(scores["int8"]) / len(scores["int8"]) <= 0.05

    if not args.keep_fp32:
        # transformers.js cannot load a graph whose weights live in an external
        # .onnx.data file, so leaving 378 MB in public/ serves no purpose.
        fp32.unlink(missing_ok=True)
        external.unlink(missing_ok=True)
        print("\n  removed the fp32 graph (--keep-fp32 to retain it)")

    print(f"\nshipping {shipped.name}, served from /models/{name}/")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

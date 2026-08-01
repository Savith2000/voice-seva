/// <reference lib="webworker" />

// Chunk 2: the speech model, off the main thread.
//
// Inference takes tens to hundreds of milliseconds. On the main thread that is
// tens to hundreds of milliseconds of frozen scrolling, which is the one thing
// the finished app must never do — a chant screen that stutters is worse than
// one that lags. So the model lives here and communicates by message.
//
// The model is a CTC model, not Whisper, and that was measured rather than
// assumed. See tools/asr-bakeoff. The short version: Whisper's decoder is a
// language model, its encoder pads every window out to 30 seconds, and it
// transcribes the padding — producing runaway loops on real chanting. CTC has
// no language model and no generation loop, so it cannot invent filler.

import {
  AutoProcessor,
  AutoModelForCTC,
  env,
  type PreTrainedModel,
  type Processor,
} from "@huggingface/transformers";

// The vocabulary is read straight from the exported files rather than through a
// tokenizer object. transformers.js's AutoProcessor carries only the feature
// extractor — tokenizers come from AutoTokenizer — and more importantly, CTC
// decoding here is eight lines of unambiguous logic. Going through a tokenizer
// would mean depending on *its* choices about when to collapse repeats and
// whether to strip the blank, which are exactly the two things that must match
// the Python harness character for character.
type Vocab = { tokens: string[]; blankId: number };
let vocab: Vocab | null = null;

async function loadVocab(): Promise<Vocab> {
  const base = `${env.localModelPath}${MODEL_ID}`;
  const [vocabJson, tokenizerConfig] = await Promise.all([
    fetch(`${base}/vocab.json`).then((r) => r.json()),
    fetch(`${base}/tokenizer_config.json`).then((r) => r.json()),
  ]);

  const tokens: string[] = [];
  for (const [token, id] of Object.entries(vocabJson as Record<string, number>)) {
    tokens[id] = token;
  }

  // The blank comes from the exported pad_token, which export_onnx.py has
  // already corrected to the token the model actually emits. Hardcoding 0 here
  // would duplicate that fact in a second place, free to drift.
  const padToken = (tokenizerConfig as { pad_token?: string }).pad_token;
  const blankId = padToken === undefined ? -1 : tokens.indexOf(padToken);
  if (blankId < 0) {
    throw new Error(
      `pad_token ${JSON.stringify(padToken) ?? "(missing)"} is not in vocab.json — ` +
        `re-run tools/asr-bakeoff/export_onnx.py`,
    );
  }
  return { tokens, blankId };
}

// Served out of public/models/, not fetched from the Hub. There is no ONNX
// build of this model on the Hub — we made one (tools/asr-bakeoff/export_onnx.py),
// so there is nothing remote to fall back to.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = "/models/";

const MODEL_ID = "vak-san";

export type AsrReady = {
  type: "ready";
  device: string;
  dtype: AsrDtype;
  loadMs: number;
  /** Non-fatal: WebGPU was asked for and refused. Worth surfacing, not throwing. */
  fallbackReason?: string;
};

export type AsrResult = {
  type: "result";
  id: number;
  text: string;
  /** Model time only, excluding the postMessage hop. */
  inferenceMs: number;
  /** Length of audio transcribed, so the panel can show a realtime factor. */
  audioSeconds: number;
};

export type AsrError = { type: "error"; id?: number; message: string };

/** Download progress, aggregated across every file the model needs. */
export type AsrProgress = {
  type: "progress";
  loaded: number;
  total: number;
  /** 0..1, or null while the total size is still unknown. */
  fraction: number | null;
  /** Whichever file most recently reported, for a bit of texture. */
  file: string | null;
};

export type AsrMessage = AsrReady | AsrResult | AsrError | AsrProgress;

/** "auto" tries WebGPU and falls back; the explicit values force one backend.
 *
 * Forcing exists because the answer was not obvious and mattered a lot. With
 * the int8 graph WebGPU managed only ~887 ms per 5-second window against
 * ~20 ms for the same graph on CPU in Python — the WebGPU provider's int8
 * kernel coverage is thin. Switching the GPU path to fp16 took that to ~48 ms
 * (see bestDtypeFor below). The panel still offers both and reports the
 * number, because the whole point is that this was measured.
 */
export type AsrDevice = "auto" | "webgpu" | "wasm";

/**
 * Which exported graph to run.
 *
 * "q8" is the 123 MB int8 export and the only one shipped by default. The
 * others exist so the cost of that choice can be measured rather than
 * assumed — int8 is the smallest download, which is not the same as the
 * fastest thing to execute.
 */
export type AsrDtype = "q8" | "fp16" | "fp32";

export type AsrRequest =
  | { type: "load"; device?: AsrDevice; dtype?: AsrDtype }
  | { type: "transcribe"; id: number; samples: Float32Array };

let processor: Processor | null = null;
let model: PreTrainedModel | null = null;
let loading: Promise<AsrReady> | null = null;
let loadedDevice: AsrDevice | null = null;
let loadedDtype: AsrDtype | null = null;

/**
 * Turn transformers.js's per-file callbacks into one overall figure.
 *
 * The graph is 123-190 MB and the first load is the longest the app ever makes
 * anyone wait, with nothing to look at. The library offers a "progress_total"
 * status that has already done the aggregating; the per-file tally is a
 * fallback, because a progress bar that silently stops moving is worse than
 * no progress bar at all.
 */
function reportProgress() {
  const files = new Map<string, { loaded: number; total: number }>();

  return (info: {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
  }) => {
    if (info.status === "progress_total") {
      post(info.loaded ?? 0, info.total ?? 0, null);
      return;
    }
    if (info.status !== "progress" || !info.file) return;

    files.set(info.file, {
      loaded: info.loaded ?? 0,
      total: info.total ?? 0,
    });
    let loaded = 0;
    let total = 0;
    for (const entry of files.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    post(loaded, total, info.file);
  };

  function post(loaded: number, total: number, file: string | null) {
    const message: AsrProgress = {
      type: "progress",
      loaded,
      total,
      fraction: total > 0 ? Math.min(1, loaded / total) : null,
      file,
    };
    self.postMessage(message);
  }
}

/**
 * The right graph for a given backend, measured rather than assumed.
 *
 * Per-window inference on a 5-second window, on this machine:
 *
 *            webgpu    wasm
 *   int8      887 ms   1405 ms
 *   fp16       48 ms   1411 ms
 *
 * fp16 is 18x faster on the GPU and identical on WASM, which is the signature
 * of int8 blocking the GPU path rather than of fp16 being clever: where
 * onnxruntime-web has no WebGPU kernel for a quantised MatMul it dequantises
 * or falls back per node, paying a copy across the GPU boundary each time.
 * WASM has real int8 kernels, so nothing changes there.
 *
 * So the download follows the backend: 190 MB of fp16 buys an 18x speedup on
 * a machine with WebGPU, and 123 MB of int8 stays the right choice without
 * one, where the extra 67 MB would buy nothing at all.
 */
function bestDtypeFor(device: string): AsrDtype {
  return device === "webgpu" ? "fp16" : "q8";
}

async function load(
  requested: AsrDevice,
  dtype?: AsrDtype,
): Promise<AsrReady> {
  const started = performance.now();
  const progress_callback = reportProgress();

  [processor, vocab] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
    loadVocab(),
  ]);

  // The dtype picks the filename: "q8" resolves to model_quantized.onnx,
  // "fp16" to model_fp16.onnx, "fp32" to model.onnx.
  let device: string = requested;
  let resolvedDtype: AsrDtype = dtype ?? bestDtypeFor(requested);
  let fallbackReason: string | undefined;

  if (requested === "auto") {
    // A hard failure here would read as "the model is broken" rather than
    // "this backend cannot run it", so fall back and say so. The fallback
    // changes the graph as well as the backend — fp16 buys nothing on WASM.
    try {
      resolvedDtype = dtype ?? bestDtypeFor("webgpu");
      model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
        dtype: resolvedDtype,
        progress_callback,
        device: "webgpu",
      });
      device = "webgpu";
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      resolvedDtype = dtype ?? bestDtypeFor("wasm");
      model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
        dtype: resolvedDtype,
        progress_callback,
        device: "wasm",
      });
      device = "wasm";
    }
  } else {
    model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
      dtype: resolvedDtype,
      progress_callback,
      device: requested,
    });
  }

  loadedDevice = requested;
  loadedDtype = resolvedDtype;
  return {
    type: "ready",
    device,
    dtype: resolvedDtype,
    loadMs: performance.now() - started,
    fallbackReason,
  };
}

self.addEventListener("message", async (event: MessageEvent<AsrRequest>) => {
  const request = event.data;

  try {
    if (request.type === "load") {
      const wanted = request.device ?? "auto";
      const wantedDtype = request.dtype;
      // Cached rather than re-entered: the panel may ask twice (a re-render, a
      // retry), and loading the same graph twice concurrently would double peak
      // memory for no benefit. Asking for a *different* backend is a real
      // request though, so that reloads.
      if (
        loadedDevice !== wanted ||
        (wantedDtype !== undefined && loadedDtype !== wantedDtype)
      ) {
        await model?.dispose();
        model = null;
        loading = load(wanted, wantedDtype);
      }
      loading ??= load(wanted, wantedDtype);
      self.postMessage(await loading);
      return;
    }

    if (request.type === "transcribe") {
      loading ??= load("auto");
      await loading;
      if (!processor || !model || !vocab) throw new Error("model failed to load");

      const started = performance.now();
      // The processor handles whatever waveform normalisation this model was
      // trained with, read from preprocessor_config.json. Doing it by hand
      // would be guessing at a value that is written down.
      const inputs = await processor(request.samples);
      const { logits } = await model(inputs);

      // CTC decoding: one prediction per frame, take the arg max, then collapse
      // repeats and drop the blank. No beam search and no language model —
      // which is the whole reason this architecture was chosen.
      const [, frames, vocabSize] = logits.dims as [number, number, number];
      const scores = logits.data as Float32Array;
      const ids = new Array<number>(frames);
      for (let frame = 0; frame < frames; frame++) {
        const offset = frame * vocabSize;
        let best = 0;
        for (let token = 1; token < vocabSize; token++) {
          if (scores[offset + token] > scores[offset + best]) best = token;
        }
        ids[frame] = best;
      }

      const text = decodeCtc(ids, vocab);
      const result: AsrResult = {
        type: "result",
        id: request.id,
        text,
        inferenceMs: performance.now() - started,
        audioSeconds: request.samples.length / 16_000,
      };
      self.postMessage(result);
    }
  } catch (error) {
    const message: AsrError = {
      type: "error",
      id: request.type === "transcribe" ? request.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(message);
  }
});

/** Collapse CTC frame predictions into a string.
 *
 * Order matters and the two steps are not interchangeable: collapse runs of
 * identical tokens FIRST, then drop the blank. A blank sitting between two
 * identical letters is exactly how CTC represents a genuine double letter, so
 * dropping blanks first would silently merge "अअ" into "अ".
 *
 * The blank for this model is *not* the token its own repo declares. The repo
 * labels vocabulary index 0 "<s>" and names "<pad>" at index 1 as the pad
 * token — and index 1 never appears in the output at all. Getting this wrong
 * does not throw; it returns "न<s>म<s>स<s>्<s>त<s>े…" with every blank frame
 * preserved, which looks almost like a transcript. export_onnx.py writes the
 * corrected token into the exported tokenizer_config.json and loadVocab reads
 * it back, so the fact lives in exactly one place.
 */
function decodeCtc(ids: number[], { tokens, blankId }: Vocab): string {
  let out = "";
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && ids[i] === ids[i - 1]) continue; // collapse
    if (ids[i] === blankId) continue; // then drop the blank
    out += tokens[ids[i]] ?? "";
  }
  // "|" is this vocabulary's word delimiter, exactly as in the Python harness.
  return out.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

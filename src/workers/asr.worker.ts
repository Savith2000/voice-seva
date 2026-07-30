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

export type AsrMessage = AsrReady | AsrResult | AsrError;

/** "auto" tries WebGPU and falls back; the explicit values force one backend.
 *
 * Forcing exists because the answer is not obvious and matters a lot. WebGPU is
 * the faster backend for most models, but this one is int8, and the WebGPU
 * execution provider's int8 operator coverage is thin — measured here at ~880 ms
 * per 5-second window against ~20 ms for the same graph on CPU in Python. So
 * the panel offers both and reports the number, rather than assuming the GPU
 * wins. Chunk 6 needs a window transcribed roughly every second, so this is a
 * feasibility question, not a micro-optimisation.
 */
export type AsrDevice = "auto" | "webgpu" | "wasm";

export type AsrRequest =
  | { type: "load"; device?: AsrDevice }
  | { type: "transcribe"; id: number; samples: Float32Array };

let processor: Processor | null = null;
let model: PreTrainedModel | null = null;
let loading: Promise<AsrReady> | null = null;
let loadedDevice: AsrDevice | null = null;

async function load(requested: AsrDevice): Promise<AsrReady> {
  const started = performance.now();

  [processor, vocab] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID),
    loadVocab(),
  ]);

  // dtype "q8" is what resolves the filename to model_quantized.onnx, which is
  // the only graph we ship — the fp32 export puts its weights in an external
  // .onnx.data file that transformers.js cannot load.
  const options = { dtype: "q8" } as const;

  let device: string = requested;
  let fallbackReason: string | undefined;

  if (requested === "auto") {
    // A hard failure here would read as "the model is broken" rather than
    // "this backend cannot run it", so fall back and say so.
    try {
      model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
        ...options,
        device: "webgpu",
      });
      device = "webgpu";
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
        ...options,
        device: "wasm",
      });
      device = "wasm";
    }
  } else {
    model = await AutoModelForCTC.from_pretrained(MODEL_ID, {
      ...options,
      device: requested,
    });
  }

  loadedDevice = requested;
  return {
    type: "ready",
    device,
    loadMs: performance.now() - started,
    fallbackReason,
  };
}

self.addEventListener("message", async (event: MessageEvent<AsrRequest>) => {
  const request = event.data;

  try {
    if (request.type === "load") {
      const wanted = request.device ?? "auto";
      // Cached rather than re-entered: the panel may ask twice (a re-render, a
      // retry), and loading the same 123 MB graph concurrently would double peak
      // memory for no benefit. Asking for a *different* backend is a real
      // request though, so that reloads.
      if (loadedDevice !== wanted) {
        await model?.dispose();
        model = null;
        loading = load(wanted);
      }
      loading ??= load(wanted);
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

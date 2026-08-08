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

/**
 * Where the model's own files live, built the same way the library builds it.
 *
 * Derived from `env` rather than hardcoded so this cannot drift from where
 * AutoProcessor and AutoModelForCTC are actually fetching from — the vocab
 * coming from one place and the weights from another is a failure that would
 * decode cleanly and be wrong.
 */
function modelBase(): string {
  const path = env.remotePathTemplate
    .replace("{model}", MODEL_ID)
    .replace("{revision}", "main");
  return `${env.remoteHost}${path}`.replace(/\/$/, "");
}

async function loadVocab(): Promise<Vocab> {
  const base = modelBase();
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

// Fetched from the Hub, not served out of public/models/.
//
// It used to be the other way round, because there was no ONNX build of this
// model on the Hub — we made one with tools/asr-bakeoff/export_onnx.py. That
// export now lives at the repo below, so there is somewhere remote to load
// from, and it has to be remote: the fp16 graph is 190 MB and the int8 one is
// 123 MB, while GitHub hard-refuses any file over 100 MiB and Vercel's Hobby
// tier caps a whole deployment at 100 MB. The weights could never travel with
// the source, which is why public/models/ is gitignored — so a deployed build
// had no model at all and would have failed the moment anyone pressed Listen.
//
// Local loading is off rather than left on as a fallback. With it on, every
// file would be requested from this origin first, 404, and only then go to the
// Hub — and, worse, development would quietly work while production did not.
// That divergence is the exact shape of the bug this change exists to fix.
//
// The audio still never leaves the device. Fetching a model is not sending one.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// ORT's WASM backend is served from this origin, not from jsdelivr.
//
// transformers.js has already chosen WHICH build to load — the asyncify pair,
// or the plain threaded pair on Safari — and that choice is knowledge this
// file should not duplicate. Only the WHERE changes: same filenames, under
// /ort/ on this origin, kept in step with the installed onnxruntime-web by
// tools/copy-ort-wasm.mjs before every dev and build.
//
// The reason is cross-origin isolation. The page sends COOP/COEP so that ORT
// allows the WASM backend more than one core (it pins itself to one thread
// without crossOriginIsolated, by its own explicit rule) — and isolation is
// precisely the policy that stops a page running executable resources from
// origins that never opted in. Loading ORT's backend from a CDN under those
// headers is what broke the worker on every real machine it met (f15d00a).
// Same origin, no conflict, and the class of failure is gone rather than
// worked around.
{
  const ortWasm = env.backends?.onnx?.wasm;
  const chosen = ortWasm?.wasmPaths;
  const local = (name: string) => new URL(`/ort/${name}`, self.location.href).href;
  if (ortWasm && chosen && typeof chosen === "object" && chosen.mjs && chosen.wasm) {
    ortWasm.wasmPaths = {
      mjs: local(String(chosen.mjs).split("/").pop()!),
      wasm: local(String(chosen.wasm).split("/").pop()!),
    };
  } else if (ortWasm) {
    // A future transformers.js that stops pre-selecting files still gets the
    // same-origin prefix; ORT appends whichever filename its build wants. If
    // that file is not in public/ort/, the fetch 404s and the refusal surfaces
    // through the ladder rather than hanging.
    ortWasm.wasmPaths = new URL("/ort/", self.location.href).href;
  }
}

const MODEL_ID = "Savith/vak-san-onnx";

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
export type AsrDevice =
  | "auto"
  | "webgpu"
  | "wasm"
  | "webnn-npu"
  | "webnn-gpu";

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
  // fp16 is a GPU-only win. Every other backend has real int8 kernels, and on
  // an NPU int8 is not merely faster, it is frequently the only thing the
  // hardware will accept at all.
  return device === "webgpu" ? "fp16" : "q8";
}

/**
 * What to try, best first, when nobody has asked for a particular backend.
 *
 * WebGPU stays at the head because it is the only rung with a measured number
 * behind it — 48 ms against 1405 ms — and because a machine that already has
 * it must not be made slower by anything below.
 *
 * WebNN is new here and it is the interesting one. It is the only web API with
 * direct access to an NPU, and recent laptops and tablets ship one that this
 * app has never touched: it asked for WebGPU, missed, and dropped straight to
 * running a 94 M-parameter transformer on a CPU while dedicated silicon for
 * exactly this sat idle beside it.
 *
 * Anything unavailable throws on load and costs only the attempt, so a device
 * with none of it lands on WASM exactly as before.
 */
const LADDER: AsrDevice[] = ["webgpu", "webnn-npu", "webnn-gpu", "wasm"];

/**
 * Apple's engine, on any platform.
 *
 * Every browser on an iPhone is this engine — Chrome on iOS is Safari wearing
 * a different icon — so a check for "Safari" by name would miss most of the
 * devices that need this. What is being detected is WebKit: Apple's build of
 * it says AppleWebKit and does not say Chrome, Chromium, Edge or Firefox,
 * each of which announces itself.
 */
function isWebKit(): boolean {
  const ua = self.navigator?.userAgent ?? "";
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\/|Firefox/.test(ua);
}

/**
 * What to actually try on this device.
 *
 * WebGPU is removed on WebKit, and this is a reluctant, evidence-led choice
 * rather than a preference. iOS 26 turned WebGPU on by default, so an iPhone
 * now advertises the fast path and this app took it — straight into an open
 * ONNX Runtime bug in which the WebGPU execution provider's memory climbs past
 * a gigabyte and keeps going (microsoft/onnxruntime#26827; the same shape is
 * reported against transformers.js as huggingface/transformers.js#1242). Safari
 * caps a page near a gigabyte, so the tab is killed and silently reloaded, and
 * the owner saw exactly that: the app restarting itself a line into the chant,
 * on both Safari and Chrome, which on an iPhone are the same engine.
 *
 * The cost is real and is accepted deliberately: WebKit now runs on the CPU,
 * which is slower, and slower is a great deal better than a page that restarts
 * mid-recitation. This comes off the moment the upstream bug is fixed — and it
 * is worth re-testing rather than assuming, because a version that fixes it
 * will not announce itself here.
 */
function ladderFor(): AsrDevice[] {
  if (!isWebKit()) return LADDER;
  return LADDER.filter((device) => device !== "webgpu");
}

/**
 * Prove the backend runs, rather than that it loaded.
 *
 * A backend can accept a graph and then fail on the first real input — WebNN
 * in particular is strict about shapes and operators, and an NPU that silently
 * declines half the graph is worse than one that refuses honestly. One second
 * of silence through the model costs little and turns "it initialised" into
 * "it produced a tensor of the right rank", which are not the same claim and
 * have been confused here before.
 */
async function proves(candidate: PreTrainedModel): Promise<void> {
  if (!processor) throw new Error("processor missing");
  const probe = new Float32Array(16_000);
  const inputs = await processor(probe);
  const { logits } = await candidate(inputs);
  try {
    const dims = logits?.dims;
    if (!dims || dims.length !== 3) {
      throw new Error(`backend returned ${dims ? `rank ${dims.length}` : "nothing"}`);
    }
  } finally {
    // The proof costs a full inference, and a rung that fails leaves its
    // tensors behind on the way to trying the next one.
    disposeAll(logits, inputs);
  }
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
    // Walk the ladder. A hard failure would read as "the model is broken"
    // rather than "this backend cannot run it", so every rung is allowed to
    // fail, the reasons are collected, and the last rung is WASM, which is
    // always there.
    const refused: string[] = [];
    for (const candidate of ladderFor()) {
      const candidateDtype = dtype ?? bestDtypeFor(candidate);
      try {
        const built = await AutoModelForCTC.from_pretrained(MODEL_ID, {
          dtype: candidateDtype,
          progress_callback,
          device: candidate,
        });
        await proves(built);
        model = built;
        device = candidate;
        resolvedDtype = candidateDtype;
        break;
      } catch (error) {
        refused.push(
          `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!model) throw new Error(`no backend would run:\n${refused.join("\n")}`);
    // Worth surfacing rather than swallowing: on a machine that ends up on
    // WASM, these lines are the whole explanation for why it is slow.
    if (refused.length) fallbackReason = refused.join(" · ");
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

      let text: string;
      try {
        // CTC decoding: one prediction per frame, take the arg max, then
        // collapse repeats and drop the blank. No beam search and no language
        // model — which is the whole reason this architecture was chosen.
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
        text = decodeCtc(ids, vocab);
      } finally {
        // Hand every tensor back, and do it in a finally so a decode that
        // throws still returns the memory.
        //
        // This loop runs several times a second for three quarters of an hour.
        // Garbage collection covers the CPU path eventually, but a tensor that
        // lives on the GPU holds a buffer the collector does not own and will
        // not free, so the leak is unbounded and silent — and on iOS, where
        // Safari caps a page near a gigabyte, unbounded means the tab is
        // killed and quietly reloaded within a few seconds of chanting. That
        // is exactly what was reported, and this is our half of the fault
        // rather than the browser's.
        disposeAll(logits, inputs);
      }

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

/**
 * Return every tensor in these values to whoever owns its memory.
 *
 * Written defensively on purpose: what comes back from the model is a plain
 * object of outputs, what goes in is a plain object of inputs, and neither
 * shape is ours to depend on. Anything carrying a dispose() gets it called,
 * anything that throws while being freed is ignored, and a library that stops
 * handing out disposable tensors quietly does nothing here rather than
 * breaking the loop that transcribes the chant.
 */
function disposeAll(...values: unknown[]): void {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const disposable = value as { dispose?: () => void };
    if (typeof disposable.dispose === "function") {
      try {
        disposable.dispose();
      } catch {
        /* already gone, or not ours to free */
      }
      continue;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const inner = nested as { dispose?: () => void } | null;
      if (inner && typeof inner === "object" && typeof inner.dispose === "function") {
        try {
          inner.dispose();
        } catch {
          /* already gone, or not ours to free */
        }
      }
    }
  }
}

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

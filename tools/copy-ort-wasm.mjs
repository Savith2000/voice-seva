// Put ONNX Runtime's WASM backend where this origin can serve it.
//
// Without this, transformers.js points ORT's WASM loader at cdn.jsdelivr.net.
// That works right up until the page turns on cross-origin isolation — the
// thing that lets the WASM backend use more than one core — because isolation
// exists precisely to stop a page loading executable resources from origins
// that have not opted in. Turning it on with the CDN in place broke the worker
// on every real machine it met (see f15d00a). Serving the same files from
// public/ makes them same-origin, and the whole class of failure goes away.
//
// Copied out of node_modules rather than committed, so the binaries can never
// drift from the installed onnxruntime-web version that transformers.js was
// built against. Runs before dev and build; public/ort/ is gitignored.
//
// Only the files transformers.js actually selects are copied: the plain
// threaded pair (its choice on Safari) and the asyncify pair (its choice
// everywhere else). The jsep/jspi variants exist but are never requested by
// its wasmPaths logic, and at 40 MB between them they are worth leaving out.

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "onnxruntime-web", "dist");
const to = join(root, "public", "ort");

const FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
];

mkdirSync(to, { recursive: true });
for (const file of FILES) {
  const source = join(from, file);
  // Fails loudly: a missing file here would otherwise surface much later as
  // a 404 inside the worker, on someone else's machine.
  statSync(source);
  copyFileSync(source, join(to, file));
}
console.log(`ort wasm: ${FILES.length} files -> public/ort/`);

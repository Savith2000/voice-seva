// Run with: npm test
//
// The WAV writer is an instrument, not app code — but a broken instrument is
// worse than none, because it makes correct audio sound wrong and sends you
// hunting for a resampling bug that was never there. These tests exist because
// the first version of this file *did* have a quantisation bug that a listening
// test could never have caught.

import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeWav } from "./wav.ts";

const HEADER_BYTES = 44;

async function view(samples: Float32Array, rate = 16_000) {
  const blob = encodeWav(samples, rate);
  return new DataView(await blob.arrayBuffer());
}

function ascii(dv: DataView, offset: number, length: number) {
  return Array.from({ length }, (_, i) =>
    String.fromCharCode(dv.getUint8(offset + i)),
  ).join("");
}

/** Decode the way every reader on earth does: signed 16-bit over 32768. */
function decode(dv: DataView): number[] {
  const count = (dv.byteLength - HEADER_BYTES) / 2;
  return Array.from({ length: count }, (_, i) =>
    dv.getInt16(HEADER_BYTES + i * 2, true) / 0x8000,
  );
}

test("header declares mono 16-bit PCM with the right sizes", async () => {
  const dv = await view(new Float32Array(8), 16_000);

  assert.equal(ascii(dv, 0, 4), "RIFF");
  assert.equal(ascii(dv, 8, 4), "WAVE");
  assert.equal(ascii(dv, 12, 4), "fmt ");
  assert.equal(ascii(dv, 36, 4), "data");

  assert.equal(dv.getUint32(16, true), 16, "fmt chunk size");
  assert.equal(dv.getUint16(20, true), 1, "format 1 = uncompressed PCM");
  assert.equal(dv.getUint16(22, true), 1, "mono");
  assert.equal(dv.getUint32(24, true), 16_000, "sample rate");
  assert.equal(dv.getUint16(34, true), 16, "bits per sample");

  // These two are the fields players actually use to compute duration, so a
  // wrong value here plays the audio at the wrong speed rather than failing
  // loudly. Mono 16-bit: 2 bytes per frame.
  assert.equal(dv.getUint32(28, true), 16_000 * 2, "byte rate");
  assert.equal(dv.getUint16(32, true), 2, "block align");

  // RIFF size counts everything after the first 8 bytes.
  assert.equal(dv.getUint32(4, true), dv.byteLength - 8, "RIFF size");
  assert.equal(dv.getUint32(40, true), 8 * 2, "data size");
  assert.equal(dv.byteLength, HEADER_BYTES + 8 * 2);
});

test("sample rate is written through, not hardcoded", async () => {
  const dv = await view(new Float32Array(2), 48_000);
  assert.equal(dv.getUint32(24, true), 48_000);
  assert.equal(dv.getUint32(28, true), 48_000 * 2);
});

test("empty input still produces a valid, playable header", async () => {
  const dv = await view(new Float32Array(0));
  assert.equal(dv.byteLength, HEADER_BYTES);
  assert.equal(dv.getUint32(40, true), 0, "data size");
  assert.equal(dv.getUint32(4, true), 36, "RIFF size");
});

test("silence encodes as exact zero, with no DC offset", async () => {
  const dv = await view(new Float32Array(16));
  assert.deepEqual(decode(dv), new Array(16).fill(0));
});

test("round-trip error stays at the mathematical floor of 0.5 LSB", async () => {
  // A 16-bit step is 1/32768. Rounding to nearest cannot do better than half a
  // step, so 0.5 LSB is the floor, not a tolerance chosen to make the test
  // pass. The original implementation scaled positives by 0x7fff and let
  // setInt16 truncate, which produced 1.5 LSB — three times the floor, and a
  // consistent bias toward quieter. That is the regression this pins down.
  const LSB = 1 / 0x8000;
  const samples = new Float32Array(4096);
  for (let i = 0; i < samples.length; i++) {
    // Deterministic sweep across the range rather than random values, so a
    // failure names the same sample every time.
    //
    // Dividing by length rather than length-1 stops the sweep just short of
    // +1.0. That single value is genuinely unrepresentable: +1.0 x 0x8000 is
    // 32768, one past the top of a signed 16-bit integer, so it clips to 32767
    // and comes back 1 LSB low. It is the one documented exception, and it is
    // asserted on its own in the clipping test below. Including it here would
    // mean either a wrong claim about the floor or a tolerance loosened to
    // 1 LSB, which would stop catching the truncation bug this test exists for.
    samples[i] = -1 + (2 * i) / samples.length;
  }

  const decoded = decode(await view(samples));
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < samples.length; i++) {
    const error = Math.abs(decoded[i] - samples[i]);
    if (error > worst) {
      worst = error;
      worstAt = i;
    }
  }

  assert.ok(
    worst <= 0.5 * LSB + 1e-9,
    `worst error ${(worst / LSB).toFixed(3)} LSB at sample ${worstAt}, ` +
      `expected <= 0.5 LSB`,
  );
});

test("error is unbiased — quantisation must not make audio quieter", async () => {
  // A truncating writer passes a max-error test on some inputs while still
  // dragging every sample toward zero. Mean signed error catches that.
  const samples = new Float32Array(4096);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.9 * Math.sin((2 * Math.PI * 440 * i) / 16_000);
  }
  const decoded = decode(await view(samples));

  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += decoded[i] - samples[i];
  const bias = sum / samples.length / (1 / 0x8000);
  assert.ok(Math.abs(bias) < 0.05, `mean error ${bias.toFixed(4)} LSB`);
});

test("full scale and out-of-range values clip instead of wrapping", async () => {
  // Web Audio floats are nominally [-1, 1] but nothing enforces it. Wrapping
  // would turn a loud positive peak into a loud *negative* one — an audible
  // click, and a discontinuity that would confuse a model far more than
  // clipping does.
  const dv = await view(new Float32Array([1, -1, 2, -2, 1e9, -1e9]));
  const raw = Array.from({ length: 6 }, (_, i) =>
    dv.getInt16(HEADER_BYTES + i * 2, true),
  );
  assert.deepEqual(raw, [32767, -32768, 32767, -32768, 32767, -32768]);
});

test("NaN does not wrap to a full-scale spike", async () => {
  // Math.round(NaN) is NaN and setInt16 coerces NaN to 0. Worth pinning: the
  // alternative failure — a NaN becoming -32768 — is a maximum-amplitude click.
  const dv = await view(new Float32Array([NaN]));
  assert.equal(dv.getInt16(HEADER_BYTES, true), 0);
});

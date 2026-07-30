// Run with: npm test
//
// The ring buffer is the one piece of this project that is silently wrong when
// it breaks. A seam bug does not throw — it hands the model a window with a
// splice in the middle, and the symptom surfaces four chunks later as "the
// matcher is a bit unreliable". So it is tested against a naive reference
// rather than against hand-written expectations.

import assert from "node:assert/strict";
import { test } from "node:test";

import { RingBuffer } from "./ring-buffer.ts";

/** Obviously-correct, obviously-unshippable version. Grows without bound. */
class Reference {
  private all: number[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  write(chunk: Float32Array) {
    this.all.push(...chunk);
  }
  get available() {
    return Math.min(this.capacity, this.all.length);
  }
  readLast(count: number) {
    const n = Math.min(count, this.available);
    return Float32Array.from(this.all.slice(this.all.length - n));
  }
}

/** Seeded so a failure reproduces exactly instead of vanishing on re-run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ramp = (from: number, count: number) =>
  Float32Array.from({ length: count }, (_, i) => from + i);

test("available climbs to capacity and then stops", () => {
  const ring = new RingBuffer(4);
  assert.equal(ring.available, 0);
  ring.write(ramp(1, 3));
  assert.equal(ring.available, 3);
  ring.write(ramp(4, 3));
  assert.equal(ring.available, 4, "must not exceed capacity");
});

test("readLast returns the newest samples, oldest first", () => {
  const ring = new RingBuffer(8);
  ring.write(ramp(1, 5));
  assert.deepEqual(Array.from(ring.readLast(3)), [3, 4, 5]);
});

test("readLast clamps to what is actually held", () => {
  const ring = new RingBuffer(8);
  ring.write(ramp(1, 2));
  const out = ring.readLast(6);
  assert.equal(out.length, 2, "must not pad with zeros it never received");
  assert.deepEqual(Array.from(out), [1, 2]);
});

test("a window spanning the seam is contiguous, not spliced", () => {
  // The bug this catches: reading across the wrap point in one .set() instead
  // of two, which silently returns zeros or stale audio for the second half.
  const ring = new RingBuffer(5);
  ring.write(ramp(1, 4)); // writeIndex = 4
  ring.write(ramp(5, 3)); // wraps: holds 3,4,5,6,7
  assert.deepEqual(Array.from(ring.readLast(5)), [3, 4, 5, 6, 7]);
  assert.deepEqual(Array.from(ring.readLast(3)), [5, 6, 7]);
});

test("a write landing exactly on the end does not desynchronise", () => {
  // writeIndex must become 0 via the modulo, not capacity. If it became
  // capacity, the next write would start past the end of the array.
  const ring = new RingBuffer(4);
  ring.write(ramp(1, 4));
  ring.write(ramp(5, 2));
  assert.deepEqual(Array.from(ring.readLast(4)), [3, 4, 5, 6]);
});

test("a chunk longer than the buffer keeps its tail, not its head", () => {
  const ring = new RingBuffer(3);
  ring.write(ramp(1, 10));
  assert.equal(ring.available, 3);
  assert.deepEqual(Array.from(ring.readLast(3)), [8, 9, 10]);
});

test("an oversized chunk leaves the write position consistent", () => {
  // The subarray() shortcut for oversized chunks changes how far writeIndex
  // advances. If that is computed from the original length instead of the
  // sliced one, every subsequent read is offset.
  const ring = new RingBuffer(3);
  ring.write(ramp(1, 10)); // holds 8,9,10
  ring.write(ramp(11, 1));
  assert.deepEqual(Array.from(ring.readLast(3)), [9, 10, 11]);
});

test("empty writes change nothing", () => {
  const ring = new RingBuffer(4);
  ring.write(ramp(1, 2));
  ring.write(new Float32Array(0));
  assert.equal(ring.available, 2);
  assert.deepEqual(Array.from(ring.readLast(2)), [1, 2]);
});

test("clear resets without reallocating", () => {
  const ring = new RingBuffer(4);
  ring.write(ramp(1, 6));
  ring.clear();
  assert.equal(ring.available, 0);
  assert.deepEqual(Array.from(ring.readLast(4)), []);
  ring.write(ramp(100, 2));
  assert.deepEqual(Array.from(ring.readLast(4)), [100, 101]);
});

test("matches a naive reference over random traffic", () => {
  // The real usage pattern: 64-sample frames arriving forever while a 5-second
  // window is read off the back. Randomising chunk sizes exercises every
  // possible alignment of the seam against the read, which hand-written cases
  // cannot cover exhaustively.
  const random = mulberry32(20260729);
  for (const capacity of [1, 2, 3, 7, 16, 64]) {
    const ring = new RingBuffer(capacity);
    const reference = new Reference(capacity);
    let next = 0;

    for (let step = 0; step < 300; step++) {
      const size = Math.floor(random() * (capacity * 2 + 3));
      const chunk = ramp(next, size);
      next += size;
      ring.write(chunk);
      reference.write(chunk);

      assert.equal(
        ring.available,
        reference.available,
        `available diverged at capacity ${capacity}, step ${step}`,
      );
      const count = Math.floor(random() * (capacity + 2));
      assert.deepEqual(
        Array.from(ring.readLast(count)),
        Array.from(reference.readLast(count)),
        `readLast(${count}) diverged at capacity ${capacity}, step ${step}`,
      );
    }
  }
});

test("reads return a copy, so a later write cannot mutate it", () => {
  // Chunk 6 posts these windows to a worker. If readLast handed back a view
  // onto the live buffer, the audio would change underneath the model between
  // being read and being transcribed.
  const ring = new RingBuffer(4);
  ring.write(ramp(1, 4));
  const out = ring.readLast(4);
  ring.write(ramp(9, 4));
  assert.deepEqual(Array.from(out), [1, 2, 3, 4]);
});

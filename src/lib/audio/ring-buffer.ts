// A fixed-size buffer holding the most recent N samples, overwriting the
// oldest as it goes.
//
// This is what the sliding window sits on in Chunk 6: audio arrives in small
// frames forever, but the only question ever asked is "give me the last few
// seconds". A growing array would leak across a 45-minute session; this
// allocates once and never grows.

export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private writeIndex = 0;
  private filled = 0;

  // Declared as a field and assigned explicitly rather than written as a
  // `constructor(readonly capacity: number)` parameter property. Parameter
  // properties are the one bit of TypeScript that cannot be erased by simply
  // deleting types — they generate an assignment — so Node refuses to run a
  // file containing one. Avoiding them means `node --test` can execute these
  // modules directly, with no build step between the source and the tests.
  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  /** Samples currently held — climbs to `capacity`, then stays there. */
  get available(): number {
    return this.filled;
  }

  write(chunk: Float32Array): void {
    // A chunk larger than the whole buffer would wrap over itself; only its
    // tail could survive anyway, so slice to that first.
    const src =
      chunk.length > this.capacity
        ? chunk.subarray(chunk.length - this.capacity)
        : chunk;

    const untilEnd = Math.min(src.length, this.capacity - this.writeIndex);
    this.data.set(src.subarray(0, untilEnd), this.writeIndex);
    if (untilEnd < src.length) {
      this.data.set(src.subarray(untilEnd), 0);
    }

    this.writeIndex = (this.writeIndex + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  /** The most recent `count` samples, oldest first. Shorter if not yet filled. */
  readLast(count: number): Float32Array {
    const n = Math.min(count, this.filled);
    const out = new Float32Array(n);
    const start = (this.writeIndex - n + this.capacity) % this.capacity;

    const untilEnd = Math.min(n, this.capacity - start);
    out.set(this.data.subarray(start, start + untilEnd), 0);
    if (untilEnd < n) {
      out.set(this.data.subarray(0, n - untilEnd), untilEnd);
    }

    return out;
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}

// Audio thread. Runs in the AudioWorkletGlobalScope — no DOM, no imports,
// no bundler. It is fetched raw from /worklets/capture-processor.js, which is
// why it lives in `public/` and is plain JS rather than TypeScript.
//
// Its only job is to be boring and never block: downmix to mono, batch into
// frames, hand them to the main thread. Anything expensive here produces
// audible glitches, because this callback runs on the realtime audio thread.

// 1024 samples at 16 kHz = 64 ms per message, ~15 messages/sec.
// The raw callback fires every 128 samples (8 ms); posting at that rate would
// be 125 messages/sec for no benefit.
const FRAME_SIZE = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SIZE);
    this.filled = 0;
    // `sampleRate` is a global in worklet scope. Posting it once lets the main
    // thread confirm the audio thread agrees about the rate rather than
    // assuming it.
    this.port.postMessage({ type: "ready", sampleRate });
  }

  process(inputs) {
    const channels = inputs[0];
    // An empty input means the source is not producing yet (or has ended).
    // Returning true keeps the node alive and waiting.
    if (!channels || channels.length === 0 || !channels[0]) return true;

    const blockSize = channels[0].length;
    const channelCount = channels.length;

    for (let i = 0; i < blockSize; i++) {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) sum += channels[c][i];
      this.frame[this.filled++] = sum / channelCount;

      if (this.filled === FRAME_SIZE) {
        // Copy, then transfer the copy. Transferring `this.frame` itself would
        // detach the buffer we are still writing into.
        const out = this.frame.slice();
        this.port.postMessage({ type: "frame", samples: out }, [out.buffer]);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);

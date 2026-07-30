// Minimal WAV writer: 16-bit PCM, mono, no extensions.
//
// This exists purely as an instrument. Nothing in the running app needs WAV —
// Whisper takes Float32 directly. But "does the resampled audio sound right?"
// is a question only ears can answer, and ears need a file they can play.

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format: 1 = uncompressed PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: Web Audio floats are nominally [-1, 1] but nothing
    // enforces it, and an out-of-range value would wrap to the opposite sign.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Scale both directions by 0x8000 so that decoding (the universal
    // convention: value / 32768) is exact, then clip the one value that
    // overflows — +1.0 exactly. Scaling positives by 0x7fff instead would
    // shift every positive sample by up to a full quantisation step.
    //
    // Round rather than let setInt16 truncate: truncation is toward zero, so
    // it biases every sample slightly quieter and doubles the error.
    const scaled = Math.round(clamped * 0x8000);
    view.setInt16(offset, scaled > 0x7fff ? 0x7fff : scaled, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

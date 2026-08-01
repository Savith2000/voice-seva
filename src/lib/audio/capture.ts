// Microphone capture, resampled to what Whisper requires.

const WORKLET_URL = "/worklets/capture-processor.js";

/** Whisper's feature extractor is hard-wired to this. It is not a preference. */
export const TARGET_SAMPLE_RATE = 16_000;

export type CaptureFrame = {
  samples: Float32Array;
  /** Loudness of this frame, 0..1. Perceptual enough for a level meter. */
  rms: number;
  peak: number;
};

export type CaptureInfo = {
  /** What the graph actually runs at. Must be 16000 or the audio is wrong. */
  contextSampleRate: number;
  /** What the audio thread reports — a cross-check on the line above. */
  workletSampleRate: number | null;
  /** The mic's own rate. Usually 48000; the gap is the browser's resampling. */
  trackSampleRate: number | null;
  trackChannels: number | null;
  deviceLabel: string;
  processingEnabled: boolean;
};

export type CaptureOptions = {
  /**
   * Browser DSP: echo cancellation, noise suppression, auto gain.
   *
   * Off by default. That chain is tuned for one person talking on a call, and
   * chanting is the opposite of that — sustained, tonal, often several voices.
   * Noise suppression can read a held note as stationary noise and gate it;
   * auto gain pumps between phrases. Exposed as a flag rather than hard-coded
   * so Chunk 3 can measure the difference instead of guessing.
   */
  processing?: boolean;

  /**
   * Which input to record from. Omit for the system default.
   *
   * Not `exact`, deliberately. Devices disappear — a headset is unplugged
   * between listing and starting — and an exact constraint then throws
   * OverconstrainedError instead of falling back, which reads to the user as
   * "the microphone is broken" rather than "that one is gone".
   */
  deviceId?: string;
};

export type AudioInput = { deviceId: string; label: string };

/**
 * The microphones the browser will admit to having.
 *
 * Labels are empty until the page has been granted microphone permission at
 * least once — the browser withholds them because the list of attached
 * hardware is itself identifying. Callers get a numbered placeholder rather
 * than a row of blanks, and a second call after permission fills in the real
 * names.
 */
export async function listAudioInputs(): Promise<AudioInput[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    // A blank deviceId is what browsers report before permission has been
    // granted. It cannot be passed back as a constraint, so offering it would
    // be offering a choice that does nothing.
    .filter((device) => device.deviceId && device.deviceId !== "default")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

type WorkletMessage =
  | { type: "ready"; sampleRate: number }
  | { type: "frame"; samples: Float32Array };

export class MicCapture {
  private readonly ctx: AudioContext;
  private readonly stream: MediaStream;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  readonly info: CaptureInfo;

  // Spelled out rather than using constructor parameter properties. Those are
  // the one TypeScript feature that cannot be erased by deleting types — they
  // generate an assignment — so Node refuses to execute a file containing one,
  // and `node --test` could not then run any module that imports this one.
  // `erasableSyntaxOnly` in tsconfig makes tsc catch a relapse.
  private constructor(
    ctx: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    node: AudioWorkletNode,
    info: CaptureInfo,
  ) {
    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.node = node;
    this.info = info;
  }

  static async start(
    onFrame: (frame: CaptureFrame) => void,
    onInfo: (info: CaptureInfo) => void,
    { processing = false, deviceId }: CaptureOptions = {},
  ): Promise<MicCapture> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      // Almost always the cause: served over plain http from a LAN address.
      // getUserMedia needs a secure context; localhost counts, 192.168.x.x does not.
      throw new Error(
        "No microphone API. This page must be served from localhost or over HTTPS.",
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: 1,
        ...(deviceId ? { deviceId } : {}),
      },
      video: false,
    });

    // Everything past this point can throw, and a live mic stream that outlives
    // its failed context leaves the browser's recording indicator on forever.
    try {
      // Asking the context for 16 kHz makes the browser resample the mic for
      // us, in C++, with a real anti-aliasing filter. Hand-rolling 48k → 16k
      // means writing that filter; naive decimation folds everything above
      // 8 kHz back down into the speech band as aliasing, which would quietly
      // poison every transcript from here on.
      const ctx = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
        latencyHint: "interactive",
      });

      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);

        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "capture-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });

        const track = stream.getAudioTracks()[0];
        const settings = track?.getSettings() ?? {};

        const info: CaptureInfo = {
          contextSampleRate: ctx.sampleRate,
          workletSampleRate: null,
          trackSampleRate: settings.sampleRate ?? null,
          trackChannels: settings.channelCount ?? null,
          deviceLabel: track?.label || "(unnamed input)",
          processingEnabled: processing,
        };

        node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          const message = event.data;
          if (message.type === "ready") {
            info.workletSampleRate = message.sampleRate;
            onInfo({ ...info });
            return;
          }

          const { samples } = message;
          let sumSquares = 0;
          let peak = 0;
          for (let i = 0; i < samples.length; i++) {
            const value = samples[i];
            sumSquares += value * value;
            const magnitude = value < 0 ? -value : value;
            if (magnitude > peak) peak = magnitude;
          }

          onFrame({
            samples,
            rms: Math.sqrt(sumSquares / samples.length),
            peak,
          });
        };

        source.connect(node);

        // A worklet node is only pulled if it reaches the destination — an
        // unconnected output means `process()` may never run. The processor
        // writes nothing to its output so it is already silent, but routing
        // through a muted gain node makes that guaranteed rather than
        // incidental: no path exists for the mic to reach the speakers and
        // start a feedback loop.
        const silence = ctx.createGain();
        silence.gain.value = 0;
        node.connect(silence);
        silence.connect(ctx.destination);

        // Contexts can start suspended even when created from a click.
        if (ctx.state === "suspended") await ctx.resume();

        onInfo({ ...info });
        return new MicCapture(ctx, stream, source, node, info);
      } catch (error) {
        await ctx.close();
        throw error;
      }
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    // Stopping the tracks is what actually releases the mic and clears the
    // browser's recording indicator. Closing the context alone does not.
    this.stream.getTracks().forEach((track) => track.stop());
    await this.ctx.close();
  }
}

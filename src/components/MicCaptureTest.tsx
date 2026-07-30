"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MicCapture,
  TARGET_SAMPLE_RATE,
  type CaptureInfo,
} from "@/lib/audio/capture";
import { RingBuffer } from "@/lib/audio/ring-buffer";
import { encodeWav } from "@/lib/audio/wav";

/** Hard stop, so a forgotten tab cannot grow the recording without bound. */
const MAX_SECONDS = 60;
/** Rolling window the ring buffer keeps — the size Chunk 6 will transcribe. */
const WINDOW_SECONDS = 5;
/** Stats redraw interval. Frames arrive ~15/sec; the eye needs far less. */
const UI_INTERVAL_MS = 100;

type Phase = "idle" | "starting" | "running";

type Stats = {
  frames: number;
  samples: number;
  rms: number;
  peak: number;
  windowSamples: number;
};

const ZERO_STATS: Stats = {
  frames: 0,
  samples: 0,
  rms: 0,
  peak: 0,
  windowSamples: 0,
};

type Take = { url: string; seconds: number; bytes: number };

export default function MicCaptureTest() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [stats, setStats] = useState<Stats>(ZERO_STATS);
  const [processing, setProcessing] = useState(false);
  const [take, setTake] = useState<Take | null>(null);

  const mountedRef = useRef(true);
  const captureRef = useRef<MicCapture | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const ringRef = useRef<RingBuffer | null>(null);
  const countsRef = useRef({ frames: 0, samples: 0, peak: 0 });
  const lastPaintRef = useRef(0);
  const takeUrlRef = useRef<string | null>(null);

  // Only touches refs and setState, so it never goes stale — which is what lets
  // the audio callback below call it directly to enforce MAX_SECONDS.
  const stop = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;

    await capture.stop();

    const chunks = chunksRef.current;
    chunksRef.current = [];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const recording = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      recording.set(chunk, offset);
      offset += chunk.length;
    }

    setPhase("idle");
    if (total === 0) return;

    const rate = capture.info.contextSampleRate;
    const blob = encodeWav(recording, rate);
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    takeUrlRef.current = URL.createObjectURL(blob);
    setTake({
      url: takeUrlRef.current,
      seconds: total / rate,
      bytes: blob.size,
    });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStats(ZERO_STATS);
    setInfo(null);
    setPhase("starting");

    chunksRef.current = [];
    countsRef.current = { frames: 0, samples: 0, peak: 0 };
    lastPaintRef.current = 0;
    const ring = new RingBuffer(WINDOW_SECONDS * TARGET_SAMPLE_RATE);
    ringRef.current = ring;

    try {
      const capture = await MicCapture.start(
        (frame) => {
          // Keep two copies for two purposes: the flat chunk list becomes the
          // WAV, the ring buffer is the live window Chunk 6 will read from.
          chunksRef.current.push(frame.samples);
          ring.write(frame.samples);

          const counts = countsRef.current;
          counts.frames += 1;
          counts.samples += frame.samples.length;
          if (frame.peak > counts.peak) counts.peak = frame.peak;

          const now = performance.now();
          if (now - lastPaintRef.current >= UI_INTERVAL_MS) {
            lastPaintRef.current = now;
            setStats({
              frames: counts.frames,
              samples: counts.samples,
              rms: frame.rms,
              peak: counts.peak,
              windowSamples: ring.available,
            });
          }

          if (counts.samples >= MAX_SECONDS * TARGET_SAMPLE_RATE) {
            void stop();
          }
        },
        (nextInfo) => setInfo(nextInfo),
        { processing },
      );

      // getUserMedia takes as long as the user takes to click "allow", and the
      // component can unmount in that gap — leaving a live mic with no owner.
      if (!mountedRef.current) {
        await capture.stop();
        return;
      }
      captureRef.current = capture;
      setPhase("running");
    } catch (caught) {
      setPhase("idle");
      setError(describeMicError(caught));
    }
  }, [processing, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void captureRef.current?.stop();
      captureRef.current = null;
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    };
  }, []);

  const running = phase === "running";
  const rateOk = info?.contextSampleRate === TARGET_SAMPLE_RATE;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-5 font-mono text-sm">
      <h2 className="mb-4 text-xs uppercase tracking-widest text-neutral-500">
        Chunk 1 · microphone capture
      </h2>

      <div className="mb-5 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => (running ? void stop() : void start())}
          disabled={phase === "starting"}
          className={`rounded border px-4 py-2 text-xs uppercase tracking-widest transition-colors disabled:opacity-50 ${
            running
              ? "border-red-900 bg-red-950/50 text-red-300 hover:bg-red-950"
              : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800"
          }`}
        >
          {phase === "starting" ? "starting…" : running ? "stop" : "start"}
        </button>

        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={processing}
            disabled={running || phase === "starting"}
            onChange={(event) => setProcessing(event.target.checked)}
            className="accent-neutral-400"
          />
          browser DSP (AEC / NS / AGC)
        </label>

        {running && (
          <span className="text-xs text-neutral-600">
            auto-stops at {MAX_SECONDS}s
          </span>
        )}
      </div>

      {error && (
        <p className="mb-5 rounded border border-red-950 bg-red-950/30 px-3 py-2 text-red-300">
          {error}
        </p>
      )}

      {running && <LevelMeter rms={stats.rms} peak={stats.peak} />}

      {info && (
        <dl className="mt-5 space-y-2">
          <Row
            label="context rate"
            value={`${info.contextSampleRate} Hz${
              rateOk ? "" : " — expected 16000, audio will be wrong"
            }`}
            good={rateOk}
          />
          <Row
            label="audio thread rate"
            value={
              info.workletSampleRate === null
                ? "(no frame yet)"
                : `${info.workletSampleRate} Hz`
            }
            good={info.workletSampleRate === TARGET_SAMPLE_RATE}
          />
          <Row
            label="device rate"
            value={
              info.trackSampleRate === null
                ? "(not reported)"
                : `${info.trackSampleRate} Hz${
                    info.trackSampleRate !== info.contextSampleRate
                      ? " → browser resampled it"
                      : ""
                  }`
            }
            good
          />
          <Row
            label="input"
            value={`${info.deviceLabel}${
              info.trackChannels ? ` · ${info.trackChannels} ch` : ""
            }`}
            good
          />
          <Row
            label="browser DSP"
            value={info.processingEnabled ? "on" : "off (raw mic)"}
            good
          />
          <Row
            label="captured"
            value={`${stats.frames} frames · ${stats.samples.toLocaleString()} samples · ${(
              stats.samples / TARGET_SAMPLE_RATE
            ).toFixed(2)}s`}
            good
          />
          <Row
            label={`window (${WINDOW_SECONDS}s ring)`}
            value={`${stats.windowSamples.toLocaleString()} / ${(
              WINDOW_SECONDS * TARGET_SAMPLE_RATE
            ).toLocaleString()} samples`}
            good
          />
        </dl>
      )}

      {take && (
        <div className="mt-5 border-t border-neutral-800 pt-4">
          <p className="mb-2 text-xs uppercase tracking-widest text-neutral-500">
            Playback check
          </p>
          <p className="mb-3 text-xs leading-relaxed text-neutral-400">
            {take.seconds.toFixed(2)}s · {(take.bytes / 1024).toFixed(0)} KB ·
            16 kHz mono. It should sound muffled but{" "}
            <span className="text-neutral-200">normal speed and pitch</span>.
            Chipmunked or slowed down means the resampling is wrong.
          </p>
          <audio controls src={take.url} className="w-full" />
          <a
            href={take.url}
            download="voice-seva-16k.wav"
            className="mt-3 inline-block text-xs text-neutral-500 underline underline-offset-4 hover:text-neutral-300"
          >
            download wav (feed this to Chunk 2)
          </a>
        </div>
      )}
    </div>
  );
}

function LevelMeter({ rms, peak }: { rms: number; peak: number }) {
  // RMS on speech sits low in linear terms — a normal voice is ~0.05 and would
  // barely move a linear bar. dB maps it to something the eye can read.
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  const width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const clipping = peak >= 0.99;

  return (
    <div>
      <div className="h-3 w-full overflow-hidden rounded-sm bg-neutral-900">
        <div
          className={`h-full transition-[width] duration-75 ${
            clipping ? "bg-red-500" : "bg-emerald-500"
          }`}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-neutral-600">
        {db > -99 ? `${db.toFixed(1)} dB` : "silence"} · peak{" "}
        {peak.toFixed(3)}
        {clipping && <span className="text-red-400"> · clipping</span>}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-48 shrink-0 text-neutral-500">{label}</dt>
      <dd className={good ? "text-emerald-400" : "text-amber-400"}>{value}</dd>
    </div>
  );
}

function describeMicError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  switch (error.name) {
    case "NotAllowedError":
      return "Microphone permission denied. Allow it in the address bar, then press start again.";
    case "NotFoundError":
      return "No microphone found.";
    case "NotReadableError":
      return "The microphone is in use by another app.";
    default:
      return error.message || error.name;
  }
}

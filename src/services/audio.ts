/**
 * Live microphone analysis. Kept outside React state on purpose - the
 * waveform runs at 60fps and must not trigger re-renders.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;

const timeData = new Uint8Array(1024);
const freqData = new Uint8Array(512);

export interface MicHandle { ok: boolean; error?: string }

export async function startMic(): Promise<MicHandle> {
  if (analyser) return { ok: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    return { ok: true };
  } catch (e) {
    stopMic();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function stopMic(): void {
  try { source?.disconnect(); } catch { /* already gone */ }
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
  try { void ctx?.close(); } catch { /* already gone */ }
  source = null;
  analyser = null;
  stream = null;
  ctx = null;
}

export const micActive = () => analyser !== null;

/** Normalized 0..1 RMS level of the current frame. */
export function getLevel(): number {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / timeData.length) * 3.4);
}

/** Raw waveform samples in -1..1, downsampled to `points`. */
export function getWaveform(points: number): number[] {
  const out = new Array<number>(points).fill(0);
  if (!analyser) return out;
  analyser.getByteTimeDomainData(timeData);
  const step = Math.floor(timeData.length / points) || 1;
  for (let i = 0; i < points; i++) {
    out[i] = (timeData[i * step] - 128) / 128;
  }
  return out;
}

/** Frequency magnitudes 0..1, downsampled to `bands`. */
export function getSpectrum(bands: number): number[] {
  const out = new Array<number>(bands).fill(0);
  if (!analyser) return out;
  analyser.getByteFrequencyData(freqData);
  // Log-ish spacing so the low end does not eat the whole chart
  const usable = Math.floor(freqData.length * 0.62);
  for (let i = 0; i < bands; i++) {
    const start = Math.floor((i / bands) ** 1.5 * usable);
    const end = Math.max(start + 1, Math.floor(((i + 1) / bands) ** 1.5 * usable));
    let peak = 0;
    for (let j = start; j < end && j < freqData.length; j++) peak = Math.max(peak, freqData[j]);
    out[i] = peak / 255;
  }
  return out;
}

/** The live mic stream, for the recorder to tap. Null when the mic is closed. */
export const getStream = (): MediaStream | null => stream;

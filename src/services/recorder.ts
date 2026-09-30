/**
 * Captures push-to-talk audio and hands back exactly what Whisper wants:
 * mono Float32 samples at 16 kHz.
 */

let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export function startRecording(stream: MediaStream): boolean {
  if (recorder) return true;
  const mimeType = pickMime();
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    recorder = null;
    return false;
  }
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(120); // small timeslice so short clips still produce data
  return true;
}

/** Stops the recorder and returns 16 kHz mono samples, or null if nothing usable. */
export async function stopRecording(): Promise<Float32Array | null> {
  const rec = recorder;
  recorder = null;
  if (!rec) return null;

  const blob = await new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    if (rec.state !== 'inactive') rec.stop();
    else resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
  });

  chunks = [];
  if (blob.size < 1200) return null; // essentially silence / a stray tap

  return decodeToMono16k(await blob.arrayBuffer());
}

/** Decode any browser-supported audio container into 16 kHz mono Float32. */
export async function decodeToMono16k(buffer: ArrayBuffer): Promise<Float32Array | null> {
  const ctx = new AudioContext();
  try {
    return await toMono16k(await ctx.decodeAudioData(buffer));
  } catch {
    return null;
  } finally {
    void ctx.close();
  }
}

const TARGET_RATE = 16000;

async function toMono16k(input: AudioBuffer): Promise<Float32Array | null> {
  const frames = Math.ceil((input.duration || 0) * TARGET_RATE);
  if (frames < TARGET_RATE * 0.25) return null; // under 250ms of audio

  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = input;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

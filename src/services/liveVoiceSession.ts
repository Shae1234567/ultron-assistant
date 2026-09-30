import { startLiveVoice, isLiveVoiceSupported, type LiveVoiceHandle } from './liveVoice';
import { ultron } from './bridge';

/**
 * Wires liveVoice.ts's Gemini Live session to an actual microphone and
 * speakers - liveVoice.ts deliberately knows nothing about audio I/O, this
 * is that missing half. Two separate AudioContexts are used because input
 * and output run at different required sample rates (16kHz in, 24kHz out) -
 * resampling one context to both would need the same manual work anyway,
 * so two contexts at their native rates is simpler and cheaper.
 *
 * This has not been exercised against the real Gemini Live API (no key/mic
 * available in the environment that built this) - the wiring follows the
 * documented contract in liveVoice.ts exactly, but treat first real use as
 * the actual test.
 */

export type LiveVoiceState = 'idle' | 'connecting' | 'live' | 'error';

interface Session {
  handle: LiveVoiceHandle;
  inputCtx: AudioContext;
  inputSource: MediaStreamAudioSourceNode;
  inputProcessor: ScriptProcessorNode;
  micStream: MediaStream;
  outputCtx: AudioContext;
  nextPlayTime: number;
}

let session: Session | null = null;
let state: LiveVoiceState = 'idle';
const listeners = new Set<(s: LiveVoiceState) => void>();

function setState(s: LiveVoiceState): void {
  state = s;
  for (const l of listeners) l(s);
}

export function onLiveVoiceState(cb: (s: LiveVoiceState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLiveVoiceState(): LiveVoiceState {
  return state;
}

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

/** Downsamples/upsamples Float32 mono audio to `targetRate` via simple linear
 *  interpolation - not audiophile quality, but more than enough for speech. */
function resampleFloat32(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function float32ToPcm16Base64(float32: Float32Array): string {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** Plays one model-audio chunk back-to-back with whatever is already queued,
 *  instead of overlapping playback - `nextPlayTime` tracks the schedule. */
function playChunk(s: Session, base64: string): void {
  const float32 = pcm16Base64ToFloat32(base64);
  if (float32.length === 0) return;
  const buffer = s.outputCtx.createBuffer(1, float32.length, OUTPUT_RATE);
  // TS's lib.dom types buffer.copyToChannel as wanting Float32Array<ArrayBuffer>
  // specifically; pcm16Base64ToFloat32's array is backed by a real ArrayBuffer
  // at runtime (never a SharedArrayBuffer here), so this narrows a type-only
  // mismatch, not a real one.
  buffer.copyToChannel(float32 as Float32Array<ArrayBuffer>, 0);
  const node = s.outputCtx.createBufferSource();
  node.buffer = buffer;
  node.connect(s.outputCtx.destination);
  const startAt = Math.max(s.outputCtx.currentTime, s.nextPlayTime);
  node.start(startAt);
  s.nextPlayTime = startAt + buffer.duration;
}

export interface LiveVoiceStartOptions {
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
}

export async function startLiveVoiceSession(opts: LiveVoiceStartOptions = {}): Promise<{ ok: boolean; error?: string }> {
  if (session) return { ok: true }; // already live, idempotent
  if (!isLiveVoiceSupported()) return { ok: false, error: 'This browser build has no Web Audio support.' };

  setState('connecting');
  try {
    // The Live API is a direct browser<->Google WebSocket, so (unlike every
    // other brain call in this app) the renderer needs the real key - the one
    // deliberate exception to secrets staying in the main process.
    const live = await ultron.brain.liveVoice();
    const apiKey = live.key;
    if (!apiKey) {
      setState('error');
      return { ok: false, error: 'No Gemini API key configured - add one in Settings first.' };
    }

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const inputCtx = new AudioContext();
    if (inputCtx.state === 'suspended') await inputCtx.resume();
    const inputSource = inputCtx.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated but universally supported and simple -
    // an AudioWorklet would need a separate module file loaded across the
    // Electron file:// origin, which is more moving parts for the same result
    // at speech-audio scale (4096 samples ~ 85-260ms depending on context rate).
    const inputProcessor = inputCtx.createScriptProcessor(4096, 1, 1);

    const outputCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
    if (outputCtx.state === 'suspended') await outputCtx.resume();

    const s: Session = { handle: null as unknown as LiveVoiceHandle, inputCtx, inputSource, inputProcessor, micStream, outputCtx, nextPlayTime: 0 };

    const handle = await startLiveVoice(
      apiKey,
      {
        onOpen: () => setState('live'),
        onModelAudioChunk: (b64) => playChunk(s, b64),
        onModelText: (text) => opts.onTranscript?.(text),
        onError: (message) => { opts.onError?.(message); },
        onClose: () => { if (session === s) stopLiveVoiceSession(); },
      },
      {
        model: live.model ?? undefined,
        systemInstruction: live.system ?? 'You are ULTRON. You are in a real-time spoken voice conversation - keep replies short and natural.',
      },
    );

    s.handle = handle;
    inputSource.connect(inputProcessor);
    // A ScriptProcessorNode must be connected to a destination to actually
    // fire onaudioprocess in some browsers, even though we discard its output.
    const mute = inputCtx.createGain();
    mute.gain.value = 0;
    inputProcessor.connect(mute);
    mute.connect(inputCtx.destination);

    inputProcessor.onaudioprocess = (e) => {
      if (!session) return;
      const raw = e.inputBuffer.getChannelData(0);
      const resampled = resampleFloat32(raw, inputCtx.sampleRate, INPUT_RATE);
      session.handle.sendAudioChunk(float32ToPcm16Base64(resampled));
    };

    session = s;
    return { ok: true };
  } catch (e) {
    setState('error');
    const message = e instanceof Error ? e.message : String(e);
    opts.onError?.(message);
    return { ok: false, error: message };
  }
}

export function stopLiveVoiceSession(): void {
  if (!session) { setState('idle'); return; }
  const s = session;
  session = null;
  try { s.inputProcessor.onaudioprocess = null; } catch { /* already gone */ }
  try { s.inputProcessor.disconnect(); } catch { /* already gone */ }
  try { s.inputSource.disconnect(); } catch { /* already gone */ }
  try { s.micStream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
  try { void s.inputCtx.close(); } catch { /* already gone */ }
  try { void s.outputCtx.close(); } catch { /* already gone */ }
  try { s.handle.close(); } catch { /* already gone */ }
  setState('idle');
}

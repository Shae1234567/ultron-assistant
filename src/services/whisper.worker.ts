/// <reference lib="webworker" />
import { pipeline, env } from '@xenova/transformers';

/**
 * Whisper running locally in a worker.
 *
 * Free and offline: the model weights are fetched from Hugging Face once, cached
 * by the browser, and every transcription after that is pure local computation.
 * Kept off the main thread so inference never freezes the HUD animations.
 */

// We only ever load from the hub - there is no local model directory in this app.
env.allowLocalModels = false;

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) =>
  Promise<{ text?: string } | { text?: string }[]>;

let transcriber: Transcriber | null = null;
let loading: Promise<void> | null = null;
let loadedModel = '';

/**
 * Try known-good builds in order and keep the first that initialises - not every
 * Whisper export loads under every onnxruntime build.
 */
const CANDIDATES: { model: string; quantized: boolean }[] = [
  { model: 'Xenova/whisper-base.en', quantized: true },
  { model: 'Xenova/whisper-tiny.en', quantized: true },
  { model: 'Xenova/whisper-tiny.en', quantized: false },
];

type InMsg =
  | { type: 'load'; model: string }
  | { type: 'transcribe'; id: string; audio: Float32Array };

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function load(preferred: string): Promise<void> {
  if (transcriber && loadedModel === preferred) return;
  if (loading) return loading;

  loading = (async () => {
    post({ type: 'status', status: 'loading', model: preferred });

    const ordered = [
      ...CANDIDATES.filter((c) => c.model === preferred),
      ...CANDIDATES.filter((c) => c.model !== preferred),
    ];

    const failures: string[] = [];
    for (const candidate of ordered) {
      try {
        transcriber = (await pipeline('automatic-speech-recognition', candidate.model, {
          quantized: candidate.quantized,
          progress_callback: (p: unknown) => post({ type: 'progress', payload: p }),
        })) as unknown as Transcriber;
        loadedModel = candidate.model;
        post({ type: 'status', status: 'ready', model: candidate.model });
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        failures.push(candidate.model + (candidate.quantized ? '/q8' : '/fp32') + ': ' + why.slice(0, 150));
      }
    }
    throw new Error('No Whisper build could be loaded. Tried -- ' + failures.join(' | '));
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

self.addEventListener('message', async (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
      return;
    }

    if (msg.type === 'transcribe') {
      if (!transcriber) {
        post({ type: 'error', id: msg.id, message: 'Whisper model is not loaded yet.' });
        return;
      }
      const output = await transcriber(msg.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'english',
        task: 'transcribe',
      });
      const text = Array.isArray(output)
        ? output.map((o) => o.text ?? '').join(' ')
        : (output.text ?? '');
      post({ type: 'result', id: msg.id, text: text.trim() });
    }
  } catch (e) {
    post({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

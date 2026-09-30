import { useSttStore } from '../state/store';

/**
 * Main-thread handle on the Whisper worker.
 *
 * This is the swap point for speech-to-text, the same way ai.ts is for the LLM:
 * everything upstream just calls transcribe() and gets text back.
 */

export const DEFAULT_STT_MODEL = 'Xenova/whisper-base.en';

let worker: Worker | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((e: Error) => void) | null = null;
let readyPromise: Promise<void> | null = null;

const pending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();
let counter = 0;

interface ProgressPayload {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

function spawn(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as {
      type: string; id?: string; text?: string; message?: string;
      status?: string; payload?: ProgressPayload;
    };
    const store = useSttStore.getState();

    switch (msg.type) {
      case 'status':
        if (msg.status === 'loading') store.setStt('loading', 'Downloading Whisper model...');
        if (msg.status === 'ready') {
          store.setStt('ok', '');
          store.setSttProgress(1);
          readyResolve?.();
          readyResolve = null; readyReject = null;
        }
        break;

      case 'progress': {
        const p = msg.payload;
        if (p && typeof p.progress === 'number' && p.status === 'progress') {
          store.setSttProgress(Math.max(0, Math.min(1, p.progress / 100)));
          const mb = p.total ? ` (${(p.total / 1024 / 1024).toFixed(0)} MB)` : '';
          store.setStt('loading', `Downloading ${p.file ?? 'model'}${mb}`);
        }
        break;
      }

      case 'result':
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!.resolve(msg.text ?? '');
          pending.delete(msg.id);
        }
        break;

      case 'error': {
        const err = new Error(msg.message ?? 'Whisper failed');
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!.reject(err);
          pending.delete(msg.id);
        } else {
          useSttStore.getState().setStt('unavailable', err.message);
          readyReject?.(err);
          readyResolve = null; readyReject = null;
        }
        break;
      }
    }
  };

  worker.onerror = (e) => {
    const message = e.message || 'Whisper worker crashed';
    useSttStore.getState().setStt('unavailable', message);
    readyReject?.(new Error(message));
    readyResolve = null; readyReject = null;
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };

  return worker;
}

/** Kicks off the model download/load. Safe to call repeatedly. */
export function ensureModel(model = DEFAULT_STT_MODEL): Promise<void> {
  if (readyPromise) return readyPromise;
  const w = spawn();
  readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  useSttStore.getState().setStt('loading', 'Preparing Whisper...');
  w.postMessage({ type: 'load', model });
  return readyPromise;
}

export async function transcribe(audio: Float32Array): Promise<string> {
  await ensureModel();
  const w = spawn();
  const id = `t${counter++}`;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Transfer the buffer rather than copying it.
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

export const sttReady = (): boolean => useSttStore.getState().stt === 'ok';

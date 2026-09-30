/**
 * Real-time, full-duplex spoken conversation with Gemini via the Live API.
 *
 * IMPORTANT — scope of this module:
 *   - This module does NOT capture the microphone and does NOT play audio.
 *     The caller is responsible for both: capture 16kHz mono PCM16 from the
 *     mic (see `src/services/recorder.ts` / `src/services/audio.ts` for the
 *     existing capture patterns in this codebase) and feed base64-encoded
 *     chunks in via `sendAudioChunk`; then take the base64 PCM16 chunks that
 *     arrive via `onModelAudioChunk` and play them back through a Web Audio
 *     graph (e.g. an AudioContext running at 24kHz, or resampled to the
 *     output device's rate).
 *
 *   - PCM FORMATS — these are easy to get backwards, and the Live API is
 *     strict about them:
 *       IN  (mic -> model):  base64 PCM16, 16kHz, mono   ("audio/pcm;rate=16000")
 *       OUT (model -> mic):  base64 PCM16, 24kHz, mono
 *     Sending 24kHz audio in, or expecting 16kHz audio out, will produce
 *     garbled/chipmunked or slowed-down audio. Do not "fix" these numbers
 *     without checking Google's current docs first.
 *
 * This is a browser/renderer-side module (no Node/Electron APIs). It is
 * intentionally defensive: nothing thrown by the underlying SDK or a
 * malformed server message should ever escape as an unhandled exception or
 * rejected promise back into the caller. Everything is routed through the
 * `onError` callback instead.
 */

import { GoogleGenAI, Modality } from '@google/genai';

// Default Gemini Live model id. Google periodically renames/versions Live
// models (e.g. dropping "-001", moving to newer generations). If a session
// fails to connect with a "model not found" style error, this is the first
// thing to check and update.
const DEFAULT_LIVE_MODEL = 'gemini-2.0-flash-live-001';

export interface LiveVoiceCallbacks {
  onOpen?: () => void;
  onModelAudioChunk?: (pcmBase64: string) => void; // raw audio the model is speaking: base64 PCM16, 24kHz, mono
  onModelText?: (text: string) => void;             // transcript text, if the turn includes any
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onClose?: (reason?: string) => void;
  onError?: (message: string) => void;
}

export interface LiveVoiceHandle {
  sendAudioChunk(pcm16Base64: string): void; // caller streams mic audio in: base64 PCM16, 16kHz, mono, ~100-200ms chunks
  sendText(text: string): void;
  close(): void; // idempotent — safe to call twice
}

/** Basic capability check. Does not touch the mic — just confirms the browser has Web Audio. */
export function isLiveVoiceSupported(): boolean {
  try {
    return typeof window !== 'undefined' &&
      (typeof window.AudioContext !== 'undefined' ||
        typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined');
  } catch {
    // Accessing `window` defensively in case this ever runs somewhere odd.
    return false;
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return String(e);
  } catch {
    return 'Unknown error';
  }
}

export async function startLiveVoice(
  apiKey: string,
  callbacks: LiveVoiceCallbacks,
  opts?: { model?: string; systemInstruction?: string; voiceName?: string },
): Promise<LiveVoiceHandle> {
  const model = opts?.model ?? DEFAULT_LIVE_MODEL;

  const ai = new GoogleGenAI({ apiKey });

  const config: {
    responseModalities: Modality[];
    systemInstruction?: string;
    speechConfig?: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  } = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: opts?.systemInstruction,
  };
  // Only attach speechConfig when a voice name was actually given — an empty
  // object here would override the model's default voice selection.
  if (opts?.voiceName) {
    config.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } },
    };
  }

  const session = await ai.live.connect({
    model,
    config,
    callbacks: {
      onopen: () => {
        try {
          callbacks.onOpen?.();
        } catch (e) {
          callbacks.onError?.(errorMessage(e));
        }
      },
      onmessage: (message: unknown) => {
        // Server messages are defensively unwrapped: an unexpected/partial
        // shape here must never crash the session or bubble out of this
        // callback.
        try {
          const msg = message as {
            serverContent?: {
              modelTurn?: { parts?: Array<{ inlineData?: { data?: string }; text?: string }> };
              turnComplete?: boolean;
              interrupted?: boolean;
            };
          };

          const parts = msg.serverContent?.modelTurn?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part?.inlineData?.data) {
                callbacks.onModelAudioChunk?.(part.inlineData.data);
              }
              if (typeof part?.text === 'string') {
                callbacks.onModelText?.(part.text);
              }
            }
          }

          if (msg.serverContent?.turnComplete) {
            callbacks.onTurnComplete?.();
          }
          if (msg.serverContent?.interrupted) {
            callbacks.onInterrupted?.();
          }
        } catch (e) {
          callbacks.onError?.(errorMessage(e));
        }
      },
      onerror: (e: unknown) => {
        callbacks.onError?.(errorMessage(e));
      },
      onclose: (e: unknown) => {
        const reason =
          typeof e === 'string'
            ? e
            : e && typeof e === 'object' && 'reason' in e
              ? String((e as { reason?: unknown }).reason ?? '')
              : undefined;
        callbacks.onClose?.(reason);
      },
    },
  });

  let closed = false;

  const handle: LiveVoiceHandle = {
    sendAudioChunk(pcm16Base64: string): void {
      try {
        if (closed) return;
        void Promise.resolve(
          session.sendRealtimeInput({
            audio: { data: pcm16Base64, mimeType: 'audio/pcm;rate=16000' },
          }),
        ).catch((e: unknown) => callbacks.onError?.(errorMessage(e)));
      } catch (e) {
        callbacks.onError?.(errorMessage(e));
      }
    },

    sendText(text: string): void {
      try {
        if (closed) return;
        void Promise.resolve(
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true,
          }),
        ).catch((e: unknown) => callbacks.onError?.(errorMessage(e)));
      } catch (e) {
        callbacks.onError?.(errorMessage(e));
      }
    },

    close(): void {
      if (closed) return; // idempotent
      closed = true;
      try {
        session.close();
      } catch (e) {
        callbacks.onError?.(errorMessage(e));
      }
    },
  };

  return handle;
}

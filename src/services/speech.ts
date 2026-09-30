/**
 * Text-to-speech via the Web Speech API - free, built into Chromium, and it
 * uses the OS voices so it works reliably inside Electron.
 *
 * Speech-to-text deliberately does NOT live here. The Web Speech recognition
 * API exists in Electron but is backed by a Google-hosted service that Electron
 * builds cannot reach, so it fails with a `network` error every time. Ultron
 * runs Whisper locally instead - see services/stt.ts.
 */

export const ttsSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;

let cachedVoice: SpeechSynthesisVoice | null = null;
let cachedFor = ' ';

/** Every English voice installed on this machine. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!ttsSupported()) return [];
  const all = window.speechSynthesis.getVoices();
  const english = all.filter((v) => /^en(-|_|$)/i.test(v.lang));
  return english.length ? english : all;
}

/**
 * Picks a voice. An exact name wins; otherwise prefer a male English voice,
 * British first - the closest the stock OS voices get to the JARVIS register.
 */
export function pickVoice(preferredName = ''): SpeechSynthesisVoice | null {
  if (!ttsSupported()) return null;
  if (cachedVoice && cachedFor === preferredName) return cachedVoice;

  const voices = listVoices();
  if (!voices.length) return null;

  const exact = preferredName ? voices.find((v) => v.name === preferredName) : undefined;
  const partial = preferredName ? voices.find((v) => v.name.includes(preferredName)) : undefined;

  const britishMale = voices.find(
    (v) => /^en-GB/i.test(v.lang) && /george|ryan|guy|thomas|oliver|male/i.test(v.name),
  );
  const anyMale = voices.find((v) => /david|george|guy|mark|ryan|thomas|male/i.test(v.name));

  cachedVoice = exact || partial || britishMale || anyMale || voices[0] || null;
  cachedFor = preferredName;
  return cachedVoice;
}

export function primeVoices(): void {
  if (!ttsSupported()) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
    cachedFor = ' ';
  };
}

/** Deep and deliberate - as close to Ultron as the stock OS voices get. */
export const VOICE_DEFAULTS = { rate: 0.93, pitch: 0.8 };

/** What the voice should actually say: no markdown symbols, citation markers or raw URLs. */
export function toSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/\s*\[\d+(?:[,\s-]+\d+)*\]/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    // A line break reads as a pause: end the sentence if it didn't already.
    .replace(/([^.!?:;,\s])[ \t]*\n+\s*/g, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface SpeakOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  rate?: number;
  pitch?: number;
  voiceName?: string;
}

export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!ttsSupported() || !text.trim()) { opts.onEnd?.(); return; }
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(opts.voiceName || '');
  if (voice) utter.voice = voice;
  utter.rate = opts.rate ?? VOICE_DEFAULTS.rate;
  utter.pitch = opts.pitch ?? VOICE_DEFAULTS.pitch;
  utter.volume = 1;
  utter.onstart = () => opts.onStart?.();
  utter.onend = () => opts.onEnd?.();
  utter.onerror = (e) => {
    // 'interrupted'/'canceled' fire on normal stop - not worth surfacing
    const err = String((e as SpeechSynthesisErrorEvent).error ?? '');
    if (err === 'interrupted' || err === 'canceled') opts.onEnd?.();
    else { opts.onError?.(err || 'speech synthesis failed'); opts.onEnd?.(); }
  };
  window.speechSynthesis.speak(utter);
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

export const isSpeaking = (): boolean => ttsSupported() && window.speechSynthesis.speaking;

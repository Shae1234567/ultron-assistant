import { useStore, useSttStore } from '../state/store';
import { speak, stopSpeaking, toSpeech } from './speech';
import { getStream, startMic, stopMic } from './audio';
import { startRecording, stopRecording } from './recorder';
import { ensureModel, transcribe } from './stt';
import { askBrain, brainBusy, cancelBrain } from './brain';

/**
 * Conversation orchestration. Lives outside React so the push-to-talk key
 * handler, the composer, reminders and proactive lines all share one
 * pipeline: message -> team (main process) -> streamed reply -> voice.
 */

const HISTORY_TURNS = 24;

function historyMessages(): { role: 'user' | 'assistant'; content: string }[] {
  const { transcript } = useStore.getState();
  return transcript
    .filter((t) => (t.who === 'you' || t.who === 'ultron') && !t.error && !t.streaming && t.text.trim() && t.text !== '(cancelled)')
    .slice(-HISTORY_TURNS)
    .map((t) => ({ role: t.who === 'you' ? 'user' : 'assistant', content: t.text }));
}

export function isBusy(): boolean {
  return brainBusy() || useStore.getState().busy;
}

/** Speaks a line in Ultron's voice with the operator's voice settings, driving the orb state. */
export function speakAsUltron(text: string): void {
  const line = toSpeech(text);
  if (!line) return;
  const { setCoreState } = useStore.getState();
  const voice = useStore.getState().settings?.voice;
  setCoreState('speaking');
  // Web Speech's onend is documented to sometimes never fire (focus changes,
  // sleep/wake) - without a watchdog the orb would stay on RESPONDING forever.
  const watchdog = setTimeout(() => {
    if (useStore.getState().coreState === 'speaking') setCoreState('idle');
  }, Math.max(8000, line.length * 90));
  speak(line, {
    voiceName: voice?.name,
    rate: voice?.rate,
    pitch: voice?.pitch,
    onEnd: () => {
      clearTimeout(watchdog);
      if (useStore.getState().coreState === 'speaking') setCoreState('idle');
    },
    onError: () => { clearTimeout(watchdog); setCoreState('idle'); },
  });
}

export function cancelCurrent(): void {
  cancelBrain();
  if (pttActive) {
    pttActive = false;
    stopRecording().catch(() => {});
    stopMic();
  }
  stopSpeaking();
  useStore.getState().setCoreState('idle');
}

/** Sends a message to the team, streams the reply into the transcript, then speaks it. */
export async function submitMessage(text: string, opts: { speakReply?: boolean } = {}): Promise<void> {
  const trimmed = text.trim();
  // Refuses while push-to-talk is recording, or the transcribed voice message
  // that follows would find the run slot already taken and silently vanish.
  if (!trimmed || isBusy() || pttActive) return;

  const store = useStore.getState();
  const history = historyMessages();
  store.pushEntry({ who: 'you', text: trimmed });

  if (store.brain && !store.brain.active) {
    store.pushEntry({
      who: 'system',
      text: 'No brain is available: Ollama is not running (or its model is not pulled) and there is no working Gemini key. Opening brain setup.',
      error: true,
    });
    store.setOverlay({ kind: 'brain' });
    return;
  }

  stopSpeaking();
  store.setCoreState('thinking');
  store.setBusy(true);
  const replyId = store.pushEntry({ who: 'ultron', text: '', streaming: true });

  const result = await askBrain(trimmed, history, replyId);
  const s = useStore.getState();
  s.setBusy(false);

  if (!result.ok) {
    if (result.cancelled) {
      s.finishEntry(replyId, { text: '(cancelled)' });
    } else {
      s.finishEntry(replyId, { error: true, text: `[failed] ${result.error ?? 'Something went wrong.'}` });
    }
    s.setCoreState('idle');
    return;
  }

  const agents = result.agents.filter((a) => a !== 'ultron');
  s.finishEntry(replyId, {
    text: result.text,
    sources: result.sources.length ? result.sources : undefined,
    team: agents.length || result.runNote ? { agents, runNote: result.runNote, actions: result.actions } : undefined,
  });

  if (opts.speakReply === false || !result.text.trim()) {
    s.setCoreState('idle');
    return;
  }
  speakAsUltron(result.text);
}

/* ── Push to talk (local Whisper) ───────────────────────────────────────
   Web Speech recognition is a Google-hosted service that Electron builds
   cannot reach, so speech-to-text runs locally: record the clip, resample
   it, and transcribe it with Whisper in a worker.                         */

let pttActive = false;
let modelWarned = false;

export const isPushToTalkActive = () => pttActive;

export function preloadSpeechModel(): void {
  void ensureModel().catch(() => {
    /* status is reported through the stt store */
  });
}

export async function beginPushToTalk(): Promise<void> {
  if (pttActive || isBusy()) return;
  const store = useStore.getState();

  pttActive = true;
  stopSpeaking();

  const mic = await startMic();
  if (!mic.ok) {
    pttActive = false;
    store.pushEntry({ who: 'system', text: `Microphone unavailable: ${mic.error}`, error: true });
    return;
  }

  const stream = getStream();
  if (!stream || !startRecording(stream)) {
    pttActive = false;
    stopMic();
    store.pushEntry({ who: 'system', text: 'Could not start the recorder on this machine.', error: true });
    return;
  }

  if (useSttStore.getState().stt === 'unknown') {
    if (!modelWarned) {
      modelWarned = true;
      store.pushEntry({ who: 'system', text: 'Loading the local Whisper model on first use. This downloads once, then runs offline.' });
    }
    preloadSpeechModel();
  }

  store.setCoreState('listening');
}

export function endPushToTalk(): void {
  if (!pttActive) return;
  pttActive = false;
  void finishPushToTalk();
}

async function finishPushToTalk(): Promise<void> {
  const store = useStore.getState();
  let audio: Float32Array | null = null;
  try {
    audio = await stopRecording();
  } catch {
    audio = null;
  }
  stopMic();

  if (!audio) {
    if (store.coreState === 'listening') store.setCoreState('idle');
    return;
  }

  store.setCoreState('thinking');
  useSttStore.getState().setStt('transcribing');

  try {
    const text = (await transcribe(audio)).trim();
    useSttStore.getState().setStt('ok');
    // Whisper emits these for silence or noise - not worth sending to the brain.
    const noise = /^[\s.,!?-]*(\[[^\]]*\]|\([^)]*\))?[\s.,!?-]*$/i;
    if (!text || noise.test(text)) {
      store.setCoreState('idle');
      return;
    }
    await submitMessage(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useSttStore.getState().setStt('unavailable', message);
    store.pushEntry({ who: 'system', text: `Transcription failed: ${message}`, error: true });
    store.setCoreState('idle');
  }
}

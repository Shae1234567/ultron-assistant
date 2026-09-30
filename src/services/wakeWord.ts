import { getStream, startMic, stopMic } from './audio';
import { startRecording, stopRecording } from './recorder';
import { ensureModel, transcribe } from './stt';

/**
 * Always-on wake-phrase detection ("Ultron" / "hey Ultron").
 *
 * Deliberately dumb: there is no real wake-word model here (Whisper is a
 * full transcriber, not a lightweight keyword spotter), so this runs the same
 * record -> transcribe pipeline push-to-talk uses on a rolling 3-second
 * window and checks the text for the name. That is continuous Whisper
 * inference in the background - real CPU cost - so it stays strictly opt-in.
 */

const WINDOW_MS = 3000;
// Whisper's usual spellings of "Ultron" when it mishears it.
const WAKE_RE = /\b(ult?ron|altron|all[\s-]?tron|ultra[\s-]?on)\b/i;

export type WakeWordStatus = 'off' | 'listening' | 'unavailable';

let active = false;
let stopping = false;

export const isWakeWordActive = (): boolean => active;

export async function startWakeWordListening(
  onWake: () => void,
  onStatus?: (s: WakeWordStatus) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (active) return { ok: true }; // already running - don't stack a second loop

  try {
    const mic = await startMic();
    if (!mic.ok) {
      onStatus?.('unavailable');
      return { ok: false, error: mic.error };
    }

    // Mirrors conversation.ts's preloadSpeechModel/beginPushToTalk pattern:
    // make sure the model is resident before the loop starts, so the first
    // window isn't wasted waiting on a download mid-listen.
    await ensureModel();

    active = true;
    stopping = false;
    onStatus?.('listening');
    void runLoop(onWake, onStatus);
    return { ok: true };
  } catch (e) {
    active = false;
    onStatus?.('unavailable');
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function stopWakeWordListening(): void {
  // Flip the flag and let the in-flight window finish naturally rather than
  // aborting mid-recording - runLoop checks this before starting the next one.
  stopping = true;
}

async function runLoop(onWake: () => void, onStatus?: (s: WakeWordStatus) => void): Promise<void> {
  while (!stopping) {
    const stream = getStream();
    if (!stream || !startRecording(stream)) break; // mic dropped out from under us

    await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_MS));

    try {
      const audio = await stopRecording();
      if (audio) {
        const text = (await transcribe(audio)).trim();
        if (WAKE_RE.test(text)) onWake();
      }
    } catch (e) {
      // One bad window (transient Whisper error) should not kill the whole
      // rolling loop - log and roll into the next window.
      console.warn('[wakeWord] transcription window failed, continuing:', e);
    }
  }

  active = false;
  stopping = false;
  stopMic();
  onStatus?.('off');
}

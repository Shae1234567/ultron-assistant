import { startWakeWordListening, stopWakeWordListening, type WakeWordStatus } from './wakeWord';
import { greetNow } from './proactive';
import { playWakeDetected } from './sfx';
import { ultron } from './bridge';
import { useStore } from '../state/store';

/**
 * Turning the wake word on or off from anywhere (Settings, the command
 * palette) goes through here, so the choice is saved and comes back on its
 * own the next time Ultron starts.
 */

async function remember(on: boolean): Promise<void> {
  try {
    useStore.getState().setSettings(await ultron.settings.save({ voice: { wakeWord: on } } as Parameters<typeof ultron.settings.save>[0]));
  } catch {
    /* the toggle still works for this session */
  }
}

export async function setWakeWord(on: boolean, onStatus: (s: WakeWordStatus) => void = () => {}): Promise<{ ok: boolean; error?: string }> {
  if (!on) {
    stopWakeWordListening();
    onStatus('off');
    await remember(false);
    return { ok: true };
  }
  const res = await startWakeWordListening(() => { playWakeDetected(); void ultron.win.show(); greetNow(); }, onStatus);
  if (res.ok) await remember(true);
  return res;
}

/** At boot: bring the wake word back if it was on when Ultron last ran. */
export async function restoreWakeWord(): Promise<void> {
  if (!useStore.getState().settings?.voice.wakeWord) return;
  await startWakeWordListening(() => { playWakeDetected(); void ultron.win.show(); greetNow(); }, () => {}).catch(() => {});
}

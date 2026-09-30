import { useStore } from '../state/store';
import { speakAsUltron } from './conversation';
import { isSpeaking } from './speech';
import { ultron } from './bridge';
import { playAlert } from './sfx';
import { spokenDue } from './format';
import type { Task } from '../types';

/**
 * The part of Ultron that speaks first: a greeting when the brain comes up,
 * the wake-word greeting, occasional idle check-ins, and spoken reminders.
 *
 * Two rules: never talk over the operator (every line re-checks busy state
 * right before speaking), and fail silently - a proactive line nobody asked
 * for is not worth an error in the transcript if the brain call fails.
 */

let greetedThisSession = false;

function operatorEngaged(): boolean {
  const { busy, transcript, coreState } = useStore.getState();
  if (busy || coreState === 'listening' || coreState === 'thinking') return true;
  return transcript.some((t) => t.who === 'you');
}

function brainReady(): boolean {
  return Boolean(useStore.getState().brain?.active);
}

function sayProactively(text: string): void {
  const trimmed = text.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return;
  useStore.getState().pushEntry({ who: 'ultron', text: trimmed });
  speakAsUltron(trimmed);
  void ultron.notify.show('Ultron', trimmed).catch(() => {});
}

function waitForBrain(timeoutMs: number): Promise<boolean> {
  if (brainReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(ok);
    };
    const unsub = useStore.subscribe(() => { if (brainReady()) finish(true); });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function greetOnce(kind: 'boot' | 'wake' | 'checkin'): Promise<void> {
  try {
    const res = await ultron.brain.greet(kind);
    if (!res.ok || !res.text) return;
    if (kind !== 'wake' && operatorEngaged()) return; // the call took real time - re-check
    sayProactively(res.text);
  } catch (e) {
    console.warn('[proactive] greeting failed, staying quiet:', e);
  }
}

/** Once per session, as soon as the brain is actually usable. */
export function initProactiveGreeting(): void {
  if (greetedThisSession) return;
  greetedThisSession = true;
  void (async () => {
    if (!(await waitForBrain(20_000))) return;
    if (operatorEngaged()) return;
    await greetOnce('boot');
  })();
}

/** The wake word summoned Ultron from the tray - greet again, briefly. */
export function greetNow(): void {
  if (!brainReady() || operatorEngaged()) return;
  void greetOnce('wake');
}

/** Low-frequency idle check-in; returns a stop function. */
export function scheduleProactiveCheckIn(intervalMinutes = 45): () => void {
  const intervalMs = Math.max(5, intervalMinutes) * 60_000;
  const timer = setInterval(() => {
    const { coreState, transcript, busy } = useStore.getState();
    if (!brainReady() || busy || coreState !== 'idle') return;
    const lastAt = transcript.length ? transcript[transcript.length - 1].at : 0;
    if (Date.now() - lastAt < intervalMs) return;
    void greetOnce('checkin');
  }, intervalMs);
  return () => clearInterval(timer);
}

/* ── Spoken reminders ───────────────────────────────────────────────── */

const reminderQueue: { task: Task; missed: boolean }[] = [];
let reminderTimer: ReturnType<typeof setInterval> | null = null;

function drainReminders(): void {
  if (!reminderQueue.length) return;
  const { busy, coreState } = useStore.getState();
  // Never cut into the operator talking or Ultron mid-sentence; try again shortly.
  if (busy || coreState === 'listening' || coreState === 'thinking' || isSpeaking()) return;
  const { task, missed } = reminderQueue.shift()!;
  const line = `${missed ? 'Missed reminder' : 'Reminder'}: ${task.title.replace(/[.!?]+$/, '')}. ${spokenDue(task)}`.trim();
  useStore.getState().pushEntry({ who: 'system', text: line });
  playAlert();
  if (useStore.getState().settings?.voice.speakReminders !== false) speakAsUltron(line);
}

export function handleReminder(p: { task: Task; missed: boolean }): void {
  reminderQueue.push(p);
  drainReminders();
  if (!reminderTimer) reminderTimer = setInterval(drainReminders, 3000);
}

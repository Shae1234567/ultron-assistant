import { Notification } from 'electron';

/**
 * Native OS notification primitive. Intended real call sites (not wired up
 * here - someone else does that):
 *  1. src/services/proactive.ts's sayProactively()
 *  2. src/services/wakeWord.ts's wake-detection point
 * Both should only actually fire the notification when the main window is
 * not focused/visible - that focus/visibility check belongs in the IPC
 * handler on the main-process side when this gets wired up, not in here.
 */

export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch {
    // Swallow silently - a failed notification should never crash or throw.
  }
}

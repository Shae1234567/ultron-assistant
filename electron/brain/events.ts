import type { BrowserWindow } from 'electron';

let window: BrowserWindow | null = null;

export function setEventWindow(win: BrowserWindow | null): void {
  window = win;
}

export function emit(channel: string, payload: unknown): void {
  try {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  } catch {
    /* renderer reloading - nothing to deliver to */
  }
}

/** Brings the HUD forward (e.g. an approval is waiting and the window is in the tray). */
export function surfaceWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (!window.isVisible()) window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}

export function windowFocused(): boolean {
  return Boolean(window && !window.isDestroyed() && window.isVisible() && window.isFocused());
}

import { clipboard } from 'electron';

/**
 * Clipboard Intelligence - detection side.
 *
 * Electron has no built-in "clipboard changed" event, so the only portable
 * way to notice a new copy is to poll `clipboard.readText()` on an interval
 * and diff against the last-seen value. This is a known, accepted tradeoff
 * (not an oversight) - a native OS clipboard-change hook would require
 * platform-specific code (win32 AddClipboardFormatListener, macOS NSPasteboard
 * change-count polling, etc.) that isn't worth the complexity for this feature.
 */

/** How often to check the clipboard, in milliseconds. */
const POLL_INTERVAL_MS = 600;

/** Clipboard blobs larger than this are assumed to be pasted files/dumps,
 *  not something the operator wants run through the AI - skip them. */
const MAX_TEXT_LENGTH = 20_000;

/**
 * Starts polling the system clipboard for new text. `onNewText` fires only
 * when the clipboard contents actually changed since the last poll, are
 * non-empty (after trimming), and are under MAX_TEXT_LENGTH.
 *
 * Returns a stop function that clears the interval - callers must invoke it
 * on shutdown/unmount to avoid leaking the timer.
 */
export function startClipboardWatch(onNewText: (text: string) => void): () => void {
  let lastSeen = clipboard.readText();

  const interval = setInterval(() => {
    let current: string;
    try {
      current = clipboard.readText();
    } catch {
      // Clipboard can throw transiently (e.g. another process holding it
      // open on Windows) - just skip this tick rather than crash the timer.
      return;
    }

    if (current === lastSeen) return;
    lastSeen = current;

    const trimmed = current.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_TEXT_LENGTH) return;

    onNewText(trimmed);
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

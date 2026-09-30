import { desktopCapturer } from 'electron';

// "Visual Awareness" - real screen capture via Electron's built-in desktopCapturer,
// piped into Gemini for actual scene understanding (not simulated). This module
// only grabs the pixels; turning a capture into a described answer happens on the
// renderer side (see src/services/vision.ts, which calls Gemini's vision model).
// IPC wiring (vision:capture / vision:listSources channels, preload bridge) is
// left to whoever integrates this.

export interface CaptureResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

/** Captures the primary screen as a PNG data URL. */
export async function captureScreen(): Promise<CaptureResult> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    if (!sources.length) {
      return { ok: false, error: 'No screen sources available.' };
    }

    const primary = sources[0];
    const dataUrl = primary.thumbnail.toDataURL();
    if (!dataUrl) {
      return { ok: false, error: 'Failed to encode screen capture.' };
    }

    return { ok: true, dataUrl };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * Lists every capturable screen AND window source (id + name), so a future
 * caller can let the operator pick a specific window instead of the whole
 * screen.
 */
export async function listScreenSources(): Promise<{ ok: boolean; sources: { id: string; name: string }[]; error?: string }> {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return { ok: true, sources: sources.map((s) => ({ id: s.id, name: s.name })) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, sources: [], error: message };
  }
}

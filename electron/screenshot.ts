import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { captureScreen } from './vision';

// Thin save-to-disk wrapper around vision.ts's real screen capture. This module
// does NOT re-implement capture — it calls captureScreen() to get a real PNG
// data URL, then decodes it and writes it to the user's Pictures folder under
// a sanitized (and collision-safe) filename.

const INVALID_FILENAME_CHARS = /[<>:"|?*\x00-\x1F/\\]/g;
const PARENT_DIR_TOKEN = /\.\./g;

function sanitizeFilename(filename?: string): string {
  let name = (filename ?? '').trim();

  // Strip path traversal tokens and any path separators / invalid chars.
  name = name.replace(PARENT_DIR_TOKEN, '');
  name = name.replace(INVALID_FILENAME_CHARS, '');
  name = name.trim();

  if (!name) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    name = `screenshot-${timestamp}.png`;
  }

  if (!/\.png$/i.test(name)) {
    name = `${name}.png`;
  }

  return name;
}

function resolveAvailablePath(directory: string, filename: string): { ok: true; fullPath: string } | { ok: false; error: string } {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);

  let candidate = path.join(directory, filename);
  if (!fs.existsSync(candidate)) {
    return { ok: true, fullPath: candidate };
  }

  const MAX_ATTEMPTS = 100;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    candidate = path.join(directory, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) {
      return { ok: true, fullPath: candidate };
    }
  }

  return { ok: false, error: `Could not find an available filename after ${MAX_ATTEMPTS} attempts.` };
}

/** Captures the screen (via vision.ts) and saves it to disk as a PNG. */
export async function takeScreenshotAndSave(filename?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const capture = await captureScreen();
    if (!capture.ok || !capture.dataUrl) {
      return { ok: false, error: capture.error ?? 'Screen capture failed.' };
    }

    const match = capture.dataUrl.match(/^data:image\/png;base64,(.+)$/);
    const base64 = match ? match[1] : capture.dataUrl.replace(/^data:image\/png;base64,/, '');
    if (!base64) {
      return { ok: false, error: 'Failed to parse captured image data URL.' };
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Failed to decode image data: ${message}` };
    }

    const sanitized = sanitizeFilename(filename);
    const picturesDir = app.getPath('pictures');

    const resolved = resolveAvailablePath(picturesDir, sanitized);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    fs.writeFileSync(resolved.fullPath, buffer);

    return { ok: true, path: resolved.fullPath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

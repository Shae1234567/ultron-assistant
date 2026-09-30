import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { shell } from 'electron';

/**
 * Real OS integration for the operator's own machine: launching apps, opening
 * specific web destinations, volume, and locking/sleeping it. Deliberately
 * scoped to these - NOT raw keyboard/mouse input simulation, and shutdown/
 * restart are exported but intentionally excluded from the agent tool
 * registry (src/services/tools.ts) - see the comments on those two below.
 */

const run = promisify(execFile);

export interface AppLaunchResult { ok: boolean; error?: string }

const UNSAFE_CHARS = /[&|;`\r\n]/;

export async function openApp(nameOrPath: string): Promise<AppLaunchResult> {
  const clean = nameOrPath.trim();
  if (!clean) return { ok: false, error: 'No app name given.' };
  if (UNSAFE_CHARS.test(clean)) return { ok: false, error: 'Invalid app name.' };

  try {
    // A real existing path opens directly via Electron's own opener.
    const pathError = await shell.openPath(clean);
    if (!pathError) return { ok: true };
    // Not a real path (or shell.openPath failed) - fall back to letting
    // Windows resolve it as an app/protocol name, same as the Run box.
    // execFile (not exec) so Node handles argument escaping, not a hand-built
    // shell string.
    await run('cmd.exe', ['/c', 'start', '""', clean]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const GOOGLE_SERVICES: Record<string, string> = {
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  'gmail-compose': 'https://mail.google.com/mail/u/0/#inbox?compose=new',
  compose: 'https://mail.google.com/mail/u/0/#inbox?compose=new',
  calendar: 'https://calendar.google.com/calendar/u/0/r',
  drive: 'https://drive.google.com/drive/u/0/my-drive',
  docs: 'https://docs.google.com/document/u/0/',
  sheets: 'https://docs.google.com/spreadsheets/u/0/',
  slides: 'https://docs.google.com/presentation/u/0/',
  maps: 'https://maps.google.com',
  photos: 'https://photos.google.com',
  translate: 'https://translate.google.com',
  youtube: 'https://www.youtube.com',
  search: 'https://www.google.com',
};

export async function openGoogleService(service: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const key = service.trim().toLowerCase();
  const url = GOOGLE_SERVICES[key];
  if (!url) {
    return {
      ok: false,
      error: `Unknown Google service: ${service}. Known: ${Object.keys(GOOGLE_SERVICES).join(', ')}`,
    };
  }
  try {
    await shell.openExternal(url);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// SendKeys' virtual media-key codes - Windows treats these exactly like a
// physical keyboard's volume keys regardless of which app has focus. No
// native audio dependency needed for this.
const VOLUME_KEYS: Record<'up' | 'down' | 'mute', string> = {
  up: '([char]175)',
  down: '([char]174)',
  mute: '([char]173)',
};

export async function setVolume(direction: 'up' | 'down' | 'mute'): Promise<{ ok: boolean; error?: string }> {
  const code = VOLUME_KEYS[direction];
  if (!code) return { ok: false, error: 'Invalid direction.' };
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${code})`;
    await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function lockComputer(): Promise<{ ok: boolean; error?: string }> {
  try {
    await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sleepComputer(): Promise<{ ok: boolean; error?: string }> {
  try {
    await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Deliberately NOT registered as an agent tool in src/services/tools.ts.
// Shutting the operator's machine down is exactly the kind of action a model
// should never be able to trigger from a conversational misfire - this is
// for a manual, explicitly-confirmed UI button only. Whoever wires a button
// to this must add its own "are you sure" confirmation step first.
export function shutdownComputer(): { ok: boolean; error?: string } {
  try {
    execFile('shutdown.exe', ['/s', '/t', '30']); // 30s grace period, abortable via `shutdown /a`
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Same exclusion and rationale as shutdownComputer() above.
export function restartComputer(): { ok: boolean; error?: string } {
  try {
    execFile('shutdown.exe', ['/r', '/t', '30']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function openFileExplorer(path?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const target = path || os.homedir();
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Window enumeration and switching for the operator's own machine. Uses
 * PowerShell for enumeration (Get-Process) and the WScript.Shell COM
 * object's AppActivate for focus-switching - a real, documented Windows
 * automation technique, and simpler/less error-prone to write blind than
 * a hand-rolled Add-Type P/Invoke SetForegroundWindow/FindWindow shim.
 */

const run = promisify(execFile);

export interface OpenWindow { title: string; processName: string }

export async function listOpenWindows(): Promise<{ ok: boolean; windows: OpenWindow[]; error?: string }> {
  try {
    const ps =
      "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object MainWindowTitle,ProcessName | ConvertTo-Json";
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    const trimmed = stdout.trim();
    if (!trimmed) return { ok: true, windows: [] };

    const parsed = JSON.parse(trimmed);
    // ConvertTo-Json returns a bare object (not an array) when there's
    // exactly one match - normalize both shapes to an array.
    const items: Array<{ MainWindowTitle?: string; ProcessName?: string }> = Array.isArray(parsed)
      ? parsed
      : [parsed];

    const windows: OpenWindow[] = items
      .filter((item) => item && typeof item.MainWindowTitle === 'string' && item.MainWindowTitle !== '')
      .map((item) => ({
        title: item.MainWindowTitle as string,
        processName: item.ProcessName ?? '',
      }));

    return { ok: true, windows };
  } catch (e) {
    return { ok: false, windows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function switchToWindow(titleContains: string): Promise<{ ok: boolean; error?: string }> {
  const needle = titleContains.trim();
  if (!needle) return { ok: false, error: 'No window title given.' };

  try {
    const escaped = needle.replace(/'/g, "''");
    const ps =
      `$shell = New-Object -ComObject WScript.Shell; ` +
      `$result = $shell.AppActivate('${escaped}'); ` +
      `Write-Output $result`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    const activated = stdout.trim().toLowerCase() === 'true';

    if (!activated) {
      return { ok: false, error: `No window matching "${titleContains}" found.` };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function cycleWindow(): Promise<{ ok: boolean; error?: string }> {
  try {
    const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{TAB}')";
    await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

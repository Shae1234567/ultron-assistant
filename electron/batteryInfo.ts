import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Battery status via PowerShell's WMI access (Win32_Battery) - no new npm
 * dependency needed. Desktop PCs with no battery return an empty result from
 * that query, which is treated as a normal "no battery" case, not an error.
 */

const run = promisify(execFile);

export interface BatteryInfo {
  hasBattery: boolean;
  percent?: number;
  charging?: boolean;
  // Win32_Battery doesn't expose design-capacity-vs-full-charge-capacity, the
  // actual measure of battery "health". The more accurate source is
  // `powercfg /batteryreport`, which writes an HTML report - reliably parsing
  // that HTML is significantly more involved than this task's scope, so this
  // is left undefined rather than fabricated or scraped fragilely.
  healthPercent?: number;
}

interface Win32Battery {
  EstimatedChargeRemaining?: number;
  BatteryStatus?: number;
}

export async function getBatteryInfo(): Promise<{ ok: boolean; info?: BatteryInfo; error?: string }> {
  try {
    const ps = 'Get-CimInstance -ClassName Win32_Battery | ConvertTo-Json';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps]);

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { ok: true, info: { hasBattery: false } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (parsed === null) {
      return { ok: true, info: { hasBattery: false } };
    }

    // ConvertTo-Json returns a single object when there's one battery, or an
    // array when there are multiple (or none). Normalize to the first entry.
    const battery: Win32Battery | undefined = Array.isArray(parsed) ? parsed[0] : (parsed as Win32Battery);

    if (!battery || typeof battery !== 'object') {
      return { ok: true, info: { hasBattery: false } };
    }

    const percent = typeof battery.EstimatedChargeRemaining === 'number' ? battery.EstimatedChargeRemaining : undefined;
    // WMI BatteryStatus codes: 1 = discharging, 2 = on AC/charging, others = various states.
    const charging = battery.BatteryStatus === 2;

    return { ok: true, info: { hasBattery: true, percent, charging } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

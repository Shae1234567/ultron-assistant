/**
 * Hardware monitoring with localized (spoken) voice alerts.
 *
 * Thresholds: CPU 90%, RAM 90%, GPU 95% (GPU is allowed to run hotter under
 * sustained load - e.g. rendering/inference - before it's worth interrupting
 * the operator), temperature 85C (a conservative "getting dangerous" line for
 * both CPU and discrete GPU silicon, well under thermal-throttle/shutdown
 * territory on most consumer hardware).
 *
 * One-shot-per-excursion + hysteresis: each metric only speaks once when it
 * first crosses its threshold, then stays silent while it remains above that
 * threshold. Without this, a metric pinned above threshold for a minute of
 * polling (e.g. one tick per second) would trigger the same spoken alert
 * dozens of times in a row. The alert re-arms only after the metric drops
 * back below (threshold - 5), not right at the boundary, so small jitter
 * around the threshold doesn't cause the alert to flap on and off repeatedly.
 */

import { speak } from './speech';

export interface HardwareSample {
  cpuPercent?: number;
  ramPercent?: number;
  gpuPercent?: number;
  tempC?: number;
}

// Mutable-ish so a future settings UI could adjust these at runtime.
export const HARDWARE_THRESHOLDS = {
  cpuPercent: 90,
  ramPercent: 90,
  gpuPercent: 95,
  tempC: 85,
};

// Re-arm gap: a metric must drop below (threshold - HYSTERESIS) before its
// one-shot alert flag resets, preventing flapping right at the boundary.
const HYSTERESIS = 5;

let alertedCpu = false;
let alertedRam = false;
let alertedGpu = false;
let alertedTemp = false;

function evaluate(
  value: number | undefined,
  threshold: number,
  alerted: boolean,
  onAlert: (value: number) => void,
): boolean {
  if (value === undefined) return alerted;

  if (value >= threshold) {
    if (!alerted) {
      onAlert(value);
      return true;
    }
    return alerted;
  }

  if (value < threshold - HYSTERESIS) {
    return false;
  }

  // Between (threshold - HYSTERESIS) and threshold: hold current state.
  return alerted;
}

export function checkHardwareThresholds(sample: HardwareSample): void {
  try {
    alertedCpu = evaluate(sample.cpuPercent, HARDWARE_THRESHOLDS.cpuPercent, alertedCpu, (v) => {
      speak(`CPU usage is running high at ${Math.round(v)} percent.`);
    });

    alertedRam = evaluate(sample.ramPercent, HARDWARE_THRESHOLDS.ramPercent, alertedRam, (v) => {
      speak(`Memory usage is running high at ${Math.round(v)} percent.`);
    });

    alertedGpu = evaluate(sample.gpuPercent, HARDWARE_THRESHOLDS.gpuPercent, alertedGpu, (v) => {
      speak(`GPU usage is running high at ${Math.round(v)} percent.`);
    });

    alertedTemp = evaluate(sample.tempC, HARDWARE_THRESHOLDS.tempC, alertedTemp, (v) => {
      speak(`Temperature is running high at ${Math.round(v)} degrees.`);
    });
  } catch {
    // A hardware-alert failure must never throw into the caller's polling loop.
  }
}

import os from 'node:os';

/**
 * Real, dependency-free hardware telemetry using only Node's built-in `os`
 * module. `os.loadavg()` always reads [0,0,0] on Windows (Node doesn't
 * emulate it there), so CPU% instead diffs two `os.cpus()` snapshots against
 * the last call - the standard technique, and the only one that's actually
 * accurate on Windows. The first call after boot has nothing to diff against
 * and returns 0; every call after that is a real busy/idle ratio since the
 * previous sample. RAM% is exact. GPU/temperature have no free,
 * dependency-free, cross-platform source, so they're omitted rather than
 * faked.
 */

export interface HardwareStats {
  cpuPercent: number;
  ramPercent: number;
  ramUsedGB: number;
  ramTotalGB: number;
}

let lastSample: { idle: number; total: number } | null = null;

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const core of os.cpus()) {
    for (const t of Object.values(core.times)) total += t;
    idle += core.times.idle;
  }
  return { idle, total };
}

export function getHardwareStats(): HardwareStats {
  const sample = cpuTotals();
  let cpuPercent = 0;
  if (lastSample) {
    const idleDelta = sample.idle - lastSample.idle;
    const totalDelta = sample.total - lastSample.total;
    cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
  }
  lastSample = sample;
  cpuPercent = Math.max(0, Math.min(100, cpuPercent));

  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const ramPercent = total > 0 ? Math.round((used / total) * 100) : 0;

  return {
    cpuPercent,
    ramPercent,
    ramUsedGB: Math.round((used / 1024 / 1024 / 1024) * 10) / 10,
    ramTotalGB: Math.round((total / 1024 / 1024 / 1024) * 10) / 10,
  };
}

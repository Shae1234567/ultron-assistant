import { getSettings, type WorkflowVersion } from '../store';

/**
 * The team's workflow, versioned. Each improvement is a named switch so a
 * version can be evaluated against the one before it (evals/), promoted only
 * when the numbers support it, and switched back in Settings if it turns out
 * worse in real use. v1 is the behaviour before the 28 Sep 2026 upgrade.
 */
export interface Workflow {
  version: WorkflowVersion;
  /** Per-step reasoning levels and the strongest model for the hardest steps (Settings -> Thinking). */
  effort: boolean;
  /** run_code, mathjs calculate, google_search and memory_forget. */
  newTools: boolean;
  /** Maths answers must come from the sandbox; worked equations are re-checked before the answer is shown. */
  verifyMath: boolean;
  /** Research from several perspectives with follow-ups, dated sources, quotes and a citation check. */
  research2: boolean;
  /** Plan steps carry "done when" criteria, checked in review; a failed step gets one recovery attempt. */
  criteria: boolean;
  /** A read that fails on a network blip is tried once more. */
  toolRetry: boolean;
  /** Memory facts carry their source, guesses are kept apart as "unconfirmed", and unfinished work is noted. */
  memory2: boolean;
  /** Hard problems are solved by several independent programs, and the answer they agree on is used (solver.ts). */
  solver: boolean;
}

export const WORKFLOWS: Record<WorkflowVersion, Workflow> = {
  v1: { version: 'v1', effort: false, newTools: false, verifyMath: false, research2: false, criteria: false, toolRetry: false, memory2: false, solver: false },
  v2: { version: 'v2', effort: true, newTools: true, verifyMath: true, research2: true, criteria: true, toolRetry: true, memory2: true, solver: false },
  v3: { version: 'v3', effort: true, newTools: true, verifyMath: true, research2: true, criteria: true, toolRetry: true, memory2: true, solver: true },
};

/** Tools that only exist from v2 on - hidden from the agents on v1, so a v1 run really is the old behaviour. */
export const V2_TOOLS = new Set(['run_code', 'google_search', 'memory_forget', 'browser_agent', 'youtube_transcript', 'read_feed', 'skill_search', 'skill_read', 'memory_reflect']);

export function workflow(version: WorkflowVersion = getSettings().workflow): Workflow {
  return WORKFLOWS[version] ?? WORKFLOWS.v2;
}

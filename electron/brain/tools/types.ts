import type { AgentId, JsonSchema } from '../types';

export interface ToolContext {
  runId: string;
  agent: AgentId;
  /** The browser tab this caller owns - one per agent, one per helper, so they can browse in parallel. */
  tab: { id: string; runId: string; agent: string; label: string };
  signal: AbortSignal;
  /** How many characters of a result the caller will actually see (results are clipped to this) - a tool that
      can choose what to return (the passages about a question) should fit its best material inside it. */
  resultBudget?: number;
  /** How much of a skill guide (skill_read) fits - more than other results on Gemini, since the guide is followed step by step. */
  guideBudget?: number;
  /** Asks the operator; resolves false on deny or timeout. `kind` groups "approve the rest". */
  approve: (kind: string, title: string, detail: string) => Promise<boolean>;
  /** Short live status line shown under the agent's card. */
  progress: (text: string) => void;
  /** Shares an interim finding with the rest of the team (the blackboard). */
  post: (text: string) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  owner: AgentId;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /** One-line human summary of a call, for the activity log. */
  label?: (args: Record<string, unknown>) => string;
  /** Changes something in the operator's apps - what a "done it" report has to point to. */
  writes?: boolean;
}

export function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required };
}

export const S = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
export const N = (description: string): JsonSchema => ({ type: 'number', description });
export const B = (description: string): JsonSchema => ({ type: 'boolean', description });
export const A = (description: string, items: JsonSchema = { type: 'string' }): JsonSchema => ({ type: 'array', description, items });

export function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true';
  return fallback;
}

export function list(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/** Keeps tool output inside the model's context budget. */
export function clip(value: unknown, max = 6000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

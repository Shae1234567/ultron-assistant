import { ultron } from './bridge';
import { useStore } from '../state/store';
import type { ActivityLine, AgentId, BrainEvent, SourceLink } from '../types';

/**
 * Renderer side of a brain run: sends the message to the main process and
 * turns its event stream into HUD state - agent cards, the plan, the activity
 * log, and the streamed reply text.
 */

export interface RunResult {
  ok: boolean;
  text: string;
  cancelled?: boolean;
  error?: string;
  agents: AgentId[];
  sources: SourceLink[];
  runNote?: string;
  actions: ActivityLine[];
}

interface Current {
  runId: string;
  replyId: string;
  actions: ActivityLine[];
  final?: Extract<BrainEvent, { type: 'final' }>;
  error?: Extract<BrainEvent, { type: 'error' }>;
  resolve: (r: RunResult) => void;
}

let current: Current | null = null;
let wired = false;
// Events can arrive before brain:ask resolves with the runId - hold them briefly.
let early: BrainEvent[] = [];

function handle(e: BrainEvent): void {
  if (!current || e.runId !== current.runId) return;
  const s = useStore.getState();
  switch (e.type) {
    case 'phase':
      s.setPhase(e.phase, e.label);
      break;
    case 'agent':
      s.setAgent(e.agent, e.status, e.task);
      break;
    case 'action':
      current.actions.push(s.logActivity({ agent: e.agent, sub: e.sub, text: e.text, kind: e.kind }));
      break;
    case 'helper':
      s.setHelper({ id: e.id, parent: e.parent, name: e.name, status: e.status, task: e.task, report: e.report });
      break;
    case 'plan':
      s.setPlan(e.steps.map((st) => ({ ...st, status: 'queued' })), e.note);
      break;
    case 'step':
      s.setStepStatus(e.id, e.status);
      break;
    case 'token':
      s.appendToEntry(current.replyId, e.text);
      break;
    case 'reset':
      s.finishEntry(current.replyId, { text: '', streaming: true });
      break;
    case 'notice':
      current.actions.push(s.logActivity({ agent: 'ultron', text: e.text, kind: 'warn' }));
      break;
    case 'final':
      current.final = e;
      if (e.timings) s.setTimings(e.timings);
      break;
    case 'error':
      current.error = e;
      break;
    case 'done': {
      const c = current;
      current = null;
      s.endTeam();
      c.resolve({
        ok: Boolean(c.final) && !c.error,
        text: c.final?.text ?? '',
        cancelled: c.error?.cancelled,
        error: c.error?.message,
        agents: c.final?.agents ?? [],
        sources: c.final?.sources ?? [],
        runNote: c.final?.runNote,
        actions: c.actions,
      });
      break;
    }
    default:
      break;
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  ultron.brain.onEvent((e) => {
    if (!current || !current.runId) {
      early.push(e);
      if (early.length > 400) early = early.slice(-400);
      return;
    }
    handle(e);
  });
}

export function brainBusy(): boolean {
  return current !== null;
}

export async function askBrain(
  text: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  replyId: string,
): Promise<RunResult> {
  wire();
  if (current) return { ok: false, text: '', error: 'Already working on something.', agents: [], sources: [], actions: [] };
  early = [];
  return new Promise<RunResult>((resolve) => {
    current = { runId: '', replyId, actions: [], resolve };
    void ultron.brain.ask(text, history).then((res) => {
      if (!res.ok || !res.runId) {
        const c = current;
        current = null;
        c?.resolve({ ok: false, text: '', error: res.error ?? 'The brain did not start.', agents: [], sources: [], actions: [] });
        return;
      }
      if (!current) return;
      current.runId = res.runId;
      useStore.getState().startTeam(res.runId);
      const backlog = early.filter((e) => e.runId === res.runId);
      early = [];
      for (const e of backlog) handle(e);
    });
  });
}

export function cancelBrain(): void {
  if (current?.runId) void ultron.brain.cancel(current.runId);
}

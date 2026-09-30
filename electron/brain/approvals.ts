import { emit, surfaceWindow } from './events';
import { newId, type AgentId } from './types';

/**
 * Human-in-the-loop gate. Anything that sends, deletes, overwrites, moves or
 * runs code on the operator's machine waits here for an explicit Approve in
 * the HUD. No answer within the timeout counts as a no.
 */

export interface ApprovalRequest {
  id: string;
  runId: string;
  agent: AgentId;
  /** Groups similar actions so "approve the rest" only covers the same kind. */
  kind: string;
  title: string;
  detail: string;
  createdAt: number;
}

const TIMEOUT_MS = 3 * 60_000;

const pending = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
const approvedKinds = new Map<string, Set<string>>();

export function requestApproval(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<boolean> {
  if (approvedKinds.get(input.runId)?.has(input.kind)) return Promise.resolve(true);
  const req: ApprovalRequest = { ...input, id: newId('a'), createdAt: Date.now() };
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => settle(req.id, false), TIMEOUT_MS);
    pending.set(req.id, { req, resolve, timer });
    emit('approval:request', req);
    surfaceWindow();
  });
}

function settle(id: string, approved: boolean, all = false): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (approved && all) {
    const kinds = approvedKinds.get(entry.req.runId) ?? new Set<string>();
    kinds.add(entry.req.kind);
    approvedKinds.set(entry.req.runId, kinds);
    // Anything of the same kind already queued behind this one goes through too.
    for (const [otherId, other] of [...pending]) {
      if (other.req.runId === entry.req.runId && other.req.kind === entry.req.kind) settle(otherId, true);
    }
  }
  emit('approval:settled', { id, approved });
  entry.resolve(approved);
}

export function respond(id: string, approved: boolean, all = false): void {
  settle(id, approved, all);
}

export function denyAllForRun(runId: string): void {
  for (const [id, entry] of [...pending]) {
    if (entry.req.runId === runId) settle(id, false);
  }
  approvedKinds.delete(runId);
}

export function endRun(runId: string): void {
  approvedKinds.delete(runId);
}

export function pendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req);
}

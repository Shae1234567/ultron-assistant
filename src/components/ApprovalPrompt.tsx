import { useEffect, type CSSProperties } from 'react';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { HexPanel } from './hud/HexPanel';

/**
 * The operator's veto. Anything that sends, deletes, overwrites, moves, runs a
 * command or looks at the screen stops here. Escape denies; there is
 * deliberately no Enter-to-approve, so a stray keypress can't sign off.
 */
export function ApprovalPrompt() {
  const approvals = useStore((s) => s.approvals);
  const removeApproval = useStore((s) => s.removeApproval);
  const info = useStore((s) => s.agentsInfo);
  const req = approvals[0];

  const answer = (approved: boolean, all = false) => {
    if (!req) return;
    removeApproval(req.id);
    void ultron.approvals.respond(req.id, approved, all);
  };

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.id]);

  if (!req) return null;
  const agent = info.find((a) => a.id === req.agent);

  return (
    <div className="approval" role="alertdialog" aria-modal="true" aria-label="Ultron needs your approval">
      <HexPanel className="approval__card" title="Authorization required" meta={agent ? agent.title.toUpperCase() : 'AGENT'} scroll={false}>
        <div className="approval__who">
          <span className="agent-tag" style={{ color: agent?.color ?? 'var(--cyan)' } as CSSProperties}>
            {(agent?.name ?? req.agent).toUpperCase()}
          </span>
          wants to:
        </div>
        <div className="approval__title">{req.title}</div>
        <div className="approval__detail">{req.detail}</div>
        <div className="approval__actions">
          {approvals.length > 1 && <span className="approval__queue">+{approvals.length - 1} more waiting</span>}
          <button className="hud-btn hud-btn--danger" onClick={() => answer(false)}>Deny</button>
          <button className="hud-btn" onClick={() => answer(true, true)} title="Approve this and any more of the same kind for the rest of this task">
            Approve all like this
          </button>
          <button className="hud-btn hud-btn--active" onClick={() => answer(true)} autoFocus={false}>Approve</button>
        </div>
      </HexPanel>
    </div>
  );
}

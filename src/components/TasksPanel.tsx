import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { dueLabel } from '../services/format';
import { playClick, playConfirm } from '../services/sfx';
import type { Task } from '../types';

type Filter = 'open' | 'today' | 'done';

function TaskRow({ task }: { task: Task }) {
  const due = dueLabel(task);
  const reminderSet = task.remindAt && !task.done && !task.notifiedAt;
  return (
    <div className={`task-row ${task.done ? 'task-row--done' : ''}`}>
      <button
        className="task-row__check"
        aria-label={task.done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        title={task.recurrence && !task.done ? 'Done for this time - it rolls to the next occurrence' : undefined}
        onClick={() => { playClick(); void (task.done ? ultron.tasks.reopen(task.id) : ultron.tasks.complete(task.id)); }}
      >
        {task.done && <span className="task-row__check-mark" />}
      </button>
      <div style={{ minWidth: 0 }}>
        <div className="task-row__title">{task.title}</div>
        <div className="task-row__meta">
          {due && <span className={`task-chip task-chip--${due.tone}`}>{due.text}</span>}
          {task.priority === 'high' && <span className="task-chip task-chip--high">HIGH</span>}
          {task.recurrence && <span className="task-chip">repeats {task.recurrence}</span>}
          {reminderSet && (
            <span className="task-chip" title={new Date(task.remindAt!).toLocaleString('en-CA')}>
              reminder {new Date(task.remindAt!).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {task.source === 'ultron' && <span className="task-chip">via Ultron</span>}
        </div>
        {task.notes && <div className="task-chip" style={{ marginTop: 3, whiteSpace: 'pre-wrap' }}>{task.notes}</div>}
      </div>
      <div className="task-row__actions">
        {!task.done && (
          <button className="mini-btn" title="Remind me again in an hour" onClick={() => void ultron.tasks.snooze(task.id, 60)}>+1H</button>
        )}
        <button className="mini-btn mini-btn--danger" aria-label={`Delete ${task.title}`} onClick={() => void ultron.tasks.remove(task.id)}>DEL</button>
      </div>
    </div>
  );
}

export function TasksPanel() {
  const tasks = useStore((s) => s.tasks);
  const d2l = useStore((s) => s.d2l);
  const setOverlay = useStore((s) => s.setOverlay);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('open');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const flash = (text: string, bad = false) => {
    setMsg({ text, bad });
    setTimeout(() => setMsg(null), 4000);
  };

  const shown = useMemo(() => {
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    if (filter === 'done') return tasks.filter((t) => t.done).slice(0, 50);
    if (filter === 'today') return tasks.filter((t) => !t.done && t.due && Date.parse(t.due) <= endOfDay.getTime());
    return tasks.filter((t) => !t.done);
  }, [tasks, filter]);

  const openCount = tasks.filter((t) => !t.done).length;
  const overdue = tasks.filter((t) => !t.done && t.due && Date.parse(t.due) < Date.now()).length;

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    const res = await ultron.tasks.add({ title: text });
    if (res.ok && res.task) {
      playConfirm();
      setDraft('');
      const due = dueLabel(res.task);
      flash(due ? `Added - ${due.text}` : 'Added (no due time)');
    } else {
      flash(res.error ?? 'Could not add that.', true);
    }
  };

  const syncD2L = async () => {
    setSyncing(true);
    const res = await ultron.d2l.sync();
    setSyncing(false);
    if (!res.ok) flash(res.error ?? 'D2L sync failed.', true);
    else flash(res.added?.length ? `Imported ${res.added.length} from D2L` : 'D2L is already up to date');
  };

  return (
    <>
      <div className="task-add">
        <input
          className="hud-input"
          value={draft}
          placeholder='e.g. "math homework tomorrow 7pm"'
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          aria-label="New task"
        />
        <button className="hud-btn" onClick={() => void add()} disabled={!draft.trim()}>Add</button>
      </div>
      <div className="task-filters">
        {(['open', 'today', 'done'] as Filter[]).map((f) => (
          <span key={f} className={`chip ${filter === f ? '' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => setFilter(f)}>
            {f === 'open' ? `OPEN ${openCount}` : f.toUpperCase()}
          </span>
        ))}
        {overdue > 0 && <span className="chip chip--bad">{overdue} OVERDUE</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          {d2l?.signedIn ? (
            <button className="mini-btn" onClick={() => void syncD2L()} disabled={syncing} title="Copy upcoming D2L due dates into your tasks, with reminders the evening before">
              {syncing ? 'SYNCING...' : 'IMPORT D2L'}
            </button>
          ) : (
            <button className="mini-btn" onClick={() => setOverlay({ kind: 'apps' })} title="Sign in to D2L from the Apps panel">D2L SIGN-IN</button>
          )}
          {filter === 'done' && tasks.some((t) => t.done) && (
            <button className="mini-btn" onClick={() => void ultron.tasks.clearDone()}>CLEAR</button>
          )}
        </span>
      </div>
      {msg && (
        <div className={`alert-strip ${msg.bad ? 'alert-strip--warn' : 'alert-strip--info'}`}>
          <span className="dot" />{msg.text}
        </div>
      )}
      <div className="panel-body" style={{ flex: '1 1 auto' }}>
        {shown.length === 0 ? (
          <div className="empty-note">
            {filter === 'done'
              ? 'Nothing finished yet.'
              : filter === 'today'
                ? 'Nothing due today.'
                : 'No open tasks. Add one above, or just tell Ultron - "remind me to study for the math quiz Thursday at 6pm" - and Chronos schedules it with a reminder.'}
          </div>
        ) : (
          shown.map((t) => <TaskRow key={t.id} task={t} />)
        )}
      </div>
    </>
  );
}

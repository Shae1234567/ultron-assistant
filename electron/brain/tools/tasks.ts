import * as tasks from '../../tasks';
import { S, obj, str, type AgentTool } from './types';

function brief(t: tasks.Task) {
  return {
    id: t.id,
    title: t.title,
    due: t.due,
    remind_at: t.remindAt,
    all_day: t.allDay,
    priority: t.priority,
    repeats: t.recurrence,
    done: t.done,
    notes: t.notes || undefined,
    summary: tasks.describeTask(t),
  };
}

const priorityOf = (v: string): tasks.Priority | undefined => (v === 'low' || v === 'high' || v === 'normal' ? v : undefined);
const repeatOf = (v: string): tasks.Recurrence | undefined =>
  v === 'daily' || v === 'weekdays' || v === 'weekly' ? v : v === 'none' ? null : undefined;

export const taskTools: AgentTool[] = [
  {
    name: 'task_add',
    owner: 'chronos',
    description: 'Add a task to the operator\'s task list, with an optional due time and reminder. Times can be natural language ("tomorrow 7pm", "friday", "in 2 hours") or ISO. A timed task reminds at its due time by default; a date-only task reminds at 9am that day.',
    parameters: obj({
      title: S('What needs doing, short and specific'),
      due: S('When it is due, e.g. "tomorrow at 7pm"'),
      remind_at: S('When to remind, if different from the due time, e.g. "tomorrow 6:30pm"'),
      notes: S('Extra detail'),
      priority: S('low, normal or high', { enum: ['low', 'normal', 'high'] }),
      repeat: S('none, daily, weekdays or weekly', { enum: ['none', 'daily', 'weekdays', 'weekly'] }),
    }, ['title']),
    label: (a) => `add task "${str(a, 'title')}"${str(a, 'due') ? ` (${str(a, 'due')})` : ''}`,
    run: async (args) => {
      const t = tasks.addTask({
        title: str(args, 'title'),
        due: str(args, 'due') || undefined,
        remindAt: str(args, 'remind_at') || undefined,
        notes: str(args, 'notes') || undefined,
        priority: priorityOf(str(args, 'priority')),
        recurrence: repeatOf(str(args, 'repeat')) ?? null,
        source: 'ultron',
      });
      return { ok: true, task: brief(t) };
    },
  },
  {
    name: 'task_list',
    owner: 'chronos',
    description: 'List the operator\'s tasks.',
    parameters: obj({ filter: S('open (default), today, overdue, done or all', { enum: ['open', 'today', 'overdue', 'done', 'all'] }) }),
    label: (a) => `list ${str(a, 'filter', 'open')} tasks`,
    run: async (args) => {
      const f = str(args, 'filter', 'open') as 'open' | 'today' | 'overdue' | 'done' | 'all';
      const list = tasks.listTasks(['open', 'today', 'overdue', 'done', 'all'].includes(f) ? f : 'open');
      return { now: new Date().toISOString(), count: list.length, tasks: list.slice(0, 40).map(brief) };
    },
  },
  {
    name: 'task_complete',
    owner: 'chronos',
    description: 'Mark a task done (by id or by its title). Repeating tasks roll forward to their next occurrence.',
    parameters: obj({ task: S('Task id or title') }, ['task']),
    label: (a) => `complete "${str(a, 'task')}"`,
    run: async (args) => {
      const t = tasks.completeTask(str(args, 'task'));
      return t ? { ok: true, task: brief(t) } : { error: 'No open task matches that.' };
    },
  },
  {
    name: 'task_update',
    owner: 'chronos',
    description: 'Change a task\'s title, due time, reminder, priority, notes or repeat.',
    parameters: obj({
      task: S('Task id or current title'),
      title: S('New title'),
      due: S('New due time (natural language or ISO); empty string clears it'),
      remind_at: S('New reminder time; empty string clears it'),
      priority: S('low, normal or high', { enum: ['low', 'normal', 'high'] }),
      notes: S('Replace notes'),
      repeat: S('none, daily, weekdays or weekly', { enum: ['none', 'daily', 'weekdays', 'weekly'] }),
    }, ['task']),
    label: (a) => `update "${str(a, 'task')}"`,
    run: async (args) => {
      const patch: tasks.TaskPatch = {};
      if ('title' in args) patch.title = str(args, 'title');
      if ('due' in args) patch.due = str(args, 'due') || null;
      if ('remind_at' in args) patch.remindAt = str(args, 'remind_at') || null;
      if ('notes' in args) patch.notes = str(args, 'notes');
      const p = priorityOf(str(args, 'priority'));
      if (p) patch.priority = p;
      const r = repeatOf(str(args, 'repeat'));
      if (r !== undefined) patch.recurrence = r;
      const t = tasks.updateTask(str(args, 'task'), patch);
      return t ? { ok: true, task: brief(t) } : { error: 'No open task matches that.' };
    },
  },
  {
    name: 'task_remove',
    owner: 'chronos',
    description: 'Delete a task from the list entirely (use task_complete when it was done).',
    parameters: obj({ task: S('Task id or title') }, ['task']),
    label: (a) => `remove "${str(a, 'task')}"`,
    run: async (args) => {
      const t = tasks.removeTask(str(args, 'task'));
      return t ? { ok: true, removed: t.title } : { error: 'No task matches that.' };
    },
  },
  {
    name: 'current_time',
    owner: 'chronos',
    description: 'The exact current date, time and weekday on the operator\'s PC.',
    parameters: obj({}),
    label: () => 'check the time',
    run: async () => {
      const now = new Date();
      const offsetMin = -now.getTimezoneOffset();
      const sign = offsetMin >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMin);
      return {
        iso: now.toISOString(),
        local: now.toLocaleString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        utc_offset: `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`,
      };
    },
  },
];

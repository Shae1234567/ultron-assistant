import * as chrono from 'chrono-node';
import { readDoc, writeDoc } from './store';
import { newId } from './brain/types';

/**
 * The operator's task list and reminder scheduler. Reminders fire from this
 * process (Ultron lives in the tray, so it's running whenever the PC is),
 * which replaces the old Task Scheduler approach whose relaunch flag nothing
 * ever handled - those reminders never actually fired.
 */

export type Priority = 'low' | 'normal' | 'high';
export type Recurrence = 'daily' | 'weekdays' | 'weekly' | null;

export interface Task {
  id: string;
  title: string;
  notes: string;
  due: string | null;
  remindAt: string | null;
  allDay: boolean;
  priority: Priority;
  recurrence: Recurrence;
  done: boolean;
  doneAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'operator' | 'ultron';
}

interface TaskDoc { v: 1; tasks: Task[] }

export interface WhenParse { date: Date; hasTime: boolean; matched: string }

const FILE = 'tasks.json';
let tasks: Task[] | null = null;
let onChange: ((all: Task[]) => void) | null = null;
let onFire: ((task: Task, missed: boolean) => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function load(): Task[] {
  if (tasks) return tasks;
  const doc = readDoc<TaskDoc>(FILE, { v: 1, tasks: [] });
  tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  return tasks;
}

function persist(): void {
  writeDoc(FILE, { v: 1, tasks: load() });
  onChange?.(listTasks('all'));
}

export function parseWhen(text: string, ref = new Date()): WhenParse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Full timestamps only - a bare "2026-09-25" parses as UTC midnight, which
  // is the previous evening in the Americas. chrono reads date-only strings as local.
  const iso = Date.parse(trimmed);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !Number.isNaN(iso)) {
    return { date: new Date(iso), hasTime: true, matched: trimmed };
  }
  const results = chrono.parse(trimmed, ref, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  return { date: r.start.date(), hasTime: r.start.isCertain('hour'), matched: r.text };
}

function atHour(d: Date, h: number, m = 0): Date {
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
}

function stripWhen(title: string, matched: string): string {
  return title
    .replace(matched, ' ')
    .replace(/\b(remind me to|remind me|at|on|by|for|due)\s*$/i, ' ')
    .replace(/^\s*(remind me to|remind me)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.-]+$/, '')
    .trim();
}

export interface AddTaskInput {
  title: string;
  due?: string;
  remindAt?: string;
  notes?: string;
  priority?: Priority;
  recurrence?: Recurrence;
  source?: 'operator' | 'ultron';
}

export function addTask(input: AddTaskInput): Task {
  let title = input.title.trim();
  let when = input.due ? parseWhen(input.due) : null;
  if (!when) {
    const inTitle = parseWhen(title);
    if (inTitle) {
      const stripped = stripWhen(title, inTitle.matched);
      if (stripped.length >= 2) {
        when = inTitle;
        title = stripped;
      }
    }
  }
  if (!title) throw new Error('A task needs a title.');
  const now = new Date();
  let due: Date | null = null;
  let remind: Date | null = null;
  let allDay = false;
  if (when) {
    if (when.hasTime) {
      due = when.date;
      remind = when.date;
    } else {
      allDay = true;
      due = atHour(when.date, 23, 59);
      remind = atHour(when.date, 9);
    }
  }
  if (input.remindAt) {
    const r = parseWhen(input.remindAt);
    if (r) remind = r.hasTime ? r.date : atHour(r.date, 9);
  }
  if (remind && remind.getTime() < now.getTime() - 60_000) remind = null;

  const task: Task = {
    id: newId('task'),
    title: title.slice(0, 200),
    notes: (input.notes ?? '').slice(0, 2000),
    due: due ? due.toISOString() : null,
    remindAt: remind ? remind.toISOString() : null,
    allDay,
    priority: input.priority ?? 'normal',
    recurrence: input.recurrence ?? null,
    done: false,
    doneAt: null,
    notifiedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: input.source ?? 'operator',
  };
  load().push(task);
  persist();
  return task;
}

export function listTasks(filter: 'open' | 'all' | 'today' | 'overdue' | 'done' = 'open'): Task[] {
  const now = Date.now();
  const endOfDay = atHour(new Date(), 23, 59).getTime();
  const all = [...load()];
  const sorted = all.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.due ? Date.parse(a.due) : Infinity;
    const bd = b.due ? Date.parse(b.due) : Infinity;
    if (ad !== bd) return ad - bd;
    const rank = { high: 0, normal: 1, low: 2 };
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
    return a.createdAt < b.createdAt ? -1 : 1;
  });
  switch (filter) {
    case 'all': return sorted;
    case 'done': return sorted.filter((t) => t.done);
    case 'today': return sorted.filter((t) => !t.done && t.due && Date.parse(t.due) <= endOfDay);
    case 'overdue': return sorted.filter((t) => !t.done && t.due && Date.parse(t.due) < now);
    default: return sorted.filter((t) => !t.done);
  }
}

/** Finds a task by id, or by a case-insensitive title match (the model often only knows the title). */
export function findTask(idOrTitle: string): Task | undefined {
  const all = load();
  const byId = all.find((t) => t.id === idOrTitle);
  if (byId) return byId;
  const q = idOrTitle.trim().toLowerCase();
  const open = all.filter((t) => !t.done);
  return open.find((t) => t.title.toLowerCase() === q)
    ?? open.find((t) => t.title.toLowerCase().includes(q))
    ?? open.find((t) => q.includes(t.title.toLowerCase()));
}

function nextOccurrence(d: Date, rec: Exclude<Recurrence, null>): Date {
  const x = new Date(d);
  do {
    x.setDate(x.getDate() + (rec === 'weekly' ? 7 : 1));
  } while (rec === 'weekdays' && (x.getDay() === 0 || x.getDay() === 6));
  return x;
}

function rollForward(t: Task): void {
  if (!t.recurrence) return;
  const base = t.remindAt ? new Date(t.remindAt) : t.due ? new Date(t.due) : new Date();
  let next = nextOccurrence(base, t.recurrence);
  while (next.getTime() < Date.now()) next = nextOccurrence(next, t.recurrence);
  const shift = next.getTime() - base.getTime();
  if (t.remindAt) t.remindAt = new Date(Date.parse(t.remindAt) + shift).toISOString();
  if (t.due) t.due = new Date(Date.parse(t.due) + shift).toISOString();
  t.notifiedAt = null;
}

export function completeTask(idOrTitle: string): Task | null {
  const t = findTask(idOrTitle);
  if (!t) return null;
  const now = new Date().toISOString();
  if (t.recurrence) {
    rollForward(t);
  } else {
    t.done = true;
    t.doneAt = now;
  }
  t.updatedAt = now;
  persist();
  return t;
}

export function reopenTask(id: string): Task | null {
  const t = load().find((x) => x.id === id);
  if (!t) return null;
  t.done = false;
  t.doneAt = null;
  t.updatedAt = new Date().toISOString();
  persist();
  return t;
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  due?: string | null;
  remindAt?: string | null;
  priority?: Priority;
  recurrence?: Recurrence;
}

export function updateTask(idOrTitle: string, patch: TaskPatch): Task | null {
  const t = findTask(idOrTitle);
  if (!t) return null;
  if (patch.title?.trim()) t.title = patch.title.trim().slice(0, 200);
  if (patch.notes !== undefined) t.notes = patch.notes.slice(0, 2000);
  if (patch.priority) t.priority = patch.priority;
  if (patch.recurrence !== undefined) t.recurrence = patch.recurrence;
  if (patch.due !== undefined) {
    if (patch.due === null || patch.due === '') {
      t.due = null;
      t.allDay = false;
    } else {
      const w = parseWhen(patch.due);
      if (w) {
        t.allDay = !w.hasTime;
        t.due = (w.hasTime ? w.date : atHour(w.date, 23, 59)).toISOString();
        if (patch.remindAt === undefined) {
          t.remindAt = (w.hasTime ? w.date : atHour(w.date, 9)).toISOString();
          t.notifiedAt = null;
        }
      }
    }
  }
  if (patch.remindAt !== undefined) {
    if (!patch.remindAt) t.remindAt = null;
    else {
      const r = parseWhen(patch.remindAt);
      if (r) t.remindAt = (r.hasTime ? r.date : atHour(r.date, 9)).toISOString();
    }
    t.notifiedAt = null;
  }
  t.updatedAt = new Date().toISOString();
  persist();
  return t;
}

export function snoozeTask(id: string, minutes: number): Task | null {
  const t = load().find((x) => x.id === id);
  if (!t) return null;
  t.remindAt = new Date(Date.now() + Math.max(1, minutes) * 60_000).toISOString();
  t.notifiedAt = null;
  t.updatedAt = new Date().toISOString();
  persist();
  return t;
}

export function removeTask(idOrTitle: string): Task | null {
  const all = load();
  const t = findTask(idOrTitle) ?? all.find((x) => x.id === idOrTitle);
  if (!t) return null;
  tasks = all.filter((x) => x.id !== t.id);
  persist();
  return t;
}

export function clearCompleted(): number {
  const all = load();
  const kept = all.filter((t) => !t.done);
  const removed = all.length - kept.length;
  if (removed) {
    tasks = kept;
    persist();
  }
  return removed;
}

function tick(): void {
  const now = Date.now();
  let changed = false;
  for (const t of load()) {
    if (t.done || !t.remindAt || t.notifiedAt) continue;
    const at = Date.parse(t.remindAt);
    if (Number.isNaN(at) || at > now) continue;
    const missed = now - at > 5 * 60_000;
    t.notifiedAt = new Date().toISOString();
    changed = true;
    // Anything missed by more than a day is stale - mark it seen without nagging.
    if (now - at < 24 * 3600_000) onFire?.({ ...t }, missed);
    if (t.recurrence) rollForward(t);
  }
  if (changed) persist();
}

export function startScheduler(handlers: { onChange: (all: Task[]) => void; onFire: (task: Task, missed: boolean) => void }): void {
  onChange = handlers.onChange;
  onFire = handlers.onFire;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 15_000);
  setTimeout(tick, 4000); // after the HUD has booted, so a missed reminder can be spoken
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function describeTask(t: Task): string {
  const parts = [t.title];
  if (t.due) {
    const d = new Date(t.due);
    parts.push(t.allDay
      ? `due ${d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : `due ${d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  }
  if (t.recurrence) parts.push(`repeats ${t.recurrence}`);
  if (t.priority !== 'normal') parts.push(`${t.priority} priority`);
  if (t.done) parts.push('done');
  return parts.join(' - ');
}

export function tasksMarkdown(): string {
  const open = listTasks('open');
  const done = listTasks('done').slice(0, 30);
  const line = (t: Task) => `- [${t.done ? 'x' : ' '}] ${describeTask(t)}${t.notes ? ` - ${t.notes.replace(/\n/g, ' ')}` : ''}`;
  return [
    '---',
    'type: tasks',
    `updated: ${new Date().toISOString()}`,
    '---',
    '# Tasks',
    '',
    '> Mirror of Ultron\'s task list. Edit tasks in Ultron - changes here are overwritten.',
    '',
    '## Open',
    ...(open.length ? open.map(line) : ['- (nothing open)']),
    '',
    '## Recently done',
    ...(done.length ? done.map(line) : ['- (none yet)']),
    '',
  ].join('\n');
}

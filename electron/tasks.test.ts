import { beforeEach, describe, expect, it, vi } from 'vitest';

const docs = new Map<string, unknown>();
vi.mock('./store', () => ({
  readDoc: (name: string, fallback: unknown) => (docs.has(name) ? structuredClone(docs.get(name)) : fallback),
  writeDoc: (name: string, data: unknown) => { docs.set(name, structuredClone(data)); },
}));

async function freshTasks() {
  vi.resetModules();
  docs.clear();
  return import('./tasks');
}

describe('parseWhen', () => {
  it('reads natural language relative to now', async () => {
    const { parseWhen } = await freshTasks();
    const ref = new Date(2026, 8, 24, 10, 0); // Thu 24 Sep 2026, 10:00 local
    const r = parseWhen('tomorrow at 7pm', ref)!;
    expect(r.hasTime).toBe(true);
    expect(r.date.getDate()).toBe(25);
    expect(r.date.getHours()).toBe(19);
  });

  it('keeps a bare date on the same local day (no UTC shift)', async () => {
    const { parseWhen } = await freshTasks();
    const r = parseWhen('2026-09-25')!;
    expect(r.hasTime).toBe(false);
    expect(r.date.getFullYear()).toBe(2026);
    expect(r.date.getMonth()).toBe(8);
    expect(r.date.getDate()).toBe(25);
  });

  it('accepts full ISO timestamps as timed', async () => {
    const { parseWhen } = await freshTasks();
    const r = parseWhen('2026-09-25T19:30:00.000Z')!;
    expect(r.hasTime).toBe(true);
    expect(r.date.toISOString()).toBe('2026-09-25T19:30:00.000Z');
  });

  it('returns null for text with no date', async () => {
    const { parseWhen } = await freshTasks();
    expect(parseWhen('buy shin guards')).toBeNull();
  });
});

describe('addTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 24, 10, 0));
  });

  it('pulls the time out of the title', async () => {
    const tasks = await freshTasks();
    const t = tasks.addTask({ title: 'math homework tomorrow at 7pm' });
    expect(t.title).toBe('math homework');
    const due = new Date(t.due!);
    expect(due.getDate()).toBe(25);
    expect(due.getHours()).toBe(19);
    expect(t.remindAt).toBe(t.due);
    expect(t.allDay).toBe(false);
  });

  it('strips a leading "remind me to"', async () => {
    const tasks = await freshTasks();
    const t = tasks.addTask({ title: 'remind me to call grandma on friday' });
    expect(t.title).toBe('call grandma');
    expect(t.allDay).toBe(true);
    const remind = new Date(t.remindAt!);
    expect(remind.getHours()).toBe(9);
    expect(remind.getDay()).toBe(5);
  });

  it('keeps a plain title when there is no date in it', async () => {
    const tasks = await freshTasks();
    const t = tasks.addTask({ title: 'buy new cleats' });
    expect(t.title).toBe('buy new cleats');
    expect(t.due).toBeNull();
    expect(t.remindAt).toBeNull();
  });

  it('rolls a repeating task forward instead of finishing it', async () => {
    const tasks = await freshTasks();
    const t = tasks.addTask({ title: 'stretch', due: 'today at 8pm', recurrence: 'daily' });
    const firstDue = Date.parse(t.due!);
    const after = tasks.completeTask(t.id)!;
    expect(after.done).toBe(false);
    expect(Date.parse(after.due!) - firstDue).toBe(24 * 3600_000);
  });

  it('finds tasks by partial title', async () => {
    const tasks = await freshTasks();
    tasks.addTask({ title: 'history essay outline' });
    expect(tasks.findTask('essay')?.title).toBe('history essay outline');
    expect(tasks.completeTask('essay outline')?.done).toBe(true);
    expect(tasks.listTasks('open')).toHaveLength(0);
  });
});

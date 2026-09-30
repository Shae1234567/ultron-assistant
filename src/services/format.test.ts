import { describe, expect, it } from 'vitest';
import { spokenDue } from './format';
import type { Task } from '../types';

const now = new Date(2026, 8, 25, 10, 0); // Fri Sep 25 2026, 10:00 local
const task = (due: Date, allDay = false) => ({ id: 't', title: 'x', due: due.toISOString(), allDay }) as Task;

describe('spokenDue', () => {
  it('counts down when it is close', () => {
    expect(spokenDue(task(new Date(2026, 8, 25, 10, 40)), now)).toBe('It\'s due in 40 minutes.');
  });

  it('says a missed time is in the past, with no doubled period after a.m.', () => {
    const line = spokenDue(task(new Date(2026, 8, 25, 9, 0)), now);
    expect(line.startsWith('It was due Friday')).toBe(true);
    expect(line.endsWith('..')).toBe(false);
  });

  it('names the right day for all-day tasks instead of always saying today', () => {
    expect(spokenDue(task(new Date(2026, 8, 25, 23, 59), true), now)).toBe('It\'s due today.');
    expect(spokenDue(task(new Date(2026, 8, 26, 23, 59), true), now)).toBe('It\'s due tomorrow.');
    expect(spokenDue(task(new Date(2026, 8, 23, 23, 59), true), now)).toMatch(/^It was due Wednesday/);
  });
});

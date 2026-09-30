import type { Task } from '../types';

export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "overdue 2h", "in 40m", "today 7:00 PM", "tomorrow", "Fri Sep 26" - with an urgency tone for colouring. */
export function dueLabel(t: Task, now = new Date()): { text: string; tone: 'late' | 'soon' | 'due' } | null {
  if (!t.due) return null;
  const due = new Date(t.due);
  const diffMin = Math.round((due.getTime() - now.getTime()) / 60_000);
  const time = due.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (!t.done && diffMin < 0) {
    const late = -diffMin;
    const txt = late < 60 ? `${late}m` : late < 1440 ? `${Math.round(late / 60)}h` : `${Math.round(late / 1440)}d`;
    return { text: `overdue ${txt}`, tone: 'late' };
  }
  if (sameDay(due, now)) {
    if (!t.allDay && diffMin < 120) return { text: `in ${diffMin}m`, tone: 'soon' };
    return { text: t.allDay ? 'today' : `today ${time}`, tone: 'soon' };
  }
  if (sameDay(due, tomorrow)) return { text: t.allDay ? 'tomorrow' : `tomorrow ${time}`, tone: 'due' };
  const day = due.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  return { text: t.allDay ? day : `${day} ${time}`, tone: 'due' };
}

/** The due part of a spoken reminder: "It's due in 40 minutes.", "It was due Friday 9:00 a.m." */
export function spokenDue(t: Task, now = new Date()): string {
  if (!t.due) return '';
  const due = new Date(t.due);
  const diffMin = Math.round((due.getTime() - now.getTime()) / 60_000);
  if (t.allDay) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (sameDay(due, now)) return 'It\'s due today.';
    if (sameDay(due, tomorrow)) return 'It\'s due tomorrow.';
    const day = due.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
    return diffMin < 0 ? `It was due ${day}.` : `It's due ${day}.`;
  }
  if (diffMin > 1 && diffMin < 180) return `It's due in ${diffMin} minutes.`;
  if (diffMin >= -1 && diffMin <= 1) return 'It\'s due now.';
  // en-CA writes "9:00 a.m." - drop that last period so the sentence doesn't end in "..".
  const when = due.toLocaleString('en-CA', { weekday: 'long', hour: 'numeric', minute: '2-digit' }).replace(/\.$/, '');
  return diffMin < 0 ? `It was due ${when}.` : `It's due ${when}.`;
}

export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.round((now - ms) / 60_000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 1440)}d ago`;
}

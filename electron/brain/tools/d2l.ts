import * as d2l from '../../d2l';
import { N, S, num, obj, str, type AgentTool } from './types';

const signInHint = 'Not signed in to D2L. The operator needs to open Apps and press "Sign in to D2L" (they log in themselves; Ultron never sees the password).';

async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (!d2l.isAuthError(e)) return { error: e instanceof Error ? e.message : String(e) };
    // The session may just have lapsed - status() re-establishes it quietly through school SSO when it can.
    if ((await d2l.status()).signedIn) {
      try {
        return await fn();
      } catch (again) {
        return { error: d2l.isAuthError(again) ? signInHint : again instanceof Error ? again.message : String(again) };
      }
    }
    return { error: signInHint };
  }
}

function when(iso: string | null): string {
  if (!iso) return 'no due date';
  return new Date(iso).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const d2lTools: AgentTool[] = [
  {
    name: 'd2l_due',
    owner: 'hermes',
    description: 'What is due on D2L Brightspace (school): assignments, quizzes and content with due dates in the next N days, across all courses or one course.',
    parameters: obj({ days_ahead: N('How many days ahead (default 14)'), course: S('Optional part of a course name, e.g. "math"') }),
    label: (a) => `D2L due (${num(a, 'days_ahead', 14)} days${str(a, 'course') ? `, ${str(a, 'course')}` : ''})`,
    run: async (args) => guarded(async () => {
      const items = await d2l.dueItems(Math.min(num(args, 'days_ahead', 14), 60), str(args, 'course') || undefined);
      return {
        count: items.length,
        items: items.slice(0, 40).map((i) => ({ course: i.course, name: i.name, type: i.type, due: when(i.due), due_iso: i.due, completed: i.completed })),
      };
    }),
  },
  {
    name: 'd2l_overdue',
    owner: 'hermes',
    description: 'Overdue items on D2L Brightspace across courses.',
    parameters: obj({}),
    label: () => 'D2L overdue',
    run: async () => guarded(async () => {
      const items = await d2l.overdue();
      return { count: items.length, items: items.map((i) => ({ course: i.course, name: i.name, was_due: when(i.due) })) };
    }),
  },
  {
    name: 'd2l_grades',
    owner: 'hermes',
    description: 'The operator\'s grades on D2L Brightspace, per course (graded items and final grade where visible).',
    parameters: obj({ course: S('Optional part of a course name') }),
    label: (a) => `D2L grades${str(a, 'course') ? ` (${str(a, 'course')})` : ''}`,
    run: async (args) => guarded(async () => ({ courses: await d2l.grades(str(args, 'course') || undefined) })),
  },
  {
    name: 'd2l_announcements',
    owner: 'hermes',
    description: 'Recent course announcements (news) from teachers on D2L Brightspace.',
    parameters: obj({ course: S('Optional part of a course name'), limit: N('Default 8') }),
    label: (a) => `D2L announcements${str(a, 'course') ? ` (${str(a, 'course')})` : ''}`,
    run: async (args) => guarded(async () => ({ announcements: await d2l.announcements(str(args, 'course') || undefined, num(args, 'limit', 8)) })),
  },
  {
    name: 'd2l_courses',
    owner: 'hermes',
    description: 'The operator\'s D2L Brightspace courses.',
    parameters: obj({}),
    label: () => 'D2L courses',
    run: async () => guarded(async () => ({ courses: await d2l.courses() })),
  },
  {
    name: 'd2l_sync_tasks',
    owner: 'chronos',
    description: 'Copy upcoming D2L due dates into Ultron\'s task list with reminders (the evening before), skipping ones already added.',
    parameters: obj({ days_ahead: N('How far ahead (default 21)') }),
    label: () => 'sync D2L deadlines into tasks',
    run: async (args) => guarded(async () => d2l.syncToTasks(Math.min(num(args, 'days_ahead', 21), 60))),
  },
];

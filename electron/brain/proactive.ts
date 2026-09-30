import { getSettings } from '../store';
import { listTasks, describeTask } from '../tasks';
import { previousJournalTail, profileForPrompt } from '../memory/vault';
import * as d2l from '../d2l';
import { memoryBlock, persona } from './prompts';
import { once } from './team';

export type GreetKind = 'boot' | 'wake' | 'checkin';

function timeOfDay(d = new Date()): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'late night';
}

async function schoolSoon(): Promise<string> {
  try {
    const due = await Promise.race([
      d2l.dueItems(3),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    const open = due.filter((i) => !i.completed).slice(0, 4);
    return open.length
      ? `D2L items due in the next 3 days: ${open.map((i) => `${i.name} (${i.course}, ${i.due ? new Date(i.due).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'no time'})`).join('; ')}.`
      : '';
  } catch {
    return '';
  }
}

/** A short spoken opener generated fresh each time - never a canned line. */
export async function greet(kind: GreetKind): Promise<string> {
  const s = getSettings();
  const today = listTasks('today').slice(0, 5).map(describeTask);
  const overdue = listTasks('overdue').slice(0, 3).map(describeTask);
  const last = kind === 'boot' ? previousJournalTail(1400) : null;
  const school = kind === 'checkin' ? '' : await schoolSoon();

  const mode = {
    boot: 'PROACTIVE GREETING MODE - you are speaking FIRST, unprompted, as the app starts. Greet the operator naturally for the time of day. Keep the whole thing under 35 words.',
    wake: 'The operator just said your wake word to summon you. Greet them briefly like you just walked in. Under 20 words.',
    checkin: 'PROACTIVE CHECK-IN - you are speaking first after a long quiet stretch. One useful, specific nudge or question. Under 25 words.',
  }[kind];

  const facts = [
    `- It is ${timeOfDay()} for the operator.`,
    today.length ? `- Tasks due today: ${today.join('; ')}.` : '- Nothing is on the task list for today.',
    overdue.length ? `- Overdue tasks: ${overdue.join('; ')}.` : '',
    school ? `- ${school}` : '',
    last ? `- Last conversation (${last.date}), only if genuinely useful:\n${last.text}` : '',
  ].filter(Boolean).join('\n');

  const system = [
    persona(s, memoryBlock(profileForPrompt(1400), [])),
    '',
    mode,
    `FACTS YOU MAY MENTION (nothing else):\n${facts}`,
    'Hard rule: the profile above is background for tone only - it is NOT news. Do not claim anything is happening,',
    'due, scheduled or planned today or tomorrow (practices, games, homework, tests, events) unless it is listed under',
    'FACTS. If FACTS has nothing due, just greet them and ask what they want to do.',
    'If something is due soon, lead with that - it is the most useful thing you can say.',
    'End with one short, specific question inviting them to say what they want to work on (not a generic "how can I help").',
    'Output only the words you will say - no labels, quotes or stage directions.',
  ].join('\n');

  return once({ system, user: 'Speak now.', tier: 'main', temperature: 0.5 });
}

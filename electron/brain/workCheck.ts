/**
 * Small models "finish" jobs in words: "I typed the code, clicked Run and
 * the preview shows a big red heading" - when the browser log says typing
 * failed and nothing was ever run (real reports from testing). Before a
 * builder's report counts, it is checked against what it actually did: its
 * browser moves (Daedalus), or its create/send/edit actions in the operator's
 * apps (Hermes).
 */

export interface WorkEntry {
  /** Tool name; a changing app action is logged as "apps_run_action:write". */
  tool: string;
  ok: boolean;
  /** What it looked like in the activity feed: "type "<h1>..." into [14]". */
  label?: string;
}

export type WorkKind = 'browser' | 'apps';

export interface WorkDoubt {
  /** no_edits: nothing was made at all. no_action: app data described with no app action behind it.
      unchecked: work happened, but the result described was never looked at. */
  kind: 'no_edits' | 'no_action' | 'unchecked';
  message: string;
}

/* What actually makes something. For the browser: typing and drawing - keys, choices and clicks only count as
   "something changed since you last looked". In apps: an action that creates, sends or edits. */
const MAKES: Record<WorkKind, Set<string>> = {
  browser: new Set(['browser_type', 'browser_mouse']),
  apps: new Set(['apps_run_action:write']),
};
const CHANGES = new Set(['browser_type', 'browser_mouse', 'browser_press', 'browser_select', 'browser_click']);
const LOOKS = new Set(['browser_read', 'browser_look', 'browser_find', 'browser_wait']);

const BUILT = /\b(built|created|made|typed|entered|added|wrote|written|inserted|pasted|filled|drew|drawn|designed|edited)\b/i;
const DONE_IN_APPS = /\b(created|made|wrote|written|added|inserted|filled|sent|scheduled|shared|uploaded|updated|posted|booked|invited|saved|drafted|edited|renamed|moved|replied|forwarded)\b/i;
// "I ran the action and got a count of 12" - with no action in the log (a live test, 26 Sep 2026).
const READ_IN_APPS = /\b(ran|fetched|checked|got|found|counted|pulled|retrieved|listed|searched|looked up|read)\b|\byou have\b|\bthere (are|is|were)\b/i;
// D2L's own tools read real data too - leaving them out sent a correct D2L answer back for a redo (live test).
const ANY_APP_ACTION = new Set(['apps_run_action', 'apps_run_action:write', 'd2l_due', 'd2l_overdue', 'd2l_grades', 'd2l_announcements', 'd2l_courses', 'telegram_recent_chats',
  'discord_servers', 'discord_server_info', 'discord_read_messages', 'discord_members']);
const SHOWS = /\b(shows?|showing|displays?|displaying|renders?|rendered|appears?|confirm(s|ed)?)\b/i;
const NEGATED = /\b(not|never|no|nothing|unable|failed|fails|cannot)\b|n't\b/i;

const NOTHING_MADE: Record<WorkKind, string> = {
  browser: 'Your browser log shows NO successful typing or drawing - nothing on the site was made, whatever this report says. Do the work now: browser_type with the editor or field number and the whole text in one call. Or report honestly what failed and what is left.',
  apps: 'Your action log shows NO successful create, send or edit in the apps - nothing was made or changed, whatever this report says. Do it now: find the action with apps_find_actions, then run it with apps_run_action. Or report honestly what failed and what is left.',
};

/** Sentences (and clauses after "but") that claim something happened - "could not type" is not a claim. */
function claims(report: string, re: RegExp): boolean {
  return report
    .split(/(?<=[.!?;])\s+|\n+|,?\s+but\s+/i)
    .some((part) => re.test(part) && !NEGATED.test(part));
}

function lastOk(log: WorkEntry[], tools: Set<string>): number {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].ok && tools.has(log[i].tool)) return i;
  return -1;
}

/** Why the report can't be trusted yet, or null when the log backs it up. */
export function checkWork(report: string, log: WorkEntry[], kind: WorkKind = 'browser'): WorkDoubt | null {
  const made = lastOk(log, MAKES[kind]);
  if (made < 0 && claims(report, kind === 'apps' ? DONE_IN_APPS : BUILT)) {
    return { kind: 'no_edits', message: NOTHING_MADE[kind] };
  }
  if (kind === 'apps' && lastOk(log, ANY_APP_ACTION) < 0 && claims(report, READ_IN_APPS)) {
    return {
      kind: 'no_action',
      message: 'Your action log shows NO successful app action - nothing was read from the app, so any numbers or details in this report are made up. Run the action now (apps_find_actions, then apps_run_action) and report what it returns - or say honestly that you could not.',
    };
  }
  // Only a browser has "a result on screen" that can go unchecked.
  if (kind === 'browser' && made >= 0 && claims(report, SHOWS) && lastOk(log, LOOKS) < lastOk(log, CHANGES)) {
    return {
      kind: 'unchecked',
      message: 'You describe what the page shows, but you have not checked it since your last change. Look now with browser_read (it includes embedded previews) or browser_look, and report only what it actually shows.',
    };
  }
  return null;
}

/** The action log as one line - what the synthesis gets instead of a report that can't be trusted. */
export function workSummary(log: WorkEntry[], max = 24): string {
  if (!log.length) return 'nothing';
  const shown = log.slice(-max).map((e) => `${e.label ?? e.tool}${e.ok ? '' : ' (FAILED)'}`);
  return (log.length > max ? `...${log.length - max} earlier steps; ` : '') + shown.join('; ');
}

/** True when making actually succeeded - the difference between "built" and "tried". */
export function madeSomething(log: WorkEntry[], kind: WorkKind = 'browser'): boolean {
  return lastOk(log, MAKES[kind]) >= 0;
}

/**
 * "I see the editors are blank. Let me fill them... I'll start by typing into
 * the HTML editor." - a small model announcing its next step instead of
 * taking it (a real "final report" from testing).
 */
export function announcesStep(text: string): boolean {
  const t = text.trim();
  // A tool call written out as text - "[Called apps_find_actions {...}]" - instead of made (a live "answer").
  if (/\[called \w+|^\s*\w+_\w+\s*[({]|"(name|tool)"\s*:\s*"\w+_\w+"/im.test(t)) return true;
  if (!t || t.length > 700 || /\bREPORT\b/.test(t)) return false;
  const tail = t.split(/(?<=[.!?])\s+/).slice(-2).join(' ');
  return /\b(let me|let's|i'll|i will|i am going to|i'm going to|next,? i|now i)\b/i.test(tail);
}

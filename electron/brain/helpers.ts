/**
 * Helper sub-agents: any specialist can build its own small crew for a job -
 * "one scout per platform", "one reader per folder" - each with a name, a
 * role, a task and a set of skills. Helpers run in parallel with their own
 * browser tabs, share the team blackboard, and report back to the agent that
 * made them. They can't make helpers of their own, and they only read: any
 * change to files or apps goes back through their parent.
 */

export interface HelperSpec {
  name: string;
  role: string;
  task: string;
  skills: string[];
  tools: string[];
}

export const SKILL_PACKS: Record<string, string[]> = {
  browse: ['web_search', 'read_webpage', 'browser_open', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_read', 'browser_find', 'browser_links', 'browser_look'],
  research: ['deep_research', 'encyclopedia_lookup', 'youtube_search', 'on_this_day'],
  memory: ['memory_search', 'memory_read_note'],
  math: ['calculate'],
  files: ['list_folder', 'read_file', 'search_files', 'file_info'],
  apps: ['apps_connected', 'apps_find_actions', 'apps_run_action'],
};

/** Packs every agent may hand out - so even Athena or Chronos can send a scout to the web. */
const OPEN_PACKS = new Set(['browse', 'research', 'memory', 'math']);
/** Packs a parent may only hand out if it has the capability itself. */
const GATED_BY: Record<string, string> = { files: 'list_folder', apps: 'apps_find_actions' };

export const MAX_HELPERS_PER_CALL = 4;
export const MAX_HELPERS_PER_RUN = 8;

const SITES: [string, RegExp][] = [
  ['Reddit', /\breddit\b|\br\/\w+/i],
  ['Hacker News', /\b[Hh]acker ?[Nn]ews\b|\bycombinator\b|\bHN\b/],
  ['TikTok', /\btik ?tok\b/i],
  ['YouTube', /\byou ?tube\b/i],
  ['Instagram', /\binstagram\b|\binsta\b/i],
  ['X / Twitter', /\btwitter\b|\bx\.com\b|\btweets?\b/i],
  ['Facebook', /\bfacebook\b/i],
  ['Threads', /\bthreads\.net\b|\bthreads app\b/i],
  ['GitHub', /\bgithub\b/i],
  ['Product Hunt', /\bproduct ?hunt\b/i],
  ['Google Trends', /\bgoogle trends\b/i],
  ['Know Your Meme', /\bknow ?your ?meme\b/i],
  ['Twitch', /\btwitch\b/i],
  ['Pinterest', /\bpinterest\b/i],
  ['LinkedIn', /\blinked ?in\b/i],
];

/** The separate sites an assignment names - two or more is a job to split between helpers. */
export function namedSites(text: string): string[] {
  return SITES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * A nudge appended to an assignment that spans several sites. Small local
 * models ignore "use helpers for multi-part jobs" in a system prompt but do
 * follow it when it's spelled out next to the task.
 */
export function fanOutHint(task: string, canBrowse: boolean): string {
  const sites = namedSites(task);
  if (sites.length < 2 || !canBrowse) return '';
  return `\n\nThis covers ${sites.length} separate sites (${sites.join(', ')}). Start by calling spawn_helpers with one helper per site - each browses its own site in its own tab while you wait - then check and combine their reports.`;
}

export function helperTools(parentTools: readonly string[], skills: string[]): { skills: string[]; tools: string[] } {
  const granted = [...new Set(skills.map((s) => s.toLowerCase().trim()))].filter((s) => {
    if (OPEN_PACKS.has(s)) return true;
    const needs = GATED_BY[s];
    return Boolean(needs && parentTools.includes(needs));
  });
  if (!granted.length) granted.push('browse');
  const tools = [...new Set(granted.flatMap((s) => SKILL_PACKS[s] ?? []))];
  return { skills: granted, tools };
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Validates what an agent asked for: 1-4 helpers per call, within what's left of the run's budget. */
export function sanitizeHelpers(raw: unknown, parentTools: readonly string[], budgetLeft: number): { helpers: HelperSpec[]; refused: number } {
  const list = Array.isArray(raw) ? raw : [];
  const cap = Math.max(0, Math.min(MAX_HELPERS_PER_CALL, budgetLeft));
  const helpers: HelperSpec[] = [];
  const names = new Set<string>();
  let refused = 0;
  for (const item of list) {
    const h = (item ?? {}) as { name?: unknown; role?: unknown; task?: unknown; skills?: unknown };
    const task = text(h.task, 1500);
    if (!task) continue;
    if (helpers.length >= cap) { refused++; continue; }
    let name = text(h.name, 32) || `Helper ${helpers.length + 1}`;
    while (names.has(name.toLowerCase())) name = `${name} ${helpers.length + 1}`;
    names.add(name.toLowerCase());
    const skills = Array.isArray(h.skills) ? h.skills.filter((s): s is string => typeof s === 'string') : typeof h.skills === 'string' ? [h.skills] : ['browse'];
    helpers.push({ name, role: text(h.role, 200) || task.slice(0, 120), task, ...helperTools(parentTools, skills) });
  }
  return { helpers, refused };
}

import { chat, chatJson, preferredProvider } from './llm';
import { emit } from './events';
import { denyAllForRun, endRun, requestApproval } from './approvals';
import { AGENTS, SPECIALISTS } from './agents';
import { getTool, toolsFor, toSpecs } from './tools';
import { clip } from './tools/types';
import type { AgentTool, ToolContext } from './tools';
import { helperSystem, leadInstructions, memoryBlock, persona, withoutHistory, plannerSystem, reviewerSystem, specialistSystem, synthesisInstructions } from './prompts';
import { LlmError, newId, type AgentId, type Effort, type JsonSchema, type LlmMessage, type Provider, type ToolCall, type ToolSpec, cloud } from './types';
import { getSettings, type Settings } from '../store';
import { isoDate, profileForPrompt, safeName, upsertMemory, writeNote } from '../memory/vault';
import { searchMemory, syncIndex, type MemoryHit } from '../memory/semantic';
import { recordExchange, setBusyCheck } from '../memory/extract';
import { connectedApps, isWriteAction } from '../composio';
import { hasToken as discordReady } from '../discord';
import { DISCORD_READS } from './tools/discord';
import * as browser from '../browser';
import { MAX_HELPERS_PER_CALL, MAX_HELPERS_PER_RUN, fanOutHint, sanitizeHelpers, type HelperSpec } from './helpers';
import { mergeSameAgent, routeAppSteps, trimPlan, withoutHandOffs, type PlanStep } from './plan';
import { addressesIn, idsIn, linkKey, linksIn, looksInvented, plainSpoken, titledLinksIn, verifyLinks, withAskedLink, withoutTabClaims } from './grounding';
import { announcesStep, checkWork, madeSomething, workSummary, type WorkEntry, type WorkKind } from './workCheck';
import { actsInApp, asksContent, buildsOnSite, needsAction, readsPage, thinksDeep, thinksHard, usesApp, usesPc } from './intent';
import { hintNote, planAddons, type AddonPlan } from './addonRouter';
import { solveWithPrograms, solverNote, statesAnswer, wantsSolver } from './solver';
import { LATERAL_SKILLS, SCIENCE_SKILLS, lateralLoop, loadSkills, matchSkills } from '../addons';
import { installed as spotifyInstalled } from '../spotifyLocal';
import * as hindsight from '../hindsight';
import { COMPUTE_FIRST, checkEquations, describeWrong, isMathAsk, type WrongStep } from './verify';
import { describeUsage, newMeter, overBudget, withMeter, type Meter } from './meter';
import { workflow, type Workflow } from './workflow';

/**
 * The team runtime. Every message goes: recall (Mnemosyne) -> lead (Ultron).
 * The lead answers directly, uses a quick tool, or calls assemble_team - in
 * which case Athena plans, specialists work in parallel on a shared
 * blackboard (they see each other's finished work and live notes), Athena
 * reviews and can send work back, and Ultron writes the final answer.
 * Everything streams to the HUD as events so the operator sees who is doing what.
 */

export interface AskInput {
  runId: string;
  text: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}

interface StepState extends PlanStep {
  status: 'queued' | 'working' | 'done' | 'failed' | 'skipped';
  report: string;
  actions: number;
  round: number;
  /** The only step, given straight to one specialist - its report can be the answer itself. */
  solo?: boolean;
  /** A builder's own words (before Ultron's ledger was added), and whether the browser log backed them. */
  own?: string;
  verified?: boolean;
}
interface Note { agent: AgentId; /** the helper that posted it, if any */ from?: string; text: string; at: number }
interface Board { objective: string; steps: StepState[]; notes: Note[] }
interface Source { title: string; url: string }

interface RunCtx {
  runId: string;
  signal: AbortSignal;
  settings: Settings;
  provider: Provider | null;
  profile: string;
  hits: MemoryHit[];
  apps: string[];
  /** The ask deserves full reasoning (maths, "why", plans, comparisons...) - intent.ts thinksHard. */
  hard: boolean;
  /** The answer is a worked-out number - it must come from calculate or run_code (workflow v2). */
  mathAsk: boolean;
  /** A calculate or run_code call succeeded during this request. */
  computed: boolean;
  /** Something was actually read (a transcript, page, feed, guide, file) during this request. */
  readContent: boolean;
  /** The add-ons that fit this request (addonRouter.ts). */
  addons: AddonPlan;
  /** Model calls, tokens and time for this request, against its limits. */
  meter: Meter;
  /** What was checked before the answer went out - shown after the run and kept in its note. */
  checks: string[];
  wf: Workflow;
  /** The operator's message plus Ultron's previous reply - what counts as "asked for". */
  asked: string;
  involved: Set<AgentId>;
  sources: Source[];
  board: Board | null;
  /** Helper sub-agents built so far in this run (capped). */
  helpersUsed: number;
  /** Every search and page the team really opened - the final answer may only talk about these. */
  visited: string[];
  /** What each helper brought back - the final answer sees these directly, not only through the parent. */
  helperReports: { parent: AgentId; name: string; status: string; report: string }[];
  /** Every link that appeared in real tool output (pages, search results, app data) - never an agent's own writing. */
  toolLinks: Set<string>;
  /** Titles of the links tools returned (url -> title) - lets an invented link be swapped for the real one. */
  titled: Map<string, string>;
  /** Document/post IDs tools returned - a link built around one of them is real. */
  toolIds: Set<string>;
  /** Ultron really put something on the operator's screen this run (a link, an app, a video). */
  openedForUser: boolean;
}

const active = new Map<string, AbortController>();
// Memory filing waits for the team to go quiet, so it never competes with a live request.
setBusyCheck(() => active.size > 0);

/* Every phase change is also a stopwatch lap, so each run reports where its time went. */
const timelines = new Map<string, { label: string; at: number }[]>();

function ev(runId: string, e: Record<string, unknown>): void {
  if (e.type === 'phase' || e.type === 'start') {
    const laps = timelines.get(runId) ?? [];
    laps.push({ label: e.type === 'start' ? 'STARTING' : String(e.label ?? e.phase), at: Date.now() });
    timelines.set(runId, laps);
  }
  emit('brain:event', { runId, at: Date.now(), ...e });
}

function timingsFor(runId: string): { label: string; ms: number }[] {
  const laps = timelines.get(runId) ?? [];
  const now = Date.now();
  return laps.map((l, i) => ({ label: l.label, ms: (laps[i + 1]?.at ?? now) - l.at }));
}

export function cancelRun(runId: string): void {
  active.get(runId)?.abort();
  denyAllForRun(runId);
}

export function isRunning(): boolean {
  return active.size > 0;
}

const ASSEMBLE_TEAM: ToolSpec = {
  name: 'assemble_team',
  description: 'Hand a task to your specialist team (web research, the operator\'s files/PC, their connected apps, tasks/reminders, long-term memory, analysis). They plan, work in parallel, and report back to you.',
  parameters: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: 'The complete objective with every detail the team needs: what, who, when, where, constraints, and what the finished result should be.' },
      specialist: {
        type: 'string',
        enum: SPECIALISTS,
        description: 'Optional, and much faster: if ONE specialist can clearly do the whole job, name them to skip planning (argus = web research or browsing, hephaestus = files/PC, hermes = connected apps and D2L, chronos = tasks/reminders, mnemosyne = memory, athena = analysis, daedalus = doing or building things on websites). Leave empty when the job needs several of them.',
      },
    },
    required: ['objective'],
  },
};

const TEAM_POST: ToolSpec = {
  name: 'team_post',
  description: 'Share a short interim finding with your teammates working in parallel (they see it on the shared blackboard).',
  parameters: { type: 'object', properties: { note: { type: 'string', description: 'The finding, one or two sentences' } }, required: ['note'] },
};

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agent: { type: 'string', enum: SPECIALISTS },
          task: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          done_when: { type: 'string' },
        },
        required: ['id', 'agent', 'task'],
      },
    },
    review: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['steps'],
};

const REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    issues: { type: 'array', items: { type: 'string' } },
    followups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { agent: { type: 'string', enum: SPECIALISTS }, task: { type: 'string' } },
        required: ['agent', 'task'],
      },
    },
  },
  required: ['verdict'],
};

/* ── Helpers ─────────────────────────────────────────────────────────── */

function trimHistory(history: AskInput['history'], provider: Provider | null): LlmMessage[] {
  const local = !cloud(provider);
  const turns = local ? 10 : 24;
  const per = local ? 1200 : 4000;
  return history.slice(-turns).map((m) => ({ role: m.role, content: m.content.slice(0, per) }) as LlmMessage);
}

function toolBudget(provider: Provider | null, tool?: string): number {
  // A skill guide is followed step by step, so Gemini gets all of it (the lateral-thinking techniques run 5-9k characters).
  if (tool === 'skill_read' && cloud(provider)) return 12_000;
  return cloud(provider) ? 7000 : 2800;
}

/** What the add-on router needs: the provider, the science skills library and the lateral-thinking techniques. */
function addonOpts(rc: RunCtx, text: string) {
  return {
    gemini: cloud(rc.provider),
    skills: (q: string) => matchSkills(q, 2, SCIENCE_SKILLS),
    lateral: loadSkills().some((s) => s.collection === LATERAL_SKILLS) ? lateralLoop : undefined,
    maths: isMathAsk(text),
    // Spotify Free: the desktop app on this PC, unless Spotify is a connected app (Premium, via Composio).
    spotifyLocal: !rc.apps.includes('spotify') && spotifyInstalled(),
  };
}

/** Shrinks older tool results once a specialist's conversation outgrows a small local context. */
function compact(messages: LlmMessage[], budget: number): void {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  for (let i = 0; i < messages.length - 2 && total > budget; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 700) {
      total -= m.content.length - 700;
      m.content = `${m.content.slice(0, 700)}\n...[older result trimmed]`;
    }
  }
}

function collectSources(result: unknown, sink: Source[]): void {
  if (!result || typeof result !== 'object') return;
  const r = result as { sources?: { title?: string; url?: string }[]; url?: string; title?: string };
  const add = (title?: string, url?: string) => {
    if (!url || !/^https?:/.test(url) || sink.some((s) => s.url === url) || sink.length >= 10) return;
    sink.push({ title: title || url, url });
  };
  for (const s of r.sources ?? []) add(s.title, s.url);
  if (typeof r.url === 'string' && typeof r.title === 'string') add(r.title, r.url);
}

/** Logs what a web tool really did, so the final answer can't invent visits (or failures) that never happened. */
function recordVisit(rc: RunCtx, call: ToolCall, result: unknown, who: string): void {
  if (!/^(web_search|read_webpage|deep_research|browser_\w+)$/.test(call.name) || rc.visited.length >= 40) return;
  const r = (result ?? {}) as { url?: unknown; title?: unknown; error?: unknown; engine?: unknown; results?: unknown[]; warning?: unknown; guessed?: unknown; sources?: { url?: string }[] };
  let line: string;
  if (call.name === 'web_search') {
    line = `${who} searched ${typeof r.engine === 'string' ? r.engine : 'the web'} for "${String(call.args?.query ?? '').slice(0, 80)}"${r.error ? ` - failed: ${String(r.error).slice(0, 80)}` : ` - ${r.results?.length ?? 0} results`}`;
  } else if (call.name === 'deep_research') {
    line = `${who} ran deep research${r.error ? ` - failed: ${String(r.error).slice(0, 80)}` : ` - read ${r.sources?.length ?? 0} sources`}`;
  } else if (typeof r.url === 'string' && r.guessed) {
    line = `${who} opened ${r.url} - a guessed address that no page linked to (not verified)`;
  } else if (typeof r.url === 'string') {
    line = `${who} had ${r.url} open${typeof r.title === 'string' && r.title ? ` ("${r.title.slice(0, 60)}")` : ''}${r.warning ? ' - blocked by a login wall or bot check' : ''}`;
  } else if (r.error) {
    line = `${who} ${call.name.replace('browser_', '')} failed: ${String(r.error).slice(0, 100)}`;
  } else {
    return;
  }
  if (!rc.visited.includes(line)) rc.visited.push(line);
}

function recentContext(history: AskInput['history']): string {
  return history.slice(-6).map((m) => `${m.role === 'user' ? 'Operator' : 'Ultron'}: ${m.content.slice(0, 500)}`).join('\n');
}

function guessAgent(text: string, apps: string[] = []): AgentId {
  // Making something in a connected app is done through the app, not a browser.
  if (actsInApp(text, apps)) return 'hermes';
  const t = text.toLowerCase();
  if (/\b(build|make|create|design|draw|fill (in|out)|write)\b.*\b(on|in|at|using)\s+(canva|figma|codepen|jsfiddle|playcode|w3schools|excalidraw|google (docs|slides|sheets)|notion|wix|a website|the website|the site)\b/.test(t)) return 'daedalus';
  if (/\b(email|gmail|inbox|calendar|event|drive|docs?|sheet|slides|notion|spotify|song|playlist|github|repo|discord|classroom)\b/.test(t)) return 'hermes';
  if (/\b(file|folder|downloads|desktop|documents|organi[sz]e|rename|pc|computer|disk)\b/.test(t)) return 'hephaestus';
  if (/\b(remind|task|todo|to-do|schedule|deadline|plan my)\b/.test(t)) return 'chronos';
  if (/\b(remember|recall|memory|what did i)\b/.test(t)) return 'mnemosyne';
  return 'argus';
}

function sanitizePlan(raw: { steps?: unknown[]; review?: boolean; note?: string } | null, objective: string, apps: string[] = []): { steps: PlanStep[]; review: boolean; note: string } {
  const steps: PlanStep[] = [];
  const ids = new Set<string>();
  for (const item of (raw?.steps ?? []).slice(0, 7)) {
    const s = item as { id?: unknown; agent?: unknown; task?: unknown; depends_on?: unknown; done_when?: unknown };
    const agent = String(s.agent ?? '').toLowerCase() as AgentId;
    const task = typeof s.task === 'string' ? s.task.trim() : '';
    if (!SPECIALISTS.includes(agent) || !task) continue;
    let id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${steps.length + 1}`;
    if (ids.has(id)) id = `s${steps.length + 1}`;
    ids.add(id);
    const deps = Array.isArray(s.depends_on) ? s.depends_on.filter((d): d is string => typeof d === 'string') : [];
    const doneWhen = typeof s.done_when === 'string' && s.done_when.trim() ? s.done_when.trim().slice(0, 240) : undefined;
    steps.push({ id, agent, task, dependsOn: deps, doneWhen });
  }
  for (const st of steps) st.dependsOn = st.dependsOn.filter((d) => d !== st.id && ids.has(d));
  // Break any dependency cycle by dropping edges that point forward in the list.
  const order = new Map(steps.map((s, i) => [s.id, i]));
  for (const st of steps) st.dependsOn = st.dependsOn.filter((d) => (order.get(d) ?? 0) < (order.get(st.id) ?? 0));
  if (!steps.length) steps.push({ id: 's1', agent: guessAgent(objective, apps), task: objective, dependsOn: [] });
  return { steps, review: Boolean(raw?.review) || steps.length >= 2, note: typeof raw?.note === 'string' ? raw.note : '' };
}

function boardText(board: Board, meId?: string): string {
  const lines = [`OBJECTIVE: ${board.objective}`, '', 'TEAM PLAN:'];
  for (const s of board.steps) lines.push(`- ${s.id} ${AGENTS[s.agent].name}: ${s.task} [${s.id === meId ? 'YOU' : s.status}]`);
  const finished = board.steps.filter((s) => s.id !== meId && s.status === 'done' && s.report);
  if (finished.length) {
    lines.push('', 'FINISHED WORK FROM TEAMMATES:');
    for (const s of finished) lines.push(`[${s.id} - ${AGENTS[s.agent].name.toUpperCase()}]\n${s.report.slice(0, 2500)}`);
  }
  if (board.notes.length) {
    lines.push('', 'TEAM NOTES:');
    for (const n of board.notes.slice(-14)) lines.push(`- ${AGENTS[n.agent].name}${n.from ? ` > ${n.from}` : ''}: ${n.text}`);
  }
  return lines.join('\n');
}

/* ── Who is acting ───────────────────────────────────────────────────── */

/**
 * A specialist, or a helper one of them built. Helpers act under their
 * parent's name and colour, with their own tools and their own browser tab.
 */
interface Worker {
  agent: AgentId;
  /** The plan step it is working on - two steps for one agent never share a tab. */
  stepId?: string;
  helper?: { id: string; name: string; tools: string[] };
}

function tabOf(rc: RunCtx, w: Worker): ToolContext['tab'] {
  const name = AGENTS[w.agent].name.toUpperCase();
  if (w.helper) return { id: `${rc.runId}:${w.agent}:${w.helper.id}`, runId: rc.runId, agent: w.agent, label: `${name} > ${w.helper.name.toUpperCase()}` };
  // Review follow-ups can put an agent on a second step while the first is still browsing.
  const twin = w.stepId && (rc.board?.steps.filter((s) => s.agent === w.agent).length ?? 0) > 1;
  return { id: `${rc.runId}:${w.agent}${w.stepId ? `:${w.stepId}` : ''}`, runId: rc.runId, agent: w.agent, label: twin ? `${name} (${w.stepId})` : name };
}

/* ── Tools ───────────────────────────────────────────────────────────── */

async function runTool(rc: RunCtx, caller: AgentId, call: ToolCall, worker?: Worker): Promise<unknown> {
  const tool: AgentTool | undefined = getTool(call.name);
  if (!tool) return { error: `Unknown tool: ${call.name}` };
  const allowed = worker?.helper ? worker.helper.tools : caller === 'ultron' ? null : AGENTS[caller].tools;
  if (allowed && !allowed.includes(call.name)) return { error: `${call.name} is not one of your tools.` };
  // Helpers only look and report - changes to the operator's apps go back through their parent.
  if (worker?.helper && call.name === 'apps_run_action' && isWriteAction(String(call.args?.action ?? ''))) {
    return { error: 'Helpers only read. Put what should change in your report and your lead will do it.' };
  }
  // Opening a deep link nobody gave and no tool found - a made-up document or post ID - on the operator's screen.
  if (call.name === 'open_url') {
    const url = String(call.args?.url ?? '');
    const known = new Set([...addressesIn(rc.asked), ...rc.toolLinks, ...browser.seenUrls(rc.runId)].map(linkKey));
    if (looksInvented(url, known)) {
      return { error: `Not opening ${url.slice(0, 80)}: that address was not given by the operator or found by any tool - it looks made up. Find or create the real one first (Hermes can create or search documents in connected apps).` };
    }
  }
  // A long page read without saying what to look for is cut at its start - small models skip the optional focus
  // (eval, 29 Sep 2026: "the page doesn't mention it" - the answer was further down). Default to the question asked.
  if ((call.name === 'read_webpage' || call.name === 'browser_read') && rc.wf.research2 && !String(call.args?.focus ?? '').trim()) {
    call.args = { ...(call.args ?? {}), focus: rc.asked.slice(0, 300) };
  }
  // The lead's quick tools belong to specialists - credit the specialist in the HUD.
  const owner: AgentId = caller === 'ultron' ? tool.owner : caller;
  const sub = worker?.helper?.name;
  rc.involved.add(owner);
  const label = tool.label?.(call.args ?? {}) ?? call.name;
  if (caller === 'ultron') ev(rc.runId, { type: 'agent', agent: owner, status: 'working', task: label });
  ev(rc.runId, { type: 'action', agent: owner, sub, text: label });
  const ctx: ToolContext = {
    runId: rc.runId,
    agent: owner,
    tab: tabOf(rc, worker ?? { agent: owner }),
    signal: rc.signal,
    resultBudget: toolBudget(rc.provider),
    guideBudget: toolBudget(rc.provider, 'skill_read'),
    approve: async (kind, title, detail) => {
      ev(rc.runId, { type: 'agent', agent: owner, status: 'waiting', task: title });
      const ok = await requestApproval({ runId: rc.runId, agent: owner, kind, title: sub ? `${sub}: ${title}` : title, detail });
      ev(rc.runId, { type: 'action', agent: owner, sub, text: ok ? `approved: ${title}` : `declined: ${title}`, kind: ok ? 'ok' : 'warn' });
      ev(rc.runId, { type: 'agent', agent: owner, status: 'working', task: label });
      return ok;
    },
    progress: (text) => ev(rc.runId, { type: 'action', agent: owner, sub, text, kind: 'progress' }),
    post: (text) => {
      rc.board?.notes.push({ agent: owner, from: sub, text, at: Date.now() });
      ev(rc.runId, { type: 'action', agent: owner, sub, text: `note: ${text}`, kind: 'note' });
    },
  };
  const attempt = async (): Promise<unknown> => {
    try {
      return await tool.run(call.args ?? {}, ctx);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  let result = await attempt();
  // A read that failed on a network blip is tried once more - never a write, never a browser move.
  if (rc.wf.toolRetry && retriable(call, result) && !rc.signal.aborted) {
    ev(rc.runId, { type: 'action', agent: owner, sub, text: `${call.name}: temporary failure - trying once more`, kind: 'warn' });
    await new Promise((r) => setTimeout(r, 1500));
    result = await attempt();
  }
  const err = result && typeof result === 'object' && 'error' in result ? (result as { error?: unknown }).error : undefined;
  if (!err && (call.name === 'calculate' || call.name === 'run_code')) rc.computed = true;
  if (!err && READS_CONTENT.has(call.name)) rc.readContent = true;
  const verification = result && typeof result === 'object' ? (result as { verification?: unknown }).verification : undefined;
  if (!err && typeof verification === 'string') rc.checks.push(verification);
  if (err) ev(rc.runId, { type: 'action', agent: owner, sub, text: `failed: ${String(err).slice(0, 140)}`, kind: 'warn' });
  collectSources(result, rc.sources);
  recordVisit(rc, call, result, sub ? `${AGENTS[owner].name} > ${sub}` : AGENTS[owner].name);
  if (!err && /^(open_url|open_app|open_path|play_on_youtube)$/.test(call.name)) rc.openedForUser = true;
  if (result && typeof result === 'object' && rc.toolLinks.size < 20_000) {
    const r = result as { url?: unknown; guessed?: unknown };
    // A page opened from a made-up address doesn't vouch for that address.
    const skip = r.guessed && typeof r.url === 'string' ? r.url : '';
    const json = JSON.stringify(result).slice(0, 300_000);
    for (const link of linksIn(json)) if (link !== skip) rc.toolLinks.add(link);
    for (const l of titledLinksIn(json)) if (l.url !== skip && rc.titled.size < 5000 && !rc.titled.has(l.url)) rc.titled.set(l.url, l.title);
    if (!skip) for (const id of idsIn(json)) if (rc.toolIds.size < 5000) rc.toolIds.add(id);
  }
  if (caller === 'ultron') ev(rc.runId, { type: 'agent', agent: owner, status: err ? 'error' : 'done', task: label });
  return result;
}

/* Tools that actually read the thing asked about - not open it, play it or recall a past run. */
const READS_CONTENT = new Set(['youtube_transcript', 'read_webpage', 'read_feed', 'browser_read', 'browser_open', 'google_search', 'web_search', 'deep_research', 'skill_read', 'skill_search', 'read_file', 'memory_read_note', 'browser_agent']);

/* Reads that are safe to repeat, and the failures worth repeating them for. */
const RETRY_READS = new Set([
  'google_search', 'web_search', 'read_webpage', 'encyclopedia_lookup', 'get_weather', 'youtube_search', 'on_this_day', 'memory_search',
  'apps_find_actions', 'apps_run_action', 'd2l_due', 'd2l_overdue', 'd2l_grades', 'd2l_announcements', 'd2l_courses',
  'discord_servers', 'discord_server_info', 'discord_read_messages', 'discord_members',
]);
const TRANSIENT = /timed? ?out|did not answer in time|stopped responding|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|\b50[0234]\b|temporar|overloaded/i;

function retriable(call: ToolCall, result: unknown): boolean {
  if (!RETRY_READS.has(call.name)) return false;
  if (call.name === 'apps_run_action' && isWriteAction(String(call.args?.action ?? ''))) return false;
  const err = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
  return Boolean(err) && TRANSIENT.test(String(err)) && !/declined|not set up|not connected|sign in/i.test(String(err));
}

/* ── The agent loop (specialists and helpers) ────────────────────────── */

const SPAWN_HELPERS: ToolSpec = {
  name: 'spawn_helpers',
  description:
    'Build your own helper sub-agents to split a big job - one per platform, source, angle or folder. Each helper gets its own browser tab and works in parallel with the others; ' +
    'you get every report back to combine. Up to 4 per call. Give each a short name, a role, and a specific task with every detail it needs and what to report. ' +
    'Skills: browse (its own web browser + search), research (deep research, encyclopedia, YouTube search), memory, math - plus files or apps if you have those yourself (read-only).',
  parameters: {
    type: 'object',
    properties: {
      helpers: {
        type: 'array',
        description: '1 to 4 helpers',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name, e.g. "Reddit Scout"' },
            role: { type: 'string', description: 'What it is, e.g. "tracks what is trending on Reddit today"' },
            task: { type: 'string', description: 'The exact assignment: what to find or do, where to look, and what to report back' },
            skills: { type: 'array', description: 'Default ["browse"]', items: { type: 'string', enum: ['browse', 'research', 'memory', 'math', 'files', 'apps'] } },
          },
          required: ['name', 'task'],
        },
      },
    },
    required: ['helpers'],
  },
};

/** Tools with no shared state (no browser tab, no approval prompt) - safe to run side by side in one turn. */
const PARALLEL_SAFE = new Set([
  'memory_search', 'memory_read_note', 'calculate', 'encyclopedia_lookup', 'get_weather', 'on_this_day', 'youtube_search',
  'deep_research', 'apps_connected', 'apps_find_actions', 'd2l_due', 'd2l_overdue', 'd2l_grades', 'd2l_announcements', 'd2l_courses', ...DISCORD_READS,
  'google_search', 'run_code', 'calculate', 'youtube_transcript', 'read_feed', 'skill_search', 'skill_read', 'task_list', 'current_time', 'list_folder', 'read_file', 'search_files', 'file_info', 'system_info', 'list_windows', 'distance_between',
  'team_post',
]);

interface LoopOpts {
  worker: Worker;
  system: string;
  firstMessage: string;
  specs: ToolSpec[];
  maxIters: number;
  onAction?: () => void;
  /** Builders' reports are checked against what their browser actually did before they count. */
  checkWork?: WorkKind;
  /** Gets a builder's own report and whether its browser log backed it. */
  onOwn?: (own: string, verified: boolean) => void;
  /** How hard to think on every turn - Athena's reasoning work gets the most. */
  effort?: Effort;
  /** Worth the strongest model (Gemini Pro when the key allows it). */
  deep?: boolean;
  /** Its numbers must come from calculate or run_code before the report counts. */
  mustCompute?: boolean;
}

async function agentLoop(rc: RunCtx, o: LoopOpts): Promise<string> {
  const board = rc.board!;
  const budget = toolBudget(rc.provider);
  const messages: LlmMessage[] = [{ role: 'user', content: o.firstMessage }];
  const me = { agent: o.worker.agent, from: o.worker.helper?.name };
  let seenNotes = board.notes.length;
  let report = '';
  // Small models sometimes loop on the same call; answer repeats from memory instead of re-running them.
  const callsMade = new Set<string>();
  let lastCall = '';
  let repeats = 0;
  const work: WorkEntry[] = [];
  let pushbacks = 0;
  let nudges = 0;
  let computePushes = 0;

  for (let i = 0; i < o.maxIters && repeats < 3; i++) {
    // Past the request's budget: stop starting new work and write up what there is.
    const over = overBudget(rc.meter);
    if (over) {
      ev(rc.runId, { type: 'action', agent: me.agent, sub: me.from, text: `stopping here: reached ${over}`, kind: 'warn' });
      break;
    }
    if (!cloud(rc.provider)) compact(messages, 14_000);
    const res = await chat({
      system: o.system,
      messages,
      tools: o.specs,
      temperature: 0.35,
      effort: o.effort,
      deep: o.deep,
      signal: rc.signal,
      onNotice: (t) => ev(rc.runId, { type: 'notice', text: t }),
    });
    if (!res.toolCalls.length) {
      // "Let me type the HTML now." - announced, not done. Send it back to take the step.
      if (nudges < 2 && i < o.maxIters - 1 && announcesStep(res.text)) {
        nudges++;
        messages.push({ role: 'assistant', content: res.text });
        messages.push({ role: 'user', content: '[CONTINUE] You said what you will do next but did not do it. Make that tool call now - or, if the job is finished, write your REPORT.' });
        continue;
      }
      // Numbers in the report that no tool computed: send it back to compute them (once).
      if (o.mustCompute && computePushes < 1 && i < o.maxIters - 1 && /\d/.test(res.text) && !work.some((w) => w.ok && (w.tool === 'calculate' || w.tool === 'run_code'))) {
        computePushes++;
        ev(rc.runId, { type: 'action', agent: me.agent, sub: me.from, text: 'verify: numbers not computed yet - sent back to compute them', kind: 'warn' });
        messages.push({ role: 'assistant', content: res.text });
        messages.push({ role: 'user', content: COMPUTE_FIRST });
        continue;
      }
      const doubt = o.checkWork && pushbacks < 2 && i < o.maxIters - 1 ? checkWork(res.text, work, o.checkWork) : null;
      if (doubt) {
        // The report claims work the browser log doesn't show - send the builder back to do it (or own up).
        pushbacks++;
        ev(rc.runId, { type: 'action', agent: me.agent, sub: me.from, text: doubt.kind === 'no_edits' ? `work check: nothing was ${o.checkWork === 'apps' ? 'created or sent' : 'typed'} yet - sent back to do it` : doubt.kind === 'no_action' ? 'work check: no app action behind that answer - sent back to run it' : 'work check: result not looked at - sent back to check', kind: 'warn' });
        messages.push({ role: 'assistant', content: res.text });
        messages.push({ role: 'user', content: `[WORK CHECK] ${doubt.message}` });
        continue;
      }
      report = res.text;
      break;
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, native: res.native, nativeProvider: res.provider });
    const handle = async (call: ToolCall): Promise<string> => {
      const signature = `${call.name}|${JSON.stringify(call.args ?? {})}`;
      // On a live page the same move can be right twice (Run after each edit) - only back-to-back repeats count there.
      const repeat = call.name.startsWith('browser_') ? signature === lastCall : callsMade.has(signature);
      lastCall = signature;
      if (repeat) {
        repeats++;
        const hint = call.name === 'browser_click' ? ' Clicking an editor does not type into it - to write there, call browser_type with its number and the text.' : '';
        return JSON.stringify({ note: `You just made this exact call - its result is above. Do not repeat it: use that result, try something different, or write your REPORT.${hint}` });
      }
      callsMade.add(signature);
      let result: unknown;
      if (call.name === 'team_post') {
        const note = String(call.args?.note ?? '').slice(0, 400);
        board.notes.push({ agent: me.agent, from: me.from, text: note, at: Date.now() });
        ev(rc.runId, { type: 'action', agent: me.agent, sub: me.from, text: `note: ${note}`, kind: 'note' });
        result = { ok: true };
      } else if (call.name === 'spawn_helpers' && !o.worker.helper) {
        result = await spawnHelpers(rc, o.worker.agent, call.args ?? {});
      } else {
        result = await runTool(rc, o.worker.agent, call, o.worker);
        work.push({
          // An app action that changes something is what "I created / sent it" has to point to.
          tool: (call.name === 'apps_run_action' && isWriteAction(String(call.args?.action ?? ''))) || getTool(call.name)?.writes ? 'apps_run_action:write' : call.name,
          ok: !(result && typeof result === 'object' && (result as { error?: unknown }).error),
          label: getTool(call.name)?.label?.(call.args ?? {}) ?? call.name,
        });
      }
      o.onAction?.();
      return clip(result, call.name === 'spawn_helpers' ? budget * 2 : call.name === 'skill_read' ? toolBudget(rc.provider, call.name) : budget);
    };
    // Independent lookups asked for in the same turn run together; anything touching this worker's browser tab
    // (or asking the operator) stays in order.
    const together = res.toolCalls.length > 1 && res.toolCalls.every((c) => PARALLEL_SAFE.has(c.name));
    const outputs = together
      ? await Promise.all(res.toolCalls.map(handle))
      : await res.toolCalls.reduce<Promise<string[]>>(async (acc, c) => [...(await acc), await handle(c)], Promise.resolve([]));
    res.toolCalls.forEach((call, idx) => messages.push({ role: 'tool', callId: call.id, name: call.name, content: outputs[idx] }));
    // Teammates and helpers working in parallel may have posted something useful since the last turn.
    if (board.notes.length > seenNotes) {
      const fresh = board.notes.slice(seenNotes).filter((n) => n.agent !== me.agent || n.from !== me.from);
      seenNotes = board.notes.length;
      const last = messages[messages.length - 1];
      if (fresh.length && last.role === 'tool') {
        last.content += `\n\n[TEAM UPDATE] ${fresh.map((n) => `${AGENTS[n.agent].name}${n.from ? ` > ${n.from}` : ''}: ${n.text}`).join(' | ')}`;
      }
    }
  }
  if (!report) {
    const res = await chat({
      system: o.system,
      messages: [...messages, { role: 'user', content: 'Stop using tools now and write your REPORT from what you have.' }],
      temperature: 0.3,
      effort: o.effort,
      deep: o.deep,
      signal: rc.signal,
    });
    report = res.text;
  }
  if (o.checkWork) {
    // A report that claims more than was done is set aside - the answer is written from the log (and the page) instead.
    const kind = o.checkWork;
    const logName = kind === 'apps' ? 'action log' : 'browser log';
    const doubt = checkWork(report, work, kind);
    // A report that only announces its next move is not an answer, even if it claims nothing.
    o.onOwn?.(report.trim(), !doubt && !announcesStep(report));
    if (doubt) {
      ev(rc.runId, { type: 'action', agent: me.agent, sub: me.from, text: `work check: report did not match the ${logName} - set aside`, kind: 'warn' });
      report = `[UNVERIFIED] ${AGENTS[me.agent].name}'s report claimed work the ${logName} does not show, so Ultron set it aside. ${doubt.kind === 'no_edits' ? (kind === 'apps' ? 'No create, send or edit action succeeded - the job is NOT done.' : 'Nothing was typed or drawn - the job is NOT done.') : doubt.kind === 'no_action' ? 'No app action ran, so nothing was actually read from the app - any numbers or details in the report were made up.' : 'The work below happened, but its result was never checked.'}\nWHAT ${me.agent.toUpperCase()} ACTUALLY DID: ${workSummary(work)}`;
    } else if (work.length) {
      report += `\n\nWHAT ${me.agent.toUpperCase()} ACTUALLY DID: ${workSummary(work)}`;
    }
    if (work.length && !madeSomething(work, kind)) {
      report += kind === 'apps'
        ? `\nRESULT: no create, send or edit action succeeded, so nothing was made or changed in the apps.`
        : `\nRESULT: nothing was typed or drawn on the site, so nothing was built or changed there.`;
    }
    const page = kind === 'browser' && work.some((e) => e.tool.startsWith('browser_')) ? await browser.pageState(tabOf(rc, o.worker)) : '';
    if (page) report += `\n\nTHE PAGE AT THE END (read by Ultron itself, not the agent):\n${page}`;
  }
  return report.trim() || '(no report)';
}

/* ── Specialists ─────────────────────────────────────────────────────── */

const SOLO_REPORT = 'Your REPORT goes straight to the operator as Ultron\'s answer: talk to them directly (you, your), in 2-6 short plain sentences with no markdown - what you did, what actually happened (say plainly if anything was unavailable, blocked or failed), where the result is, and what is left for them.';

async function runStep(rc: RunCtx, step: StepState): Promise<void> {
  const board = rc.board!;
  step.status = 'working';
  rc.involved.add(step.agent);
  ev(rc.runId, { type: 'agent', agent: step.agent, status: 'working', task: step.task });
  ev(rc.runId, { type: 'step', id: step.id, status: 'working' });
  try {
    const attempt = () => agentLoop(rc, {
      worker: { agent: step.agent, stepId: step.id },
      system: specialistSystem(step.agent, rc.settings, rc.profile),
      firstMessage: `${boardText(board, step.id)}\n\nYOUR ASSIGNMENT (${step.id}): ${step.task}${rc.wf.newTools ? hintNote(planAddons(step.task, addonOpts(rc, step.task))) || hintNote(rc.addons) : ''}${rc.wf.criteria && step.doneWhen ? `\n\nDONE WHEN: ${step.doneWhen} - check this before you write your REPORT, and say in the report whether it is met.` : ''}${fanOutHint(step.task, step.agent !== 'chronos' && step.agent !== 'mnemosyne' && step.agent !== 'daedalus')}${step.solo && (step.agent === 'daedalus' || step.agent === 'hermes') ? `\n\n${SOLO_REPORT}` : ''}`,
      specs: [...toSpecs(toolsFor(step.agent)), TEAM_POST, SPAWN_HELPERS],
      // Real browsing is many small steps (open, look, scroll, click, read) - leave room for it.
      // Building on a website is dozens of small moves (click, type, look, fix) - Daedalus gets the room for it.
      // App work is find the action, run it, fill it in, fix a bad argument - Hermes gets a little more room too.
      maxIters: step.agent === 'daedalus' ? (cloud(rc.provider) ? 36 : 18) : step.agent === 'hermes' ? (cloud(rc.provider) ? 16 : 10) : cloud(rc.provider) ? 12 : 8,
      onAction: () => { step.actions++; },
      checkWork: step.agent === 'daedalus' ? 'browser' : step.agent === 'hermes' ? 'apps' : undefined,
      onOwn: (own, verified) => { step.own = own; step.verified = verified; },
      // Athena is the team's thinker: full reasoning on the strongest model. The others work in many small
      // tool steps (click, read, run) where deep thought per step only adds waiting.
      effort: step.agent === 'athena' ? 'high' : undefined,
      deep: step.agent === 'athena',
      mustCompute: rc.wf.verifyMath && (isMathAsk(step.task) || (rc.mathAsk && step.agent === 'athena')),
    });
    step.report = await withRecovery(rc, step.agent, attempt);
    step.status = 'done';
    ev(rc.runId, { type: 'agent', agent: step.agent, status: 'done', task: step.task });
    ev(rc.runId, { type: 'step', id: step.id, status: 'done', report: step.report.slice(0, 600) });
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'aborted') throw e;
    step.status = 'failed';
    step.report = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
    ev(rc.runId, { type: 'agent', agent: step.agent, status: 'error', task: step.report.slice(0, 160) });
    ev(rc.runId, { type: 'step', id: step.id, status: 'failed' });
  }
}

/* ── Helpers (sub-agents a specialist builds for itself) ─────────────── */

async function spawnHelpers(rc: RunCtx, parent: AgentId, args: Record<string, unknown>): Promise<unknown> {
  const { helpers, refused } = sanitizeHelpers(args.helpers, AGENTS[parent].tools, MAX_HELPERS_PER_RUN - rc.helpersUsed);
  if (!helpers.length) {
    return {
      error: rc.helpersUsed >= MAX_HELPERS_PER_RUN
        ? 'The helper budget for this task is used up - finish the work yourself.'
        : 'No valid helpers - give each one a name and a specific task.',
    };
  }
  const first = rc.helpersUsed + 1;
  rc.helpersUsed += helpers.length;
  ev(rc.runId, { type: 'action', agent: parent, text: `built ${helpers.length} helper${helpers.length > 1 ? 's' : ''}: ${helpers.map((h) => h.name).join(', ')}`, kind: 'note' });
  const results = await Promise.all(helpers.map((h, i) => runHelper(rc, parent, h, `h${first + i}`)));
  return {
    helpers: results.map((r) => ({ name: r.name, status: r.status, report: clip(r.report, 3000) })),
    note: refused ? `${refused} more helper(s) were not created (limit ${MAX_HELPERS_PER_CALL} per call, ${MAX_HELPERS_PER_RUN} per task).` : undefined,
    // Measured: parents re-opening their helpers' pages "to check" cost more time than the helpers themselves.
    next: 'Combine these reports into your REPORT now. Do not re-open their pages or redo their work - only fill a gap if a report is clearly missing something the assignment needs.',
  };
}

async function runHelper(rc: RunCtx, parent: AgentId, spec: HelperSpec, id: string): Promise<{ name: string; status: 'done' | 'failed'; report: string }> {
  const worker: Worker = { agent: parent, helper: { id, name: spec.name, tools: spec.tools } };
  ev(rc.runId, { type: 'helper', id, parent, name: spec.name, task: spec.task, skills: spec.skills, status: 'working' });
  try {
    const report = await agentLoop(rc, {
      worker,
      system: helperSystem(parent, spec, rc.settings, rc.profile),
      firstMessage: `${boardText(rc.board!)}\n\nYOUR ASSIGNMENT FROM ${AGENTS[parent].name.toUpperCase()}: ${spec.task}`,
      specs: [...toSpecs(spec.tools.map((t) => getTool(t)).filter((t): t is AgentTool => Boolean(t))), TEAM_POST],
      maxIters: cloud(rc.provider) ? 10 : 6,
    });
    ev(rc.runId, { type: 'helper', id, parent, name: spec.name, status: 'done', report: report.slice(0, 500) });
    rc.helperReports.push({ parent, name: spec.name, status: 'done', report });
    return { name: spec.name, status: 'done', report };
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'aborted') throw e;
    const message = e instanceof Error ? e.message : String(e);
    ev(rc.runId, { type: 'helper', id, parent, name: spec.name, status: 'failed', report: message.slice(0, 200) });
    return { name: spec.name, status: 'failed', report: `FAILED: ${message}` };
  } finally {
    await browser.closeTab(tabOf(rc, worker).id).catch(() => {});
  }
}

async function executeSteps(rc: RunCtx, steps: StepState[]): Promise<void> {
  // Two at a time: enough for real parallel work, gentle on Gemini's free-tier rate limit and a single local GPU.
  const limit = 2;
  const running = new Map<string, Promise<void>>();
  const finished = (id: string) => {
    const s = rc.board!.steps.find((x) => x.id === id);
    return !s || s.status === 'done' || s.status === 'failed' || s.status === 'skipped';
  };
  for (;;) {
    if (rc.signal.aborted) throw new LlmError('cancelled', 'aborted');
    const queued = steps.filter((s) => s.status === 'queued');
    if (!queued.length && !running.size) return;
    const ready = queued.filter((s) => s.dependsOn.every(finished));
    for (const s of ready) {
      if (running.size >= limit) break;
      const p = runStep(rc, s).finally(() => running.delete(s.id));
      running.set(s.id, p);
    }
    if (!running.size) {
      for (const s of queued) s.status = 'skipped';
      return;
    }
    await Promise.race(running.values());
  }
}

async function runTeam(rc: RunCtx, objective: string, history: AskInput['history'], direct?: AgentId): Promise<string> {
  const mode = rc.settings.team.mode;
  let plan: { steps: PlanStep[]; review: boolean; note: string };
  let requestedReview = false;

  if (direct && mode !== 'full') {
    // The lead already knows who does this - a one-step plan, no planning call.
    plan = { steps: [{ id: 's1', agent: direct, task: objective, dependsOn: [] }], review: false, note: `Straight to ${AGENTS[direct].name}` };
    ev(rc.runId, { type: 'phase', phase: 'planning', label: 'ASSIGNING' });
  } else {
    ev(rc.runId, { type: 'phase', phase: 'planning', label: 'ATHENA PLANNING' });
    ev(rc.runId, { type: 'agent', agent: 'athena', status: 'working', task: 'Planning the approach' });
    rc.involved.add('athena');
    const memoryText = rc.hits.map((h) => `- ${h.text.slice(0, 300)}`).join('\n');
    const raw = await chatJson<{ steps?: unknown[]; review?: boolean; note?: string }>({
      system: plannerSystem(mode, rc.apps, rc.wf.criteria),
      messages: [{
        role: 'user',
        content: [
          `OBJECTIVE: ${objective}`,
          history.length ? `\nRECENT CONVERSATION:\n${recentContext(history)}` : '',
          memoryText ? `\nRELEVANT MEMORY:\n${memoryText}` : '',
        ].filter(Boolean).join('\n'),
      }],
      schema: PLAN_SCHEMA,
      temperature: 0.2,
      effort: 'high',
      signal: rc.signal,
    }).catch((e) => {
      if (e instanceof LlmError && e.kind === 'aborted') throw e;
      return null;
    });
    plan = sanitizePlan(raw, objective, rc.apps);
    requestedReview = Boolean(raw?.review);
  }

  const trimmed = trimPlan(plan.steps, { asked: rc.asked, apps: rc.apps });
  const routed = routeAppSteps(trimmed.steps, rc.apps);
  for (const m of routed.moved) {
    ev(rc.runId, { type: 'action', agent: 'athena', text: `gave ${m.id} to Hermes - ${m.app} is connected, so it's done through the app`, kind: 'note' });
  }
  plan.steps = mergeSameAgent(withoutHandOffs(routed.steps));
  for (const d of trimmed.dropped) {
    ev(rc.runId, { type: 'action', agent: 'athena', text: `dropped ${AGENTS[d.agent].name}'s step - ${d.why}`, kind: 'warn' });
  }
  const board: Board = {
    objective,
    steps: plan.steps.map((s) => ({ ...s, status: 'queued', report: '', actions: 0, round: 0, solo: Boolean(direct) && plan.steps.length === 1 })),
    notes: [],
  };
  rc.board = board;
  ev(rc.runId, { type: 'plan', steps: plan.steps, note: plan.note });
  if (!direct || mode === 'full') ev(rc.runId, { type: 'agent', agent: 'athena', status: 'done', task: plan.note || `${plan.steps.length}-step plan` });

  ev(rc.runId, { type: 'phase', phase: 'working', label: 'TEAM WORKING' });
  const workStart = Date.now();
  await executeSteps(rc, board.steps);

  // Review costs a model call, and a follow-up round costs a whole second pass - measured at nearly half of a
  // two-helper task's time. Worth it for big jobs and for failures; not for a finished small one.
  const failed = board.steps.some((s) => s.status === 'failed');
  const worthReviewing = failed || board.steps.length >= 3 || (requestedReview && board.steps.length >= 2 && cloud(rc.provider));
  const tooLongAlready = Date.now() - workStart > 150_000 || Boolean(overBudget(rc.meter));
  if (worthReviewing && !tooLongAlready) {
    ev(rc.runId, { type: 'phase', phase: 'reviewing', label: 'ATHENA REVIEWING' });
    ev(rc.runId, { type: 'agent', agent: 'athena', status: 'working', task: 'Reviewing the team\'s work' });
    rc.involved.add('athena');
    const review = await chatJson<{ verdict?: string; issues?: string[]; followups?: { agent?: string; task?: string }[] }>({
      system: reviewerSystem(rc.wf.criteria),
      messages: [{
        role: 'user',
        content: `OBJECTIVE: ${objective}\n\nWORK:\n${board.steps.map((s) => `[${s.id} ${AGENTS[s.agent].name} - ${s.status}] ${s.task}${rc.wf.criteria && s.doneWhen ? `\nDONE WHEN: ${s.doneWhen}` : ''}\n${s.report.slice(0, 3000)}`).join('\n\n')}`,
      }],
      schema: REVIEW_SCHEMA,
      temperature: 0.2,
      effort: 'high',
      deep: true,
      signal: rc.signal,
    }).catch((e) => {
      if (e instanceof LlmError && e.kind === 'aborted') throw e;
      return null;
    });
    // Follow-up rounds only to fix a failure, or when the reviewer is the stronger (Gemini) model.
    const allowFollowups = failed || cloud(rc.provider);
    const proposed = review?.verdict === 'revise' && allowFollowups
      ? (review.followups ?? []).filter((f) => SPECIALISTS.includes(f.agent as AgentId) && f.task?.trim()).slice(0, 2)
      : [];
    // Review follow-ups get the same check as the plan - "also set a reminder" is not a fix.
    const kept = new Set(trimPlan(
      proposed.map((f, i) => ({ id: `r${i + 1}`, agent: f.agent as AgentId, task: f.task!.trim(), dependsOn: [] })),
      { asked: rc.asked, apps: rc.apps, allowEmpty: true },
    ).steps.map((s) => s.task));
    const followups = proposed.filter((f) => kept.has(f.task!.trim()));
    ev(rc.runId, {
      type: 'agent', agent: 'athena', status: 'done',
      task: followups.length ? `Sent back ${followups.length} follow-up${followups.length > 1 ? 's' : ''}` : 'Work approved',
    });
    if (review?.issues?.length) ev(rc.runId, { type: 'action', agent: 'athena', text: `review: ${review.issues.slice(0, 3).join('; ').slice(0, 200)}`, kind: 'note' });
    if (followups.length) {
      const extra: StepState[] = followups.map((f, i) => ({
        id: `r${i + 1}`, agent: f.agent as AgentId, task: f.task!.trim(), dependsOn: [], status: 'queued', report: '', actions: 0, round: 1,
      }));
      board.steps.push(...extra);
      ev(rc.runId, { type: 'plan', steps: board.steps.map(({ id, agent, task, dependsOn }) => ({ id, agent, task, dependsOn })), note: 'Follow-ups from review' });
      ev(rc.runId, { type: 'phase', phase: 'working', label: 'FOLLOW-UPS' });
      await executeSteps(rc, extra);
    }
  }

  const steps = board.steps
    .map((s) => `[${s.id} - ${AGENTS[s.agent].name} (${AGENTS[s.agent].title}) - ${s.status}]\nTask: ${s.task}\n${s.report || '(no report)'}`)
    .join('\n\n');
  // Helpers' own words go to the answer too: a parent that garbles or truncates a combined report must not lose what they found.
  // They go first - the local model only gets the first ~7000 characters of all this.
  const helpers = rc.helperReports
    .map((h) => `[HELPER ${h.name.toUpperCase()} - built by ${AGENTS[h.parent].name} - ${h.status}]\n${h.report.slice(0, 2200)}`)
    .join('\n\n');
  return helpers ? `${helpers}\n\n${steps}` : steps;
}

/**
 * A step whose model call failed on a network blip or a rate limit gets one
 * more attempt after a pause (workflow v2). Anything else - a cancel, a used-up
 * budget, a real error - fails the step as before, and the review can follow up.
 */
async function withRecovery(rc: RunCtx, agent: AgentId, attempt: () => Promise<string>): Promise<string> {
  try {
    return await attempt();
  } catch (e) {
    const transient = e instanceof LlmError && (e.kind === 'network' || e.kind === 'rate');
    if (!rc.wf.criteria || !transient || rc.signal.aborted || overBudget(rc.meter)) throw e;
    ev(rc.runId, { type: 'action', agent, text: `recovering: ${e.message.slice(0, 100)} - one more attempt`, kind: 'warn' });
    await new Promise((r) => setTimeout(r, 4000));
    return attempt();
  }
}

/** Asks the model to correct the steps the checker found wrong - given the right values, nothing to work out. */
async function fixMath(text: string, wrong: WrongStep[], signal: AbortSignal): Promise<string | null> {
  const res = await chat({
    system: 'You correct arithmetic mistakes in a reply. A checker recomputed some steps and gives the right values. Rewrite the reply with those steps - and every result that depends on them - corrected. Change nothing else: same wording, tone and length. Output only the corrected reply.',
    messages: [{ role: 'user', content: `REPLY:\n${text}\n\nWRONG STEPS:\n${wrong.map((w) => `- ${describeWrong(w)}`).join('\n')}` }],
    temperature: 0.1,
    effort: 'low',
    signal,
  });
  return res.text.trim() || null;
}

function saveTeamRun(rc: RunCtx, userText: string, finalText: string, timings: { label: string; ms: number }[] = []): string | undefined {
  const board = rc.board;
  if (!board) return undefined;
  const now = new Date();
  const stamp = `${isoDate(now)} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const rel = `Team Runs/${stamp} ${safeName(board.objective.slice(0, 60))}.md`;
  const body = [
    '---',
    'type: team-run',
    `created: ${now.toISOString()}`,
    `agents: [${[...rc.involved].join(', ')}]`,
    'tags: [ultron/team-run]',
    '---',
    `# ${board.objective}`,
    '',
    `> Asked: ${userText.replace(/\n/g, ' ')}`,
    '',
    '## Plan',
    ...board.steps.map((s) => `- **${s.id} · ${AGENTS[s.agent].name}** (${s.status}): ${s.task}`),
    '',
    ...board.steps.flatMap((s) => [`## ${s.id} · ${AGENTS[s.agent].name} - ${AGENTS[s.agent].title}`, '', s.report || '(no report)', '']),
    ...(rc.helperReports.length ? ['## Helpers', '', ...rc.helperReports.flatMap((h) => [`### ${h.name} (built by ${AGENTS[h.parent].name}) - ${h.status}`, '', h.report, ''])] : []),
    board.notes.length ? '## Blackboard notes' : '',
    ...board.notes.map((n) => `- ${AGENTS[n.agent].name}: ${n.text}`),
    '',
    '## Ultron\'s answer',
    '',
    finalText,
    '',
    ...(timings.length ? ['## Timing', '', timings.map((t) => `${t.label.toLowerCase()} ${(t.ms / 1000).toFixed(1)}s`).join(' · '), ''] : []),
    ...(rc.checks.length ? ['## Verification', '', ...rc.checks.map((c) => `- ${c}`), ''] : []),
    '## Cost', '', `${describeUsage(rc.meter)}${rc.meter.stopped ? ` - stopped early at ${rc.meter.stopped}` : ''}`, '',
    rc.sources.length ? '## Sources' : '',
    ...rc.sources.map((s) => `- [${s.title.replace(/[[\]]/g, '')}](${s.url})`),
  ].join('\n');
  try {
    writeNote(rel, body);
    void syncIndex([rel]).catch(() => {});
    return rel;
  } catch {
    return undefined;
  }
}

/* ── Entry point ─────────────────────────────────────────────────────── */

export async function ask(input: AskInput): Promise<void> {
  const l = getSettings().limits;
  const meter = newMeter({ maxCalls: l.maxCalls, maxTokens: l.maxTokens, maxMs: l.minutes * 60_000 });
  return withMeter(meter, () => askRun(input, meter));
}

async function askRun(input: AskInput, meter: Meter): Promise<void> {
  const ctrl = new AbortController();
  active.set(input.runId, ctrl);
  const settings = getSettings();
  const rc: RunCtx = {
    runId: input.runId,
    signal: ctrl.signal,
    settings,
    provider: null,
    profile: '',
    hits: [],
    apps: [],
    hard: false,
    mathAsk: false,
    computed: false,
    readContent: false,
    addons: { hints: [], picked: [] },
    meter,
    checks: [],
    wf: workflow(settings.workflow),
    // Ultron's previous reply only counts when the message is a short "yes" to it - not when it's a greeting that mentioned a task.
    asked: /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|please( do)?|sounds good|go for it)\b/i.test(input.text.trim()) && input.text.trim().split(/\s+/).length <= 8
      ? [input.text, [...input.history].reverse().find((h) => h.role === 'assistant')?.content ?? ''].join('\n')
      : input.text,
    involved: new Set<AgentId>(['ultron']),
    sources: [],
    board: null,
    helpersUsed: 0,
    visited: [],
    helperReports: [],
    toolLinks: new Set<string>(),
    titled: new Map<string, string>(),
    toolIds: new Set<string>(),
    openedForUser: false,
  };
  let finalText = '';
  let teamReports = '';

  try {
    rc.provider = await preferredProvider('main');
    ev(input.runId, { type: 'start', provider: rc.provider });

    ev(input.runId, { type: 'phase', phase: 'recall', label: 'RECALLING' });
    ev(input.runId, { type: 'agent', agent: 'mnemosyne', status: 'working', task: 'Recalling relevant memories' });
    const [hits, apps, learned] = await Promise.all([
      searchMemory(input.text, 6).catch(() => [] as MemoryHit[]),
      connectedApps().catch(() => []),
      // Hindsight's learned memories come along automatically (it's fast - tens of milliseconds - when running).
      rc.wf.memory2 ? hindsight.recall(input.text, 4).catch(() => []) : Promise.resolve([]),
    ]);
    rc.hits = [...hits, ...learned.map((m) => ({ rel: 'Hindsight', title: 'Hindsight memory', text: m.when ? `${m.text} (${m.when.slice(0, 10)})` : m.text, score: 0.5 }))];
    rc.apps = apps.map((a) => a.slug);
    rc.hard = thinksHard(input.text);
    rc.mathAsk = rc.wf.verifyMath && isMathAsk(input.text);
    // Which add-ons fit - chosen here, so the operator never has to name one.
    rc.addons = rc.wf.newTools ? planAddons(input.text, addonOpts(rc, input.text)) : { hints: [], picked: [] };
    if (rc.addons.picked.length) ev(input.runId, { type: 'action', agent: 'ultron', text: `add-ons for this: ${rc.addons.picked.join(', ')}`, kind: 'note' });
    // The operator's own Discord bot counts as Discord being connected, with or without Composio.
    if (discordReady() && !rc.apps.includes('discord')) rc.apps.push('discord');
    rc.profile = profileForPrompt();
    ev(input.runId, { type: 'agent', agent: 'mnemosyne', status: 'done', task: hits.length ? `Recalled ${hits.length} memor${hits.length === 1 ? 'y' : 'ies'}` : 'Nothing new to recall' });
    if (hits.length) {
      rc.involved.add('mnemosyne');
      ev(input.runId, { type: 'action', agent: 'mnemosyne', text: `recalled: ${[...new Set(hits.map((h) => h.title))].slice(0, 4).join(', ')}` });
    }

    ev(input.runId, { type: 'phase', phase: 'thinking', label: 'THINKING' });
    ev(input.runId, { type: 'agent', agent: 'ultron', status: 'working', task: 'Deciding how to handle it' });
    const system = persona(settings, memoryBlock(rc.profile, hits)) + '\n' + leadInstructions(settings.team.mode, rc.apps);
    const messages: LlmMessage[] = [...trimHistory(input.history, rc.provider), { role: 'user', content: input.text + hintNote(rc.addons) }];
    const leadTools = [ASSEMBLE_TEAM, ...toSpecs(toolsFor('ultron'))];
    let streamed = '';
    const onToken = (t: string) => { streamed += t; ev(input.runId, { type: 'token', text: t }); };
    const resetStream = () => {
      if (streamed) { streamed = ''; ev(input.runId, { type: 'reset' }); }
    };

    // "Open this site and build that" can't be answered in words - however much a recalled past run looks like the answer.
    const appJob = usesApp(input.text, rc.apps);
    // The operator's own PC (files, folders, disk) is Hephaestus's - the lead has no file tools to answer with.
    const pcJob = !appJob && usesPc(input.text);
    // A page at a given address to read and answer from is Argus's (workflow v2) - the lead has no page reader.
    const pageJob = rc.wf.criteria && !appJob && !pcJob && !buildsOnSite(input.text) && (readsPage(input.text) || rc.addons.specialist === 'argus');
    const mustAct = needsAction(input.text) || Boolean(appJob) || pcJob || pageJob;
    let usedTool = false;
    let nudged = false;
    let computeNudged = false;
    let contentNudged = false;
    // v3: a hard problem is first solved by several independent programs; the lead answers with what they agree on.
    let solved = '';
    let solverAnswer: string | null = null;
    let solverNudged = false;
    if (rc.wf.solver && !appJob && !pcJob && !pageJob && wantsSolver(input.text)) {
      ev(input.runId, { type: 'action', agent: 'athena', text: 'solving it with independent programs', kind: 'progress' });
      const gem = cloud(rc.provider);
      const r = await solveWithPrograms(input.text, { k: gem ? 2 : 3, extra: gem ? 1 : 2, signal: ctrl.signal }).catch(() => null);
      if (r) {
        solved = solverNote(r);
        solverAnswer = r.answer;
        if (r.answer) {
          rc.computed = true;
          rc.involved.add('athena');
          rc.checks.push(`solved by programs: ${r.agree} of ${r.tried} agree on "${r.answer.slice(0, 60)}"`);
        }
        ev(input.runId, { type: 'action', agent: 'athena', text: r.answer ? `solver: ${r.agree} of ${r.tried} programs agree - ${r.answer.slice(0, 80)}` : `solver: no agreement (${r.outputs.map((o) => o.slice(0, 30)).join(' | ')})`, kind: r.answer ? 'ok' : 'warn' });
        if (solved) messages[messages.length - 1] = { role: 'user', content: `${String(messages[messages.length - 1].content)}${solved}` };
      }
    }
    const contentAsk = rc.wf.criteria && asksContent(input.text);
    for (let round = 0; round < 5 && !finalText; round++) {
      // "Make a Google Doc" is Hermes's job through the app. The lead's quick tools can't do it - in testing it
      // tried "open app google-docs" and then opened a made-up document link in the operator's browser.
      if (round === 0 && appJob) {
        ev(input.runId, { type: 'action', agent: 'ultron', text: `Straight to Hermes - ${appJob} is connected, so it's done through the app.`, kind: 'note' });
      } else if (round === 0 && pcJob) {
        ev(input.runId, { type: 'action', agent: 'ultron', text: 'Straight to Hephaestus - it is about your PC.', kind: 'note' });
      } else if (round === 0 && pageJob) {
        ev(input.runId, { type: 'action', agent: 'ultron', text: rc.addons.picked.includes('browser agent') ? 'Straight to Argus - a many-step job on one site, for the browser agent.' : 'Straight to Argus - there is a page to read.', kind: 'note' });
      }
      const res = round === 0 && (appJob || pcJob || pageJob) ? { text: '', toolCalls: [] as ToolCall[], native: undefined, provider: rc.provider ?? 'gemini' } : await chat({
        system,
        messages,
        tools: leadTools,
        temperature: 0.7,
        effort: rc.hard ? 'high' : undefined,
        deep: thinksDeep(input.text),
        signal: ctrl.signal,
        onToken,
        onNotice: (t) => { ev(input.runId, { type: 'notice', text: t }); resetStream(); },
      });
      let forced = round === 0 && (Boolean(appJob) || pcJob || pageJob);
      if (!forced && !res.toolCalls.length) {
        // A worked-out number from the model's head: compute it first (once).
        if (rc.mathAsk && !rc.computed && !computeNudged && round < 4) {
          computeNudged = true;
          resetStream();
          ev(input.runId, { type: 'action', agent: 'ultron', text: 'verify: those numbers were not computed - working them out with code first', kind: 'warn' });
          messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: COMPUTE_FIRST });
          continue;
        }
        // Asked what something says, and nothing has read it yet: read it first (once).
        if (contentAsk && !rc.readContent && !contentNudged && round < 4) {
          contentNudged = true;
          resetStream();
          ev(input.runId, { type: 'action', agent: 'ultron', text: 'check: nothing has been read yet - reading it before answering', kind: 'warn' });
          messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: '[CHECK] You have not read what the operator asked about - opening, playing or remembering it is not reading it. Read it now (youtube_transcript for a video, read_webpage for a page, read_feed for a feed, skill_read for a guide) and answer only from what it says - or say plainly that you could not read it.' });
          continue;
        }
        // The programs agreed, but the reply doesn't lead with that answer (hard set, opt: "You're wrong: there's
        // 90 minutes left for gaming" after 3 of 3 programs got -5). Once.
        if (solverAnswer && !solverNudged && round < 4 && !statesAnswer(res.text, solverAnswer)) {
          solverNudged = true;
          resetStream();
          ev(input.runId, { type: 'action', agent: 'ultron', text: `check: the reply does not give the computed answer (${solverAnswer.slice(0, 40)}) - answering again`, kind: 'warn' });
          messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: `[CHECK] The independent programs agreed the answer is ${solverAnswer}, but your reply does not start with it. Answer again: first sentence gives ${solverAnswer} in plain words (a negative amount left over means there is not enough - say by how much), then explain the method briefly. If you are certain it is wrong, show why with run_code.` });
          continue;
        }
        if (!mustAct || usedTool) {
          finalText = res.text;
          break;
        }
        resetStream();
        if (!nudged) {
          nudged = true;
          messages.push(
            { role: 'assistant', content: res.text },
            { role: 'user', content: '[CHECK] Nothing has been done for this message yet - recalled memories are past runs, not this one. The operator asked you to act on a website: call assemble_team (or the right quick tool) now, and never describe results nobody has produced.' },
          );
          continue;
        }
        // Asked twice and still only talking: the team takes it.
        forced = true;
        ev(input.runId, { type: 'action', agent: 'ultron', text: 'This needs doing, not describing - sending it to the team.', kind: 'note' });
      }
      if (res.text.trim() && !forced) ev(input.runId, { type: 'action', agent: 'ultron', text: res.text.trim().slice(0, 160) });
      resetStream();
      const teamCall = forced
        ? { args: { objective: input.text, specialist: usesApp(input.text, rc.apps) ? 'hermes' : pcJob ? 'hephaestus' : buildsOnSite(input.text) ? 'daedalus' : pageJob ? 'argus' : '' } as Record<string, unknown> }
        : res.toolCalls.find((c) => c.name === 'assemble_team');
      if (teamCall) {
        // A page to read: the whole page, not its first screen (a live check read only the top rows and missed the answer).
        const readNote = pageJob && !rc.addons.picked.includes('browser agent')
          ? '\n\n[HOW] Read the whole page with read_webpage - it pulls out the parts of a long page about the question. browser_open only shows the first screen, which is not the whole page.'
          : '';
        const objective = (String(teamCall.args?.objective ?? '').trim() || input.text) + solved + readNote;
        const named = String(teamCall.args?.specialist ?? '').toLowerCase() as AgentId;
        const direct = SPECIALISTS.includes(named) ? named : undefined;
        // 'waiting' reads as "NEEDS YOU" in the HUD - that label is reserved for approvals.
        ev(input.runId, { type: 'agent', agent: 'ultron', status: 'working', task: 'Leading the team' });
        teamReports = await runTeam(rc, objective, input.history, direct);

        // One builder, working alone, whose report its browser log backs: on the local model that report IS the answer.
        // A second small-model pass over it is where "the preview is unavailable" turned into "the preview renders correctly".
        const solo = rc.board?.steps.length === 1 ? rc.board.steps[0] : undefined;
        if (!cloud(rc.provider) && solo?.solo && solo.verified && solo.own) {
          finalText = plainSpoken(solo.own);
          break;
        }

        ev(input.runId, { type: 'phase', phase: 'writing', label: 'ULTRON REPORTING' });
        ev(input.runId, { type: 'agent', agent: 'ultron', status: 'working', task: 'Writing the answer' });
        const synth = await chat({
          // This run's reports only - an old run recalled from memory is exactly what a small model retells as today's result.
          system: persona(settings, memoryBlock(rc.profile, withoutHistory(hits))) + '\n' + synthesisInstructions(),
          messages: [
            ...trimHistory(input.history, rc.provider),
            {
              role: 'user',
              content: `${input.text}\n\n---\nTEAM REPORTS (internal - summarise them for me, do not read them out):\n${teamReports.slice(0, cloud(rc.provider) ? 24_000 : 7000)}` +
                (rc.meter.stopped ? `\n\nBUDGET: the team stopped early at ${rc.meter.stopped} (a limit set in Settings). Say what is unfinished.` : '') +
                (rc.visited.length
                  ? `\n\nWHAT THE TEAM ACTUALLY DID ON THE WEB (internal, for your accuracy only - never recite or mention this list; a site not in it was never visited, so claim no results and no failures for it):\n${rc.visited.slice(0, 30).map((v) => `- ${v}`).join('\n')}`
                  : ''),
            },
          ],
          temperature: 0.6,
          effort: rc.hard ? 'high' : undefined,
          signal: ctrl.signal,
          onToken,
          onNotice: (t) => { ev(input.runId, { type: 'notice', text: t }); resetStream(); },
        });
        finalText = synth.text;
        break;
      }
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, native: res.native, nativeProvider: res.provider });
      for (const call of res.toolCalls) {
        const result = await runTool(rc, 'ultron', call);
        // Looking things up doesn't do the job - opening the site on the operator's screen, playing it, etc. does.
        // ...and only when it worked: a failed "open app" did nothing.
        const failed = Boolean(result && typeof result === 'object' && (result as { error?: unknown }).error);
        if (!failed && !/^(memory_search|task_list|current_time|calculate|run_code|google_search|get_weather)$/.test(call.name)) usedTool = true;
        messages.push({ role: 'tool', callId: call.id, name: call.name, content: clip(result, toolBudget(rc.provider, call.name)) });
      }
    }
    // Out of rounds with tool results but no answer (live eval, 29 Sep 2026: four run_code attempts, then "Done.")
    // - write the answer from what the tools returned instead of saying nothing.
    if (rc.wf.criteria && !finalText && !streamed.trim() && messages.some((m) => m.role === 'tool') && !ctrl.signal.aborted) {
      resetStream();
      const wrap = await chat({
        system,
        messages: [...messages, { role: 'user', content: '[FINISH] Stop using tools. Answer the operator now from the tool results above. If they do not settle it, say plainly what is still unknown.' }],
        temperature: 0.4,
        signal: ctrl.signal,
        onToken,
      }).catch(() => null);
      finalText = wrap?.text.trim() ?? '';
    }
    if (!finalText) finalText = streamed.trim() || 'Done.';

    // After real web work, every link in the answer must be one the team actually saw.
    if (teamReports || rc.visited.length) {
      // Only what tools actually returned counts - an agent's report can carry an invented link as easily as the answer can.
      const known = [
        ...rc.toolLinks,
        ...addressesIn(input.text),
        ...rc.sources.map((s) => s.url),
        ...browser.seenUrls(input.runId),
      ];
      const checked = verifyLinks(finalText, known, [...rc.titled].map(([url, title]) => ({ url, title })), rc.toolIds);
      if (checked.removed.length) {
        finalText = checked.text;
        const n = checked.removed.length;
        const fixed = checked.repaired ? ` (${checked.repaired} swapped for the real link to the same story)` : '';
        ev(input.runId, { type: 'notice', text: `Caught ${n} made-up link${n > 1 ? 's' : ''}${fixed}: ${checked.removed.slice(0, 3).join(', ')}` });
      }
      if (!rc.openedForUser) finalText = withoutTabClaims(finalText) || finalText;
      finalText = withAskedLink(input.text, finalText, [...rc.titled].map(([url, title]) => ({ url, title })));
    }

    // Worked maths in the answer is recomputed; a wrong step is corrected before anyone sees it.
    if (rc.wf.verifyMath && finalText) {
      const eq = checkEquations(finalText);
      if (eq.wrong.length) {
        const fixed = await fixMath(finalText, eq.wrong, ctrl.signal).catch(() => null);
        const ok = fixed && !checkEquations(fixed).wrong.length;
        finalText = ok ? fixed! : `${finalText}\n\nCorrection: ${eq.wrong.map(describeWrong).join('; ')}.`;
        rc.checks.push(`corrected ${eq.wrong.length} wrong calculation${eq.wrong.length > 1 ? 's' : ''}: ${eq.wrong.map(describeWrong).join('; ')}`);
      } else if (eq.checked) {
        rc.checks.push(`${eq.checked} worked calculation${eq.checked > 1 ? 's' : ''} in the answer re-checked - correct`);
      }
      if (rc.computed) rc.checks.unshift('numbers computed with code, not estimated');
    }
    if (rc.checks.length) ev(input.runId, { type: 'action', agent: 'ultron', text: `verified: ${rc.checks.join(' · ')}`, kind: 'ok' });
    ev(input.runId, { type: 'action', agent: 'ultron', text: `cost: ${describeUsage(rc.meter)}${rc.meter.stopped ? ` - stopped early at ${rc.meter.stopped}` : ''}`, kind: 'note' });

    const timings = timingsFor(input.runId);
    const runNote = saveTeamRun(rc, input.text, finalText, timings);
    // Work that didn't get finished is remembered, with where to pick it up - not silently dropped.
    const failedSteps = rc.board?.steps.filter((s) => s.status === 'failed') ?? [];
    if (rc.wf.memory2 && (rc.meter.stopped || failedSteps.length)) {
      const why = rc.meter.stopped ? `stopped at ${rc.meter.stopped}` : `${failedSteps.map((s) => `${AGENTS[s.agent].name}'s step failed (${s.report.replace(/^FAILED:\s*/, '').slice(0, 80)})`).join('; ')}`;
      try {
        upsertMemory({
          category: 'Projects',
          title: 'Open Work',
          facts: [`Unfinished: "${input.text.replace(/\s+/g, ' ').slice(0, 140)}" - ${why}`],
          source: runNote ? `team run [[${runNote.replace(/\.md$/, '')}]]` : `conversation on ${isoDate()}`,
        });
      } catch { /* memory is best-effort; the answer already says what is unfinished */ }
    }
    const agents = [...rc.involved].filter((a) => a !== 'ultron').map((a) => AGENTS[a].name);
    ev(input.runId, {
      type: 'final',
      text: finalText,
      agents: [...rc.involved],
      sources: rc.sources,
      runNote,
      timings,
    });
    recordExchange({
      at: new Date(),
      user: input.text,
      reply: finalText,
      agents,
      runNote,
      teamSummary: teamReports ? teamReports.slice(0, 1500) : undefined,
    });
  } catch (e) {
    const aborted = (e instanceof LlmError && e.kind === 'aborted') || ctrl.signal.aborted;
    ev(input.runId, { type: 'error', message: aborted ? 'cancelled' : e instanceof Error ? e.message : String(e), cancelled: aborted });
  } finally {
    active.delete(input.runId);
    denyAllForRun(input.runId);
    endRun(input.runId);
    // Every agent's browser tab for this task closes with it (the HUD keeps their last frames).
    void browser.closeRunTabs(input.runId).catch(() => {});
    ev(input.runId, { type: 'done' });
    timelines.delete(input.runId);
  }
}

/** Short single-shot generations for the HUD (greetings, news blurbs) - same brain, no team. */
export async function once(opts: { system: string; user?: string; tier?: 'main' | 'fast'; temperature?: number; effort?: Effort }): Promise<string> {
  const res = await chat({
    system: opts.system,
    messages: [{ role: 'user', content: opts.user ?? 'Go.' }],
    tier: opts.tier ?? 'fast',
    temperature: opts.temperature ?? 0.6,
    effort: opts.effort ?? 'low',
  });
  return res.text.trim();
}

export function newRunId(): string {
  return newId('run');
}

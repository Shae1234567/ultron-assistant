import type { AgentId } from './types';
import { actsInApp } from './intent';

export interface PlanStep {
  id: string;
  agent: AgentId;
  task: string;
  dependsOn: string[];
  /** The checkable result that shows the step is finished (workflow v2) - given to the agent and checked in review. */
  doneWhen?: string;
}

export interface DroppedStep { id: string; agent: AgentId; why: string }

const SCHOOL_WORK = /\b(d2l|brightspace|assignments?|due|grades?|marks?|courses?|class(es)?|announcements?|homework|quiz(zes)?|school)\b/i;
const ASKED_FOR_TASK = /\b(remind\w*|tasks?|to-?dos?|deadlines?|schedul\w*|alarms?|forget|d2l|due)\b/i;
const CREATES_TASK = /\b(add|create|set|schedule|make)\b[^.]{0,60}\b(tasks?|reminders?|to-?dos?|alarms?)\b|\bremind\b/i;
const ASKED_TO_KEEP = /\b(remember|save|note|write (it |this |that )?down|keep track|log|store|record)\b/i;
const WRITES_MEMORY = /\b(update|record|save|log|write|store|add)\b/i;
const NO_OP = /^\s*(do not|don't|no need|nothing to do|skip( this)?|none)\b|\b(does not|doesn't) (involve|require|need)\b/i;

/**
 * Strips "open them in tabs for the operator to review" from assignments. The agents'
 * tabs are Ultron's own and close when the task ends, so that hand-off can't
 * happen - and a planner asking for it made the final answer claim it had.
 */
export function withoutHandOffs(steps: PlanStep[]): PlanStep[] {
  const HAND_OFF = /\b(open|leave|keep)\b[^.;\n]*\btabs?\b|\bfor (the operator|the user|me)('s)? to (review|read|look)/i;
  // "identify the top 3, open each in a browser tab for the operator, capture their URLs" - cut just that clause.
  const CLAUSE = /,?\s*(and\s+)?(then\s+)?(open|leave|keep)\s+[^,.;\n]*\btabs?\b[^,.;\n]*/gi;
  const out = steps.flatMap((s) => {
    const trimmed = s.task.replace(CLAUSE, '').replace(/\s+,/g, ',').replace(/([.;])(\s*[.;])+/g, '$1').replace(/\s{2,}/g, ' ').trim();
    const parts = trimmed.split(/(?<=[.;])\s+|,\s*(?=then\b)|\n/);
    const kept = parts.filter((p) => !HAND_OFF.test(p));
    const task = kept.join(' ').replace(/\s+/g, ' ').replace(/[,\s]+([.;])/g, '$1').trim();
    if (!/[a-z]{3}/i.test(task)) return []; // the whole step was the hand-off ("Hermes: open six tabs for the operator") - there is no work in it
    return task !== s.task ? [{ ...s, task }] : [s];
  });
  return out.length ? out : steps;
}

/**
 * Folds independent steps for the same agent into one multi-part assignment.
 * Planners like to write "Argus: Hacker News" and "Argus: GitHub" as two
 * parallel steps; one step with two parts lets Argus hand each part to its
 * own helper (own tab, own reasoning) and combine them itself - the team
 * design - instead of two copies of Argus racing each other.
 */
export function mergeSameAgent(steps: PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  const mergedInto = new Map<string, string>();
  for (const s of steps) {
    const host = s.dependsOn.length === 0 ? out.find((o) => o.agent === s.agent && o.dependsOn.length === 0) : undefined;
    if (!host) {
      out.push({ ...s, dependsOn: [...s.dependsOn] });
      continue;
    }
    if (!/^Do these parts/.test(host.task)) host.task = `Do these parts - hand separate sites or sources to helpers:\n1. ${host.task}`;
    host.task += `\n${host.task.split('\n').length}. ${s.task}`;
    mergedInto.set(s.id, host.id);
  }
  for (const s of out) s.dependsOn = [...new Set(s.dependsOn.map((d) => mergedInto.get(d) ?? d))].filter((d) => d !== s.id);
  return out;
}

/**
 * Removes plan steps that would do work nobody asked for. Planners - Gemini
 * included - keep adding a "set a reminder to review this" step or an "update
 * the vault" step despite being told not to, and those have real side effects
 * (a stray reminder fires the next morning). Prompt rules proved not to be
 * enough, so this enforces it.
 *
 * `asked` is the operator's message plus Ultron's previous reply, so "yes, do
 * it" after "want me to set a reminder?" still counts as asking for one.
 * If every step would go, the plan is left alone - the lead chose it - unless
 * `allowEmpty` is set (review follow-ups, where nothing is a fine answer).
 */
export function trimPlan(
  steps: PlanStep[],
  opts: { asked: string; apps: string[]; allowEmpty?: boolean },
): { steps: PlanStep[]; dropped: DroppedStep[] } {
  const dropped: DroppedStep[] = [];
  for (const s of steps) {
    // "Chronos: do not create any reminders" - a planner writing down what NOT to do is not a step.
    if (s.task.length < 200 && NO_OP.test(s.task)) {
      dropped.push({ id: s.id, agent: s.agent, why: 'it was an instruction to do nothing' });
    } else if (s.agent === 'hermes' && !opts.apps.length && !SCHOOL_WORK.test(s.task)) {
      dropped.push({ id: s.id, agent: s.agent, why: 'no apps are connected' });
    } else if (s.agent === 'chronos' && CREATES_TASK.test(s.task) && !ASKED_FOR_TASK.test(opts.asked)) {
      dropped.push({ id: s.id, agent: s.agent, why: 'nobody asked for a task or reminder' });
    } else if (s.agent === 'mnemosyne' && WRITES_MEMORY.test(s.task) && !ASKED_TO_KEEP.test(opts.asked)) {
      dropped.push({ id: s.id, agent: s.agent, why: 'memory is filed automatically after the run' });
    }
  }
  if (!dropped.length || (dropped.length === steps.length && !opts.allowEmpty)) return { steps, dropped: [] };
  const gone = new Set(dropped.map((d) => d.id));
  return {
    steps: steps.filter((s) => !gone.has(s.id)).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => !gone.has(d)) })),
    dropped,
  };
}

/**
 * Work IN a connected app goes to Hermes, who does it through the app itself.
 * Planners kept handing "create a Google Doc" to Daedalus, the browser builder,
 * who needs a Google login in the agents' browser and then fights the editor by
 * hand (a real run, 26 Sep 2026: the doc was never made). Only Daedalus steps
 * move - a research step that mentions a doc still needs Argus's browser.
 */
export function routeAppSteps(steps: PlanStep[], apps: string[]): { steps: PlanStep[]; moved: { id: string; app: string }[] } {
  const moved: { id: string; app: string }[] = [];
  const out = steps.map((s) => {
    if (s.agent !== 'daedalus') return s;
    const app = actsInApp(s.task, apps);
    if (!app) return s;
    moved.push({ id: s.id, app });
    return { ...s, agent: 'hermes' as AgentId };
  });
  return { steps: out, moved };
}

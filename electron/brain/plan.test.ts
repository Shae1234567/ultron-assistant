import { describe, expect, it } from 'vitest';
import { trimPlan, type PlanStep } from './plan';

const step = (id: string, agent: PlanStep['agent'], task: string, dependsOn: string[] = []): PlanStep => ({ id, agent, task, dependsOn });

describe('trimPlan', () => {
  it('drops the unrequested reminder and vault update from a plain question (a real plan from testing)', () => {
    const plan = [
      step('s1', 'hephaestus', 'Count the files in C:\\Users\\alex\\Downloads and identify the three largest.'),
      step('s2', 'mnemosyne', 'Recall previous context about the Downloads folder, then update the Obsidian vault with the new file count.'),
      step('s4', 'chronos', 'Create a reminder for tomorrow morning to review the Downloads folder with the operator.', ['s1']),
    ];
    const r = trimPlan(plan, { asked: 'How many files are in my Downloads folder, and what are the three biggest?', apps: [] });
    expect(r.steps.map((s) => s.id)).toEqual(['s1']);
    expect(r.dropped.map((d) => d.agent)).toEqual(['mnemosyne', 'chronos']);
  });

  it('keeps a reminder the operator asked for, including a yes to an offer', () => {
    const plan = [step('s1', 'argus', 'Find the test date'), step('s2', 'chronos', 'Set a reminder for the day before the test', ['s1'])];
    expect(trimPlan(plan, { asked: 'find my test date and remind me the day before', apps: [] }).steps).toHaveLength(2);
    expect(trimPlan(plan, { asked: 'yes do it\nWant me to set a reminder for the night before?', apps: [] }).steps).toHaveLength(2);
  });

  it('keeps memory writes when the operator asked to keep something', () => {
    const plan = [step('s1', 'mnemosyne', 'Save that the math teacher is Mr. Patel'), step('s2', 'argus', 'Look up linear equations practice')];
    expect(trimPlan(plan, { asked: 'Remember this: my math teacher is Mr. Patel', apps: [] }).steps).toHaveLength(2);
  });

  it('keeps Chronos reading tasks and Mnemosyne recalling', () => {
    const plan = [step('s1', 'chronos', 'List what is on the schedule today'), step('s2', 'mnemosyne', 'Recall what we know about the tryouts')];
    expect(trimPlan(plan, { asked: 'what should I focus on today?', apps: [] }).steps).toHaveLength(2);
  });

  it('drops Hermes when nothing is connected, unless it is D2L work or the whole plan', () => {
    const plan = [step('s1', 'argus', 'Search for Qwen releases'), step('s2', 'hermes', 'Check the Ollama Discord for new threads', ['s1'])];
    expect(trimPlan(plan, { asked: 'newest qwen?', apps: [] }).steps.map((s) => s.id)).toEqual(['s1']);
    expect(trimPlan(plan, { asked: 'newest qwen?', apps: ['discord'] }).steps).toHaveLength(2);
    const d2l = [step('s1', 'argus', 'Find study guides'), step('s2', 'hermes', 'List assignments due this week on D2L')];
    expect(trimPlan(d2l, { asked: 'what is due?', apps: [] }).steps).toHaveLength(2);
    const onlyHermes = [step('s1', 'hermes', 'Check my Gmail for the coach email')];
    expect(trimPlan(onlyHermes, { asked: 'did coach email me?', apps: [] }).steps).toHaveLength(1);
  });

  it('can drop everything for review follow-ups', () => {
    const followups = [step('r1', 'chronos', 'Add a task to double-check the answer tomorrow')];
    expect(trimPlan(followups, { asked: 'newest qwen?', apps: [], allowEmpty: true }).steps).toEqual([]);
  });

  it('drops steps that only say what not to do (a real plan from testing)', () => {
    const plan = [
      step('s1', 'argus', 'Browse news.ycombinator.com and github.com/trending'),
      step('s5', 'chronos', 'Do not create any reminders, as the objective does not involve tasks, deadlines, or scheduling.'),
    ];
    const r = trimPlan(plan, { asked: 'top of HN and GitHub trending?', apps: [] });
    expect(r.steps.map((s) => s.id)).toEqual(['s1']);
    expect(r.dropped[0].why).toContain('nothing');
  });

  it('prunes dependencies on dropped steps', () => {
    const plan = [step('s1', 'hermes', 'Check Discord'), step('s2', 'argus', 'Search the web', ['s1'])];
    expect(trimPlan(plan, { asked: 'anything new?', apps: [] }).steps[0].dependsOn).toEqual([]);
  });
});

describe('mergeSameAgent', async () => {
  const { mergeSameAgent } = await import('./plan');

  it('folds parallel steps for one agent into a single multi-part assignment (a real plan from testing)', () => {
    const merged = mergeSameAgent([
      step('s1', 'argus', 'Navigate to news.ycombinator.com and find the top 3 stories.'),
      step('s2', 'argus', 'Navigate to github.com/trending and find the top 3 repositories.'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].task).toContain('1. Navigate to news.ycombinator.com');
    expect(merged[0].task).toContain('2. Navigate to github.com/trending');
  });

  it('keeps dependent steps separate and points dependencies at the merged step', () => {
    const merged = mergeSameAgent([
      step('s1', 'argus', 'Find A'),
      step('s2', 'argus', 'Find B'),
      step('s3', 'athena', 'Compare A and B', ['s2']),
      step('s4', 'argus', 'Dig deeper into the winner', ['s3']),
    ]);
    expect(merged.map((s) => s.id)).toEqual(['s1', 's3', 's4']);
    expect(merged.find((s) => s.id === 's3')?.dependsOn).toEqual(['s1']);
    expect(merged.find((s) => s.id === 's4')?.dependsOn).toEqual(['s3']);
  });

  it('leaves different agents alone', () => {
    expect(mergeSameAgent([step('s1', 'argus', 'a'), step('s2', 'hermes', 'b')])).toHaveLength(2);
  });
});

describe('withoutHandOffs', async () => {
  const { withoutHandOffs } = await import('./plan');

  it('removes "open them in tabs for the operator" from an assignment and keeps the real work (from testing)', () => {
    const [s] = withoutHandOffs([step('s1', 'argus', 'Navigate to news.ycombinator.com and identify the top 3 front-page stories. Open all 6 items in separate browser tabs for the operator to review.')]);
    expect(s.task).toBe('Navigate to news.ycombinator.com and identify the top 3 front-page stories.');
  });

  it('leaves ordinary tasks untouched', () => {
    const original = step('s1', 'argus', 'Find the top 3 trending repositories and report their links.');
    expect(withoutHandOffs([original])[0]).toBe(original);
  });

  it('cuts a hand-off clause out of the middle of a sentence (from testing)', () => {
    const [s] = withoutHandOffs([step('s1', 'argus', 'Browse news.ycombinator.com to identify the top 3 front-page stories, open each in a browser tab for the operator, capture their direct URLs, and record a one-sentence summary.')]);
    expect(s.task).toBe('Browse news.ycombinator.com to identify the top 3 front-page stories, capture their direct URLs, and record a one-sentence summary.');
  });

  it('drops a step that is nothing but a hand-off (from testing)', () => {
    const r = withoutHandOffs([
      step('s1', 'argus', 'Identify the top 3 stories and repos with their URLs.'),
      step('s2', 'hermes', "Open six new browser tabs in the operator's session so they can review them immediately.", ['s1']),
    ]);
    expect(r.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('routeAppSteps', async () => {
  const { routeAppSteps } = await import('./plan');

  it('moves the doc step off the browser builder when Docs is connected (the plan from 26 Sep 2026)', () => {
    const steps = [
      { id: 's1', agent: 'hermes' as const, task: 'Access the operator\'s D2L to list current Grade 9 math and science topics.', dependsOn: [] },
      { id: 's3', agent: 'daedalus' as const, task: 'Create a new Google Doc titled "Grade 9 Math & Science Prep Plan" and populate it with the topics.', dependsOn: [] },
    ];
    const r = routeAppSteps(steps, ['googledocs']);
    expect(r.steps.map((s) => s.agent)).toEqual(['hermes', 'hermes']);
    expect(r.moved).toEqual([{ id: 's3', app: 'googledocs' }]);
  });

  it('keeps browser work with no connected app on Daedalus', () => {
    const steps = [{ id: 's1', agent: 'daedalus' as const, task: 'Build a page on JSFiddle with a red heading.', dependsOn: [] }];
    expect(routeAppSteps(steps, ['googledocs']).steps[0].agent).toBe('daedalus');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A fake ~/UltronTools with three skills: one open, one proprietary, one missing its licence.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-tools-'));
process.env.ULTRON_TOOLS_DIR = ROOT;
const skill = (dir: string, fm: string, body = '# Guide\n\nDo the thing.') => {
  fs.mkdirSync(path.join(ROOT, 'skills', 'pack', 'skills', dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'skills', 'pack', 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
  fs.writeFileSync(path.join(ROOT, 'skills', 'pack', 'skills', dir, 'references', 'methods.md'), 'Method details.');
};
skill('statistics', 'name: statistical-analysis\ndescription: Run t-tests, ANOVA and regressions, and report effect sizes.\nlicense: MIT');
skill('closed', 'name: closed-tool\ndescription: A proprietary statistics helper.\nlicense: Proprietary. LICENSE.txt has complete terms');
skill('mystery', 'name: mystery-skill\ndescription: No licence given for statistics work.');

// A second library shaped like lateral-thinking: no licence in the skills, MIT in the repo's LICENSE file.
const LATERAL = path.join(ROOT, 'skills', 'lateral-thinking');
const lateralSkill = (dir: string, fm: string, body: string) => {
  fs.mkdirSync(path.join(LATERAL, 'skills', dir), { recursive: true });
  fs.writeFileSync(path.join(LATERAL, 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
};
fs.mkdirSync(LATERAL, { recursive: true });
fs.writeFileSync(path.join(LATERAL, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 danium\n\nPermission is hereby granted, free of charge, to any person');
lateralSkill('lateral', 'name: lateral\ndescription: Lateral thinking toolkit router.', '# Lateral\n\n## Condensed core loops\n\n**six-hats** — Take the decision through six unblended passes: White, Red, Black, Yellow, Green, Blue.\n\n**worst-idea** — Design 5-8 terrible solutions and invert their mechanisms.\n\n## What NOT to do\n\n- Nothing.');
lateralSkill('six-hats', 'name: six-hats\ndescription: Six Thinking Hats for a decision.', '# Six hats\n\nWhite hat first.');

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
const addons = await import('./addons');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('skills libraries', () => {
  it('indexes only openly licensed skills - from the front matter, or else the library\'s LICENSE file', () => {
    const skills = addons.loadSkills();
    expect(skills.map((s) => s.name).sort()).toEqual(['lateral', 'six-hats', 'statistical-analysis']);
    expect(skills.find((s) => s.name === 'six-hats')).toMatchObject({ license: 'MIT', collection: 'lateral-thinking' });
    expect(skills.find((s) => s.name === 'statistical-analysis')).toMatchObject({ license: 'MIT', collection: 'pack' });
  });

  it('lets a router skill read its sibling techniques - but not an unlicensed file next to them', () => {
    expect(addons.readSkill('lateral', '../six-hats/SKILL.md')).toMatchObject({ text: expect.stringContaining('White hat first') });
    expect(addons.readSkill('statistical-analysis', '../mystery/SKILL.md')).toEqual({ error: 'That file is outside the skill.' });
    expect(addons.readSkill('lateral', '../../../pack/skills/statistics/SKILL.md')).toEqual({ error: 'That file is outside the skill.' });
  });

  it('hands out one technique in its condensed form, for the local model', () => {
    expect(addons.lateralLoop('six-hats')).toBe('Take the decision through six unblended passes: White, Red, Black, Yellow, Green, Blue.');
    expect(addons.lateralLoop('worst-idea')).toMatch(/^Design 5-8 terrible/);
    expect(addons.lateralLoop('nonsense')).toBeNull();
  });

  it('keeps each library to its own job', () => {
    expect(addons.matchSkills('anova regressions', 2, 'pack').map((s) => s.name)).toEqual(['statistical-analysis']);
    expect(addons.matchSkills('anova regressions', 2, 'lateral-thinking')).toEqual([]);
  });

  it('finds a skill by what the job is', () => {
    expect(addons.searchSkills('anova and regressions')[0]?.name).toBe('statistical-analysis');
  });

  it('reads a skill and its files, but nothing outside it', () => {
    const r = addons.readSkill('statistical-analysis');
    expect(r).toMatchObject({ name: 'statistical-analysis', files: expect.arrayContaining(['SKILL.md', 'references/methods.md']) });
    expect(addons.readSkill('statistical-analysis', 'references/methods.md')).toMatchObject({ text: 'Method details.' });
    expect(addons.readSkill('statistical-analysis', '../closed/SKILL.md')).toEqual({ error: 'That file is outside the skill.' });
    expect(addons.readSkill('closed-tool')).toMatchObject({ error: expect.stringMatching(/No skill called/) });
  });
});

describe('YouTube captions', () => {
  it('turns WebVTT into plain text without timings, tags or rolling repeats', () => {
    const vtt = [
      'WEBVTT', 'Kind: captions', 'Language: en', '',
      '00:00:00.000 --> 00:00:03.520', 'Black holes are one of the strangest things.', '',
      '00:00:03.520 --> 00:00:05.000', 'Black holes are one of the strangest things.', 'They<00:00:04.100><c> don\'t</c> seem to make sense.', '',
      '00:00:05.000 --> 00:00:07.000', 'Where &amp; how do they form?',
    ].join('\n');
    expect(addons.vttToText(vtt)).toBe('Black holes are one of the strangest things. They don\'t seem to make sense. Where & how do they form?');
  });
});

describe('status for the Apps panel', () => {
  it('reports what is and is not installed', () => {
    const s = addons.addonStatus();
    expect(s.map((a) => a.id)).toEqual(['browser-use', 'agent-reach', 'hindsight', 'skills', 'lateral']);
    // The fake science library is called "pack", not scientific-agent-skills.
    expect(s.find((a) => a.id === 'skills')).toMatchObject({ installed: false, detail: '0 skill guides the agents can look up.' });
    expect(s.find((a) => a.id === 'lateral')).toMatchObject({ installed: true, detail: expect.stringMatching(/^2 brainstorming techniques/) });
    expect(s.find((a) => a.id === 'browser-use')?.installed).toBe(false);
    expect(s.find((a) => a.id === 'browser-use')?.detail).toMatch(/runs without asking/);
    expect(addons.addonStatus(true).find((a) => a.id === 'browser-use')?.detail).toMatch(/asks you before every run/);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_HELPERS_PER_CALL, helperTools, sanitizeHelpers } from './helpers';

const ARGUS = ['web_search', 'read_webpage', 'browser_open', 'deep_research'];
const HEPHAESTUS = ['list_folder', 'read_file', 'search_files', 'write_file', 'delete_path', 'run_command'];
const HERMES = ['apps_connected', 'apps_find_actions', 'apps_run_action', 'd2l_due'];

describe('helperTools', () => {
  it('lets any agent hand out browsing - even one that cannot browse itself', () => {
    const r = helperTools(['memory_search', 'calculate'], ['browse']);
    expect(r.tools).toContain('browser_open');
    expect(r.tools).toContain('browser_look');
  });

  it('only hands out file or app access when the parent has it, and never write tools', () => {
    expect(helperTools(ARGUS, ['files']).skills).toEqual(['browse']);
    const files = helperTools(HEPHAESTUS, ['files']);
    expect(files.tools).toEqual(['list_folder', 'read_file', 'search_files', 'file_info']);
    expect(files.tools).not.toContain('delete_path');
    expect(files.tools).not.toContain('run_command');
    expect(helperTools(HERMES, ['apps']).tools).toContain('apps_find_actions');
    expect(helperTools(ARGUS, ['apps']).tools).not.toContain('apps_run_action');
  });

  it('defaults to browsing when the skills are missing or unknown', () => {
    expect(helperTools(ARGUS, ['teleport']).skills).toEqual(['browse']);
  });
});

describe('sanitizeHelpers', () => {
  it('keeps real assignments, names them uniquely, and caps each call', () => {
    const raw = Array.from({ length: 6 }, (_, i) => ({ name: 'Scout', task: `platform ${i}`, skills: ['browse'] }));
    const r = sanitizeHelpers(raw, ARGUS, 8);
    expect(r.helpers).toHaveLength(MAX_HELPERS_PER_CALL);
    expect(new Set(r.helpers.map((h) => h.name.toLowerCase())).size).toBe(MAX_HELPERS_PER_CALL);
    expect(r.refused).toBe(2);
  });

  it('respects what is left of the run budget and drops empty tasks', () => {
    const r = sanitizeHelpers([{ name: 'A', task: 'x' }, { name: 'B', task: '' }, { name: 'C', task: 'y' }], ARGUS, 1);
    expect(r.helpers.map((h) => h.name)).toEqual(['A']);
    expect(r.refused).toBe(1);
    expect(sanitizeHelpers('not a list', ARGUS, 8).helpers).toEqual([]);
  });
});

describe('fanOutHint', async () => {
  const { fanOutHint, namedSites } = await import('./helpers');

  it('spots several named sites in an assignment', () => {
    expect(namedSites('Open Reddit (r/all) and Hacker News (news.ycombinator.com) and find the top posts')).toEqual(['Reddit', 'Hacker News']);
    expect(namedSites('what is viral on TikTok, YouTube and Instagram this week')).toEqual(['TikTok', 'YouTube', 'Instagram']);
  });

  it('only nudges when there are two or more sites and the agent can browse', () => {
    expect(fanOutHint('top posts on Reddit and Hacker News', true)).toContain('spawn_helpers');
    expect(fanOutHint('top posts on Reddit', true)).toBe('');
    expect(fanOutHint('top posts on Reddit and Hacker News', false)).toBe('');
  });
});

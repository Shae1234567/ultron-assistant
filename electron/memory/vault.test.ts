import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// Fake keys, assembled at runtime so the file itself never holds a complete key-shaped string.
const FAKE_GEMINI = ['AIza', 'SyD4f6gH8jK0lM2nP4qR6sT8uV0wX2yZ4aB6'].join('');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-vault-'));
vi.mock('../store', () => ({ getSettings: () => ({ vault: { path: ROOT } }) }));

const vault = await import('./vault');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('vault', () => {
  it('creates the Obsidian layout with a seeded profile', () => {
    vault.ensureVault("# About the operator\n\nThis file is the old assistant's memory. Edit this directly.\n\n## Identity\n\n- Name: Alex.\n- Plays for Riverside FC.");
    for (const dir of ['Profile', 'Journal', 'Memory', 'Research', 'Team Runs', '.obsidian', '.ultron']) {
      expect(fs.existsSync(path.join(ROOT, dir)), dir).toBe(true);
    }
    const profile = vault.readProfile();
    expect(profile).toContain('Plays for Riverside FC');
    expect(profile).toContain('## Learned by Ultron');
    expect(profile).not.toContain('# About the operator');
    expect(profile).not.toContain("the old assistant's memory");
    expect(profile).toContain('## Identity');
  });

  it('files facts into topic notes and skips near-duplicates', () => {
    const first = vault.upsertMemory({ category: 'sports', title: 'Soccer', facts: ['Alex made Division 2 at Riverside FC.'], links: ['Coach Mike'] });
    expect(first.created).toBe(true);
    expect(first.rel).toBe('Memory/Sports/Soccer.md');
    const again = vault.upsertMemory({ category: 'Sports', title: 'soccer', facts: ['Alex made Division 2 at the Riverside FC', 'Practices are Tuesdays and Thursdays at 6pm.'] });
    expect(again.created).toBe(false);
    expect(again.added).toBe(1);
    const note = vault.readNote('Memory/Sports/Soccer.md')!;
    expect(note).toContain('[[Coach Mike]]');
    expect(note.match(/Division 2/g)).toHaveLength(1);
  });

  it('journals every exchange under the day\'s note', () => {
    const at = new Date(2026, 8, 24, 14, 5);
    const rel = vault.appendJournal({ at, operatorName: 'Alex', user: 'hey', reply: 'Evening.', agents: ['Argus'], runNote: 'Team Runs/x.md' });
    expect(rel).toBe('Journal/2026/2026-09-24.md');
    const text = vault.readNote(rel)!;
    expect(text).toContain('### 14:05');
    expect(text).toContain('**Alex:** hey');
    expect(text).toContain('[[Team Runs/x|team log]]');
  });

  it('keeps note titles safe for Windows and Obsidian', () => {
    expect(vault.safeName('What: is <this>? / a|test*')).toBe('What is this a test');
    expect(vault.safeName('...')).toBe('Untitled');
  });

  it('refuses paths that escape the vault', () => {
    expect(() => vault.writeNote('../outside.md', 'x')).toThrow(/escapes/);
  });
});

describe('memory with provenance, unconfirmed facts and corrections (workflow v2)', () => {
  const note = () => fs.readFileSync(path.join(ROOT, 'Memory/School/Math class.md'), 'utf8');

  it('records where a fact came from, keeps guesses apart, and never stores a secret', () => {
    vault.upsertMemory({
      category: 'School',
      title: 'Math class',
      facts: ['Alex has a unit test on linear equations on October 2, 2026.', `Their Gemini key is ${FAKE_GEMINI}`],
      unconfirmed: ['Alex might switch to the AP math stream next term.'],
      source: 'conversation [[Journal/2026-09-28]]',
    });
    const text = note();
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2}: Alex has a unit test on linear equations on October 2, 2026\. \(source: conversation \[\[Journal\/2026-09-28\]\]\)/);
    expect(text).not.toContain('AIzaSy');
    expect(text).toContain('[API key removed]');
    const [confirmed, unconfirmed] = text.split('## Unconfirmed');
    expect(confirmed).toContain('unit test');
    expect(unconfirmed).toMatch(/\(unconfirmed\): Alex might switch to the AP math stream/);
    // A later confirmed fact still goes above the Unconfirmed section.
    vault.upsertMemory({ category: 'School', title: 'Math class', facts: ['His math teacher is Mr. Patel.'] });
    expect(note().indexOf('Mr. Patel')).toBeLessThan(note().indexOf('## Unconfirmed'));
  });

  it('corrects a stale fact without keeping the wrong text', () => {
    const r = vault.forgetFact('Math class', 'unit test on linear equations', "Alex's linear equations unit test moved to October 6, 2026.", 'the date changed');
    expect(r).toMatchObject({ rel: 'Memory/School/Math class.md', removed: 1 });
    const text = note();
    expect(text).not.toContain('October 2');
    expect(text).toMatch(/moved to October 6, 2026\. \(source: corrected by the operator\)/);
    expect(text).toMatch(/## Corrections\n- \d{4}-\d{2}-\d{2}: removed 1 fact and wrote the correction above - the date changed/);
  });

  it('refuses vague or unmatched removals', () => {
    expect(vault.forgetFact('Math class', 'xy').error).toMatch(/Say which fact/);
    expect(vault.forgetFact('Math class', 'chemistry lab').error).toMatch(/Nothing in/);
    expect(vault.forgetFact('Nonexistent note', 'anything').error).toMatch(/No memory note/);
  });

  it('keeps secrets out of the journal', () => {
    const rel = vault.appendJournal({ at: new Date(2026, 8, 28, 9, 0), operatorName: 'Alex', user: `my key is ${FAKE_GEMINI}`, reply: 'Saved.' });
    expect(vault.readNote(rel)).not.toContain('AIzaSy');
  });
});

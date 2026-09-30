import { searchMemory, syncIndex } from '../../memory/semantic';
import { findMemoryNote, forgetFact, listNotes, readNote, upsertMemory, writeNote, safeName, isoDate } from '../../memory/vault';
import { workflow } from '../workflow';
import * as hindsight from '../../hindsight';
import { A, N, S, clip, list, num, obj, str, type AgentTool } from './types';

export const memoryTools: AgentTool[] = [
  {
    name: 'memory_search',
    owner: 'mnemosyne',
    description: 'Search Ultron\'s long-term memory (the Obsidian vault: past conversations, facts about the operator, research reports, team logs).',
    parameters: obj({ query: S('What to recall'), limit: N('Default 6') }, ['query']),
    label: (a) => `recall "${str(a, 'query').slice(0, 50)}"`,
    run: async (args, ctx) => {
      const [hits, learned] = await Promise.all([
        searchMemory(str(args, 'query'), Math.min(num(args, 'limit', 6), 12)),
        // Hindsight's facts, when that add-on is running - labelled, since they are its extraction, not a note.
        workflow().memory2 ? hindsight.recall(str(args, 'query'), 5, ctx.signal).catch(() => []) : Promise.resolve([]),
      ]);
      if (!hits.length && !learned.length) return { results: [], note: 'Nothing relevant in memory.' };
      return {
        results: hits.map((h) => ({ note: h.rel, relevance: Math.round(h.score * 100) / 100, text: h.text })),
        hindsight: learned.length ? learned.map((m) => ({ fact: m.text, when: m.when })) : undefined,
      };
    },
  },
  {
    name: 'memory_read_note',
    owner: 'mnemosyne',
    description: 'Read a full note from the vault by its path (e.g. "Memory/Sports/Soccer.md") or title.',
    parameters: obj({ note: S('Vault path or note title') }, ['note']),
    label: (a) => `read note ${str(a, 'note')}`,
    run: async (args) => {
      const q = str(args, 'note').trim();
      let rel = q.endsWith('.md') ? q : '';
      if (!rel) {
        const byTitle = findMemoryNote(q) ?? listNotes().find((n) => n.title.toLowerCase() === q.toLowerCase());
        rel = byTitle?.rel ?? '';
      }
      const text = rel ? readNote(rel) : null;
      return text === null ? { error: 'No such note.' } : { note: rel, content: clip(text, 10_000) };
    },
  },
  {
    name: 'memory_remember',
    owner: 'mnemosyne',
    description: 'Save specific facts to long-term memory right now (use when the operator says "remember..." or when something important was learned). Facts are filed into a topic note.',
    parameters: obj({
      title: S('Topic note title, e.g. "Soccer", "Math class", "Grandma"'),
      category: S('People, Projects, School, Sports, Goals, Preferences, Health, Places, Events, Ideas, Tech, History or Other'),
      facts: A('Standalone facts to store'),
    }, ['title', 'facts']),
    label: (a) => `remember -> ${str(a, 'title')}`,
    run: async (args) => {
      const facts = list(args, 'facts');
      if (!facts.length) return { error: 'No facts given.' };
      const r = upsertMemory({ title: str(args, 'title'), category: str(args, 'category', 'Other'), facts, ...(workflow().memory2 ? { source: `told to Ultron on ${isoDate()}` } : {}) });
      void syncIndex([r.rel]).catch(() => {});
      return { ok: true, note: r.rel, added: r.added, created: r.created };
    },
  },
  {
    name: 'memory_forget',
    owner: 'mnemosyne',
    description: 'Correct or remove a fact in long-term memory - when the operator says something Ultron remembers is wrong, out of date, or should be forgotten. Find the note with memory_search first. Give the corrected fact to replace it, or leave it out to just remove it.',
    parameters: obj({
      note: S('The memory note\'s title or path (e.g. "Soccer", "Memory/Sports/Soccer.md"), or "profile"'),
      fact: S('A few words from the fact to remove, e.g. "dentist appointment on May 3"'),
      corrected: S('Optional: the correct fact to store instead'),
      reason: S('Optional: why, e.g. "out of date", "the operator corrected it"'),
    }, ['note', 'fact']),
    label: (a) => `forget "${str(a, 'fact').slice(0, 50)}" in ${str(a, 'note')}`,
    run: async (args) => {
      const r = forgetFact(str(args, 'note'), str(args, 'fact'), str(args, 'corrected') || undefined, str(args, 'reason') || undefined);
      if (r.error) return { error: r.error };
      void syncIndex([r.rel!]).catch(() => {});
      return { ok: true, note: r.rel, removed: r.removed, corrected: Boolean(str(args, 'corrected')) };
    },
  },
  {
    name: 'vault_write_note',
    owner: 'mnemosyne',
    description: 'Write a markdown note into the vault (plans, summaries, study guides, meeting notes). Goes in the folder you choose inside the vault.',
    parameters: obj({
      folder: S('Vault folder, e.g. "Notes", "School", "Plans"'),
      title: S('Note title'),
      content: S('Markdown body'),
    }, ['title', 'content']),
    label: (a) => `write note "${str(a, 'title')}"`,
    run: async (args) => {
      const folder = safeName(str(args, 'folder', 'Notes')).replace(/^\.+/, '') || 'Notes';
      if (/^(journal|profile|tasks)$/i.test(folder)) return { error: 'That folder is managed automatically - pick another.' };
      const rel = `${folder}/${safeName(str(args, 'title'))}.md`;
      const existing = readNote(rel);
      const body = `---\ntype: note\ncreated: ${isoDate()}\ntags: [ultron/note]\n---\n# ${str(args, 'title')}\n\n${str(args, 'content').trim()}\n`;
      writeNote(rel, existing ? `${existing.trimEnd()}\n\n## Update ${isoDate()}\n\n${str(args, 'content').trim()}\n` : body);
      void syncIndex([rel]).catch(() => {});
      return { ok: true, note: rel, appended: Boolean(existing) };
    },
  },
];

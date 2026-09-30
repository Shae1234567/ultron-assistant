import { chatJson } from '../brain/llm';
import { emit } from '../brain/events';
import type { JsonSchema } from '../brain/types';
import { getSettings } from '../store';
import { workflow } from '../brain/workflow';
import * as hindsight from '../hindsight';
import { appendJournal, appendProfileFacts, isoDate, memoryTitles, upsertMemory, journalRel } from './vault';
import { searchMemory, syncIndex } from './semantic';

/**
 * Runs after every exchange: the conversation is journaled immediately (no
 * model involved, can't fail silently), then Mnemosyne distils durable facts
 * into topic notes in the background so the reply is never held up by it.
 */

export interface ExchangeRecord {
  at: Date;
  user: string;
  reply: string;
  agents?: string[];
  runNote?: string;
  teamSummary?: string;
}

interface Extraction {
  memories?: { category?: string; title?: string; facts?: string[]; unconfirmed?: string[]; links?: string[] }[];
  profile?: string[];
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          title: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          unconfirmed: { type: 'array', items: { type: 'string' } },
          links: { type: 'array', items: { type: 'string' } },
        },
        required: ['category', 'title', 'facts'],
      },
    },
    profile: { type: 'array', items: { type: 'string' } },
  },
  required: ['memories', 'profile'],
};

const queue: ExchangeRecord[] = [];
let draining = false;

/*
 * Filing memories is background work - it must never slow down the next
 * thing the operator asks. The team runtime registers how to tell it's busy;
 * extraction waits (a few seconds at a time) until nothing is running.
 */
let busy: () => boolean = () => false;
export function setBusyCheck(check: () => boolean): void {
  busy = check;
}

async function whenIdle(maxWaitMs = 10 * 60_000): Promise<void> {
  const until = Date.now() + maxWaitMs;
  // A moment's grace first: the operator often sends the next message right after reading a reply.
  await new Promise((r) => setTimeout(r, 2500));
  while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 3000));
}

export function recordExchange(e: ExchangeRecord): void {
  const name = getSettings().profile.name || 'Operator';
  try {
    appendJournal({ at: e.at, operatorName: name, user: e.user, reply: e.reply, agents: e.agents, runNote: e.runNote });
  } catch (err) {
    console.warn('[memory] journal append failed:', err);
  }
  if (queue.length < 20) queue.push(e);
  void drain();
  // The second, learning memory (Hindsight add-on) gets the same exchange - in the background, never slowing a reply.
  if (workflow().memory2) {
    void hindsight.retain(`${name}: ${e.user}\nUltron: ${e.reply}`, e.at, e.runNote ? `conversation with Ultron (team run: ${e.runNote})` : 'conversation with Ultron').catch(() => {});
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      await whenIdle();
      const e = queue.shift()!;
      try {
        await extract(e);
      } catch (err) {
        console.warn('[memory] extraction failed:', err);
        void syncIndex([journalRel(e.at)]).catch(() => {});
      }
    }
  } finally {
    draining = false;
  }
}

async function extract(e: ExchangeRecord): Promise<void> {
  const name = getSettings().profile.name || 'the operator';
  const v2 = workflow().memory2;
  // Where each fact came from: the day's conversation, and the team run when there was one.
  const source = [`conversation [[${journalRel(e.at).replace(/\.md$/, '')}]]`, e.runNote ? `team run [[${e.runNote.replace(/\.md$/, '')}]]` : ''].filter(Boolean).join(', ');
  const related = await searchMemory(`${e.user}\n${e.reply.slice(0, 400)}`, 5).catch(() => []);
  const titles = memoryTitles(150);

  const system = [
    `You are Mnemosyne, the memory keeper for Ultron, a personal AI assistant for ${name}.`,
    `Today is ${isoDate(e.at)} (${e.at.toLocaleDateString('en-CA', { weekday: 'long' })}).`,
    'From one exchange, extract only DURABLE facts worth remembering about the operator and their world:',
    'preferences, plans, goals, deadlines, people and relationships, projects, school, sport, health/training,',
    'events, decisions, opinions they expressed, things they asked Ultron to remember, and concrete outcomes of',
    'work the team finished (what was found, created, sent or scheduled, and where it was saved).',
    'Do NOT store: small talk, generic knowledge anyone could look up, Ultron\'s own opinions, passwords/keys/',
    'account numbers, or anything the operator did not state or confirm.',
    'Each fact must stand alone and be specific. Convert relative dates ("tomorrow", "next Friday") to absolute',
    'dates using today\'s date. Write facts in third person about the operator.',
    // A guessed "her" ended up in a note about the operator's Discord server (30 Sep 2026).
    `Call the operator "${name}" - never "he", "she", "his" or "her" unless the operator said which; name, "they" or "the" instead ("${name}'s server", "the server").`,
    'Reuse an existing note title EXACTLY when the topic already has a note. Categories: People, Projects, School,',
    'Sports, Goals, Preferences, Health, Places, Events, Ideas, Tech, History, Other.',
    '"links" lists other note titles this note should link to. "profile" is only for core identity-level changes',
    '(new school, team tier, major life update) - usually empty.',
    'Extract ONLY from the EXCHANGE (and team work done). EXISTING NOTES and RELATED EXISTING MEMORY are shown only so',
    'you can reuse titles and skip duplicates - never copy facts out of them, they are already stored.',
    'If nothing is worth saving, return {"memories": [], "profile": []}. Return at most 5 memories.',
    v2 ? '"facts" is only for what the operator stated or confirmed, or what a tool actually did or found. Anything uncertain - a guess, something Ultron inferred, a plan the operator was unsure about, a claim from one web page - goes in "unconfirmed" instead.' : '',
  ].filter(Boolean).join('\n');

  const user = [
    titles.length ? `EXISTING NOTES (Category/Title):\n${titles.join('\n')}` : 'EXISTING NOTES: none yet.',
    related.length ? `\nRELATED EXISTING MEMORY:\n${related.map((r) => `- ${r.text.slice(0, 300)}`).join('\n')}` : '',
    `\nEXCHANGE\n${name}: ${e.user.slice(0, 2000)}`,
    `Ultron: ${e.reply.slice(0, 1800)}`,
    e.teamSummary ? `\nTEAM WORK DONE:\n${e.teamSummary.slice(0, 1500)}` : '',
  ].filter(Boolean).join('\n');

  const result = await chatJson<Extraction>({
    system,
    messages: [{ role: 'user', content: user }],
    schema: SCHEMA,
    temperature: 0.1,
    tier: 'fast',
    effort: 'low',
  });

  const saved: { title: string; rel: string; added: number; created: boolean }[] = [];
  for (const m of (result?.memories ?? []).slice(0, 5)) {
    const facts = (m.facts ?? []).filter((f): f is string => typeof f === 'string' && f.trim().length > 3);
    const unconfirmed = v2 ? (m.unconfirmed ?? []).filter((f): f is string => typeof f === 'string' && f.trim().length > 3) : [];
    if (!m.title?.trim() || (!facts.length && !unconfirmed.length)) continue;
    const r = upsertMemory({ category: m.category ?? 'Other', title: m.title, facts, links: m.links, ...(v2 ? { source, unconfirmed } : {}) });
    if (r.added || r.created) saved.push({ title: m.title.trim(), rel: r.rel, added: r.added, created: r.created });
  }
  const profileFacts = (result?.profile ?? []).filter((f): f is string => typeof f === 'string');
  const profileAdded = profileFacts.length ? appendProfileFacts(profileFacts) : 0;

  const touched = [journalRel(e.at), ...saved.map((s) => s.rel), ...(profileAdded ? ['Profile/Operator.md'] : [])];
  await syncIndex(touched).catch(() => {});

  if (saved.length || profileAdded) {
    emit('memory:updated', {
      at: Date.now(),
      saved,
      profileAdded,
    });
  }
}

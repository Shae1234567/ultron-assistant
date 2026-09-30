import { readDoc, writeDoc } from './store';

/**
 * The conversation survives restarts: the operator's messages and Ultron's
 * replies (not boot notices) are kept in userData/transcript.json, so
 * reopening Ultron shows the chat where it was and the brain gets its
 * recent context back. Everything older lives in the vault's Journal.
 */

const FILE = 'transcript.json';
const MAX_ENTRIES = 200;
const MAX_TEXT = 20_000;

export interface SavedEntry {
  id: string;
  who: 'you' | 'ultron';
  text: string;
  at: number;
  sources?: { title: string; url: string }[];
  team?: unknown;
}

function clean(raw: unknown): SavedEntry | null {
  const e = raw as Partial<SavedEntry> & { streaming?: boolean; error?: boolean };
  if (!e || (e.who !== 'you' && e.who !== 'ultron') || typeof e.text !== 'string' || !e.text.trim() || e.streaming || e.error) return null;
  return {
    id: typeof e.id === 'string' ? e.id : `t${Math.random().toString(36).slice(2)}`,
    who: e.who,
    text: e.text.slice(0, MAX_TEXT),
    at: typeof e.at === 'number' ? e.at : Date.now(),
    sources: Array.isArray(e.sources) ? e.sources.slice(0, 12) : undefined,
    team: e.team,
  };
}

export function loadTranscript(): SavedEntry[] {
  const doc = readDoc<{ v?: number; entries?: unknown[] }>(FILE, { v: 1, entries: [] });
  return (Array.isArray(doc.entries) ? doc.entries : []).map(clean).filter((e): e is SavedEntry => Boolean(e)).slice(-MAX_ENTRIES);
}

export function saveTranscript(entries: unknown): void {
  const list = (Array.isArray(entries) ? entries : []).map(clean).filter((e): e is SavedEntry => Boolean(e)).slice(-MAX_ENTRIES);
  writeDoc(FILE, { v: 1, entries: list });
}

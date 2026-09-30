import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from '../store';
import { ollamaEmbed } from '../brain/providers/ollama';
import * as ollama from '../ollama';
import { listNotes, readNote, vaultRoot } from './vault';

/**
 * Semantic recall over the vault. Notes are chunked and embedded with a local
 * Ollama embedding model (nomic-embed-text); search blends cosine similarity
 * with plain keyword overlap, so recall still works - just less cleverly -
 * when Ollama is off.
 */

interface Chunk { text: string; vec: number[] | null }
interface FileEntry { mtime: number; title: string; chunks: Chunk[] }
interface IndexFile { v: 1; model: string | null; files: Record<string, FileEntry> }

export interface MemoryHit { rel: string; title: string; text: string; score: number }

const PREFERRED_EMBED = ['nomic-embed-text', 'mxbai-embed-large', 'embeddinggemma', 'all-minilm'];
const CHUNK_CHARS = 700;

let index: IndexFile | null = null;
let indexRoot = '';
let syncing: Promise<void> | null = null;
let embedModel: string | null | undefined;

function indexPath(): string {
  return path.join(vaultRoot(), '.ultron', 'index.json');
}

function load(): IndexFile {
  const root = vaultRoot();
  if (index && indexRoot === root) return index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as IndexFile;
    if (index.v !== 1 || typeof index.files !== 'object') throw new Error('bad index');
  } catch {
    index = { v: 1, model: null, files: {} };
  }
  indexRoot = root;
  return index;
}

function save(): void {
  if (!index) return;
  const p = indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
  fs.renameSync(tmp, p);
}

async function resolveEmbedModel(): Promise<string | null> {
  if (embedModel !== undefined) return embedModel;
  const s = await ollama.status();
  if (!s.running) return null; // don't cache - Ollama may come up later
  const bare = s.models.map((m) => m.replace(/:latest$/, ''));
  embedModel = PREFERRED_EMBED.find((m) => bare.includes(m)) ?? bare.find((m) => /embed/i.test(m)) ?? null;
  return embedModel;
}

export function chunkNote(title: string, content: string): string[] {
  const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
  if (!body) return [];
  const blocks = body.split(/\n(?=#{1,4} )|\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && (current.length + block.length) > CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    if (block.length > CHUNK_CHARS * 1.6) {
      for (let i = 0; i < block.length; i += CHUNK_CHARS) chunks.push(block.slice(i, i + CHUNK_CHARS));
      continue;
    }
    current = current ? `${current}\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `${title}: ${c}`);
}

function round(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1e5) / 1e5);
}

async function embedAll(texts: string[], kind: 'document' | 'query'): Promise<(number[] | null)[]> {
  const model = await resolveEmbedModel();
  if (!model || !texts.length) return texts.map(() => null);
  const host = getSettings().ollama.host.replace(/\/$/, '');
  const prefix = model.startsWith('nomic') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
  const out: (number[] | null)[] = [];
  try {
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => prefix + t);
      const vecs = await ollamaEmbed(host, model, batch);
      out.push(...vecs.map(round));
    }
    return out;
  } catch {
    return texts.map(() => null);
  }
}

/** Brings the index in line with the vault: re-embeds changed notes, drops deleted ones. */
export function syncIndex(onlyRels?: string[]): Promise<void> {
  const run = async () => {
    const idx = load();
    const model = await resolveEmbedModel();
    const notes = listNotes().filter((n) => n.folder !== 'Tasks' && n.rel !== 'Home.md');
    const live = new Set(notes.map((n) => n.rel));
    let dirty = false;
    for (const rel of Object.keys(idx.files)) {
      if (!live.has(rel)) { delete idx.files[rel]; dirty = true; }
    }
    // A different embedding model means every stored vector is incomparable.
    if (model && idx.model !== model) {
      for (const f of Object.values(idx.files)) f.mtime = -1;
      idx.model = model;
      dirty = true;
    }
    const targets = notes.filter((n) => {
      if (onlyRels && !onlyRels.includes(n.rel)) return false;
      const entry = idx.files[n.rel];
      if (!entry || entry.mtime !== n.mtime) return true;
      return Boolean(model) && entry.chunks.some((c) => c.vec === null);
    });
    for (const n of targets) {
      const content = readNote(n.rel);
      if (content === null) continue;
      const texts = chunkNote(n.title, content);
      const vecs = await embedAll(texts, 'document');
      idx.files[n.rel] = { mtime: n.mtime, title: n.title, chunks: texts.map((text, i) => ({ text, vec: vecs[i] })) };
      dirty = true;
    }
    if (dirty) save();
  };
  const next = (syncing ?? Promise.resolve()).then(run, run).finally(() => {
    if (syncing === next) syncing = null;
  });
  syncing = next;
  return next;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const STOP = new Set('the a an and or but if of to in on for with at by from is are was were be been it this that what who how why when where do does did i you me my your we our about can could would should will just'.split(' '));

function terms(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

export async function searchMemory(query: string, k = 6): Promise<MemoryHit[]> {
  const q = query.trim();
  if (!q) return [];
  const idx = load();
  const [qvec] = await embedAll([q], 'query');
  const qterms = terms(q);
  const hits: MemoryHit[] = [];
  for (const [rel, file] of Object.entries(idx.files)) {
    for (const c of file.chunks) {
      const lower = c.text.toLowerCase();
      const kw = qterms.length ? qterms.filter((t) => lower.includes(t)).length / qterms.length : 0;
      const sem = qvec && c.vec ? cosine(qvec, c.vec) : 0;
      const score = qvec && c.vec ? sem * 0.8 + kw * 0.2 : kw * 0.6;
      if (score > 0) hits.push({ rel, title: file.title, text: c.text, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // One chunk per note keeps the recall block varied instead of five slices of one journal day.
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  const floor = qvec ? 0.45 : 0.3;
  for (const h of hits) {
    if (h.score < floor || seen.has(h.rel)) continue;
    seen.add(h.rel);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}

export function forgetIndex(): void {
  index = null;
  embedModel = undefined;
}

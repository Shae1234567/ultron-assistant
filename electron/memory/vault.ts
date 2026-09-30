import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '../store';
import { redactSecrets } from './redact';

/**
 * Ultron's long-term memory is a plain Obsidian vault: markdown files the
 * operator can open, read, edit and link like any other notes. Layout:
 *
 *   Home.md                    map of the vault
 *   Profile/Operator.md        core profile, always in context
 *   Journal/YYYY/YYYY-MM-DD.md every exchange, appended as it happens
 *   Memory/<Category>/<Title>  one note per topic, facts as dated bullets
 *   Research/                  deep-research reports with sources
 *   Team Runs/                 what the team did on bigger tasks
 *   Tasks/Tasks.md             mirror of the task list
 *   .ultron/                   search index (hidden from Obsidian)
 */

export interface VaultNote {
  rel: string;
  title: string;
  folder: string;
  mtime: number;
  size: number;
}

const FOLDERS = ['Profile', 'Journal', 'Memory', 'Research', 'Team Runs', 'Tasks', '.ultron'];

export function vaultRoot(): string {
  const configured = getSettings().vault.path.trim();
  return configured || path.join(os.homedir(), 'Ultron Vault');
}

export function abs(rel: string): string {
  const root = vaultRoot();
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path escapes the vault.');
  return full;
}

export function isoDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Windows-safe, Obsidian-friendly file title. */
export function safeName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || 'Untitled').slice(0, 80);
}

function titleCase(s: string): string {
  return s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const HOME = `# Ultron Vault

This vault is Ultron's long-term memory. Ultron writes to it after every message; you can read, edit, link and reorganise anything here in Obsidian and Ultron will pick up your changes.

- [[Profile/Operator|Operator profile]] - the core facts Ultron always has in mind
- **Journal/** - every conversation, one note per day
- **Memory/** - one note per topic (people, projects, school, sport, goals...), facts as dated bullets
- **Research/** - deep-research reports with their sources
- **Team Runs/** - what the agent team did on bigger tasks
- [[Tasks/Tasks|Tasks]] - mirror of your task list (edit tasks in Ultron, not here)
`;

export function ensureVault(seedProfile?: string): string {
  const root = vaultRoot();
  for (const f of FOLDERS) fs.mkdirSync(path.join(root, f), { recursive: true });
  const obsidianDir = path.join(root, '.obsidian');
  if (!fs.existsSync(obsidianDir)) {
    fs.mkdirSync(obsidianDir, { recursive: true });
    fs.writeFileSync(path.join(obsidianDir, 'app.json'), JSON.stringify({ alwaysUpdateLinks: true }, null, 2), 'utf8');
  }
  const home = path.join(root, 'Home.md');
  if (!fs.existsSync(home)) fs.writeFileSync(home, HOME, 'utf8');
  const profile = path.join(root, 'Profile', 'Operator.md');
  if (!fs.existsSync(profile)) fs.writeFileSync(profile, profileTemplate(seedProfile), 'utf8');
  return root;
}

function profileTemplate(seed?: string): string {
  // An older memory file opened with instructions about itself ("This file is
  // ...'s memory...") before the first section - drop that preamble.
  let body = (seed ?? '').replace(/^# .*\n+/, '').trim();
  const firstSection = body.search(/^## /m);
  if (firstSection > 0 && /this file is|edit this directly/i.test(body.slice(0, firstSection))) body = body.slice(firstSection).trim();
  return [
    '---',
    'type: profile',
    `created: ${isoDate()}`,
    `updated: ${isoDate()}`,
    'tags: [ultron/profile]',
    '---',
    '# Operator profile',
    '',
    body || '- (Ultron adds what it learns about you below. You can edit this note.)',
    '',
    '## Learned by Ultron',
    '',
  ].join('\n');
}

function walk(dir: string, rootLen: number, out: VaultNote[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, rootLen, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      try {
        const st = fs.statSync(full);
        const rel = full.slice(rootLen + 1).split(path.sep).join('/');
        out.push({ rel, title: e.name.slice(0, -3), folder: rel.split('/')[0], mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-walk */ }
    }
  }
}

export function listNotes(): VaultNote[] {
  const root = vaultRoot();
  const out: VaultNote[] = [];
  if (fs.existsSync(root)) walk(root, root.length, out);
  return out;
}

export function readNote(rel: string): string | null {
  try {
    return fs.readFileSync(abs(rel), 'utf8');
  } catch {
    return null;
  }
}

export function writeNote(rel: string, content: string): string {
  const full = abs(rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/* ── Journal ─────────────────────────────────────────────────────────── */

export interface JournalEntry {
  at: Date;
  operatorName: string;
  user: string;
  reply: string;
  agents?: string[];
  runNote?: string;
}

export function journalRel(d = new Date()): string {
  return `Journal/${d.getFullYear()}/${isoDate(d)}.md`;
}

export function appendJournal(e: JournalEntry): string {
  const rel = journalRel(e.at);
  const full = abs(rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) {
    const day = e.at.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    fs.writeFileSync(full, `---\ntype: journal\ndate: ${isoDate(e.at)}\ntags: [ultron/journal]\n---\n# ${day}\n`, 'utf8');
  }
  const lines = [
    '',
    `### ${hhmm(e.at)}`,
    `**${e.operatorName}:** ${redactSecrets(e.user.trim())}`,
    `**Ultron:** ${redactSecrets(e.reply.trim())}`,
  ];
  if (e.agents?.length || e.runNote) {
    const team = e.agents?.length ? `*Team: ${e.agents.join(', ')}*` : '';
    const link = e.runNote ? `[[${e.runNote.replace(/\.md$/, '')}|team log]]` : '';
    lines.push([team, link].filter(Boolean).join(' · '));
  }
  fs.appendFileSync(full, lines.join('\n') + '\n', 'utf8');
  return rel;
}

/** Most recent journal day before today, trimmed - "what we talked about last time". */
export function previousJournalTail(maxChars = 1800): { date: string; text: string } | null {
  const today = isoDate();
  const days = listNotes()
    .filter((n) => n.folder === 'Journal' && /^\d{4}-\d{2}-\d{2}$/.test(n.title) && n.title < today)
    .sort((a, b) => (a.title < b.title ? 1 : -1));
  const last = days[0];
  if (!last) return null;
  const text = (readNote(last.rel) ?? '').replace(/^---[\s\S]*?---\n/, '');
  return { date: last.title, text: text.slice(-maxChars) };
}

/* ── Memory notes ────────────────────────────────────────────────────── */

function normalizeFact(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

function similar(a: string, b: string): boolean {
  const A = normalizeFact(a);
  const B = normalizeFact(b);
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.75;
}

function factOf(line: string): string {
  return line.replace(/^\s*-\s*(\d{4}-\d{2}-\d{2}(?: \(unconfirmed\))?:\s*)?/, '').replace(/\s*\(source: [^)]*\)\s*$/, '');
}

function existingBullets(text: string): string[] {
  return text.split('\n').filter((l) => /^\s*-\s/.test(l)).map(factOf);
}

export function findMemoryNote(title: string): VaultNote | undefined {
  const want = safeName(title).toLowerCase();
  return listNotes().find((n) => n.folder === 'Memory' && n.title.toLowerCase() === want);
}

export interface MemoryUpsert {
  category: string;
  title: string;
  facts: string[];
  links?: string[];
  /** Where the facts came from: "conversation [[Journal/2026-09-28]]", "research [[Research/...]]". */
  source?: string;
  /** Guesses, inferences and unsure plans - kept apart from the confirmed facts, under "## Unconfirmed". */
  unconfirmed?: string[];
}

/* Confirmed facts go above the "Unconfirmed" and "Corrections" sections, never below them. */
function insertFact(content: string, line: string): string {
  const at = content.search(/^## (Unconfirmed|Corrections)\b/m);
  if (at < 0) return content.replace(/\s*$/, '\n') + line + '\n';
  return content.slice(0, at).replace(/\s*$/, '\n') + line + '\n\n' + content.slice(at);
}

function insertUnconfirmed(content: string, line: string): string {
  if (!/^## Unconfirmed\b/m.test(content)) {
    const at = content.search(/^## Corrections\b/m);
    const head = '## Unconfirmed\n';
    content = at < 0 ? content.replace(/\s*$/, '\n\n') + head : content.slice(0, at) + head + '\n' + content.slice(at);
  }
  const start = content.search(/^## Unconfirmed\b/m);
  const end = content.slice(start + 1).search(/^## /m);
  if (end < 0) return content.replace(/\s*$/, '\n') + line + '\n';
  const cut = start + 1 + end;
  return content.slice(0, cut).replace(/\s*$/, '\n') + line + '\n\n' + content.slice(cut);
}

export function upsertMemory(op: MemoryUpsert): { rel: string; created: boolean; added: number } {
  const title = safeName(op.title);
  const existing = findMemoryNote(title);
  const category = safeName(titleCase(op.category || 'Other'));
  const rel = existing?.rel ?? `Memory/${category}/${title}.md`;
  let content = existing ? readNote(rel) ?? '' : '';
  const created = !existing;
  if (created) {
    content = [
      '---',
      'type: memory',
      `category: ${category}`,
      `created: ${isoDate()}`,
      `updated: ${isoDate()}`,
      `tags: [ultron/memory, ${category.toLowerCase().replace(/\s+/g, '-')}]`,
      '---',
      `# ${title}`,
      '',
    ].join('\n');
  }
  const have = existingBullets(content);
  let added = 0;
  const today = isoDate();
  const from = op.source ? ` (source: ${op.source})` : '';
  for (const raw of op.facts) {
    const fact = redactSecrets(raw.replace(/\s+/g, ' ').trim());
    if (fact.length < 4 || have.some((h) => similar(h, fact))) continue;
    content = insertFact(content, `- ${today}: ${fact}${from}`);
    have.push(fact);
    added++;
  }
  for (const raw of op.unconfirmed ?? []) {
    const fact = redactSecrets(raw.replace(/\s+/g, ' ').trim());
    if (fact.length < 4 || have.some((h) => similar(h, fact))) continue;
    content = insertUnconfirmed(content, `- ${today} (unconfirmed): ${fact}${from}`);
    have.push(fact);
    added++;
  }
  const links = (op.links ?? []).map((l) => safeName(l)).filter((l) => l.toLowerCase() !== title.toLowerCase());
  const missing = links.filter((l) => !content.includes(`[[${l}]]`));
  if (missing.length) content = content.replace(/\s*$/, '\n') + `\nRelated: ${missing.map((l) => `[[${l}]]`).join(', ')}\n`;
  if (!added && !missing.length && !created) return { rel, created, added: 0 };
  content = content.replace(/^updated: .*$/m, `updated: ${today}`);
  writeNote(rel, content);
  return { rel, created, added };
}

/**
 * Removes stale or wrong facts from a memory note (or the profile), optionally
 * putting the corrected fact in their place. The removed text is not kept -
 * only a dated line saying something was removed, and why - so search can't
 * bring the wrong fact back.
 */
export function forgetFact(note: string, match: string, replacement?: string, reason?: string): { rel?: string; removed: number; error?: string } {
  const ref = note.trim();
  const rel = /^(profile|operator|me|about me)$/i.test(ref) ? 'Profile/Operator.md' : /\.md$/i.test(ref) ? ref : findMemoryNote(ref)?.rel;
  if (!rel) return { removed: 0, error: `No memory note called "${note}". Use memory_search to find the right note first.` };
  const content = readNote(rel);
  if (!content) return { removed: 0, error: `Could not read ${rel}.` };
  const want = match.trim().toLowerCase();
  if (want.length < 3) return { removed: 0, error: 'Say which fact to remove (a few words from it).' };
  let inCorrections = false;
  const removed: string[] = [];
  const kept = content.split('\n').filter((line) => {
    if (/^## /.test(line)) inCorrections = /^## Corrections\b/.test(line);
    if (inCorrections || !/^\s*-\s/.test(line)) return true;
    const fact = factOf(line);
    const hit = fact.toLowerCase().includes(want) || similar(fact, match);
    if (hit) removed.push(fact);
    return !hit;
  });
  if (!removed.length) return { rel, removed: 0, error: `Nothing in ${rel} matches "${match}".` };
  if (removed.length > 5) return { rel, removed: 0, error: `${removed.length} facts match "${match}" - be more specific.` };
  const today = isoDate();
  let next = kept.join('\n');
  if (replacement?.trim()) next = insertFact(next, `- ${today}: ${redactSecrets(replacement.replace(/\s+/g, ' ').trim())} (source: corrected by the operator)`);
  if (!/^## Corrections\b/m.test(next)) next = next.replace(/\s*$/, '\n\n## Corrections\n');
  next = next.replace(/\s*$/, '\n') + `- ${today}: removed ${removed.length} fact${removed.length > 1 ? 's' : ''}${replacement?.trim() ? ' and wrote the correction above' : ''}${reason?.trim() ? ` - ${redactSecrets(reason.trim()).slice(0, 160)}` : ''}\n`;
  next = next.replace(/^updated: .*$/m, `updated: ${today}`);
  writeNote(rel, next);
  return { rel, removed: removed.length };
}

export function readProfile(): string {
  return readNote('Profile/Operator.md') ?? '';
}

export function saveProfile(text: string): void {
  writeNote('Profile/Operator.md', text);
}

export function appendProfileFacts(facts: string[]): number {
  const rel = 'Profile/Operator.md';
  let content = readNote(rel) ?? profileTemplate();
  if (!/^## Learned by Ultron/m.test(content)) content = content.replace(/\s*$/, '\n\n## Learned by Ultron\n');
  const have = existingBullets(content);
  let added = 0;
  for (const raw of facts) {
    const fact = redactSecrets(raw.replace(/\s+/g, ' ').trim());
    if (fact.length < 4 || have.some((h) => similar(h, fact))) continue;
    content = content.replace(/\s*$/, '\n') + `- ${isoDate()}: ${fact}\n`;
    have.push(fact);
    added++;
  }
  if (added) {
    content = content.replace(/^updated: .*$/m, `updated: ${isoDate()}`);
    writeNote(rel, content);
  }
  return added;
}

/** The profile without frontmatter, capped - what goes into every prompt. */
export function profileForPrompt(maxChars = 2600): string {
  const text = readProfile().replace(/^---[\s\S]*?---\n/, '').trim();
  if (text.length <= maxChars) return text;
  // Keep the head (identity) and the newest learned facts (the tail).
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n...\n${tail}`;
}

export function memoryTitles(limit = 250): string[] {
  return listNotes()
    .filter((n) => n.folder === 'Memory')
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((n) => `${n.rel.split('/')[1]}/${n.title}`);
}

export interface VaultStats {
  root: string;
  notes: number;
  memories: number;
  journalDays: number;
  research: number;
  teamRuns: number;
  lastUpdated: number | null;
}

export function vaultStats(): VaultStats {
  const notes = listNotes();
  return {
    root: vaultRoot(),
    notes: notes.length,
    memories: notes.filter((n) => n.folder === 'Memory').length,
    journalDays: notes.filter((n) => n.folder === 'Journal').length,
    research: notes.filter((n) => n.folder === 'Research').length,
    teamRuns: notes.filter((n) => n.folder === 'Team Runs').length,
    lastUpdated: notes.reduce<number | null>((m, n) => (m === null || n.mtime > m ? n.mtime : m), null),
  };
}

export function recentNotes(limit = 12): VaultNote[] {
  return listNotes()
    .filter((n) => n.folder !== 'Tasks')
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

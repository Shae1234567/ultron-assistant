import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import MiniSearch from 'minisearch';

/**
 * Open-source projects Ultron runs as add-ons, installed at the operator's
 * request (29 Sep 2026) into ~/UltronTools - each Python one in its own
 * virtual environment, so nothing is installed system-wide:
 *  - browser-use (github.com/browser-use/browser-use): an autonomous browser agent
 *  - Agent-Reach (github.com/Panniantong/Agent-Reach): its no-login channels - YouTube (yt-dlp) and RSS (feedparser)
 *  - Hindsight (github.com/vectorize-io/hindsight): a second long-term memory, run as a local server (hindsight.ts)
 *  - Scientific Agent Skills (github.com/K-Dense-AI/scientific-agent-skills): guides the agents can look up
 * Not AppData: the Claude desktop app that installed them redirects AppData writes into its own sandbox, where
 * Ultron would never find them.
 */

export const TOOLS_ROOT = process.env.ULTRON_TOOLS_DIR || path.join(os.homedir(), 'UltronTools');
const venv = (name: string) => path.join(TOOLS_ROOT, 'py', name, 'Scripts');

export const PATHS = {
  browserUsePython: path.join(venv('browser-use'), 'python.exe'),
  agentReachPython: path.join(venv('agent-reach'), 'python.exe'),
  ytdlp: path.join(venv('agent-reach'), 'yt-dlp.exe'),
  hindsight: path.join(venv('hindsight'), 'hindsight-api.exe'),
  skills: path.join(TOOLS_ROOT, 'skills'),
};

/** Chromium that Playwright already downloaded for Ultron's own browser - browser-use drives the same one. */
export function chromiumPath(): string | null {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  try {
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(root, d, sub, 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* none */ }
  return null;
}

/** The pytools/*.py bridge scripts: beside the app when installed (extraResources), the project folder in dev. */
function scriptPath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'pytools', name) : path.join(app.getAppPath(), 'pytools', name);
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Runs a program with no shell, a time limit and the caller's cancel; output is capped. */
export function runProcess(exe: string, args: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, add: Buffer) => (s.length > 2_000_000 ? s : s + add.toString('utf8'));
    child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
    const kill = () => { try { child.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs a pytools bridge: JSON job in, the "ULTRON_RESULT {...}" line out (libraries log freely around it). */
export async function runPyTool<T>(python: string, script: string, job: unknown, opts: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<T | { ok: false; error: string }> {
  if (!fs.existsSync(python)) return { ok: false, error: `Not installed: ${python}` };
  const r = await runProcess(python, [scriptPath(script)], { input: JSON.stringify(job), env: opts.env, timeoutMs: opts.timeoutMs, signal: opts.signal });
  const line = r.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith('ULTRON_RESULT '));
  if (line) {
    try { return JSON.parse(line.slice('ULTRON_RESULT '.length)) as T; } catch { /* fall through */ }
  }
  if (r.timedOut) return { ok: false, error: `Stopped after ${Math.round(opts.timeoutMs / 1000)} s.` };
  const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
  return { ok: false, error: tail || `Exited with code ${r.code}.` };
}

/* ── YouTube (Agent-Reach's channel: yt-dlp) ────────────────────────── */

/** A WebVTT caption file as plain text: no timings or tags, and the rolling repeats of auto-captions removed. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const l = raw.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').trim();
    if (!l || /^WEBVTT|^Kind:|^Language:|^NOTE\b|-->|^\d+$/.test(l)) continue;
    if (lines[lines.length - 1] === l) continue;
    lines.push(l);
  }
  // Auto-captions repeat each line in the next cue; drop a line the next one starts with.
  return lines.filter((l, i) => !(lines[i + 1] && lines[i + 1].startsWith(l))).join(' ').replace(/\s+/g, ' ').trim();
}

export interface Video { title: string; channel: string; published?: string; duration?: string; url: string; description: string; transcript: string; captions: 'manual' | 'automatic' | 'none' }

/** A video's details and English transcript - by link, or the top result for a search. */
export async function youtube(query: string, signal?: AbortSignal): Promise<Video | { ok: false; error: string }> {
  if (!fs.existsSync(PATHS.ytdlp)) return { ok: false, error: 'The YouTube add-on (Agent-Reach / yt-dlp) is not installed.' };
  const target = /^https?:\/\//i.test(query.trim()) ? query.trim() : `ytsearch1:${query.trim()}`;
  // YouTube now needs a JavaScript runtime to list formats; Node is on this PC. No browser impersonation is used.
  const base = ['--js-runtimes', 'node', '--no-warnings', '--no-playlist', '--skip-download'];
  const meta = await runProcess(PATHS.ytdlp, [...base, '-j', target], { timeoutMs: 60_000, signal });
  const first = meta.stdout.split(/\r?\n/).find((l) => l.startsWith('{'));
  if (!first) return { ok: false, error: `YouTube lookup failed: ${(meta.stderr || 'no result').trim().split(/\r?\n/).pop()?.slice(0, 200)}` };
  const info = JSON.parse(first) as { id: string; title?: string; channel?: string; uploader?: string; upload_date?: string; duration_string?: string; webpage_url?: string; description?: string; subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown> };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-yt-'));
  try {
    const manual = Object.keys(info.subtitles ?? {}).some((k) => /^en/.test(k));
    await runProcess(PATHS.ytdlp, [...base, manual ? '--write-subs' : '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'vtt', '-o', path.join(dir, '%(id)s.%(ext)s'), info.webpage_url || target], { timeoutMs: 60_000, signal });
    const vtt = fs.readdirSync(dir).find((f) => f.endsWith('.vtt'));
    const transcript = vtt ? vttToText(fs.readFileSync(path.join(dir, vtt), 'utf8')) : '';
    const d = info.upload_date;
    return {
      title: info.title ?? '',
      channel: info.channel ?? info.uploader ?? '',
      published: d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined,
      duration: info.duration_string,
      url: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
      description: (info.description ?? '').slice(0, 800),
      transcript,
      captions: transcript ? (manual ? 'manual' : 'automatic') : 'none',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── Skill libraries: Scientific Agent Skills, Lateral Thinking ──────── */

/** `collection`: the library it came from (its folder under ~/UltronTools/skills), e.g. "scientific-agent-skills". */
export interface Skill { name: string; description: string; license: string; dir: string; collection: string }

export const SCIENCE_SKILLS = 'scientific-agent-skills';
export const LATERAL_SKILLS = 'lateral-thinking';

/** A library's own LICENSE file, for skills whose front matter names none (lateral-thinking: MIT, in the repo only). */
const repoLicenses = new Map<string, string | undefined>();
function repoLicense(collectionDir: string): string | undefined {
  if (repoLicenses.has(collectionDir)) return repoLicenses.get(collectionDir);
  let found: string | undefined;
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const p = path.join(collectionDir, f);
    if (!fs.existsSync(p)) continue;
    const head = fs.readFileSync(p, 'utf8').slice(0, 600);
    found = /MIT License|Permission is hereby granted, free of charge/i.test(head) ? 'MIT'
      : /Apache License/i.test(head) ? 'Apache-2.0'
        : /BSD/i.test(head) ? 'BSD' : undefined;
    break;
  }
  repoLicenses.set(collectionDir, found);
  return found;
}

let skillCache: { at: number; skills: Skill[]; index: MiniSearch<Skill & { id: number }> } | null = null;

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_-]+):\s*(.*)$/i.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/**
 * Every openly licensed skill under ~/UltronTools/skills. A skill marked proprietary or of unknown licence is left
 * out; one whose front matter names no licence takes its library's LICENSE file, or is left out if there is none.
 */
export function loadSkills(): Skill[] {
  if (skillCache && Date.now() - skillCache.at < 10 * 60_000) return skillCache.skills;
  const skills: Skill[] = [];
  const root = path.resolve(PATHS.skills);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const fm = frontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
      const collection = path.relative(root, dir).split(path.sep)[0];
      const license = fm.license || repoLicense(path.join(root, collection)) || 'unknown';
      if (fm.name && fm.description && collection && !/proprietary|unknown/i.test(license)) {
        skills.push({ name: fm.name, description: fm.description, license, dir, collection });
      }
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'tests') walk(path.join(dir, e.name), depth - 1);
  };
  walk(PATHS.skills, 4);
  const index = new MiniSearch<Skill & { id: number }>({ fields: ['name', 'description'], storeFields: ['name'], processTerm: skillTerm, searchOptions: { boost: { name: 3 }, fuzzy: 0.2, prefix: true } });
  index.addAll(skills.map((s, id) => ({ ...s, id })));
  skillCache = { at: Date.now(), skills, index };
  return skills;
}

const SKILL_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'what', 'how', 'why', 'with', 'my', 'me', 'i', 'you', 'your', 'it', 'this', 'that', 'use', 'using', 'can', 'do', 'does', 'from', 'by', 'at', 'as', 'help', 'need', 'want', 'please', 'tell',
  // Generic verbs and school words: common in requests and in skill descriptions, so they only add noise to a match.
  'explain', 'explains', 'work', 'works', 'working', 'test', 'tests', 'write', 'writing', 'make', 'makes', 'show', 'showing', 'shows', 'find', 'finding', 'good', 'best', 'method', 'methods', 'report', 'see', 'run', 'running', 'different', 'difference', 'get', 'give', 'new', 'more', 'about', 'between', 'into', 'will', 'should', 'could', 'would', 'my', 'our', 'their']);
function skillTerm(t: string): string | null {
  const w = t.toLowerCase();
  return w.length < 2 || SKILL_STOP.has(w) ? null : w;
}

/** Skills that clearly fit a request - for automatic routing, so stricter than skill_search: whole words, two in common. */
export function matchSkills(query: string, limit = 2, collection?: string): Skill[] {
  const skills = loadSkills();
  if (!skillCache || !skills.length) return [];
  // Two words in common, at least one of them exactly ("plot" may find "plotting", but "works" alone must not find "workflow").
  const asked = new Set((query.toLowerCase().match(/[a-z0-9-]+/g) ?? []).map(skillTerm).filter((t): t is string => Boolean(t)));
  const hits = skillCache.index.search(query, { fuzzy: false, prefix: (t) => t.length >= 4, boost: { name: 3 } })
    .filter((h) => h.terms.length >= 2 && h.terms.some((t) => asked.has(t)))
    .filter((h) => !collection || skills[Number(h.id)].collection === collection);
  // A second match only when it is nearly as good as the first - otherwise it is noise.
  return hits.filter((h, i) => i === 0 || h.score >= hits[0].score * 0.7).slice(0, limit).map((h) => skills[Number(h.id)]);
}

export function searchSkills(query: string, limit = 5): Skill[] {
  const skills = loadSkills();
  if (!skillCache || !skills.length) return [];
  return skillCache.index.search(query).slice(0, limit).map((h) => skills[Number(h.id)]);
}

/**
 * A skill's SKILL.md (or one of its other files), and the files it has - never a path outside the skill's own
 * library. (A router skill reads its siblings as "../six-hats/SKILL.md"; that stays inside lateral-thinking.)
 */
export function readSkill(name: string, file?: string): { name: string; text: string; files: string[] } | { error: string } {
  const skill = loadSkills().find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!skill) return { error: `No skill called "${name}". Use skill_search to find one.` };
  const files: string[] = [];
  const list = (dir: string, rel: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || files.length > 60) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth > 0) list(path.join(dir, e.name), r, depth - 1);
      else if (e.isFile()) files.push(r);
    }
  };
  list(skill.dir, '', 2);
  const wanted = path.resolve(skill.dir, file?.trim() || 'SKILL.md');
  // Inside this skill, or inside another indexed (openly licensed) skill of the same library - nothing else.
  const inside = (s: Skill) => s.collection === skill.collection && wanted.startsWith(path.resolve(s.dir) + path.sep);
  if (!loadSkills().some(inside)) return { error: 'That file is outside the skill.' };
  if (!fs.existsSync(wanted)) return { error: `The skill has no file "${file}". It has: ${files.slice(0, 30).join(', ')}` };
  return { name: skill.name, text: fs.readFileSync(wanted, 'utf8'), files };
}

/**
 * One lateral-thinking technique in its condensed form, from the router skill's own "Condensed core loops"
 * section. The full technique files run 5-9k characters, over the local model's tool-result budget.
 */
export function lateralLoop(technique: string): string | null {
  const router = loadSkills().find((s) => s.collection === LATERAL_SKILLS && s.name === 'lateral');
  if (!router) return null;
  try {
    const text = fs.readFileSync(path.join(router.dir, 'SKILL.md'), 'utf8');
    const section = text.split(/^## Condensed core loops/m)[1]?.split(/^## /m)[0] ?? '';
    const line = section.split(/\r?\n/).find((l) => l.startsWith(`**${technique}**`));
    return line ? line.replace(/^\*\*[\w-]+\*\*\s*[—-]\s*/, '').trim() : null;
  } catch {
    return null;
  }
}

/* ── Status for the Apps panel ───────────────────────────────────────── */

export interface AddonStatus { id: string; name: string; repo: string; installed: boolean; detail: string }

export function addonStatus(ask = false): AddonStatus[] {
  const all = fs.existsSync(PATHS.skills) ? loadSkills() : [];
  const skills = all.filter((s) => s.collection === SCIENCE_SKILLS).length;
  const lateral = all.filter((s) => s.collection === LATERAL_SKILLS).length;
  return [
    { id: 'browser-use', name: 'Browser agent (browser-use)', repo: 'https://github.com/browser-use/browser-use', installed: fs.existsSync(PATHS.browserUsePython), detail: `Autonomous multi-step web tasks in a fresh, logged-out browser - ${ask ? 'asks you before every run' : 'runs without asking (read-only, one site, no downloads)'}.` },
    { id: 'agent-reach', name: 'YouTube and RSS (Agent-Reach)', repo: 'https://github.com/Panniantong/Agent-Reach', installed: fs.existsSync(PATHS.ytdlp), detail: 'Video transcripts and news feeds. Login-based channels (X, Reddit, Instagram) are not set up.' },
    { id: 'hindsight', name: 'Hindsight memory', repo: 'https://github.com/vectorize-io/hindsight', installed: fs.existsSync(PATHS.hindsight), detail: 'A second long-term memory beside the vault, running on this PC with the local model.' },
    { id: 'skills', name: 'Scientific skills', repo: 'https://github.com/K-Dense-AI/scientific-agent-skills', installed: skills > 0, detail: `${skills} skill guides the agents can look up.` },
    { id: 'lateral', name: 'Lateral thinking', repo: 'https://github.com/danium/lateral-thinking', installed: lateral > 0, detail: `${lateral} brainstorming techniques (de Bono) - used by itself when you are stuck, want ideas or weigh a decision.` },
  ];
}

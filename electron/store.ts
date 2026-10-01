import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { schoolUrl } from './schoolUrl';

export interface IndexedFolder {
  path: string;
  addedAt: number;
  fileCount: number;
}

export type BrainChoice = 'auto' | 'gemini' | 'openai' | 'anthropic' | 'ollama';
export type ThinkingMode = 'deep' | 'balanced' | 'fast';
export type WorkflowVersion = 'v1' | 'v2' | 'v3';
export type ResearchDepth = 'quick' | 'standard' | 'deep';
export type TeamMode = 'auto' | 'full';

export interface Settings {
  schema: number;
  profile: {
    name: string;
    location: string;
    interests: string[];
    notes: string;
    /** Under-18 safeguards: no companion/therapist role, and no finished schoolwork to hand in. On unless turned off. */
    under18: boolean;
  };
  /** The first-run setup (name, AI provider, apps) has been completed or skipped. */
  setupDone: boolean;
  news: {
    autoRefreshMinutes: number;
    dailyCap: number;
    categories: string[];
    country: string;
  };
  ollama: {
    host: string;
    model: string;
    numCtx: number;
  };
  /**
   * Which AI answers. auto = the first cloud provider with a key (Gemini, then Anthropic, then OpenAI-compatible),
   * with the local model (Ollama) as the fallback and for background jobs. A named cloud provider still falls back
   * to the local model when it fails; ollama = the local model only.
   */
  brain: BrainChoice;
  /** Any service that speaks the OpenAI chat API: OpenAI, OpenRouter, Groq, DeepSeek, LM Studio... */
  openai: {
    baseUrl: string;
    model: string;
  };
  anthropic: {
    model: string;
  };
  /** deep = Gemini Pro and full reasoning on hard steps; balanced = full reasoning on Flash; fast = quicker, lighter reasoning. */
  thinking: ThinkingMode;
  gemini: {
    /** '' = pick the newest available Flash model automatically. */
    model: string;
  };
  team: {
    /** auto = the lead pulls in whoever the task needs; full = every specialist contributes on every task. */
    mode: TeamMode;
  };
  voice: {
    /** Exact SpeechSynthesis voice name, or '' to auto-pick the deepest English voice. */
    name: string;
    rate: number;
    pitch: number;
    speakReminders: boolean;
    /** Listen for "Ultron" - remembered across restarts. */
    wakeWord: boolean;
  };
  vault: {
    /** '' = ~/Ultron Vault */
    path: string;
  };
  composio: {
    userId: string;
  };
  d2l: {
    baseUrl: string;
  };
  /** The agents' browser: hidden (watch it in the HUD) or real windows on screen. */
  browser: {
    visible: boolean;
  };
  /** Which version of the team's workflow runs - v1 is the earlier behaviour, kept so changes can be compared and undone. */
  workflow: WorkflowVersion;
  research: {
    /** How much deep_research does when a request doesn't say. */
    depth: ResearchDepth;
  };
  /** Per-request budget: past any of these the team stops starting new work and writes up what it has. */
  limits: {
    maxCalls: number;
    maxTokens: number;
    minutes: number;
  };
  /** Open-source add-ons in ~/UltronTools (addons.ts). */
  addons: {
    /** Hindsight memory server beside the vault (runs the local model in the background). */
    hindsight: boolean;
    /** Ask before each browser-agent run. Off: it runs sandboxed (logged out, one site, no downloads) without asking. */
    askBrowserAgent: boolean;
  };
  folders: IndexedFolder[];
}

export interface QuotaState {
  date: string; // YYYY-MM-DD, local
  used: number;
}

const SCHEMA = 2;
const LEGACY_DEFAULT_MODELS = new Set(['llama3.2', 'llama3.2:latest', '']);

const DEFAULTS: Settings = {
  schema: SCHEMA,
  profile: {
    name: '',
    location: '',
    interests: [],
    notes: '',
    under18: true,
  },
  setupDone: false,
  news: {
    autoRefreshMinutes: 60,
    dailyCap: 100,
    categories: ['world', 'nation'],
    country: 'us',
  },
  ollama: { host: 'http://localhost:11434', model: 'qwen3.5:4b', numCtx: 8192 },
  brain: 'auto',
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
  anthropic: { model: 'claude-sonnet-5-5' },
  thinking: 'deep',
  gemini: { model: '' },
  team: { mode: 'auto' },
  voice: { name: '', rate: 0.93, pitch: 0.8, speakReminders: true, wakeWord: false },
  vault: { path: '' },
  composio: { userId: 'ultron' },
  d2l: { baseUrl: '' },
  browser: { visible: false },
  // v2, not v3: on 12 fresh held-out hard problems v3 (the program solver) scored 20/24 to v2's 21/24 at 2-3x the
  // time (evals/README.md, 30 Sep 2026), so it stays a choice in Settings rather than the default.
  workflow: 'v2',
  research: { depth: 'standard' },
  limits: { maxCalls: 60, maxTokens: 600_000, minutes: 10 },
  addons: { hindsight: true, askBrowserAgent: false },
  folders: [],
};

function filePath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;
    return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) } as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, data: unknown): void {
  const p = filePath(name);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Temp file + rename: a crash mid-write can't leave a truncated file behind.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    // A failed persist degrades to "in-memory value only" rather than throwing through reads - but say so.
    console.warn(`[ultron] could not save ${name}:`, e instanceof Error ? e.message : e);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function normalize(raw: Partial<Settings> & { brain?: string }): Settings {
  const s = { ...DEFAULTS, ...raw } as Settings;
  const out: Settings = {
    schema: SCHEMA,
    profile: { ...DEFAULTS.profile, ...s.profile, under18: s.profile?.under18 !== false },
    setupDone: s.setupDone === true,
    news: { ...DEFAULTS.news, ...s.news },
    ollama: { ...DEFAULTS.ollama, ...s.ollama },
    brain: (['auto', 'gemini', 'openai', 'anthropic', 'ollama'] as const).includes(s.brain) ? s.brain : 'auto',
    openai: { ...DEFAULTS.openai, ...s.openai },
    anthropic: { ...DEFAULTS.anthropic, ...s.anthropic },
    thinking: s.thinking === 'balanced' || s.thinking === 'fast' ? s.thinking : 'deep',
    gemini: { ...DEFAULTS.gemini, ...s.gemini },
    team: { mode: s.team?.mode === 'full' ? 'full' : 'auto' },
    voice: { ...DEFAULTS.voice, ...s.voice },
    vault: { ...DEFAULTS.vault, ...s.vault },
    composio: { ...DEFAULTS.composio, ...s.composio },
    d2l: { ...DEFAULTS.d2l, ...s.d2l },
    browser: { visible: s.browser?.visible === true },
    workflow: s.workflow === 'v1' || s.workflow === 'v3' ? s.workflow : 'v2',
    research: { depth: s.research?.depth === 'quick' || s.research?.depth === 'deep' ? s.research.depth : 'standard' },
    limits: {
      maxCalls: clampInt(s.limits?.maxCalls, 10, 400, DEFAULTS.limits.maxCalls),
      maxTokens: clampInt(s.limits?.maxTokens, 50_000, 5_000_000, DEFAULTS.limits.maxTokens),
      minutes: clampInt(s.limits?.minutes, 2, 60, DEFAULTS.limits.minutes),
    },
    addons: { hindsight: s.addons?.hindsight !== false, askBrowserAgent: s.addons?.askBrowserAgent === true },
    folders: Array.isArray(s.folders) ? s.folders : [],
  };
  // However the school's address was typed ("myschool.brightspace.com", http, a whole copied link) - not dropped.
  out.d2l.baseUrl = schoolUrl(out.d2l.baseUrl);
  if (!/^https?:\/\/[^\s/]+/.test(out.openai.baseUrl)) out.openai.baseUrl = DEFAULTS.openai.baseUrl;
  if (!Number.isFinite(out.ollama.numCtx) || out.ollama.numCtx < 2048) out.ollama.numCtx = DEFAULTS.ollama.numCtx;
  if (!out.composio.userId.trim()) out.composio.userId = DEFAULTS.composio.userId;

  // Schema 1 (an early build) defaulted to llama3.2 on Ollama and a Gemini
  // model Google has since retired - move those onto the new defaults once.
  if ((raw.schema ?? 1) < 2) {
    if (LEGACY_DEFAULT_MODELS.has(out.ollama.model)) out.ollama.model = DEFAULTS.ollama.model;
    if (/^gemini-(1\.|2\.0)/.test(out.gemini.model)) out.gemini.model = '';
    if (raw.brain === 'ollama' || raw.brain === undefined) out.brain = 'auto';
  }
  return out;
}

export function getSettings(): Settings {
  const raw = readJson<Partial<Settings>>('settings.json', {});
  const settings = normalize(raw);
  if ((raw.schema ?? 1) < SCHEMA) writeJson('settings.json', settings);
  return settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next = normalize({
    ...current,
    ...patch,
    profile: { ...current.profile, ...patch.profile },
    news: { ...current.news, ...patch.news },
    ollama: { ...current.ollama, ...patch.ollama },
    gemini: { ...current.gemini, ...patch.gemini },
    team: { ...current.team, ...patch.team },
    voice: { ...current.voice, ...patch.voice },
    vault: { ...current.vault, ...patch.vault },
    composio: { ...current.composio, ...patch.composio },
    d2l: { ...current.d2l, ...patch.d2l },
    browser: { ...current.browser, ...patch.browser },
    research: { ...current.research, ...patch.research },
    limits: { ...current.limits, ...patch.limits },
    addons: { ...current.addons, ...patch.addons },
  });
  writeJson('settings.json', next);
  return next;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function getQuota(): QuotaState {
  const q = readJson<QuotaState>('news-quota.json', { date: today(), used: 0 });
  // A non-numeric `used` would turn the cap check into string concatenation
  // and silently disable the 100/day guard.
  const usedOk = typeof q.used === 'number' && Number.isFinite(q.used) && q.used >= 0;
  if (q.date !== today() || !usedOk) {
    const reset = { date: today(), used: 0 };
    writeJson('news-quota.json', reset);
    return reset;
  }
  return q;
}

export function bumpQuota(by = 1): QuotaState {
  const q = getQuota();
  const next = { date: q.date, used: q.used + by };
  writeJson('news-quota.json', next);
  return next;
}

/**
 * Reserves `cost` requests against today's quota atomically (read-modify-
 * write with nothing awaited in between). Callers must reserve before the
 * network request, or two concurrent fetches can both pass the cap check.
 */
export function reserveQuota(cost: number, cap: number): { ok: boolean; quota: QuotaState } {
  const q = getQuota();
  if (q.used + cost > cap) return { ok: false, quota: q };
  const next = { date: q.date, used: q.used + cost };
  writeJson('news-quota.json', next);
  return { ok: true, quota: next };
}

/** Rolls back a reservation for categories that failed before costing a real request. */
export function releaseQuota(by: number): QuotaState {
  const q = getQuota();
  const next = { date: q.date, used: Math.max(0, q.used - by) };
  writeJson('news-quota.json', next);
  return next;
}

/* ── News cache: relaunching the app shouldn't burn requests on stories we already have. */

export interface NewsCache<T> {
  fetchedAt: number;
  articles: T[];
}

export function getNewsCache<T>(): NewsCache<T> {
  return readJson<NewsCache<T>>('news-cache.json', { fetchedAt: 0, articles: [] });
}

export function saveNewsCache<T>(articles: T[]): void {
  writeJson('news-cache.json', { fetchedAt: Date.now(), articles });
}

/* ── Generic small JSON documents in userData (tasks, caches). */

export function readDoc<T>(name: string, fallback: T): T {
  try {
    const p = filePath(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeDoc(name: string, data: unknown): void {
  writeJson(name, data);
}

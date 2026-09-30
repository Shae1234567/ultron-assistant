export type Region =
  | 'NORTH AMERICA' | 'EUROPE' | 'MIDDLE EAST' | 'ASIA-PACIFIC'
  | 'AFRICA' | 'LATIN AMERICA' | 'GLOBAL';

export const ALL_REGIONS: Region[] = [
  'GLOBAL', 'NORTH AMERICA', 'EUROPE', 'MIDDLE EAST', 'ASIA-PACIFIC', 'AFRICA', 'LATIN AMERICA',
];

export interface WeatherResult {
  place: string;
  tempC: number;
  feelsLikeC: number;
  windKph: number;
  condition: string;
  isDay: boolean;
}

export interface Article {
  id: string;
  title: string;
  description: string;
  content: string;
  url: string;
  image: string | null;
  publishedAt: string;
  source: string;
  category: string;
  region: Region;
}

export interface Quota { used: number; cap: number; date: string }

export interface NewsResult {
  articles: Article[];
  quota: Quota;
  fetchedAt: number;
  error?: string;
  blocked?: boolean;
  cached?: boolean;
}

export interface OllamaStatus {
  running: boolean;
  host: string;
  models: string[];
  activeModel: string;
  modelInstalled: boolean;
  error?: string;
}

export interface GeminiState {
  configured: boolean;
  valid: boolean | null;
  model: string | null;
  liveModel: string | null;
  models: string[];
  error?: string;
  checkedAt?: number;
}

export type Provider = 'gemini' | 'openai' | 'anthropic' | 'ollama';

/** A cloud provider other than Gemini (OpenAI-compatible or Anthropic): its key and chosen model. */
export interface CloudState {
  configured: boolean;
  model: string | null;
  valid: boolean | null;
  error?: string;
}

export interface BrainStatus {
  active: Provider | null;
  label: string;
  model: string | null;
  gemini: GeminiState;
  openai: CloudState;
  anthropic: CloudState;
  ollama: OllamaStatus;
}

export interface IndexedFolder { path: string; addedAt: number; fileCount: number }

export interface IndexedFile {
  name: string; path: string; ext: string; size: number; modified: number; folder: string;
}

export interface Settings {
  schema: number;
  profile: { name: string; location: string; interests: string[]; notes: string; under18: boolean };
  setupDone: boolean;
  news: { autoRefreshMinutes: number; dailyCap: number; categories: string[]; country: string };
  ollama: { host: string; model: string; numCtx: number };
  brain: 'auto' | 'gemini' | 'openai' | 'anthropic' | 'ollama';
  openai: { baseUrl: string; model: string };
  anthropic: { model: string };
  thinking: 'deep' | 'balanced' | 'fast';
  gemini: { model: string };
  team: { mode: 'auto' | 'full' };
  voice: { name: string; rate: number; pitch: number; speakReminders: boolean; wakeWord: boolean };
  vault: { path: string };
  composio: { userId: string };
  d2l: { baseUrl: string };
  browser: { visible: boolean };
  workflow: 'v1' | 'v2' | 'v3';
  research: { depth: 'quick' | 'standard' | 'deep' };
  limits: { maxCalls: number; maxTokens: number; minutes: number };
  addons: { hindsight: boolean; askBrowserAgent: boolean };
  folders: IndexedFolder[];
}

export type SecretName = 'GEMINI_API_KEY' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'COMPOSIO_API_KEY' | 'GNEWS_API_KEY' | 'TELEGRAM_BOT_TOKEN' | 'DISCORD_BOT_TOKEN' | 'WOLFRAM_APP_ID';

/* ── Team ─────────────────────────────────────────────────────────────── */

export type AgentId = 'ultron' | 'athena' | 'argus' | 'hephaestus' | 'hermes' | 'chronos' | 'mnemosyne' | 'daedalus';

export interface AgentInfo { id: AgentId; name: string; title: string; summary: string; color: string }

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error';

export type TeamPhase = 'idle' | 'recall' | 'thinking' | 'planning' | 'working' | 'reviewing' | 'writing';

export interface PlanStep { id: string; agent: AgentId; task: string; dependsOn: string[]; status?: 'queued' | 'working' | 'done' | 'failed' }

export interface ActivityLine { id: string; at: number; agent: AgentId; /** a helper the agent built */ sub?: string; text: string; kind?: 'progress' | 'note' | 'ok' | 'warn' }

/** A helper sub-agent a specialist built for part of its job. */
export interface HelperCard { id: string; parent: AgentId; name: string; task: string; status: 'working' | 'done' | 'failed'; report?: string }

/** The latest picture of one agent's (or helper's) browser tab. */
export interface BrowserFrame { id: string; runId: string; agent: AgentId; label: string; url: string; title: string; image: string; at: number; closed?: boolean }

export interface SourceLink { title: string; url: string }

/** How long one phase of a run took (recall, thinking, planning, working, reviewing, reporting). */
export interface PhaseTiming { label: string; ms: number }

export type BrainEvent =
  | { runId: string; at: number; type: 'start'; provider: Provider | null }
  | { runId: string; at: number; type: 'phase'; phase: TeamPhase; label: string }
  | { runId: string; at: number; type: 'agent'; agent: AgentId; status: AgentStatus; task?: string }
  | { runId: string; at: number; type: 'action'; agent: AgentId; sub?: string; text: string; kind?: ActivityLine['kind'] }
  | { runId: string; at: number; type: 'helper'; id: string; parent: AgentId; name: string; task?: string; skills?: string[]; status: HelperCard['status']; report?: string }
  | { runId: string; at: number; type: 'plan'; steps: PlanStep[]; note?: string }
  | { runId: string; at: number; type: 'step'; id: string; status: 'working' | 'done' | 'failed'; report?: string }
  | { runId: string; at: number; type: 'token'; text: string }
  | { runId: string; at: number; type: 'reset' }
  | { runId: string; at: number; type: 'notice'; text: string }
  | { runId: string; at: number; type: 'final'; text: string; agents: AgentId[]; sources: SourceLink[]; runNote?: string; timings?: PhaseTiming[] }
  | { runId: string; at: number; type: 'error'; message: string; cancelled?: boolean }
  | { runId: string; at: number; type: 'done' };

export interface ApprovalRequest {
  id: string;
  runId: string;
  agent: AgentId;
  kind: string;
  title: string;
  detail: string;
  createdAt: number;
}

/* ── Tasks ────────────────────────────────────────────────────────────── */

export interface Task {
  id: string;
  title: string;
  notes: string;
  due: string | null;
  remindAt: string | null;
  allDay: boolean;
  priority: 'low' | 'normal' | 'high';
  recurrence: 'daily' | 'weekdays' | 'weekly' | null;
  done: boolean;
  doneAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'operator' | 'ultron';
}

/* ── Apps / D2L / memory ─────────────────────────────────────────────── */

export type AppConnection = 'connected' | 'pending' | 'expired' | 'failed' | 'none';

export interface AppState {
  slug: string;
  name: string;
  group: 'Google' | 'Apps';
  blurb: string;
  recommended?: boolean;
  status: AppConnection;
  accountIds: string[];
  detail?: string;
}

export interface AppsStatus { hasKey: boolean; mode: 'connect' | 'project' | 'none'; auth: 'oauth' | 'key' | 'none'; ok: boolean; error?: string; hint?: string; userId: string; apps: AppState[]; checkedAt: number }

/** The agents' own browser profile: which sites have saved logins, and whether the sign-in window is open. */
export interface WebLogins { signInOpen: boolean; sites: string[]; checkedAt?: number }

export interface D2LStatus { baseUrl: string; signedIn: boolean; user?: string; error?: string }

/** Open-source add-ons in ~/UltronTools (electron/addons.ts). */
export interface AddonStatus { id: string; name: string; repo: string; installed: boolean; detail: string }
export interface AddonsReport {
  addons: AddonStatus[];
  hindsight: { installed: boolean; enabled: boolean; running: boolean; error?: string };
}

/** The operator's own Discord bot (electron/discord.ts). */
export interface DiscordStatus {
  configured: boolean;
  ok?: boolean;
  bot?: string;
  servers?: { id: string; name: string }[];
  inviteUrl?: string;
  /** Servers where Composio's shared bot is still a member. */
  sharedBotIn?: string[];
  error?: string;
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

export interface VaultNote { rel: string; title: string; folder: string; mtime: number; size: number }

export interface MemoryHit { rel: string; title: string; text: string; score: number }

export interface MemoryUpdate { at: number; saved: { title: string; rel: string; added: number; created: boolean }[]; profileAdded: number }

/* ── Conversation ─────────────────────────────────────────────────────── */

export type CoreState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline';

export interface TranscriptEntry {
  id: string;
  who: 'you' | 'ultron' | 'system';
  text: string;
  at: number;
  streaming?: boolean;
  error?: boolean;
  sources?: SourceLink[];
  /** Which agents worked on this reply, and the saved team log if the team ran. */
  team?: { agents: AgentId[]; runNote?: string; actions: ActivityLine[] };
}

import { create } from 'zustand';
import type {
  ActivityLine, AgentId, AgentInfo, AgentStatus, AppsStatus, ApprovalRequest, Article, BrainStatus, BrowserFrame, CoreState, D2LStatus, HelperCard,
  IndexedFolder, MemoryUpdate, OllamaStatus, PhaseTiming, PlanStep, Quota, Region, Settings, Task, TeamPhase, TranscriptEntry, WeatherResult,
} from '../types';

export type RightTab = 'team' | 'tasks' | 'files' | 'system';
export type Overlay =
  | null
  | { kind: 'settings' }
  | { kind: 'brain' }
  | { kind: 'memory' }
  | { kind: 'apps' }
  | { kind: 'setup' };

export interface AgentCard { status: AgentStatus; task: string; updatedAt: number }

export interface TeamState {
  runId: string | null;
  phase: TeamPhase;
  phaseLabel: string;
  agents: Partial<Record<AgentId, AgentCard>>;
  plan: PlanStep[];
  planNote: string;
  log: ActivityLine[];
  /** Helper sub-agents the specialists built during this run. */
  helpers: HelperCard[];
  /** Where the last finished run spent its time. */
  timings: PhaseTiming[];
}

const EMPTY_TEAM: TeamState = { runId: null, phase: 'idle', phaseLabel: '', agents: {}, plan: [], planNote: '', log: [], helpers: [], timings: [] };

interface UltronState {
  coreState: CoreState;
  setCoreState: (s: CoreState) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;

  transcript: TranscriptEntry[];
  pushEntry: (e: Omit<TranscriptEntry, 'id' | 'at'> & { id?: string }) => string;
  appendToEntry: (id: string, token: string) => void;
  finishEntry: (id: string, patch?: Partial<TranscriptEntry>) => void;
  clearTranscript: () => void;
  /** Puts a saved conversation back at boot, ahead of anything already on screen. */
  restoreTranscript: (entries: TranscriptEntry[]) => void;

  brain: BrainStatus | null;
  setBrain: (s: BrainStatus) => void;
  /** Kept for panels that only care about the local daemon. */
  ollama: OllamaStatus | null;

  settings: Settings | null;
  setSettings: (s: Settings) => void;

  agentsInfo: AgentInfo[];
  setAgentsInfo: (a: AgentInfo[]) => void;
  team: TeamState;
  startTeam: (runId: string) => void;
  setPhase: (phase: TeamPhase, label: string) => void;
  setAgent: (agent: AgentId, status: AgentStatus, task?: string) => void;
  setPlan: (steps: PlanStep[], note?: string) => void;
  setStepStatus: (id: string, status: PlanStep['status']) => void;
  logActivity: (line: Omit<ActivityLine, 'id' | 'at'>) => ActivityLine;
  setHelper: (h: Partial<HelperCard> & Pick<HelperCard, 'id' | 'parent' | 'name' | 'status'>) => void;
  setTimings: (t: PhaseTiming[]) => void;
  endTeam: () => void;

  /** Live view of every agent's browser tab, newest frame per tab. */
  browsers: Record<string, BrowserFrame>;
  setFrame: (f: BrowserFrame) => void;
  markBrowserClosed: (id: string) => void;

  approvals: ApprovalRequest[];
  addApproval: (a: ApprovalRequest) => void;
  removeApproval: (id: string) => void;

  tasks: Task[];
  setTasks: (t: Task[]) => void;

  apps: AppsStatus | null;
  setApps: (a: AppsStatus) => void;
  d2l: D2LStatus | null;
  setD2L: (s: D2LStatus) => void;

  weather: WeatherResult | null;
  setWeather: (w: WeatherResult | null) => void;

  memoryFeed: MemoryUpdate[];
  pushMemoryUpdate: (u: MemoryUpdate) => void;

  articles: Article[];
  quota: Quota | null;
  newsError: string | null;
  newsLoading: boolean;
  lastFetch: number | null;
  regionFilter: Region | 'ALL';
  relevance: Record<string, { status: 'pending' | 'done' | 'failed'; text: string }>;
  setNews: (p: { articles?: Article[]; quota?: Quota; error?: string | null; loading?: boolean; lastFetch?: number }) => void;
  setRegionFilter: (r: Region | 'ALL') => void;
  setRelevance: (id: string, v: { status: 'pending' | 'done' | 'failed'; text: string }) => void;

  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;
  folders: IndexedFolder[];
  setFolders: (f: IndexedFolder[]) => void;

  overlay: Overlay;
  setOverlay: (o: Overlay) => void;

  booting: boolean;
  bootChecks: Record<'memory' | 'settings' | 'brain' | 'voice', 'pending' | 'ok' | 'warn'>;
  setBootCheck: (key: 'memory' | 'settings' | 'brain' | 'voice', status: 'ok' | 'warn') => void;
  finishBoot: () => void;
}

let seq = 0;
const nextId = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;

// Every streamed token copies the transcript array; an unbounded session
// would make that copy compete with the orb animations for frame time.
const MAX_TRANSCRIPT = 400;
const MAX_LOG = 160;

export const useStore = create<UltronState>((set) => ({
  coreState: 'idle',
  setCoreState: (coreState) => set({ coreState }),
  busy: false,
  setBusy: (busy) => set({ busy }),

  transcript: [],
  pushEntry: (e) => {
    const id = e.id ?? nextId();
    set((s) => {
      const next = [...s.transcript, { ...e, id, at: Date.now() }];
      return { transcript: next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next };
    });
    return id;
  },
  appendToEntry: (id, token) =>
    set((s) => ({ transcript: s.transcript.map((t) => (t.id === id ? { ...t, text: t.text + token } : t)) })),
  finishEntry: (id, patch) =>
    set((s) => ({ transcript: s.transcript.map((t) => (t.id === id ? { ...t, streaming: false, ...patch } : t)) })),
  clearTranscript: () => set({ transcript: [] }),
  restoreTranscript: (entries) =>
    set((s) => {
      const known = new Set(s.transcript.map((t) => t.id));
      return { transcript: [...entries.filter((e) => !known.has(e.id)), ...s.transcript].slice(-MAX_TRANSCRIPT) };
    }),

  brain: null,
  setBrain: (brain) => set({ brain, ollama: brain.ollama }),
  ollama: null,

  settings: null,
  setSettings: (settings) => set({ settings }),

  agentsInfo: [],
  setAgentsInfo: (agentsInfo) => set({ agentsInfo }),
  team: EMPTY_TEAM,
  startTeam: (runId) => set({ team: { ...EMPTY_TEAM, runId, phase: 'recall', phaseLabel: 'RECALLING' }, browsers: {} }),
  setPhase: (phase, phaseLabel) => set((s) => ({ team: { ...s.team, phase, phaseLabel } })),
  setAgent: (agent, status, task) =>
    set((s) => ({
      team: {
        ...s.team,
        agents: { ...s.team.agents, [agent]: { status, task: task ?? s.team.agents[agent]?.task ?? '', updatedAt: Date.now() } },
      },
    })),
  setPlan: (plan, planNote = '') => set((s) => ({ team: { ...s.team, plan, planNote } })),
  setStepStatus: (id, status) =>
    set((s) => ({ team: { ...s.team, plan: s.team.plan.map((p) => (p.id === id ? { ...p, status } : p)) } })),
  logActivity: (line) => {
    const full: ActivityLine = { ...line, id: nextId(), at: Date.now() };
    set((s) => {
      const log = [...s.team.log, full];
      return { team: { ...s.team, log: log.length > MAX_LOG ? log.slice(-MAX_LOG) : log } };
    });
    return full;
  },
  setHelper: (h) =>
    set((s) => {
      const existing = s.team.helpers.find((x) => x.id === h.id);
      const helpers = existing
        ? s.team.helpers.map((x) => (x.id === h.id ? { ...x, ...h, task: h.task ?? x.task } : x))
        : [...s.team.helpers, { task: '', ...h }];
      return { team: { ...s.team, helpers } };
    }),
  setTimings: (timings) => set((s) => ({ team: { ...s.team, timings } })),
  browsers: {},
  setFrame: (f) =>
    set((s) => (s.team.runId && f.runId !== s.team.runId ? {} : { browsers: { ...s.browsers, [f.id]: f } })),
  markBrowserClosed: (id) =>
    set((s) => (s.browsers[id] ? { browsers: { ...s.browsers, [id]: { ...s.browsers[id], closed: true } } } : {})),
  endTeam: () =>
    set((s) => {
      // Keep the finished run on screen (cards go idle, plan and log stay) until the next message.
      const agents: TeamState['agents'] = {};
      for (const [id, card] of Object.entries(s.team.agents)) {
        agents[id as AgentId] = { ...card!, status: card!.status === 'error' ? 'error' : card!.status === 'idle' ? 'idle' : 'done' };
      }
      return { team: { ...s.team, phase: 'idle', phaseLabel: '', agents } };
    }),

  approvals: [],
  addApproval: (a) => set((s) => (s.approvals.some((x) => x.id === a.id) ? s : { approvals: [...s.approvals, a] })),
  removeApproval: (id) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })),

  tasks: [],
  setTasks: (tasks) => set({ tasks }),

  apps: null,
  setApps: (apps) => set({ apps }),
  d2l: null,
  setD2L: (d2l) => set({ d2l }),

  weather: null,
  setWeather: (weather) => set({ weather }),

  memoryFeed: [],
  pushMemoryUpdate: (u) => set((s) => ({ memoryFeed: [u, ...s.memoryFeed].slice(0, 30) })),

  articles: [],
  quota: null,
  newsError: null,
  newsLoading: false,
  lastFetch: null,
  regionFilter: 'ALL',
  relevance: {},
  setNews: (p) =>
    set((s) => {
      const articles = p.articles ?? s.articles;
      // Prune relevance blurbs to stories still on screen, or it grows forever.
      let relevance = s.relevance;
      if (p.articles) {
        const live = new Set(articles.map((a) => a.id));
        const pruned: typeof s.relevance = {};
        for (const [id, v] of Object.entries(s.relevance)) if (live.has(id)) pruned[id] = v;
        relevance = pruned;
      }
      return {
        articles,
        relevance,
        quota: p.quota ?? s.quota,
        newsError: p.error === undefined ? s.newsError : p.error,
        newsLoading: p.loading ?? s.newsLoading,
        lastFetch: p.lastFetch ?? s.lastFetch,
      };
    }),
  setRegionFilter: (regionFilter) => set({ regionFilter }),
  setRelevance: (id, v) => set((s) => ({ relevance: { ...s.relevance, [id]: v } })),

  rightTab: 'team',
  setRightTab: (rightTab) => set({ rightTab }),
  folders: [],
  setFolders: (folders) => set({ folders }),

  overlay: null,
  setOverlay: (overlay) => set({ overlay }),

  booting: true,
  bootChecks: { memory: 'pending', settings: 'pending', brain: 'pending', voice: 'pending' },
  setBootCheck: (key, status) => set((s) => ({ bootChecks: { ...s.bootChecks, [key]: status } })),
  finishBoot: () => set({ booting: false }),
}));

/**
 * Speech-to-text capability, learned at runtime rather than assumed.
 * Whisper runs locally in a worker; the first load downloads model weights,
 * so the UI needs to distinguish "still loading" from "actually works".
 */
export type SttStatus = 'unknown' | 'loading' | 'ok' | 'transcribing' | 'unavailable';

interface SttState {
  stt: SttStatus;
  sttReason: string;
  sttProgress: number;
  setStt: (s: SttStatus, reason?: string) => void;
  setSttProgress: (p: number) => void;
}

export const useSttStore = create<SttState>((set) => ({
  stt: 'unknown',
  sttReason: '',
  sttProgress: 0,
  setStt: (stt, sttReason = '') => set({ stt, sttReason }),
  setSttProgress: (sttProgress) => set({ sttProgress }),
}));

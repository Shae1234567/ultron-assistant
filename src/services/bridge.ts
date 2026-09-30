import type { UltronBridge } from '../types/global';
import type { Settings } from '../types';

/**
 * Access point for the preload bridge. Inside Electron this is the real
 * `window.ultron`. Opened directly in a browser (`npx vite`, for quick visual
 * iteration) there is no preload, so a null implementation reports every
 * capability as unavailable - it never fabricates data.
 */

export const inElectron = typeof window !== 'undefined' && Boolean((window as unknown as { ultron?: unknown }).ultron);

const unavailable = (what: string) => `${what} is only available in the Electron app.`;
const noop = () => () => {};

const DEFAULT_SETTINGS: Settings = {
  schema: 2,
  profile: { name: '', location: '', interests: [], notes: '', under18: true },
  setupDone: true,
  news: { autoRefreshMinutes: 60, dailyCap: 100, categories: ['world', 'nation'], country: 'us' },
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
  workflow: 'v2',
  research: { depth: 'standard' },
  limits: { maxCalls: 60, maxTokens: 600_000, minutes: 10 },
  addons: { hindsight: true, askBrowserAgent: false },
  folders: [],
};

const offlineOllama = {
  running: false, host: 'http://localhost:11434', models: [], activeModel: 'qwen3.5:4b', modelInstalled: false, error: unavailable('Ollama'),
};

const nullBridge: UltronBridge = {
  win: { minimize: async () => {}, maximize: async () => false, close: async () => {}, show: async () => {}, onState: noop },
  notify: { show: async () => ({ ok: false }) },
  brain: {
    ask: async () => ({ ok: false, error: unavailable('The brain') }),
    cancel: async () => {},
    status: async () => ({
      active: null, label: 'BRAIN OFFLINE', model: null,
      gemini: { configured: false, valid: null, model: null, liveModel: null, models: [] },
      openai: { configured: false, valid: null, model: null },
      anthropic: { configured: false, valid: null, model: null },
      ollama: offlineOllama,
    }),
    recheck: async () => nullBridge.brain.status(),
    checkCloud: async () => null,
    once: async () => ({ ok: false as const, error: unavailable('The brain') }),
    greet: async () => ({ ok: false, error: unavailable('The brain') }),
    agents: async () => [],
    liveVoice: async () => ({ key: '', model: null }),
    onEvent: noop,
  },
  approvals: { respond: async () => {}, pending: async () => [], onRequest: noop, onSettled: noop },
  secrets: {
    status: async () => ({ GEMINI_API_KEY: false, OPENAI_API_KEY: false, ANTHROPIC_API_KEY: false, COMPOSIO_API_KEY: false, GNEWS_API_KEY: false, TELEGRAM_BOT_TOKEN: false, DISCORD_BOT_TOKEN: false, WOLFRAM_APP_ID: false }),
    set: async () => ({ ok: false, error: unavailable('Saving keys') }),
  },
  discord: {
    status: async () => ({ configured: false }),
  },
  addons: {
    status: async () => ({ addons: [], hindsight: { installed: false, enabled: false, running: false } }),
    setHindsight: async () => ({ addons: [], hindsight: { installed: false, enabled: false, running: false } }),
    setAskBrowserAgent: async () => false,
  },
  settings: {
    get: async () => DEFAULT_SETTINGS,
    save: async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }),
  },
  ollama: { status: async () => offlineOllama, pull: async () => ({ ok: false, error: unavailable('Ollama') }), onPullProgress: noop },
  vault: {
    stats: async () => ({ root: '(unavailable outside Electron)', notes: 0, memories: 0, journalDays: 0, research: 0, teamRuns: 0, lastUpdated: null }),
    recent: async () => [],
    search: async () => [],
    profile: async () => '',
    saveProfile: async () => ({ ok: false, error: unavailable('Memory') }),
    open: async () => ({ ok: false, error: unavailable('Memory') }),
    reveal: async () => ({ ok: false, error: unavailable('Memory') }),
    choose: async () => ({ ok: false }),
    reindex: async () => nullBridge.vault.stats(),
    onUpdated: noop,
  },
  web: { status: async () => ({ signInOpen: false, sites: [] }), signIn: async () => ({ ok: false, error: unavailable('The browser') }), clear: async () => ({ signInOpen: false, sites: [] }), onChanged: noop },
  transcript: { load: async () => [], save: async () => false },
  tasks: {
    list: async () => [],
    add: async () => ({ ok: false, error: unavailable('Tasks') }),
    complete: async () => null,
    reopen: async () => null,
    remove: async () => null,
    snooze: async () => null,
    update: async () => null,
    clearDone: async () => 0,
    onChanged: noop,
    onReminder: noop,
  },
  browser: { onFrame: noop, onClosed: noop },
  apps: {
    status: async () => ({ hasKey: false, mode: 'none', auth: 'none', ok: false, error: unavailable('Apps'), userId: 'ultron', apps: [], checkedAt: Date.now() }),
    connect: async () => ({ ok: false, error: unavailable('Apps') }),
    disconnect: async () => ({ ok: false, error: unavailable('Apps') }),
    signIn: async () => ({ ok: false, error: unavailable('Apps') }),
    signOut: async () => nullBridge.apps.status(),
    onChanged: noop,
  },
  d2l: {
    status: async () => ({ baseUrl: DEFAULT_SETTINGS.d2l.baseUrl, signedIn: false, error: unavailable('D2L') }),
    signIn: async () => nullBridge.d2l.status(),
    signOut: async () => nullBridge.d2l.status(),
    open: async () => { window.open(DEFAULT_SETTINGS.d2l.baseUrl, '_blank', 'noopener'); },
    sync: async () => ({ ok: false, error: unavailable('D2L') }),
    onChanged: noop,
  },
  news: {
    fetch: async () => ({ articles: [], quota: { used: 0, cap: 100, date: '' }, fetchedAt: Date.now(), error: unavailable('News') }),
    quota: async () => ({ used: 0, cap: 100, date: '' }),
    hasKey: async () => false,
  },
  research: { weather: async () => null },
  system: { hardwareStats: async () => ({ cpuPercent: 0, ramPercent: 0, ramUsedGB: 0, ramTotalGB: 0 }) },
  files: {
    addFolder: async () => ({ ok: false, folders: [] }),
    removeFolder: async () => [],
    list: async () => [],
    search: async () => [],
    rebuild: async () => 0,
    stats: async () => ({ folderCount: 0, fileCount: 0, capped: false }),
    reveal: async () => false,
    read: async () => ({ ok: false, error: unavailable('Files') }),
    write: async () => ({ ok: false, error: unavailable('Files') }),
    rename: async () => ({ ok: false, error: unavailable('Files') }),
    move: async () => ({ ok: false, error: unavailable('Files') }),
    delete: async () => ({ ok: false, error: unavailable('Files') }),
    createFile: async () => ({ ok: false, error: unavailable('Files') }),
    createFolder: async () => ({ ok: false, error: unavailable('Files') }),
  },
  backup: {
    export: async () => ({ ok: false, error: unavailable('Backup') }),
    import: async () => ({ ok: false, error: unavailable('Backup') }),
  },
  tray: { isAutoLaunchEnabled: async () => false, setAutoLaunch: async () => false },
  clipboard: { onNewText: noop },
  ui: { onFocus: noop },
  app: {
    openExternal: async (url: string) => { window.open(url, '_blank', 'noopener'); return true; },
    versions: async () => ({ app: '-', packaged: false, electron: '-', chrome: '-', node: '-', platform: 'browser' }),
  },
};

export const ultron: UltronBridge = inElectron ? (window as unknown as { ultron: UltronBridge }).ultron : nullBridge;

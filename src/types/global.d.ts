import type {
  AddonsReport, AgentInfo, AppsStatus, ApprovalRequest, BrainEvent, BrainStatus, BrowserFrame, D2LStatus, DiscordStatus, IndexedFile, IndexedFolder,
  MemoryHit, MemoryUpdate, NewsResult, OllamaStatus, Quota, SecretName, Settings, Task, TranscriptEntry, VaultNote, WebLogins, VaultStats, WeatherResult, CloudState,
} from './index';

type Ok = { ok: boolean; error?: string };

export interface UltronBridge {
  win: {
    minimize(): Promise<void>;
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    show(): Promise<void>;
    onState(cb: (s: { maximized: boolean }) => void): () => void;
  };
  notify: {
    show(title: string, body: string): Promise<{ ok: boolean; skipped?: boolean }>;
  };
  brain: {
    ask(text: string, history: { role: 'user' | 'assistant'; content: string }[]): Promise<{ ok: boolean; runId?: string; error?: string }>;
    cancel(runId: string): Promise<void>;
    status(): Promise<BrainStatus>;
    recheck(): Promise<BrainStatus>;
    /** Lists the models a Claude or OpenAI-compatible key can use - which also proves the key works. */
    checkCloud(p: 'openai' | 'anthropic'): Promise<(CloudState & { models?: string[] }) | null>;
    once(p: { system: string; user?: string; tier?: 'main' | 'fast'; temperature?: number }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
    greet(kind: 'boot' | 'wake' | 'checkin'): Promise<{ ok: boolean; text?: string; error?: string }>;
    agents(): Promise<AgentInfo[]>;
    liveVoice(): Promise<{ key: string; model: string | null; system?: string }>;
    onEvent(cb: (e: BrainEvent) => void): () => void;
  };
  approvals: {
    respond(id: string, approved: boolean, all?: boolean): Promise<void>;
    pending(): Promise<ApprovalRequest[]>;
    onRequest(cb: (req: ApprovalRequest) => void): () => void;
    onSettled(cb: (p: { id: string; approved: boolean }) => void): () => void;
  };
  secrets: {
    status(): Promise<Record<SecretName, boolean>>;
    set(name: SecretName, value: string): Promise<{ ok: boolean; status?: Record<SecretName, boolean>; detail?: string; error?: string }>;
  };
  discord: {
    status(): Promise<DiscordStatus>;
  };
  addons: {
    status(): Promise<AddonsReport>;
    setHindsight(on: boolean): Promise<AddonsReport>;
    setAskBrowserAgent(on: boolean): Promise<boolean>;
  };
  settings: {
    get(): Promise<Settings>;
    save(patch: Partial<Settings>): Promise<Settings>;
  };
  ollama: {
    status(): Promise<OllamaStatus>;
    pull(model: string): Promise<Ok>;
    onPullProgress(cb: (p: { model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }) => void): () => void;
  };
  vault: {
    stats(): Promise<VaultStats>;
    recent(limit?: number): Promise<VaultNote[]>;
    search(q: string): Promise<MemoryHit[]>;
    profile(): Promise<string>;
    saveProfile(text: string): Promise<Ok>;
    open(rel?: string): Promise<{ ok: boolean; via?: 'obsidian' | 'explorer'; hint?: string; error?: string }>;
    reveal(): Promise<Ok>;
    choose(): Promise<{ ok: boolean; settings?: Settings }>;
    reindex(): Promise<VaultStats>;
    onUpdated(cb: (u: MemoryUpdate) => void): () => void;
  };
  web: {
    status(): Promise<WebLogins>;
    signIn(url?: string): Promise<{ ok: boolean; error?: string }>;
    clear(): Promise<WebLogins>;
    onChanged(cb: (s: WebLogins) => void): () => void;
  };
  transcript: {
    load(): Promise<TranscriptEntry[]>;
    save(entries: TranscriptEntry[]): Promise<boolean>;
  };
  tasks: {
    list(): Promise<Task[]>;
    add(input: { title: string; due?: string; priority?: string }): Promise<{ ok: boolean; task?: Task; error?: string }>;
    complete(id: string): Promise<Task | null>;
    reopen(id: string): Promise<Task | null>;
    remove(id: string): Promise<Task | null>;
    snooze(id: string, minutes: number): Promise<Task | null>;
    update(id: string, patch: Partial<Pick<Task, 'title' | 'notes' | 'priority'>> & { due?: string | null }): Promise<Task | null>;
    clearDone(): Promise<number>;
    onChanged(cb: (all: Task[]) => void): () => void;
    onReminder(cb: (p: { task: Task; missed: boolean }) => void): () => void;
  };
  browser: {
    onFrame(cb: (f: BrowserFrame) => void): () => void;
    onClosed(cb: (c: { id: string; runId: string }) => void): () => void;
  };
  apps: {
    status(): Promise<AppsStatus>;
    connect(slug: string): Promise<{ ok: boolean; redirectUrl?: string; error?: string; setupUrl?: string }>;
    disconnect(slug: string): Promise<Ok>;
    signIn(): Promise<{ ok: boolean; error?: string; status?: AppsStatus }>;
    signOut(): Promise<AppsStatus>;
    onChanged(cb: (s: AppsStatus) => void): () => void;
  };
  d2l: {
    status(): Promise<D2LStatus>;
    signIn(): Promise<D2LStatus>;
    signOut(): Promise<D2LStatus>;
    open(): Promise<void>;
    sync(): Promise<{ ok: boolean; added?: string[]; skipped?: number; error?: string }>;
    onChanged(cb: (s: D2LStatus) => void): () => void;
  };
  news: {
    fetch(manual?: boolean): Promise<NewsResult>;
    quota(): Promise<Quota>;
    hasKey(): Promise<boolean>;
  };
  research: {
    weather(place: string): Promise<WeatherResult | null>;
  };
  system: {
    hardwareStats(): Promise<{ cpuPercent: number; ramPercent: number; ramUsedGB: number; ramTotalGB: number }>;
  };
  files: {
    addFolder(): Promise<{ ok: boolean; folders: IndexedFolder[] }>;
    removeFolder(p: string): Promise<IndexedFolder[]>;
    list(limit?: number): Promise<IndexedFile[]>;
    search(q: string): Promise<IndexedFile[]>;
    rebuild(): Promise<number>;
    stats(): Promise<{ folderCount: number; fileCount: number; capped: boolean }>;
    reveal(p: string): Promise<boolean>;
    read(p: string): Promise<{ ok: boolean; content?: string; error?: string }>;
    write(p: string, content: string): Promise<Ok>;
    rename(p: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    move(p: string, destFolder: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    delete(p: string): Promise<Ok>;
    createFile(folder: string, name: string, content?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    createFolder(folder: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  };
  backup: {
    export(): Promise<{ ok: boolean; path?: string; error?: string }>;
    import(): Promise<Ok>;
  };
  tray: {
    isAutoLaunchEnabled(): Promise<boolean>;
    setAutoLaunch(enabled: boolean): Promise<boolean>;
  };
  clipboard: {
    onNewText(cb: (text: string) => void): () => void;
  };
  ui: {
    onFocus(cb: (p: { tab?: string }) => void): () => void;
  };
  app: {
    openExternal(url: string): Promise<boolean>;
    versions(): Promise<{ app: string; packaged: boolean; electron: string; chrome: string; node: string; platform: string }>;
  };
}

declare global {
  interface Window { ultron: UltronBridge }
}

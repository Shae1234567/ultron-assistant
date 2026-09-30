import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { getSettings, saveSettings, type Settings } from './store';
import { getSecret, isSecretName, secretsStatus, setSecret } from './secrets';
import * as ollama from './ollama';
import * as news from './news';
import * as files from './files';
import * as research from './research';
import * as backup from './backup';
import * as notifications from './notifications';
import * as tasks from './tasks';
import * as composio from './composio';
import * as d2l from './d2l';
import * as discord from './discord';
import * as addons from './addons';
import * as hindsight from './hindsight';
import { loadTranscript, saveTranscript } from './transcript';
import * as browserAgent from './browser';
import { getHardwareStats } from './hardwareStats';
import { isAutoLaunchEnabled, setAutoLaunch } from './tray';
import { ask, cancelRun, newRunId, once } from './brain/team';
import { brainStatus, refreshGemini, checkCloud } from './brain/llm';
import { greet, type GreetKind } from './brain/proactive';
import { AGENTS } from './brain/agents';
import { pendingApprovals, respond as respondApproval } from './brain/approvals';
import { emit, windowFocused } from './brain/events';
import { memoryBlock, persona } from './brain/prompts';
import { ensureVault, profileForPrompt, readProfile, recentNotes, saveProfile, vaultRoot, vaultStats } from './memory/vault';
import { forgetIndex, searchMemory, syncIndex } from './memory/semantic';

type GetWin = () => BrowserWindow | null;

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Reads (never writes) Obsidian's own vault registry. */
function obsidianKnowsVault(root: string): boolean {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'obsidian', 'obsidian.json'), 'utf8')) as { vaults?: Record<string, { path?: string }> };
    const want = path.resolve(root).toLowerCase();
    return Object.values(registry.vaults ?? {}).some((v) => v.path && path.resolve(v.path).toLowerCase() === want);
  } catch {
    return false;
  }
}

export function registerIpc(getWin: GetWin): void {
  /* ── window chrome ─────────────────────────────────────────────── */
  ipcMain.handle('win:minimize', () => getWin()?.minimize());
  ipcMain.handle('win:maximize', () => {
    const win = getWin();
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => getWin()?.close());
  ipcMain.handle('win:show', () => { const w = getWin(); w?.show(); w?.focus(); });

  ipcMain.handle('notify:show', (_e, title: unknown, body: unknown) => {
    if (!isStr(title) || !isStr(body)) return { ok: false };
    if (windowFocused()) return { ok: true, skipped: true };
    notifications.showNotification(title, body);
    return { ok: true };
  });

  /* ── brain ─────────────────────────────────────────────────────── */
  ipcMain.handle('brain:ask', (_e, payload: unknown) => {
    const p = payload as { text?: unknown; history?: unknown };
    if (!isStr(p?.text) || !p.text.trim()) return { ok: false, error: 'Empty message.' };
    const history = Array.isArray(p.history)
      ? p.history
          .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
            Boolean(m) && (m.role === 'user' || m.role === 'assistant') && isStr(m.content))
          .slice(-30)
      : [];
    const runId = newRunId();
    void ask({ runId, text: p.text.slice(0, 8000), history });
    return { ok: true, runId };
  });
  ipcMain.handle('brain:cancel', (_e, runId: unknown) => { if (isStr(runId)) cancelRun(runId); });
  ipcMain.handle('brain:status', () => brainStatus());
  ipcMain.handle('brain:checkCloud', (_e, p: unknown) => (p === 'openai' || p === 'anthropic' ? checkCloud(p) : null));
  ipcMain.handle('brain:recheck', async () => {
    await refreshGemini(true);
    return brainStatus();
  });
  ipcMain.handle('brain:once', async (_e, payload: unknown) => {
    const p = payload as { system?: unknown; user?: unknown; tier?: unknown; temperature?: unknown };
    if (!isStr(p?.system)) return { ok: false, error: 'Bad payload' };
    try {
      const text = await once({
        system: p.system,
        user: isStr(p.user) ? p.user : undefined,
        tier: p.tier === 'main' ? 'main' : 'fast',
        temperature: typeof p.temperature === 'number' ? p.temperature : undefined,
      });
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('brain:greet', async (_e, kind: unknown) => {
    const k: GreetKind = kind === 'wake' || kind === 'checkin' ? kind : 'boot';
    try {
      return { ok: true, text: await greet(k) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('brain:agents', () =>
    Object.values(AGENTS).map(({ id, name, title, summary, color }) => ({ id, name, title, summary, color })));
  // Live Voice streams audio straight from the renderer to Google, so it needs
  // the key there - the one deliberate exception to "keys stay in main".
  ipcMain.handle('brain:liveVoice', async () => {
    const status = await brainStatus();
    const system = `${persona(getSettings(), memoryBlock(profileForPrompt(1800), []))}\n\nYou are in a real-time spoken voice conversation right now - keep replies short and natural, like talking, not writing.`;
    return { key: getSecret('GEMINI_API_KEY'), model: status.gemini.liveModel, system };
  });

  ipcMain.handle('approval:respond', (_e, id: unknown, approved: unknown, all: unknown) => {
    if (isStr(id)) respondApproval(id, approved === true, all === true);
  });
  ipcMain.handle('approval:pending', () => pendingApprovals());

  /* ── secrets ───────────────────────────────────────────────────── */
  ipcMain.handle('secrets:status', () => secretsStatus());
  ipcMain.handle('secrets:set', async (_e, name: unknown, value: unknown) => {
    if (!isStr(name) || !isSecretName(name) || !isStr(value)) return { ok: false, error: 'Bad payload' };
    try {
      setSecret(name, value);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // Verify on save so a bad key is caught here, not mid-conversation.
    if (name === 'GEMINI_API_KEY') {
      const g = await refreshGemini(true);
      if (!value.trim()) return { ok: true, status: secretsStatus() };
      return g.valid ? { ok: true, status: secretsStatus(), detail: `Gemini connected - using ${g.model}.` } : { ok: false, status: secretsStatus(), error: g.error ?? 'Gemini did not accept the key.' };
    }
    if ((name === 'ANTHROPIC_API_KEY' || name === 'OPENAI_API_KEY') && value.trim()) {
      const which = name === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'openai';
      const c = await checkCloud(which);
      const label = which === 'anthropic' ? 'Claude' : 'The OpenAI-compatible service';
      return c.valid ? { ok: true, status: secretsStatus(), detail: `${label} accepted the key (${c.models?.length ?? 0} models)` } : { ok: false, status: secretsStatus(), error: c.error ?? `${label} did not accept the key.` };
    }
    if (name === 'COMPOSIO_API_KEY' && value.trim()) {
      const s = await composio.appsStatus();
      emit('apps:changed', s);
      return s.ok ? { ok: true, status: secretsStatus(), detail: 'Composio connected.' } : { ok: false, status: secretsStatus(), error: s.hint ?? s.error };
    }
    if (name === 'DISCORD_BOT_TOKEN' && value.trim()) {
      const d = await discord.status();
      return d.ok
        ? { ok: true, status: secretsStatus(), detail: `Discord bot "${d.bot}" connected${d.servers?.length ? ` - in ${d.servers.map((s) => s.name).join(', ')}` : ' - now add it to your server'}` }
        : { ok: false, status: secretsStatus(), error: d.error ?? 'Discord did not accept the token.' };
    }
    return { ok: true, status: secretsStatus() };
  });
  ipcMain.handle('discord:status', () => discord.status());
  ipcMain.handle('addons:status', async () => ({ addons: addons.addonStatus(getSettings().addons.askBrowserAgent), hindsight: await hindsight.status() }));
  ipcMain.handle('addons:setHindsight', async (_e, on: unknown) => {
    saveSettings({ addons: { ...getSettings().addons, hindsight: on === true } });
    if (on === true) void hindsight.ensureRunning();
    else hindsight.stop();
    return { addons: addons.addonStatus(getSettings().addons.askBrowserAgent), hindsight: await hindsight.status() };
  });
  ipcMain.handle('addons:setAskBrowserAgent', (_e, on: unknown) => {
    saveSettings({ addons: { ...getSettings().addons, askBrowserAgent: on === true } });
    return getSettings().addons.askBrowserAgent;
  });

  /* ── settings ──────────────────────────────────────────────────── */
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:save', (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return getSettings();
    // folders only ever come from the real OS picker (files:add), never from the renderer.
    const { folders: _ignored, ...rest } = patch as Partial<Settings>;
    const before = getSettings();
    const next = saveSettings(rest);
    if (next.vault.path !== before.vault.path) {
      ensureVault();
      forgetIndex();
      void syncIndex().catch(() => {});
    }
    return next;
  });

  /* ── Ollama ────────────────────────────────────────────────────── */
  ipcMain.handle('ollama:status', () => ollama.status());
  ipcMain.handle('ollama:pull', (_e, model: unknown) => {
    if (!isStr(model)) return { ok: false, error: 'Bad model' };
    void ollama.pullModel(model, (p) => emit('ollama:pullProgress', p));
    return { ok: true };
  });

  /* ── memory vault ──────────────────────────────────────────────── */
  ipcMain.handle('vault:stats', () => vaultStats());
  ipcMain.handle('vault:recent', (_e, limit: unknown) => recentNotes(typeof limit === 'number' ? limit : 12));
  ipcMain.handle('vault:search', async (_e, q: unknown) => (isStr(q) ? searchMemory(q, 8) : []));
  ipcMain.handle('vault:profile', () => readProfile());
  ipcMain.handle('vault:saveProfile', (_e, text: unknown) => {
    if (!isStr(text)) return { ok: false };
    saveProfile(text);
    void syncIndex(['Profile/Operator.md']).catch(() => {});
    return { ok: true };
  });
  ipcMain.handle('vault:open', async (_e, rel: unknown) => {
    const root = vaultRoot();
    const target = isStr(rel) && rel ? path.join(root, ...rel.split('/')) : root;
    // obsidian:// only works once Obsidian has registered this folder as a vault.
    if (obsidianKnowsVault(root)) {
      try {
        await shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`);
        return { ok: true, via: 'obsidian' };
      } catch { /* fall through to Explorer */ }
    }
    const err = await shell.openPath(root);
    return err
      ? { ok: false, error: err }
      : { ok: true, via: 'explorer', hint: 'To browse it in Obsidian: Obsidian > Open folder as vault > pick this folder (once).' };
  });
  ipcMain.handle('vault:reveal', async () => {
    const err = await shell.openPath(vaultRoot());
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('vault:choose', async () => {
    const win = getWin();
    const opts = { title: 'Choose where Ultron keeps its vault', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const next = saveSettings({ vault: { path: res.filePaths[0] } });
    ensureVault(readProfile() || undefined);
    forgetIndex();
    void syncIndex().catch(() => {});
    return { ok: true, settings: next };
  });
  ipcMain.handle('vault:reindex', async () => {
    forgetIndex();
    await syncIndex();
    return vaultStats();
  });

  /* ── tasks ─────────────────────────────────────────────────────── */
  ipcMain.handle('web:status', () => browserAgent.webLoginStatus());
  ipcMain.handle('web:signIn', (_e, url: unknown) => browserAgent.openSignIn(isStr(url) ? url : undefined));
  ipcMain.handle('web:clear', async () => { await browserAgent.clearWebLogins(); return browserAgent.webLoginStatus(); });

  ipcMain.handle('transcript:load', () => loadTranscript());
  ipcMain.handle('transcript:save', (_e, entries: unknown) => { saveTranscript(entries); return true; });

  ipcMain.handle('tasks:list', () => tasks.listTasks('all'));
  ipcMain.handle('tasks:add', (_e, input: unknown) => {
    const p = input as { title?: unknown; due?: unknown; priority?: unknown };
    if (!isStr(p?.title) || !p.title.trim()) return { ok: false, error: 'A task needs a title.' };
    try {
      const task = tasks.addTask({
        title: p.title,
        due: isStr(p.due) && p.due.trim() ? p.due : undefined,
        priority: p.priority === 'high' || p.priority === 'low' ? p.priority : undefined,
        source: 'operator',
      });
      return { ok: true, task };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('tasks:complete', (_e, id: unknown) => (isStr(id) ? tasks.completeTask(id) : null));
  ipcMain.handle('tasks:reopen', (_e, id: unknown) => (isStr(id) ? tasks.reopenTask(id) : null));
  ipcMain.handle('tasks:remove', (_e, id: unknown) => (isStr(id) ? tasks.removeTask(id) : null));
  ipcMain.handle('tasks:snooze', (_e, id: unknown, minutes: unknown) =>
    (isStr(id) ? tasks.snoozeTask(id, typeof minutes === 'number' ? minutes : 10) : null));
  ipcMain.handle('tasks:update', (_e, id: unknown, patch: unknown) => {
    if (!isStr(id) || !patch || typeof patch !== 'object') return null;
    const p = patch as Record<string, unknown>;
    return tasks.updateTask(id, {
      title: isStr(p.title) ? p.title : undefined,
      due: p.due === null || isStr(p.due) ? (p.due as string | null) : undefined,
      priority: p.priority === 'high' || p.priority === 'low' || p.priority === 'normal' ? p.priority : undefined,
      notes: isStr(p.notes) ? p.notes : undefined,
    });
  });
  ipcMain.handle('tasks:clearDone', () => tasks.clearCompleted());

  /* ── apps (Composio) ───────────────────────────────────────────── */
  ipcMain.handle('apps:status', () => composio.appsStatus());
  ipcMain.handle('apps:connect', (_e, slug: unknown) => (isStr(slug) ? composio.connectApp(slug) : { ok: false, error: 'Bad app' }));
  ipcMain.handle('apps:signIn', () => composio.signIn());
  ipcMain.handle('apps:signOut', () => composio.signOut());
  ipcMain.handle('apps:disconnect', (_e, slug: unknown) => (isStr(slug) ? composio.disconnectApp(slug) : { ok: false, error: 'Bad app' }));

  /* ── D2L ───────────────────────────────────────────────────────── */
  ipcMain.handle('d2l:status', () => d2l.status());
  ipcMain.handle('d2l:signIn', () => d2l.signIn());
  ipcMain.handle('d2l:signOut', () => d2l.signOut());
  ipcMain.handle('d2l:open', () => d2l.openInBrowser());
  ipcMain.handle('d2l:sync', async () => {
    try {
      return { ok: true, ...(await d2l.syncToTasks(21)) };
    } catch (e) {
      return { ok: false, error: d2l.isAuthError(e) ? 'Sign in to D2L first (Apps panel).' : e instanceof Error ? e.message : String(e) };
    }
  });

  /* ── news / weather / hardware ─────────────────────────────────── */
  ipcMain.handle('news:fetch', (_e, manual: boolean) => news.fetchNews(Boolean(manual)));
  ipcMain.handle('news:quota', () => news.quotaSnapshot());
  ipcMain.handle('news:hasKey', () => news.hasApiKey());
  ipcMain.handle('research:weather', (_e, place: unknown) => (isStr(place) ? research.getWeather(place) : null));
  ipcMain.handle('system:hardwareStats', () => getHardwareStats());

  /* ── files tab (indexed folders) ───────────────────────────────── */
  ipcMain.handle('files:add', () => files.addFolder(getWin()));
  ipcMain.handle('files:remove', (_e, folderPath: string) => files.removeFolder(folderPath));
  ipcMain.handle('files:list', (_e, limit?: number) => files.listFiles(limit));
  ipcMain.handle('files:search', (_e, query: string) => files.searchFiles(query));
  ipcMain.handle('files:rebuild', () => files.rebuildIndex().length);
  ipcMain.handle('files:stats', () => files.indexStats());
  ipcMain.handle('files:reveal', (_e, filePath: unknown) => (isStr(filePath) ? files.revealSafe(filePath) : false));
  ipcMain.handle('files:read', (_e, p: unknown) => (isStr(p) ? files.readFileContent(p) : { ok: false, error: 'Bad path' }));
  ipcMain.handle('files:write', (_e, p: unknown, content: unknown) =>
    (isStr(p) && isStr(content) ? files.writeFileContent(p, content) : { ok: false, error: 'Bad payload' }));
  ipcMain.handle('files:rename', (_e, p: unknown, name: unknown) =>
    (isStr(p) && isStr(name) ? files.renameFile(p, name) : { ok: false, error: 'Bad payload' }));
  ipcMain.handle('files:move', (_e, p: unknown, destFolder: unknown) =>
    (isStr(p) && isStr(destFolder) ? files.moveFile(p, destFolder) : { ok: false, error: 'Bad payload' }));
  ipcMain.handle('files:delete', (_e, p: unknown) => (isStr(p) ? files.deleteFile(p) : Promise.resolve({ ok: false, error: 'Bad path' })));
  ipcMain.handle('files:createFile', (_e, folder: unknown, name: unknown, content: unknown) =>
    (isStr(folder) && isStr(name) ? files.createFile(folder, name, isStr(content) ? content : '') : { ok: false, error: 'Bad payload' }));
  ipcMain.handle('files:createFolder', (_e, folder: unknown, name: unknown) =>
    (isStr(folder) && isStr(name) ? files.createSubfolder(folder, name) : { ok: false, error: 'Bad payload' }));

  /* ── misc ──────────────────────────────────────────────────────── */
  ipcMain.handle('backup:export', () => backup.exportBackup(getWin()));
  ipcMain.handle('backup:import', () => backup.importBackup(getWin()));
  ipcMain.handle('tray:isAutoLaunchEnabled', () => isAutoLaunchEnabled());
  ipcMain.handle('tray:setAutoLaunch', (_e, enabled: unknown) => setAutoLaunch(Boolean(enabled)));
  ipcMain.handle('app:openExternal', async (_e, url: unknown) => {
    if (!isStr(url) || !/^https?:\/\//.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));
}

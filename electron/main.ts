import fs from 'node:fs';
import { ensureChromium } from './browser';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, Notification, screen, shell } from 'electron';
import * as ollama from './ollama';
import { registerIpc } from './ipc';
import { setupTray } from './tray';
import { emit, setEventWindow } from './brain/events';
import { refreshGemini } from './brain/llm';
import { importLegacyEnv } from './secrets';
import * as tasks from './tasks';
import * as browserAgent from './browser';
import * as clipboardWatch from './clipboardWatch';
import * as d2l from './d2l';
import { getSettings, readDoc, writeDoc } from './store';
import { warmUp } from './brain/providers/ollama';
import { ensureVault, writeNote } from './memory/vault';
import { syncIndex } from './memory/semantic';
import * as hindsight from './hindsight';

process.env.DIST = path.join(__dirname, '../dist');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const APP_ID = 'com.ultron.assistant';

app.setName('Ultron');
app.setAppUserModelId(APP_ID);
// Dev-only: run a test instance against a throwaway profile so test chats never land in the real vault.
if (!app.isPackaged && process.env.ULTRON_USER_DATA) app.setPath('userData', process.env.ULTRON_USER_DATA);

let win: BrowserWindow | null = null;
const startHidden = process.argv.includes('--hidden');

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build-assets/icon.ico');
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

interface WindowState { x: number; y: number; width: number; height: number; maximized: boolean }

/** The last window position, if it still fits on a connected screen (monitors change). */
function savedBounds(): WindowState | null {
  const s = readDoc<WindowState | null>('window-state.json', null);
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
  const area = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
  const visible = s.x < area.x + area.width - 100 && s.y < area.y + area.height - 100 && s.x + s.width > area.x + 100 && s.y >= area.y - 10;
  return visible ? s : null;
}

function rememberBounds(w: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (w.isDestroyed() || w.isMinimized()) return;
    const b = w.getNormalBounds();
    writeDoc('window-state.json', { ...b, maximized: w.isMaximized() } satisfies WindowState);
  };
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(save, 600); };
  w.on('resize', soon);
  w.on('move', soon);
  w.on('maximize', save);
  w.on('unmaximize', save);
  w.on('close', save);
}

function createWindow(): void {
  // Fit the work area so the window is never partly offscreen (which also
  // makes capturePage return uninitialised pixels). Where the operator left it wins.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const last = savedBounds();
  win = new BrowserWindow({
    width: last?.width ?? Math.min(1560, work.width - 40),
    height: last?.height ?? Math.min(960, work.height - 40),
    ...(last ? { x: last.x, y: last.y } : { center: true }),
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#060910',
    title: 'ULTRON',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setEventWindow(win);
  rememberBounds(win);
  if (last?.maximized) win.maximize();

  win.once('ready-to-show', () => { if (!startHidden) showWindow(); });
  setupTray(win, iconPath());

  // External links open in the real browser, never inside the HUD.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Never let the HUD itself navigate to a remote page - it would inherit the
  // whole preload API. Links go to the real browser instead.
  const ownOrigin = VITE_DEV_SERVER_URL ? new URL(VITE_DEV_SERVER_URL).origin : null;
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = ownOrigin ? url.startsWith(ownOrigin) : url.startsWith('file://');
    if (allowed) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  if (VITE_DEV_SERVER_URL) void win.loadURL(VITE_DEV_SERVER_URL);
  else void win.loadFile(path.join(process.env.DIST!, 'index.html'));

  const emitWindowState = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', emitWindowState);
  win.on('unmaximize', emitWindowState);
  win.on('closed', () => { win = null; setEventWindow(null); });
}

/** Installed app: make sure a Start Menu shortcut carries our AppUserModelID, which Windows needs to show toasts. */
function ensureStartMenuShortcut(): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ultron.lnk');
    if (fs.existsSync(lnk)) return;
    shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      appUserModelId: APP_ID,
      icon: iconPath(),
      iconIndex: 0,
      description: 'Ultron - personal AI command center',
    });
  } catch { /* shortcut is a nicety, not a requirement */ }
}

/** If Ollama is installed but not running, start it in the background (what the old launcher script did). */
async function ensureOllama(): Promise<void> {
  if (!(await ollama.status()).running) {
    const exe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe');
    if (!fs.existsSync(exe)) return;
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { return; /* the brain setup panel explains how to start it by hand */ }
  }
  // Load the model now, while the HUD boots, so the first request doesn't wait for it.
  for (let i = 0; i < 20; i++) {
    const s = await ollama.status();
    if (s.running && s.modelInstalled) {
      const { host, model } = getSettings().ollama;
      await warmUp(host.replace(/\/$/, ''), model);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
function mirrorTasksToVault(): void {
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    try { writeNote('Tasks/Tasks.md', tasks.tasksMarkdown()); } catch { /* vault unavailable */ }
  }, 1500);
}

function startTaskScheduler(): void {
  tasks.startScheduler({
    onChange: (all) => {
      emit('tasks:changed', all);
      mirrorTasksToVault();
    },
    onFire: (task, missed) => {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: missed ? 'Ultron - missed reminder' : 'Ultron - reminder',
          body: tasks.describeTask(task),
          icon: iconPath(),
        });
        n.on('click', () => {
          showWindow();
          emit('ui:focus', { tab: 'tasks' });
        });
        n.show();
      }
      emit('tasks:reminder', { task, missed });
    },
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Ultron is already running (probably in the tray) - that instance shows itself.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    const imported = importLegacyEnv();
    if (imported.length) console.log('[ultron] imported keys from .env:', imported.join(', '));
    try { ensureVault(); } catch (e) { console.warn('[ultron] vault unavailable:', e); }

    registerIpc(() => win);
    createWindow();
    startTaskScheduler();
    ensureStartMenuShortcut();
    void ensureOllama();
    // A new PC has no browser for the agents yet: fetch it now rather than on the first web job.
    void ensureChromium((line) => { if (/%|Downloading|downloaded/i.test(line)) console.log('[ultron] chromium:', line); }).catch((err) => console.warn('[ultron] chromium download failed:', err));
    void refreshGemini(true).catch(() => {});
    // Give Ollama a moment after login before embedding anything that changed in the vault.
    setTimeout(() => { void syncIndex().catch(() => {}); }, 8000);

    clipboardWatch.startClipboardWatch((text) => {
      if (win && !win.isDestroyed()) win.webContents.send('clipboard:newText', text);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Before quitting: keep the D2L session (its cookies would otherwise die with the app), then shut the
  // agents' browser down - it's a real OS process and must never outlive Ultron.
  let finalSaveDone = false;
  // Hindsight's memory server starts in the background with Ultron and goes when Ultron does.
  setTimeout(() => { void hindsight.ensureRunning(); }, 15_000);
  app.on('will-quit', () => { hindsight.stop(); });
  app.on('before-quit', (e) => {
    tasks.stopScheduler();
    if (finalSaveDone) return;
    e.preventDefault();
    const giveUp = new Promise((r) => setTimeout(r, 4000));
    void Promise.race([Promise.all([d2l.keepSignedIn().catch(() => 0), browserAgent.closeBrowser()]), giveUp]).finally(() => {
      finalSaveDone = true;
      app.quit();
    });
  });
}

/* ── Dev utility ────────────────────────────────────────────────────────
   ULTRON_CAPTURE=<file.png> launches the app, lets it settle, writes a
   screenshot of its own window and exits. Hard-gated to unpackaged builds:
   it runs arbitrary JS from an env var. Optional: ULTRON_CAPTURE_DELAY (ms),
   ULTRON_CAPTURE_JS (snippet run first).                                   */
if (!app.isPackaged && process.env.ULTRON_CAPTURE) {
  const target = process.env.ULTRON_CAPTURE;
  const rawDelay = Number(process.env.ULTRON_CAPTURE_DELAY);
  const delay = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 4200;
  app.whenReady().then(() => {
    setTimeout(async () => {
      try {
        if (!win || win.isDestroyed()) throw new Error('window gone');
        const js = process.env.ULTRON_CAPTURE_JS;
        if (js) {
          const jsResult = await win.webContents.executeJavaScript(js);
          if (jsResult !== undefined) console.log('[ultron] js result:', jsResult);
          await new Promise((r) => setTimeout(r, 1500));
        }
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, image.toPNG());
        console.log(`[ultron] captured -> ${target}`);
      } catch (e) {
        console.error('[ultron] capture failed:', e);
      } finally {
        app.exit(0);
      }
    }, delay);
  });
}

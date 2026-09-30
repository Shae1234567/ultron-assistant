import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import readabilitySource from '@mozilla/readability/Readability.js?raw';
import { emit } from './brain/events';
import { getSettings, readDoc, writeDoc } from './store';

/**
 * Ultron's own Chromium. Every agent - and every helper an agent spins up -
 * gets its own real tab and browses like a person: searches, opens pages,
 * clicks, types, scrolls feeds, reads, looks at the screen. Each tab streams
 * a live frame to the HUD so the operator can watch the team work; Settings
 * can also show the real browser windows.
 *
 * A separate `research` context (images and fonts blocked) serves the fast
 * background pipeline used by deep_research and a few fixed lookups.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const OCCLUSION_ARGS = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];

/*
 * Two Chromiums. The agents' browser is a PERSISTENT profile in Ultron's
 * userData (agent-browser/): sites the operator signs in to - in a real
 * window, typing their own passwords - stay signed in for every agent,
 * across tasks and restarts. The background research pipeline uses a
 * separate throwaway headless browser so it never touches those logins.
 */
let researchBrowser: Browser | null = null;
let researchLaunching: Promise<Browser> | null = null;
let research: BrowserContext | null = null;

let agentCtx: BrowserContext | null = null;
let agentLaunching: Promise<BrowserContext> | null = null;
let agentShown = false;
let signInPage: Page | null = null;
let keepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Ad, tracking and analytics hosts. Never needed to read or use a page, often
 * the slowest thing on it - blocking them makes every agent page load faster.
 */
const TRACKERS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|googletagservices\.com|amazon-adsystem\.com|adsrvr\.org|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|scorecardresearch\.com|quantserve\.com|hotjar\.com|mixpanel\.com|cdn\.segment\.com|api\.segment\.io|chartbeat\.(com|net)|js-agent\.newrelic\.com|bam\.nr-data\.net|moatads\.com|rubiconproject\.com|pubmatic\.com|openx\.net|casalemedia\.com|bat\.bing\.com|clarity\.ms|adsafeprotected\.com|teads\.tv)$/i;

export function isTracker(url: string): boolean {
  try {
    return TRACKERS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function wantVisible(): boolean {
  return getSettings().browser?.visible === true;
}

function profileDir(): string {
  return path.join(app.getPath('userData'), 'agent-browser');
}

/* ── The agents' Chromium ─────────────────────────────────────────────
   The installer does not carry a browser: on a new PC, Ultron downloads Playwright's Chromium (about 150 MB)
   itself - in the background at first start, and any browsing waits for that download instead of failing. */

let chromiumInstall: Promise<void> | null = null;

export function chromiumInstalled(): boolean {
  try { return fs.existsSync(chromium.executablePath()); } catch { return false; }
}

/** Downloads Chromium once if it is missing. Progress lines go to `onProgress`. */
export function ensureChromium(onProgress?: (line: string) => void): Promise<void> {
  if (chromiumInstalled()) return Promise.resolve();
  chromiumInstall ??= new Promise<void>((resolve, reject) => {
    // Playwright's own installer, run by Electron's bundled Node (no separate Node.js needed).
    const cli = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright-core', 'cli.js')
      : path.join(app.getAppPath(), 'node_modules', 'playwright-core', 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    const report = (buf: Buffer) => { for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onProgress?.(line.trim()); };
    child.stdout.on('data', report);
    child.stderr.on('data', report);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 && chromiumInstalled() ? resolve() : reject(new Error(`Could not download the agents' browser (exit ${code}). Check the internet connection and try again.`))));
  }).finally(() => { chromiumInstall = null; });
  return chromiumInstall;
}

function launchError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("Executable doesn't exist")) return new Error('The agents\' browser (Chromium) is not downloaded yet - Ultron fetches it by itself; try again in a minute.');
  if (/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(message)) {
    return new Error('The agents\' browser profile is busy (another Ultron browser window is open) - close it and try again.');
  }
  return e instanceof Error ? e : new Error(message);
}

async function getResearchBrowser(): Promise<Browser> {
  if (researchBrowser?.isConnected()) return researchBrowser;
  researchLaunching ??= ensureChromium().then(() => chromium.launch({ headless: true })).catch((e: unknown) => { throw launchError(e); });
  try {
    researchBrowser = await researchLaunching;
  } finally {
    researchLaunching = null;
  }
  researchBrowser.on('disconnected', () => { researchBrowser = null; research = null; });
  return researchBrowser;
}

async function researchContext(): Promise<BrowserContext> {
  if (research && researchBrowser?.isConnected()) return research;
  const b = await getResearchBrowser();
  research = await b.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 }, bypassCSP: true });
  await research.route('**/*', (route) => {
    const type = route.request().resourceType();
    return type === 'image' || type === 'media' || type === 'font' || isTracker(route.request().url()) ? route.abort() : route.continue();
  });
  return research;
}

async function launchAgentContext(shown: boolean): Promise<BrowserContext> {
  await ensureChromium();
  fs.mkdirSync(profileDir(), { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir(), {
    headless: !shown,
    userAgent: UA,
    locale: app.getLocale() || 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
    viewport: { width: 1280, height: 800 },
    // Lets the Readability script load on sites with a strict Content-Security-Policy.
    bypassCSP: true,
    // A visible window that another window covers stops painting on Windows, and screenshots then hang.
    args: shown ? OCCLUSION_ARGS : [],
  }).catch((e: unknown) => { throw launchError(e); });
  // Images stay on (agents look at pages, the operator watches them); autoplaying video, audio and trackers don't.
  await ctx.route('**/*', (route) => (route.request().resourceType() === 'media' || isTracker(route.request().url()) ? route.abort() : route.continue()));
  ctx.on('close', () => {
    if (agentCtx === ctx) agentCtx = null;
    signInPage = null;
    stopKeeping();
    for (const [id, t] of tabs) if (t.page.context() === ctx) forgetTab(id);
  });
  agentCtx = ctx;
  agentShown = shown;
  return ctx;
}

async function agentContext(): Promise<BrowserContext> {
  const shown = wantVisible() || Boolean(signInPage);
  // Showing or hiding the window needs a relaunch - only when no agent is mid-browse and no sign-in is open.
  if (agentCtx && agentShown !== shown && tabs.size === 0 && !signInPage) await closeAgentContext();
  if (agentCtx) return agentCtx;
  agentLaunching ??= launchAgentContext(shown).finally(() => { agentLaunching = null; });
  return agentLaunching;
}

async function closeAgentContext(): Promise<void> {
  const ctx = agentCtx;
  if (!ctx) return;
  await keepAgentLogins().catch(() => 0);
  agentCtx = null;
  signInPage = null;
  stopKeeping();
  await ctx.close().catch(() => {});
}

/* ── Staying signed in to websites ──────────────────────────────────────
   Same trap as D2L: many sites keep their login in session cookies, which
   Chromium drops when it closes. Re-saving them with an expiry (Chromium
   stores cookie values encrypted) keeps the agents signed in.            */

const LOGINS_FILE = 'agent-browser-sites.json';

function baseDomain(host: string): string {
  const parts = host.replace(/^\./, '').split('.');
  return parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

export async function keepAgentLogins(): Promise<number> {
  const ctx = agentCtx;
  if (!ctx) return 0;
  const cookies = await ctx.cookies().catch(() => []);
  const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
  const session = cookies.filter((c) => c.expires === -1);
  if (session.length) await ctx.addCookies(session.map((c) => ({ ...c, expires }))).catch(() => {});
  const sites = [...new Set(cookies.map((c) => baseDomain(c.domain)))].filter(Boolean).sort();
  writeDoc(LOGINS_FILE, { at: Date.now(), sites });
  return session.length;
}

function startKeeping(): void {
  stopKeeping();
  keepTimer = setInterval(() => void keepAgentLogins().catch(() => 0), 15_000);
}

function stopKeeping(): void {
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
}

const START_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Ultron - sign in to websites</title></head>
<body style="margin:0;min-height:100vh;background:#05080d;color:#cfefff;font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center">
<div style="max-width:680px;padding:36px">
<div style="letter-spacing:.3em;color:#00d9ff;font-size:13px">ULTRON</div>
<h1 style="font-weight:600;font-size:24px;margin:12px 0 6px">Sign in to the sites you want the agents to use</h1>
<p style="opacity:.75;line-height:1.5">This is the agents' own browser. Log in yourself - Ultron never sees your passwords - and they stay signed in for every task, even after a restart. Close this window when you're done.</p>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:22px">
${[['Google (Docs, Slides, Drive)', 'https://accounts.google.com'], ['Canva', 'https://www.canva.com/login'], ['Notion', 'https://www.notion.so/login'], ['GitHub', 'https://github.com/login'], ['Microsoft / Outlook', 'https://login.live.com'], ['Figma', 'https://www.figma.com/login'], ['Discord', 'https://discord.com/login'], ['Spotify', 'https://accounts.spotify.com/login'], ['CodePen', 'https://codepen.io/login']]
  .map(([n, u]) => `<a href="${u}" style="display:block;padding:14px 16px;border:1px solid #00d9ff55;color:#cfefff;text-decoration:none">${n}</a>`).join('')}
</div></div></body></html>`)}`;

/** Opens the agents' browser in a real window so the operator can sign in to sites themselves. */
export async function openSignIn(url?: string): Promise<{ ok: boolean; error?: string }> {
  if (tabs.size > 0) return { ok: false, error: 'The team is using the browser right now - try again when this task finishes.' };
  try {
    if (agentCtx && !agentShown) await closeAgentContext();
    signInPage = null;
    const ctx = await launchOrReuseShown();
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    signInPage = page;
    page.on('close', () => {
      if (signInPage !== page) return;
      signInPage = null;
      void keepAgentLogins().catch(() => 0).then(() => emit('web:changed', webLoginStatus()));
    });
    await page.goto(url && /^https:\/\//.test(url) ? url : START_PAGE).catch(() => {});
    await page.bringToFront().catch(() => {});
    startKeeping();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function launchOrReuseShown(): Promise<BrowserContext> {
  if (agentCtx && agentShown) return agentCtx;
  agentLaunching ??= launchAgentContext(true).finally(() => { agentLaunching = null; });
  return agentLaunching;
}

export function webLoginStatus(): { signInOpen: boolean; sites: string[]; checkedAt?: number } {
  const saved = readDoc<{ at?: number; sites?: string[] }>(LOGINS_FILE, {});
  return { signInOpen: Boolean(signInPage), sites: saved.sites ?? [], checkedAt: saved.at };
}

/** Forgets every website login the agents had (the operator asked for it). */
export async function clearWebLogins(): Promise<void> {
  await closeAgentContext();
  fs.rmSync(profileDir(), { recursive: true, force: true });
  writeDoc(LOGINS_FILE, { at: Date.now(), sites: [] });
}

async function withResearchPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await researchContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0].slice(0, 300);
}

/* ── Agent tabs + live frames ───────────────────────────────────────── */

export interface TabOwner {
  /** Unique per agent or helper within a run. */
  id: string;
  runId: string;
  agent: string;
  /** What the HUD shows on the tab, e.g. "ARGUS" or "ARGUS > REDDIT SCOUT". */
  label: string;
}

interface Tab {
  owner: TabOwner;
  page: Page;
  lastFrame: number;
  frameTimer?: ReturnType<typeof setTimeout>;
  settleTimer?: ReturnType<typeof setTimeout>;
}

const tabs = new Map<string, Tab>();

function forgetTab(id: string): void {
  const t = tabs.get(id);
  if (!t) return;
  clearTimeout(t.frameTimer);
  clearTimeout(t.settleTimer);
  tabs.delete(id);
  emit('browser:closed', { id, runId: t.owner.runId });
}

async function tabFor(owner: TabOwner): Promise<Tab> {
  const existing = tabs.get(owner.id);
  if (existing && !existing.page.isClosed()) return existing;
  const ctx = await agentContext();
  const page = await ctx.newPage();
  const tab: Tab = { owner, page, lastFrame: 0 };
  tabs.set(owner.id, tab);
  // Links that open a new window land back in this tab, so the agent never loses its place.
  page.on('popup', (popup) => {
    void (async () => {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      const url = popup.url();
      await popup.close().catch(() => {});
      if (/^https?:/.test(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      frameSoon(tab);
    })();
  });
  page.on('close', () => { if (tabs.get(owner.id)?.page === page) forgetTab(owner.id); });
  return tab;
}

async function sendFrame(tab: Tab): Promise<void> {
  if (tab.page.isClosed()) return;
  try {
    const buf = await tab.page.screenshot({ type: 'jpeg', quality: 45, timeout: 5000 });
    tab.lastFrame = Date.now();
    emit('browser:frame', {
      id: tab.owner.id,
      runId: tab.owner.runId,
      agent: tab.owner.agent,
      label: tab.owner.label,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ''),
      image: `data:image/jpeg;base64,${buf.toString('base64')}`,
      at: Date.now(),
    });
  } catch {
    /* mid-navigation or closing - the next action sends a fresh frame */
  }
}

/** A frame now (throttled to one per ~1.2 s per tab) and another once the page has settled. */
function frameSoon(tab: Tab): void {
  clearTimeout(tab.frameTimer);
  clearTimeout(tab.settleTimer);
  const wait = Math.max(0, 1200 - (Date.now() - tab.lastFrame));
  tab.frameTimer = setTimeout(() => void sendFrame(tab), wait);
  tab.settleTimer = setTimeout(() => void sendFrame(tab), wait + 2200);
}

export async function closeTab(id: string): Promise<void> {
  const t = tabs.get(id);
  if (!t) return;
  forgetTab(id);
  await t.page.close().catch(() => {});
}

export async function closeRunTabs(runId: string): Promise<void> {
  const ids = [...tabs.values()].filter((t) => t.owner.runId === runId).map((t) => t.owner.id);
  seenByRun.delete(runId);
  await Promise.all(ids.map((id) => closeTab(id)));
  // A task may have refreshed a site's login - keep it for next time.
  await keepAgentLogins().catch(() => 0);
}

export function openTabCount(): number {
  return tabs.size;
}

/* ── What the agent sees ────────────────────────────────────────────── */

export interface Snapshot {
  ok: boolean;
  url?: string;
  title?: string;
  /** Numbered interactive elements, nearest the visible screen first. */
  elements?: string[];
  /** Text currently on screen. */
  visible_text?: string;
  /** Titled links on or near the screen, "title -> address". */
  links?: string[];
  scroll?: { percent: number; atBottom: boolean };
  warning?: string;
  /** Opened from an address no page ever showed - probably made up. */
  guessed?: boolean;
  error?: string;
}

// "Reddit - Prove your humanity" once slipped past this, and an agent tried the image challenge - keep it broad.
const BLOCKED = /captcha|verify (that )?you('| a)re (a )?human|are you a robot|not a robot|prove (your humanity|(that )?you('| a)re (a )?human)|human verification|unusual traffic|press (and|&) hold|checking your browser|performing security verification|you('| ha)ve been blocked|blocked by network security|your request has been blocked|cf-chl|access denied|request blocked/i;

/* A site's own bot check (Cloudflare's "Just a moment..."). Some clear by themselves in a few seconds, the way they
   would for anyone; if one doesn't, the site has decided - the agent reports it and moves on, never tries to get past. */
const BOT_CHECK = /just a moment|attention required|security verification|checking (if the site connection is secure|your browser)|verify(ing)? you are (not a bot|human)/i;

const pageSample = (page: Page) => page.evaluate(() => `${document.title}\n${(document.body?.innerText || '').slice(0, 600)}`).catch(() => '');

async function botCheckClears(page: Page, ms = 5000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    await page.waitForTimeout(500);
    if (!BOT_CHECK.test(await pageSample(page))) return true;
  }
  return false;
}

/* CAPTCHA widgets live in frames: reCAPTCHA's "I'm not a robot" box and image grid, hCaptcha, Cloudflare Turnstile.
   They are never numbered, read or clicked. (reCAPTCHA's invisible score badge is not a challenge.) */
const CHALLENGE_FRAME = /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com|geo\.captcha-delivery\.com/i;

export function isChallengeFrame(url: string): boolean {
  return CHALLENGE_FRAME.test(url) && !/[?&]size=invisible\b/.test(url);
}

const WALL = 'This page is a bot check or a block page. You may not type, click or answer anything on it, and never claim to be human. Leave it - go back or use another source - and report that the site blocked automated browsing.';

/** A CAPTCHA or block page showing - by its words or by a challenge widget on screen. */
async function onWall(page: Page): Promise<boolean> {
  return BLOCKED.test(await pageSample(page)) || challengeShown(page);
}

async function challengeShown(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (!isChallengeFrame(f.url())) continue;
    const box = await f.frameElement().then((h) => h.boundingBox()).catch(() => null);
    if (box && box.width * box.height >= 12_000 && box.y < 800 && box.y + box.height > 0) return true;
  }
  return false;
}

/** Every hand on the page (click, type, keys, mouse, choose, hover) goes through this first. */
async function refuseWalls(page: Page): Promise<void> {
  if (await onWall(page)) throw new Error(WALL);
}
const LOGIN_WALL = /(log ?in|sign ?in|sign up) to (continue|see|view|watch|read)|you must (be )?(logged|signed) in|create an account to (continue|see)/i;

/** Tells the agent when a page is a wall rather than content - never try to get around it. */
export function pageWarning(title: string, text: string): string | undefined {
  const sample = `${title}\n${text.slice(0, 3000)}`;
  if (BLOCKED.test(sample)) return 'This page is a bot check / CAPTCHA. Do not try to get past it - use a different site or source.';
  if (LOGIN_WALL.test(sample) && text.length < 4000) return 'This page wants a login to show more. Do not sign in - use what is visible or try another source.';
  return undefined;
}

interface FrameScan {
  title: string;
  url: string;
  lines: string[];
  rects: { ref: number; x: number; y: number; w: number; h: number }[];
  text: string;
  titled: string[];
  hrefs: string[];
  percent: number;
  atBottom: boolean;
  count: number;
}

/**
 * Runs inside one frame: numbers its interactive elements (nearest the
 * screen first), and gathers the text and titled links on screen. Must stay
 * self-contained - it is serialised into the page.
 */
function scanFrame(args: { start: number; max: number }): FrameScan {
  // Code editors whose real input is a hidden 1-px textarea (CodeMirror 5, Ace, older Monaco) are offered as the editor itself.
  const codeEditors = '.CodeMirror, .ace_editor, .monaco-editor:not(:has(.native-edit-context)) .view-lines';
  const selector = `a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [role=textbox], [contenteditable=true], [contenteditable=""], ${codeEditors}`;
  document.querySelectorAll('[data-ultron-ref]').forEach((e) => e.removeAttribute('data-ultron-ref'));
  const vh = window.innerHeight;
  // Playgrounds have several identical editors ("Editor content") - name each after its panel's title (HTML, CSS...).
  const panelOf = (el: HTMLElement): string => {
    let n: HTMLElement | null = el;
    for (let i = 0; i < 6 && n; i++) {
      n = n.parentElement;
      for (const c of Array.from(n?.children ?? []) as HTMLElement[]) {
        if (c.contains(el)) continue;
        const t = (c.innerText || '').trim();
        if (t.length >= 2 && t.length <= 24 && !t.includes('\n')) return t;
      }
    }
    return '';
  };
  const candidates: { el: HTMLElement; dist: number; top: number }[] = [];
  for (const el of Array.from(document.querySelectorAll(selector)) as HTMLElement[]) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Read-only text areas are editors' internal helpers (Monaco's IME box) - typing there goes nowhere.
    if (el instanceof HTMLTextAreaElement && (el.readOnly || el.disabled)) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const dist = r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0;
    candidates.push({ el, dist, top: r.top });
  }
  // What's on screen first, then what's just below - that's what a person would click next.
  candidates.sort((a, b) => a.dist - b.dist || a.top - b.top);
  const lines: string[] = [];
  const rects: FrameScan['rects'] = [];
  let n = args.start - 1;
  for (const { el, dist } of candidates) {
    if (n - args.start + 1 >= args.max) break;
    n++;
    el.setAttribute('data-ultron-ref', String(n));
    const r = el.getBoundingClientRect();
    rects.push({ ref: n, x: r.left, y: r.top, w: r.width, h: r.height });
    const tag = el.tagName.toLowerCase();
    const inCode = el.matches(codeEditors) || Boolean(el.closest('.monaco-editor, .CodeMirror, .cm-editor, .ace_editor'));
    let label = (el.getAttribute('aria-label') || (el as HTMLInputElement).placeholder || (inCode ? '' : el.innerText) || el.getAttribute('title') || (el as HTMLInputElement).value || el.getAttribute('alt') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 90);
    let kind = el.getAttribute('role') || tag;
    if (tag === 'input') kind = `input[${(el as HTMLInputElement).type || 'text'}]`;
    if (el.isContentEditable && kind === tag) kind = 'editor';
    if (inCode) {
      kind = 'code editor';
      const panel = panelOf(el);
      if (panel) label = `${panel} editor`;
    }
    const readOnly = el instanceof HTMLInputElement && el.readOnly ? ' (read-only)' : '';
    const href = tag === 'a' ? ` -> ${(el as HTMLAnchorElement).href.slice(0, 110)}` : '';
    lines.push(`[${n}] ${kind} "${label}"${href}${readOnly}${dist > 0 ? ' (below)' : ''}`);
  }
  // The text a person would see right now: text nodes inside the viewport.
  const seen: string[] = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && total < 3500; node = walker.nextNode()) {
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2) continue;
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    const r = parent.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
    seen.push(t);
    total += t.length + 1;
  }
  // Titled links on screen, with their real addresses - reporting a link needs no second read (or guess).
  const titled: string[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
    if (titled.length >= 15) break;
    const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length < 12 || !/^https?:/.test(a.href)) continue;
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh * 1.5 || r.width === 0) continue;
    titled.push(`${t.slice(0, 90)} -> ${a.href.slice(0, 160)}`);
  }
  const doc = document.documentElement;
  const maxScroll = Math.max(1, doc.scrollHeight - vh);
  return {
    title: document.title,
    url: location.href,
    lines,
    rects,
    text: seen.join(' ').slice(0, 3500),
    titled,
    hrefs: (Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]).slice(0, 800).map((a) => a.href).filter((h) => /^https?:/.test(h)),
    percent: Math.round(Math.min(1, window.scrollY / maxScroll) * 100),
    atBottom: window.scrollY + vh >= doc.scrollHeight - 8,
    count: n - args.start + 1,
  };
}

/* Element numbers run across the page AND its embedded frames (editors, previews, embedded forms), so the
   agents can act inside them. These remember which frame each number lives in, and where it sits on screen. */
const refFrames = new WeakMap<Page, Map<number, Frame>>();
const frameRects = new WeakMap<Page, FrameScan['rects']>();

function locatorFor(page: Page, ref: number) {
  return (refFrames.get(page)?.get(ref) ?? page.mainFrame()).locator(`[data-ultron-ref="${ref}"]`).first();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'frame';
  }
}

/** Embedded frames big enough to matter and at least partly on screen, with where they sit on the page. */
async function visibleFrames(page: Page, limit = 6, minArea = 2400): Promise<{ frame: Frame; box: { x: number; y: number; width: number; height: number } }[]> {
  const out: { frame: Frame; box: { x: number; y: number; width: number; height: number } }[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || out.length >= limit || isChallengeFrame(frame.url())) continue;
    const box = await frame.frameElement().then((h) => h.boundingBox()).catch(() => null);
    if (!box || box.width < 60 || box.height < 40 || box.width * box.height < minArea) continue;
    if (box.y > 800 || box.y + box.height < 0 || box.x > 1280) continue;
    out.push({ frame, box });
  }
  return out;
}

/**
 * Text of the big embedded frames - a code playground's live preview, an
 * embedded form or document. Ad-sized frames are left out.
 */
async function embeddedText(page: Page, maxEach = 1500): Promise<string> {
  const parts: string[] = [];
  for (const { frame } of await visibleFrames(page, 4, 90_000)) {
    const text = tidy(await frame.evaluate(() => document.body?.innerText || '').catch(() => ''));
    if (text.length >= 2) parts.push(`[EMBEDDED FRAME ${hostOf(frame.url())}]\n${text.slice(0, maxEach)}`);
  }
  return parts.join('\n\n');
}

async function snapshotOf(page: Page, runId?: string, maxElements = 60): Promise<Snapshot> {
  const main = await page.mainFrame().evaluate(scanFrame, { start: 1, max: maxElements });
  const map = new Map<number, Frame>();
  for (let i = 1; i <= main.count; i++) map.set(i, page.mainFrame());
  const rects = [...main.rects];
  const lines = [...main.lines];
  const texts = [main.text];
  let next = main.count + 1;
  for (const { frame, box } of await visibleFrames(page)) {
    const room = maxElements + 20 - next + 1;
    if (room <= 0) break;
    const scan = await frame.evaluate(scanFrame, { start: next, max: Math.min(room, 25) }).catch(() => null);
    if (!scan) continue;
    const host = hostOf(frame.url());
    for (let i = next; i < next + scan.count; i++) map.set(i, frame);
    lines.push(...scan.lines.map((l) => `${l} (inside embedded ${host})`));
    rects.push(...scan.rects.map((r) => ({ ...r, x: r.x + box.x, y: r.y + box.y })));
    if (scan.text) texts.push(`[embedded ${host}] ${scan.text.slice(0, 900)}`);
    next += scan.count;
  }
  refFrames.set(page, map);
  frameRects.set(page, rects);
  // A page's links to itself don't vouch for it - otherwise opening a guessed address would make it "seen".
  if (runId) remember(runId, main.hrefs.filter((h) => urlKey(h) !== urlKey(main.url)));
  const text = texts.join('\n').slice(0, 4500);
  return {
    ok: true,
    url: main.url,
    title: main.title,
    elements: lines,
    visible_text: text,
    links: main.titled,
    scroll: { percent: main.percent, atBottom: main.atBottom },
    warning: pageWarning(main.title, main.text) ?? ((await challengeShown(page)) ? WALL : undefined),
  };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  // Most pages are usable long before the network goes quiet (and ad-heavy ones never do).
  await page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => {});
}

async function act(owner: TabOwner, fn: (page: Page) => Promise<void>, failPrefix: string): Promise<Snapshot> {
  try {
    const tab = await tabFor(owner);
    await fn(tab.page);
    await settle(tab.page);
    frameSoon(tab);
    return await snapshotOf(tab.page, owner.runId);
  } catch (e) {
    const why = errorText(e);
    return { ok: false, error: why === WALL ? WALL : `${failPrefix}${why}` };
  }
}

/* ── Browsing actions (one tab per agent / helper) ──────────────────── */

/**
 * What an agent typed into the address bar, made openable: "reddit.com/r/all"
 * gets https://. old.reddit.com now demands an account from logged-out
 * visitors (checked 2026-09-25) while www.reddit.com still shows posts, so
 * old/new Reddit links go to www.
 */
export function normalizeUrl(input: string): string | null {
  let url = input.trim();
  if (!url || /^(javascript|data|file|chrome|about):/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) {
    if (!/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/.test(url)) return null;
    url = `https://${url}`;
  }
  try {
    const u = new URL(url);
    if (/^(old\.|new\.)?reddit\.com$/i.test(u.hostname)) u.hostname = 'www.reddit.com';
    return u.toString();
  } catch {
    return null;
  }
}

/* Addresses the team has actually seen on a page this run (links, search results). Small models
   like to "guess" deep links - item?id=39456789 - and land on some unrelated old page. */
const seenByRun = new Map<string, Set<string>>();

function urlKey(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
}

function remember(runId: string, urls: string[]): void {
  let set = seenByRun.get(runId);
  if (!set) seenByRun.set(runId, (set = new Set()));
  for (const u of urls) if (set.size < 5000) set.add(urlKey(u));
}

/** Every address that appeared on a page or in search results during this run. */
export function seenUrls(runId: string): string[] {
  return [...(seenByRun.get(runId) ?? [])];
}

/** True when a deep link with an ID-like number was never on any page the team looked at. */
export function looksGuessed(url: string, seen: Set<string> | undefined): boolean {
  const rest = url.replace(/^https?:\/\/[^/]+/, '');
  // Deep links that point at one specific thing: ?id=9, /status/123, /comments/abc, /watch?v=..., long numbers.
  const specific = /[?&][a-z_]*id=\d+|\/\d{4,}(\/|$|\?)|\/(item|status|comments|watch|shorts|video|p|post)\b|[?&]v=[\w-]{6,}/i.test(rest);
  return specific && !seen?.has(urlKey(url));
}

export async function open(owner: TabOwner, url: string): Promise<Snapshot> {
  const target = normalizeUrl(url);
  if (!target) return { ok: false, error: `"${url}" is not a web address - use a full URL like https://example.com/page.` };
  const guessed = looksGuessed(target, seenByRun.get(owner.runId));
  const snap = await act(owner, async (page) => {
    const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const status = res?.status() ?? 0;
    if (status < 400) return;
    const sample = await pageSample(page);
    if (BOT_CHECK.test(sample) || BLOCKED.test(sample)) {
      if (BOT_CHECK.test(sample) && (await botCheckClears(page))) return;
      throw new Error(`${hostOf(target)} is checking for bots and does not let automated browsers in (HTTP ${status}). Do not retry it or try to get past it - do the job on another site that does the same thing, or tell the operator this step is theirs.`);
    }
    throw new Error(`HTTP ${status}${status === 404 ? ' - that page does not exist' : ''}`);
  }, '');
  if (snap.ok && guessed) {
    snap.guessed = true;
    snap.warning = [snap.warning, 'This address never appeared on a page you looked at. If you made up the ID, this is probably not the item you want - go back and click the real numbered link instead.'].filter(Boolean).join(' ');
  }
  return snap;
}

export function click(owner: TabOwner, ref: number): Promise<Snapshot> {
  return act(owner, async (page) => {
    await refuseWalls(page);
    const el = locatorFor(page, ref);
    if (!(await el.count())) throw new Error('that number is not on the page any more');
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      await el.click({ timeout: 2500 });
    } catch {
      // Usually a banner or overlay sitting on top of the element - click through it, then fall back to a script click.
      await el.click({ timeout: 3000, force: true }).catch(() => el.evaluate((node) => (node as HTMLElement).click()));
    }
  }, `Could not click [${ref}] (numbers change after every page change - look at the page again first): `);
}

/** Long text and code go in as one insertion - per-key typing is slow, and editors auto-close brackets and tags. */
async function enterText(page: Page, text: string): Promise<void> {
  if (text.length > 80 || text.includes('\n')) await page.keyboard.insertText(text);
  else await page.keyboard.type(text, { delay: 5 });
}

/**
 * Types like a person. With an element number: form fields are filled
 * (replacing what's there unless append), anything else - rich editors,
 * code editors, canvases - is clicked and gets real keystrokes. Without one:
 * types into whatever has focus, which is how editors like Google Docs,
 * CodePen or Canva take text.
 */
export function type(owner: TabOwner, ref: number | null, text: string, submit: boolean, append = false): Promise<Snapshot> {
  return act(owner, async (page) => {
    await refuseWalls(page);
    if (ref !== null) {
      const el = locatorFor(page, ref);
      if (!(await el.count())) throw new Error('that number is not on the page any more');
      const fillable = await el.evaluate((n) => ((n instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'submit', 'button', 'range', 'color'].includes(n.type)) || n instanceof HTMLTextAreaElement) && !n.readOnly && !n.disabled);
      if (fillable && !append) {
        await el.fill(text, { timeout: 5000 });
      } else {
        // Covered by a toolbar or the editor's own layers? Focusing it is what typing needs anyway.
        await el.click({ timeout: 1500 }).catch(() => el.focus());
        await enterText(page, text);
      }
    } else {
      await enterText(page, text);
    }
    if (submit) await page.keyboard.press('Enter');
  }, ref !== null ? `Could not type into [${ref}]: ` : 'Could not type: ');
}

const KEY = /^((Control|Shift|Alt|Meta|ControlOrMeta)\+)*(Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|F([1-9]|1[0-2])|[A-Za-z0-9]|[`~!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|])$/;

/** Key presses and shortcuts, in order: "Control+A", "Control+B", "Tab", "Enter"... */
export function press(owner: TabOwner, keys: string): Promise<Snapshot> {
  const combos = keys.trim().split(/\s+/).filter(Boolean).slice(0, 16);
  const bad = combos.find((k) => !KEY.test(k));
  if (!combos.length || bad) return Promise.resolve({ ok: false, error: `"${bad ?? keys}" is not a key - use names like Enter, Tab, Escape, ArrowDown, Control+A, Control+Shift+Z.` });
  return act(owner, async (page) => {
    await refuseWalls(page);
    for (const k of combos) await page.keyboard.press(k);
  }, 'Could not press keys: ');
}

export type MouseAction = 'click' | 'double_click' | 'right_click' | 'drag' | 'move' | 'scroll';

/** Mouse at page coordinates (the 1280 x 800 screen browser_look shows) - for canvas apps with no clickable elements. */
export function mouse(owner: TabOwner, action: MouseAction, x: number, y: number, toX?: number, toY?: number, amount?: number): Promise<Snapshot> {
  const inside = (px: number, py: number) => Number.isFinite(px) && Number.isFinite(py) && px >= 0 && py >= 0 && px <= 1280 && py <= 800;
  if (!inside(x, y) || (action === 'drag' && !inside(toX ?? NaN, toY ?? NaN))) {
    return Promise.resolve({ ok: false, error: 'Coordinates must be on the 1280 x 800 page (x 0-1280, y 0-800); drag needs to_x and to_y too.' });
  }
  return act(owner, async (page) => {
    await refuseWalls(page);
    if (action === 'click') await page.mouse.click(x, y);
    else if (action === 'double_click') await page.mouse.dblclick(x, y);
    else if (action === 'right_click') await page.mouse.click(x, y, { button: 'right' });
    else if (action === 'move') await page.mouse.move(x, y, { steps: 4 });
    else if (action === 'scroll') {
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, amount ?? 500)));
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(toX!, toY!, { steps: 14 });
      await page.mouse.up();
    }
  }, `Could not ${action.replace('_', ' ')} at ${x},${y}: `);
}

export function select(owner: TabOwner, ref: number, option: string): Promise<Snapshot> {
  return act(owner, async (page) => {
    await refuseWalls(page);
    const el = locatorFor(page, ref);
    await el.selectOption({ label: option }, { timeout: 5000 }).catch(() => el.selectOption(option, { timeout: 5000 }));
  }, `Could not choose "${option}" in [${ref}]: `);
}

export function hover(owner: TabOwner, ref: number): Promise<Snapshot> {
  return act(owner, async (page) => {
    await refuseWalls(page);
    await locatorFor(page, ref).hover({ timeout: 6000 });
  }, `Could not hover [${ref}]: `);
}

/** Waits for text to show up on the page or in an embedded frame (a save confirmation, a live preview) or just for a moment. */
export function waitFor(owner: TabOwner, text: string, seconds: number): Promise<Snapshot> {
  const ms = Math.min(Math.max(seconds || 3, 0.5), 20) * 1000;
  const wanted = text.trim().toLowerCase();
  return act(owner, async (page) => {
    if (!wanted) return page.waitForTimeout(ms);
    const deadline = Date.now() + ms;
    for (;;) {
      for (const frame of page.frames().slice(0, 10)) {
        const body = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (body.toLowerCase().includes(wanted)) return;
      }
      if (Date.now() > deadline) throw new Error('timed out');
      await page.waitForTimeout(300);
    }
  }, wanted ? `"${text.trim()}" did not appear within ${ms / 1000}s: ` : '');
}

/* What a click, key or keystroke would land on - the tool layer asks the operator before anything consequential. */

export interface Target {
  tag: string;
  type: string;
  role: string;
  text: string;
  label: string;
  href?: string;
  formButtons: string[];
  sensitive: boolean;
  editable: boolean;
  url: string;
  host: string;
}

function describeElement(node: Element | null): Omit<Target, 'url' | 'host'> | null {
  if (!node) return null;
  const e = (node.closest('a,button,input,textarea,select,[role=button],[role=link],[role=menuitem],[role=textbox],[contenteditable=""],[contenteditable=true]') ?? node) as HTMLElement;
  const tag = e.tagName.toLowerCase();
  const type = (e.getAttribute('type') || '').toLowerCase();
  const name = `${e.getAttribute('autocomplete') || ''} ${e.getAttribute('name') || ''} ${e.id || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('placeholder') || ''}`;
  const form = e.closest('form');
  const formButtons = form
    ? Array.from(form.querySelectorAll('button, input[type=submit]')).map((b) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    tag,
    type,
    role: e.getAttribute('role') || '',
    text: (e.innerText || (e as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    label: (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('name') || '').slice(0, 120),
    href: tag === 'a' ? (e as HTMLAnchorElement).href : undefined,
    formButtons,
    sensitive: type === 'password' || /\bcc-|card.?(number|num|no)|\bcvc|\bcvv|\bcsc\b|security code|\biban\b|routing|\bssn\b|social.?security|\bsin\b/i.test(name),
    // Code editors count: Monaco types through the EditContext API on a role=textbox div, not contenteditable -
    // select-all + Delete there is editing text, not deleting something (it asked for approval in a live test).
    editable: e.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type))
      || e.getAttribute('role') === 'textbox' || Boolean((e as HTMLElement & { editContext?: unknown }).editContext) || Boolean(e.closest('.monaco-editor, .CodeMirror, .cm-editor, .ace_editor')),
  };
}

async function withTarget(owner: TabOwner, find: (page: Page) => Promise<Omit<Target, 'url' | 'host'> | null>): Promise<Target | null> {
  try {
    const tab = await tabFor(owner);
    const t = await find(tab.page);
    if (!t) return null;
    const url = tab.page.url();
    return { ...t, url, host: (() => { try { return new URL(url).hostname; } catch { return ''; } })() };
  } catch {
    return null;
  }
}

export function describeRef(owner: TabOwner, ref: number): Promise<Target | null> {
  return withTarget(owner, async (page) => {
    const el = locatorFor(page, ref);
    return (await el.count()) ? el.evaluate(describeElement) : null;
  });
}

/* Focus and points can sit inside an embedded frame (a payment form, an editor) - look through the frame, not at it. */
const isFrameTag = (tag: string) => tag === 'IFRAME' || tag === 'FRAME';

export function describeFocused(owner: TabOwner): Promise<Target | null> {
  return withTarget(owner, async (page) => {
    let frame = page.mainFrame();
    for (let depth = 0; depth < 4; depth++) {
      const el = (await frame.evaluateHandle(() => document.activeElement)).asElement();
      if (!el) return null;
      const inner = isFrameTag(await el.evaluate((n) => n.tagName)) ? await el.contentFrame() : null;
      if (!inner) return el.evaluate(describeElement);
      frame = inner;
    }
    return null;
  });
}

export function describePoint(owner: TabOwner, x: number, y: number): Promise<Target | null> {
  return withTarget(owner, async (page) => {
    let frame = page.mainFrame();
    let [px, py] = [x, y];
    for (let depth = 0; depth < 4; depth++) {
      const el = (await frame.evaluateHandle(([cx, cy]) => document.elementFromPoint(cx, cy), [px, py] as const)).asElement();
      if (!el) return null;
      const inner = isFrameTag(await el.evaluate((n) => n.tagName)) ? await el.contentFrame() : null;
      if (!inner) return el.evaluate(describeElement);
      // Page coordinates -> the frame's own: boundingBox is always relative to the main page.
      const outer = await el.boundingBox();
      if (!outer) return null;
      const [ix, iy] = await el.evaluate((n) => [(n as HTMLElement).clientLeft, (n as HTMLElement).clientTop]);
      [px, py] = [x - outer.x - ix, y - outer.y - iy];
      frame = inner;
    }
    return null;
  });
}

export function back(owner: TabOwner): Promise<Snapshot> {
  return act(owner, async (page) => { await page.goBack({ timeout: 10_000 }); }, '');
}

export function scroll(owner: TabOwner, direction: 'down' | 'up', screens: number): Promise<Snapshot> {
  const n = Math.min(Math.max(screens, 0.5), 6);
  return act(owner, async (page) => {
    await page.evaluate(({ dir, amount }) => {
      window.scrollBy({ top: (dir === 'up' ? -1 : 1) * window.innerHeight * 0.85 * amount, behavior: 'instant' as ScrollBehavior });
    }, { dir: direction, amount: n });
    // Infinite feeds load the next batch when you reach them.
    await page.waitForTimeout(900);
  }, '');
}

export async function snapshot(owner: TabOwner): Promise<Snapshot> {
  try {
    const tab = await tabFor(owner);
    if (tab.page.url() === 'about:blank') return { ok: false, error: 'Nothing is open yet - search or open a page first.' };
    return await snapshotOf(tab.page, owner.runId);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * What an agent's tab shows right now - embedded previews first - read by
 * Ultron itself, so a builder's result is described from the page, not from
 * the builder's say-so. Empty when the agent has no open page.
 */
export async function pageState(owner: TabOwner, maxChars = 1800): Promise<string> {
  const tab = tabs.get(owner.id);
  if (!tab || tab.page.isClosed() || tab.page.url() === 'about:blank') return '';
  try {
    const page = tab.page;
    const frames = await embeddedText(page, 1000);
    const text = tidy(await page.evaluate(() => document.body?.innerText || ''));
    return [`${page.url()} ("${await page.title()}")`, frames, `Page text: ${text.slice(0, Math.max(300, maxChars - frames.length))}`].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

export interface PageRead { ok: boolean; url?: string; title?: string; byline?: string; text?: string; truncated?: boolean; warning?: string; error?: string; /** YYYY-MM-DD, from the page's own metadata, when it has one. */ published?: string }

/** A page's publication date from its metadata (article:published_time, JSON-LD, <time>) - research weighs how current a source is. */
export function toIsoDay(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const d = new Date(/^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : t);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 1990 || d.getTime() > Date.now() + 86_400_000 ? undefined : d.toISOString().slice(0, 10);
}

async function publishedDate(page: Page): Promise<string | undefined> {
  const raw = await page.evaluate(() => {
    const pick = (sel: string, attr: string) => document.querySelector(sel)?.getAttribute(attr) || '';
    const meta = pick('meta[property="article:published_time"]', 'content') || pick('meta[name="article:published_time"]', 'content')
      || pick('meta[itemprop="datePublished"]', 'content') || pick('meta[name="date"]', 'content') || pick('meta[name="pubdate"]', 'content')
      || pick('meta[name="dc.date"]', 'content') || pick('meta[name="DC.date.issued"]', 'content');
    if (meta) return meta;
    for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      const m = /"datePublished"\s*:\s*"([^"]+)"/.exec(el.textContent || '');
      if (m) return m[1];
    }
    return pick('article time[datetime], time[datetime]', 'datetime');
  }).catch(() => '');
  return toIsoDay(String(raw || ''));
}

async function extractReadable(page: Page, maxChars: number): Promise<{ title: string; byline: string; text: string }> {
  await page.addScriptTag({ content: readabilitySource }).catch(() => {});
  const article = await page.evaluate(() => {
    const w = window as unknown as { Readability?: new (doc: Document) => { parse(): { title?: string; byline?: string; textContent?: string } | null } };
    try {
      if (w.Readability) {
        const parsed = new w.Readability(document.cloneNode(true) as Document).parse();
        if (parsed?.textContent && parsed.textContent.trim().length > 200) {
          return { title: parsed.title || document.title, byline: parsed.byline || '', text: parsed.textContent };
        }
      }
    } catch { /* fall back to innerText */ }
    return { title: document.title, byline: '', text: document.body?.innerText || '' };
  });
  return { title: article.title, byline: article.byline, text: tidy(article.text).slice(0, maxChars) };
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** `article` = the main story (Readability); `page` = everything, for feeds, threads, comments and listings. */
export async function read(owner: TabOwner, mode: 'article' | 'page', maxChars: number): Promise<PageRead> {
  try {
    const tab = await tabFor(owner);
    if (tab.page.url() === 'about:blank') return { ok: false, error: 'Nothing is open yet - search or open a page first.' };
    const page = tab.page;
    let title = await page.title();
    let byline = '';
    let text: string;
    if (mode === 'article') ({ title, byline, text } = await extractReadable(page, maxChars + 1));
    else text = tidy(await page.evaluate(() => document.body?.innerText || '')).slice(0, maxChars + 1);
    // What big embedded frames show (a live preview, an embedded doc or form) is part of the page to a person.
    const frames = await embeddedText(page);
    // Page text has titles but not the addresses behind them - list the real links so nobody has to guess one.
    const pageLinks = mode === 'page' ? await titledLinks(page, owner.runId) : [];
    const linkBlock = pageLinks.length ? `\n\nLINKS ON THIS PAGE (title -> address):\n${pageLinks.map((l) => `${l.text} -> ${l.url}`).join('\n')}` : '';
    return {
      ok: true,
      url: page.url(),
      title,
      byline,
      text: text.slice(0, maxChars) + (frames ? `\n\n${frames}` : '') + linkBlock,
      truncated: text.length > maxChars,
      warning: pageWarning(title, text),
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Links with real titles (story, post, repo, video names) - navigation chrome filtered out by length. */
async function titledLinks(page: Page, runId: string, max = 45): Promise<{ text: string; url: string }[]> {
  const found = await page.evaluate((limit) => {
    const out: { text: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      if (out.length >= limit) break;
      const text = (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (text.length < 12 || !/^https?:/.test(a.href) || seen.has(a.href)) continue;
      seen.add(a.href);
      out.push({ text: text.slice(0, 110), url: a.href.slice(0, 220) });
    }
    return out;
  }, max).catch(() => [] as { text: string; url: string }[]);
  remember(runId, found.map((l) => l.url));
  return found;
}

/** Finds text on the page, scrolls the first hit into view, and returns each hit with context. */
export async function find(owner: TabOwner, query: string, maxHits = 8): Promise<{ ok: boolean; hits?: string[]; error?: string }> {
  const q = query.trim();
  if (!q) return { ok: false, error: 'Nothing to find.' };
  try {
    const tab = await tabFor(owner);
    const max = Math.min(maxHits, 20);
    const hits: string[] = [];
    // The page first, then what its embedded frames show (previews, embedded docs).
    const frames = [{ frame: tab.page.mainFrame(), where: '' }, ...(await visibleFrames(tab.page)).map(({ frame }) => ({ frame, where: `[in embedded ${hostOf(frame.url())}] ` }))];
    for (const { frame, where } of frames) {
      if (hits.length >= max) break;
      const found = await frame.evaluate(({ needle, limit, scroll }) => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const lower = text.toLowerCase();
        const n = needle.toLowerCase();
        const out: string[] = [];
        for (let i = lower.indexOf(n); i >= 0 && out.length < limit; i = lower.indexOf(n, i + n.length)) {
          out.push(text.slice(Math.max(0, i - 160), i + n.length + 200));
        }
        // Bring the first match on screen so the live view (and a later look) shows it.
        const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); scroll && out.length && node; node = walker.nextNode()) {
          if ((node.textContent || '').toLowerCase().includes(n)) {
            node.parentElement?.scrollIntoView({ block: 'center' });
            break;
          }
        }
        return out;
      }, { needle: q, limit: max - hits.length, scroll: hits.length === 0 }).catch(() => [] as string[]);
      hits.push(...found.map((h) => where + h));
    }
    frameSoon(tab);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function links(owner: TabOwner, filter: string, max = 40): Promise<{ ok: boolean; url?: string; links?: { text: string; url: string }[]; error?: string }> {
  try {
    const tab = await tabFor(owner);
    const found = await tab.page.evaluate(({ f, limit }) => {
      const vh = window.innerHeight;
      const out: { text: string; url: string; dist: number }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
        const url = a.href;
        if (!/^https?:/.test(url) || seen.has(url)) continue;
        const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (f && !`${text} ${url}`.toLowerCase().includes(f.toLowerCase())) continue;
        seen.add(url);
        const r = a.getBoundingClientRect();
        out.push({ text: text.slice(0, 120), url: url.slice(0, 200), dist: r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0 });
      }
      out.sort((x, y) => x.dist - y.dist);
      return out.slice(0, limit).map(({ text, url }) => ({ text, url }));
    }, { f: filter.trim(), limit: Math.min(max, 80) });
    remember(owner.runId, found.map((l) => l.url));
    return { ok: true, url: tab.page.url(), links: found };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** The current screen as a JPEG, for an agent to look at with the vision model. */
/**
 * The current screen as a JPEG. With marks, every clickable element on
 * screen wears its number in a yellow tag (the same numbers browser_click
 * takes) and a faint grid gives 100-px coordinates for browser_mouse - so a
 * vision model can say exactly where to act, even in canvas apps.
 */
export async function screenshot(owner: TabOwner, marks = false): Promise<{ ok: boolean; data?: string; url?: string; title?: string; elements?: string[]; error?: string }> {
  try {
    const tab = await tabFor(owner);
    if (tab.page.url() === 'about:blank') return { ok: false, error: 'Nothing is open yet.' };
    let elements: string[] | undefined;
    if (marks) {
      elements = (await snapshotOf(tab.page, owner.runId)).elements;
      // Where every numbered element sits on screen - embedded frames included - as the snapshot just measured it.
      const tags = frameRects.get(tab.page) ?? [];
      await tab.page.evaluate((refs) => {
        const layer = document.createElement('div');
        layer.id = '__ultron_marks';
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:bold 11px monospace';
        const add = (css: string, text = '') => {
          const d = document.createElement('div');
          d.style.cssText = `position:fixed;${css}`;
          d.textContent = text;
          layer.appendChild(d);
        };
        for (let x = 100; x < innerWidth; x += 100) {
          add(`left:${x}px;top:0;bottom:0;width:0;border-left:1px dashed rgba(255,0,170,.35)`);
          add(`left:${x + 2}px;top:2px;color:#ff00aa;background:rgba(255,255,255,.7);padding:0 2px`, String(x));
        }
        for (let y = 100; y < innerHeight; y += 100) {
          add(`top:${y}px;left:0;right:0;height:0;border-top:1px dashed rgba(255,0,170,.35)`);
          add(`top:${y + 2}px;left:2px;color:#ff00aa;background:rgba(255,255,255,.7);padding:0 2px`, String(y));
        }
        for (const r of refs) {
          if (r.y + r.h < 0 || r.y > innerHeight || r.w === 0) continue;
          add(`left:${Math.max(0, r.x)}px;top:${Math.max(0, r.y)}px;background:#ffd400;color:#000;border:1px solid #000;padding:0 3px;line-height:13px`, String(r.ref));
          add(`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;outline:1px solid rgba(255,212,0,.7)`);
        }
        document.documentElement.appendChild(layer);
      }, tags);
    }
    const buf = await tab.page.screenshot({ type: 'jpeg', quality: 70, timeout: 8000 });
    if (marks) await tab.page.evaluate(() => document.getElementById('__ultron_marks')?.remove()).catch(() => {});
    frameSoon(tab);
    return { ok: true, data: buf.toString('base64'), url: tab.page.url(), title: await tab.page.title(), elements };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/* ── Search engines ─────────────────────────────────────────────────── */

export interface WebSearchResult { title: string; url: string; snippet: string }
export type Engine = 'bing' | 'startpage' | 'yahoo' | 'duckduckgo' | 'brave';

/* Five independent front doors. In September 2026 DuckDuckGo (403) and Brave (429 "verifying you're not a
   bot") started refusing automated searches from one PC while Bing, Startpage and Yahoo still answered -
   one day every search failed because only the first three were tried. */
export const ENGINE_ORDER: Engine[] = ['bing', 'startpage', 'yahoo', 'duckduckgo', 'brave'];

/* An engine that just refused us is skipped for a while: retrying it only burns seconds, and the others
   answer the same question. A refusal is never pushed past. */
const BLOCK_COOLDOWN_MS = 30 * 60_000;
const blockedUntil = new Map<Engine, number>();

/** Engines to try, in order: the preferred one first, anything that recently refused us last-resort only. */
export function engineOrder(preferred: Engine | 'auto', now = Date.now(), blocked: ReadonlyMap<Engine, number> = blockedUntil): Engine[] {
  const base = preferred === 'auto' ? ENGINE_ORDER : [preferred, ...ENGINE_ORDER.filter((e) => e !== preferred)];
  const open = base.filter((e) => (blocked.get(e) ?? 0) <= now);
  return open.length ? open : base;
}

const ENGINE_WALL = /verifying you'?re not a bot|verify (that )?you('| a)re (a )?human|one last step|solve the (challenge|puzzle)|unusual traffic|are you a robot|not a robot|captcha|if this persists, please email us/i;

function decodeDdg(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.href;
  } catch {
    return href;
  }
}

function decodeBing(href: string): string {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith('bing.com') || !u.pathname.startsWith('/ck/')) return href;
    const raw = u.searchParams.get('u');
    if (!raw?.startsWith('a1')) return href;
    const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

/** Yahoo sometimes routes result links through r.search.yahoo.com/.../RU=<target>/RK=... */
function decodeYahoo(href: string): string {
  const m = /\/RU=([^/]+)\/R[KS]=/.exec(href);
  if (!m) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

type EngineRun = { status: number; results: WebSearchResult[] };

async function load(page: Page, url: string): Promise<number> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  return res?.status() ?? 0;
}

async function searchDuckDuckGo(page: Page, query: string, limit: number): Promise<EngineRun> {
  const status = await load(page, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const raw = await page.evaluate((max) => {
    const out: { title: string; href: string; snippet: string }[] = [];
    for (const r of Array.from(document.querySelectorAll('.result'))) {
      if (out.length >= max) break;
      if (r.classList.contains('result--ad')) continue;
      const a = r.querySelector('a.result__a') as HTMLAnchorElement | null;
      if (!a) continue;
      out.push({ title: (a.textContent || '').trim(), href: a.getAttribute('href') || '', snippet: (r.querySelector('.result__snippet')?.textContent || '').trim() });
    }
    return out;
  }, limit);
  return { status, results: raw.filter((r) => r.title && r.href).map((r) => ({ title: r.title, url: decodeDdg(r.href), snippet: r.snippet })) };
}

async function searchBing(page: Page, query: string, limit: number): Promise<EngineRun> {
  const status = await load(page, `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`);
  const raw = await page.evaluate((max) => {
    const out: { title: string; href: string; snippet: string }[] = [];
    for (const li of Array.from(document.querySelectorAll('#b_results > li.b_algo'))) {
      if (out.length >= max) break;
      const a = li.querySelector('h2 a') as HTMLAnchorElement | null;
      if (!a) continue;
      out.push({ title: (a.textContent || '').trim(), href: a.href, snippet: (li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4')?.textContent || '').trim() });
    }
    return out;
  }, limit);
  return { status, results: raw.filter((r) => r.title && r.href).map((r) => ({ title: r.title, url: decodeBing(r.href), snippet: r.snippet })) };
}

async function searchStartpage(page: Page, query: string, limit: number): Promise<EngineRun> {
  const status = await load(page, `https://www.startpage.com/do/search?q=${encodeURIComponent(query)}`);
  await page.waitForSelector('a.result-title, a.w-gl__result-title', { timeout: 5000 }).catch(() => {});
  const raw = await page.evaluate((max) => {
    const out: { title: string; href: string; snippet: string }[] = [];
    for (const a of Array.from(document.querySelectorAll('a.result-title, a.w-gl__result-title')) as HTMLAnchorElement[]) {
      if (out.length >= max) break;
      const title = (a.querySelector('h2, h3')?.textContent || a.textContent || '').trim();
      // Sponsored links route through startpage.com itself.
      if (!title || !/^https?:/.test(a.href) || /(^|\.)startpage\.com$/.test(new URL(a.href).hostname)) continue;
      const box = a.closest('.result, .w-gl__result') ?? a.parentElement;
      out.push({ title, href: a.href, snippet: (box?.querySelector('p, .description, .w-gl__description')?.textContent || '').trim() });
    }
    return out;
  }, limit);
  return { status, results: raw.map((r) => ({ title: r.title, url: r.href, snippet: r.snippet })) };
}

async function searchYahoo(page: Page, query: string, limit: number): Promise<EngineRun> {
  const status = await load(page, `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`);
  const raw = await page.evaluate((max) => {
    const out: { title: string; href: string; snippet: string }[] = [];
    for (const li of Array.from(document.querySelectorAll('#web ol > li'))) {
      if (out.length >= max) break;
      const a = li.querySelector('.compTitle a') as HTMLAnchorElement | null;
      // The heading holds the title; the rest of the link is a "site > path" breadcrumb.
      const title = (a?.querySelector('h3')?.textContent || '').trim();
      if (!a || !title) continue;
      out.push({ title, href: a.href, snippet: (li.querySelector('.compText')?.textContent || '').trim() });
    }
    return out;
  }, limit);
  return { status, results: raw.filter((r) => /^https?:/.test(r.href)).map((r) => ({ title: r.title, url: decodeYahoo(r.href), snippet: r.snippet })) };
}

async function searchBrave(page: Page, query: string, limit: number): Promise<EngineRun> {
  const status = await load(page, `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`);
  await page.waitForSelector('#results, main', { timeout: 6000 }).catch(() => {});
  const results = await page.evaluate((max) => {
    const out: WebSearchResult[] = [];
    const seen = new Set<string>();
    // Brave changes its markup often - take result headings generically instead of trusting class names.
    for (const a of Array.from(document.querySelectorAll('#results a[href^="http"], main a[href^="http"]')) as HTMLAnchorElement[]) {
      if (out.length >= max) break;
      const host = new URL(a.href).hostname;
      if (/(^|\.)brave\.com$/.test(host) || seen.has(a.href)) continue;
      const title = (a.querySelector('.title, .heading, h2, h3, [class*="title"]')?.textContent || '').trim();
      if (title.length < 6) continue;
      seen.add(a.href);
      const box = a.closest('[data-type="web"], .snippet, article, li, div');
      const snippet = (box?.querySelector('.snippet-description, .description, [class*="description"]')?.textContent || '').trim();
      out.push({ title, url: a.href, snippet });
    }
    return out;
  }, limit) as WebSearchResult[];
  return { status, results };
}

const ENGINES: Record<Engine, (page: Page, q: string, limit: number) => Promise<EngineRun>> = {
  bing: searchBing,
  startpage: searchStartpage,
  yahoo: searchYahoo,
  duckduckgo: searchDuckDuckGo,
  brave: searchBrave,
};

/* Some engines answer a suspected bot with junk instead of a refusal - a Vancouver restaurant for
   "<a local high school> advanced placement" (seen live, September 2026). When not one of the top
   results shares a real word with the question, that answer is thrown out. */
const RELEVANCE_STOP = new Set(['what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'about', 'your', 'have', 'does', 'into', 'than', 'then', 'them', 'they', 'best', 'most', 'more', 'right', 'today', 'tell', 'find', 'show', 'give', 'list', 'news']);

export function looksUnrelated(query: string, results: WebSearchResult[]): boolean {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !RELEVANCE_STOP.has(w));
  if (!terms.length || !results.length) return false;
  return !results.slice(0, 5).some((r) => {
    const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

/** One engine: its results, or why there were none (a refusal puts it on the bench for a while). */
async function tryEngine(e: Engine, page: Page, q: string, max: number): Promise<{ results: WebSearchResult[]; why?: string }> {
  try {
    const { status, results } = await ENGINES[e](page, q, max);
    if (results.length && looksUnrelated(q, results)) {
      blockedUntil.set(e, Date.now() + BLOCK_COOLDOWN_MS / 3);
      return { results: [], why: `${e} returned unrelated results` };
    }
    if (results.length) return { results };
    const refused = status === 403 || status === 429 || ENGINE_WALL.test(await pageSample(page));
    if (refused) blockedUntil.set(e, Date.now() + BLOCK_COOLDOWN_MS);
    return { results: [], why: refused ? `${e} refused automated searches${status >= 400 ? ` (HTTP ${status})` : ''}` : `${e} found nothing` };
  } catch (err) {
    return { results: [], why: `${e}: ${errorText(err).slice(0, 80)}` };
  }
}

/** Searches in the agent's own tab (visible in the live view), falling back across engines. */
export async function search(owner: TabOwner, query: string, engine: Engine | 'auto' = 'auto', limit = 8): Promise<{ ok: boolean; engine?: Engine; results: WebSearchResult[]; error?: string }> {
  const q = query.trim();
  if (!q) return { ok: false, results: [], error: 'Empty query.' };
  const max = Math.min(Math.max(limit, 1), 15);
  try {
    const tab = await tabFor(owner);
    const why: string[] = [];
    for (const e of engineOrder(engine)) {
      const r = await tryEngine(e, tab.page, q, max);
      frameSoon(tab);
      if (r.results.length) {
        remember(owner.runId, r.results.map((x) => x.url));
        return { ok: true, engine: e, results: r.results };
      }
      if (r.why) why.push(r.why);
    }
    return { ok: false, results: [], error: `No results - ${why.join('; ')}. Try different words, or open a site you know directly.` };
  } catch (e) {
    return { ok: false, results: [], error: errorText(e) };
  }
}

/* ── Background pipeline (deep research, fixed lookups) ─────────────── */

export async function webSearch(query: string, limit = 8): Promise<{ ok: boolean; results: WebSearchResult[]; engine?: string; error?: string }> {
  const q = query.trim();
  if (!q) return { ok: false, results: [], error: 'Empty query.' };
  const max = Math.min(Math.max(limit, 1), 15);
  try {
    return await withResearchPage(async (page) => {
      const why: string[] = [];
      for (const e of engineOrder('auto')) {
        const r = await tryEngine(e, page, q, max);
        if (r.results.length) return { ok: true, results: r.results, engine: e };
        if (r.why) why.push(r.why);
      }
      return { ok: false, results: [], error: `No results - ${why.join('; ')}.` };
    });
  } catch (e) {
    return { ok: false, results: [], error: errorText(e) };
  }
}

export async function readPage(url: string, maxChars = 8000): Promise<PageRead> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs can be read.' };
  try {
    return await withResearchPage(async (page) => {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
      if (res && res.status() >= 400) return { ok: false, url: page.url(), error: `HTTP ${res.status()}` };
      const { title, byline, text } = await extractReadable(page, maxChars + 1);
      const published = await publishedDate(page);
      return { ok: true, url: page.url(), title, byline, text: text.slice(0, maxChars), truncated: text.length > maxChars, warning: pageWarning(title, text), published };
    });
  } catch (e) {
    return { ok: false, url, error: errorText(e) };
  }
}

/** Visible body text, no article extraction - for listing pages (flights, results) rather than articles. */
export async function pageText(url: string, maxChars = 12_000): Promise<PageRead> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) URLs can be read.' };
  try {
    return await withResearchPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const text = await page.evaluate(() => document.body?.innerText || '');
      return { ok: true, url: page.url(), title: await page.title(), text: text.slice(0, maxChars), truncated: text.length > maxChars };
    });
  } catch (e) {
    return { ok: false, url, error: errorText(e) };
  }
}

/* ── YouTube ────────────────────────────────────────────────────────── */

export interface YouTubeResult { title: string; url: string; channel: string }

/** YouTube's own results page - general search engines rarely return clean watch links. */
export async function youtubeSearch(query: string, limit = 6): Promise<{ ok: boolean; results: YouTubeResult[]; error?: string }> {
  try {
    return await withResearchPage(async (page) => {
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForSelector('a#video-title, a.yt-lockup-metadata-view-model-wiz__title, a.yt-lockup-metadata-view-model__title', { timeout: 8000 }).catch(() => {});
      const results = await page.evaluate((max) => {
        const out: { title: string; url: string; channel: string }[] = [];
        const seen = new Set<string>();
        const anchors = Array.from(document.querySelectorAll('a#video-title, a.yt-lockup-metadata-view-model-wiz__title, a.yt-lockup-metadata-view-model__title'));
        for (const el of anchors) {
          if (out.length >= max) break;
          const a = el as HTMLAnchorElement;
          const href = a.getAttribute('href') || '';
          if (!href.startsWith('/watch')) continue;
          const url = 'https://www.youtube.com' + href.split('&')[0];
          if (seen.has(url)) continue;
          seen.add(url);
          const title = (a.getAttribute('title') || a.textContent || '').trim();
          if (!title) continue;
          const container = a.closest('ytd-video-renderer, yt-lockup-view-model');
          const channel = (container?.querySelector('ytd-channel-name a, ytd-channel-name #text, .yt-content-metadata-view-model-wiz__metadata-text, .yt-content-metadata-view-model__metadata-text')?.textContent || '').trim();
          out.push({ title, url, channel });
        }
        return out;
      }, Math.min(limit, 12));
      return { ok: true, results };
    });
  } catch (e) {
    return { ok: false, results: [], error: errorText(e) };
  }
}

/** At quit: keep the website logins, then shut both Chromiums down - they are real OS processes. */
export async function closeBrowser(): Promise<void> {
  for (const [id] of tabs) forgetTab(id);
  await closeAgentContext();
  const b = researchBrowser;
  researchBrowser = null;
  research = null;
  await b?.close().catch(() => {});
}

import { BrowserWindow, session, shell, type Session } from 'electron';
import { getSettings } from './store';
import * as tasks from './tasks';
import { emit } from './brain/events';

/**
 * D2L Brightspace - the school's own address, set in Settings (e.g. https://myschool.brightspace.com).
 * Students can't get API keys, so the
 * operator signs in themselves in a normal window (school SSO, 2FA and all)
 * and Ultron keeps that session in its own cookie partition. Ultron never
 * sees or stores the password. Data then comes from Brightspace's own REST
 * API - the same calls the D2L website makes - using that session.
 */

const PARTITION = 'persist:d2l';

export interface D2LStatus { baseUrl: string; signedIn: boolean; user?: string; error?: string }
export interface D2LCourse { id: number; name: string; code: string; active: boolean }
export interface D2LDueItem { course: string; courseId: number; name: string; due: string | null; type: string; completed: boolean; url?: string }

let versions: { lp: string; le: string } | null = null;
let coursesCache: { at: number; list: D2LCourse[] } | null = null;
let loginWindow: BrowserWindow | null = null;

function ses(): Session {
  return session.fromPartition(PARTITION);
}

export const NOT_SET_UP = 'D2L is not set up: add your school\'s Brightspace address in Settings (Apps & school), then sign in from the Apps panel.';

/** The school's Brightspace address, or '' when the operator has not set one. */
export function baseUrl(): string {
  const raw = (getSettings().d2l.baseUrl || '').trim();
  return raw.replace(/\/+$/, '').replace(/\/d2l(\/.*)?$/, '');
}

/** The address, or an error the tools pass on when there is none. */
function requireBase(): string {
  const url = baseUrl();
  if (!url) throw new Error(NOT_SET_UP);
  return url;
}

class D2LAuthError extends Error {}

/* ── Staying signed in ───────────────────────────────────────────────────
   D2L and school SSO use session cookies (no expiry date), and Chromium
   drops those when the app quits - so every restart meant signing in
   again. After a good sign-in, and again at quit, the partition's session
   cookies are re-saved with an expiry so they survive restarts (Chromium
   keeps cookie values encrypted on disk). If D2L's own server session has
   timed out anyway, a hidden window reloads D2L so SSO can sign back in
   silently - a visible window is only needed when a password is.        */

const KEEP_DAYS = 30;

type StoredCookie = Pick<Electron.Cookie, 'name' | 'value' | 'domain' | 'hostOnly' | 'path' | 'secure' | 'httpOnly' | 'sameSite' | 'session'>;

/** The same cookie, made to outlive the app: host-only cookies must not gain a domain. */
export function persistentCopy(c: StoredCookie, nowMs = Date.now()): Electron.CookiesSetDetails {
  const host = (c.domain ?? '').replace(/^\./, '');
  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    ...(c.hostOnly ? {} : { domain: c.domain }),
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: Math.floor(nowMs / 1000) + KEEP_DAYS * 86400,
  };
}

/** Re-saves every session cookie in the D2L partition with an expiry date. Returns how many. */
export async function keepSignedIn(): Promise<number> {
  const s = ses();
  const cookies = await s.cookies.get({});
  let kept = 0;
  for (const c of cookies) {
    if (!c.session) continue;
    try {
      await s.cookies.set(persistentCopy(c));
      kept++;
    } catch {
      /* an unusual cookie the API won't re-set - the rest still count */
    }
  }
  await s.cookies.flushStore().catch(() => {});
  return kept;
}

let silentTried = 0;

/** Reloads D2L in a hidden window so school SSO can re-establish the session without the operator. */
async function silentRefresh(): Promise<boolean> {
  if (Date.now() - silentTried < 10 * 60_000) return false;
  silentTried = Date.now();
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await win.loadURL(`${requireBase()}/d2l/home`).catch(() => {});
    const until = Date.now() + 20_000;
    while (Date.now() < until && !win.isDestroyed()) {
      if (/\/d2l\/(home|le|lp)/.test(win.webContents.getURL())) {
        versions = null;
        const me = await whoami().catch(() => null);
        if (me) {
          await keepSignedIn();
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await ses().fetch(`${requireBase()}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new D2LAuthError('Not signed in to D2L (or the session expired). Sign in from the Apps panel.');
  }
  if (!res.ok) throw new Error(`D2L ${res.status} on ${path.split('?')[0]}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new D2LAuthError('D2L returned a login page - sign in again from the Apps panel.');
  return (await res.json()) as T;
}

async function apiVersions(): Promise<{ lp: string; le: string }> {
  if (versions) return versions;
  try {
    const list = await getJson<{ ProductCode: string; LatestVersion: string }[]>('/d2l/api/versions/');
    const pick = (code: string, fallback: string) => list.find((v) => v.ProductCode === code)?.LatestVersion ?? fallback;
    versions = { lp: pick('lp', '1.40'), le: pick('le', '1.70') };
  } catch (e) {
    if (e instanceof D2LAuthError) throw e;
    versions = { lp: '1.40', le: '1.70' };
  }
  return versions;
}

interface WhoAmI { FirstName?: string; LastName?: string; UniqueName?: string }

async function whoami(): Promise<WhoAmI> {
  const v = await apiVersions();
  return getJson<WhoAmI>(`/d2l/api/lp/${v.lp}/users/whoami`);
}

async function hasSessionCookies(): Promise<boolean> {
  return (await ses().cookies.get({}).catch(() => [])).length > 0;
}

export async function status(): Promise<D2LStatus> {
  const url = baseUrl();
  if (!url) return { baseUrl: '', signedIn: false, error: NOT_SET_UP };
  try {
    const me = await whoami();
    void keepSignedIn().catch(() => {});
    return { baseUrl: url, signedIn: true, user: [me.FirstName, me.LastName].filter(Boolean).join(' ') || me.UniqueName };
  } catch (e) {
    // Signed in before (cookies exist) but the server session lapsed: try once, quietly, before asking the operator.
    if (e instanceof D2LAuthError && (await hasSessionCookies()) && (await silentRefresh())) {
      const me = await whoami().catch(() => null);
      if (me) return { baseUrl: url, signedIn: true, user: [me.FirstName, me.LastName].filter(Boolean).join(' ') || me.UniqueName };
    }
    return { baseUrl: url, signedIn: false, error: e instanceof D2LAuthError ? undefined : e instanceof Error ? e.message : String(e) };
  }
}

/** Opens a real D2L sign-in window; resolves once the session works or the window is closed. */
export function signIn(): Promise<D2LStatus> {
  if (!baseUrl()) return Promise.resolve({ baseUrl: '', signedIn: false, error: NOT_SET_UP });
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return status();
  }
  versions = null;
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1040,
      height: 780,
      title: 'Sign in to D2L - Ultron',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    loginWindow = win;
    // School SSO sometimes pops a window; keep it inside the same signed-in session.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true } } };
      }
      return { action: 'deny' };
    });
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      await keepSignedIn().catch(() => 0);
      const s = await status();
      if (!win.isDestroyed()) win.close();
      loginWindow = null;
      emit('d2l:changed', s);
      resolve(s);
    };
    const poll = setInterval(async () => {
      if (win.isDestroyed()) return;
      if (!/\/d2l\/(home|le|lp)/.test(win.webContents.getURL())) return;
      const s = await status();
      if (s.signedIn) void finish();
    }, 2000);
    win.on('closed', () => { void finish(); });
    void win.loadURL(`${requireBase()}/d2l/home`);
  });
}

export async function signOut(): Promise<D2LStatus> {
  await ses().clearStorageData();
  versions = null;
  coursesCache = null;
  const s = await status();
  emit('d2l:changed', s);
  return s;
}

export function openInBrowser(): void {
  void shell.openExternal(`${requireBase()}/d2l/home`);
}

function page<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const d = data as { Objects?: T[]; Items?: T[] } | null;
  return d?.Objects ?? d?.Items ?? [];
}

export async function courses(): Promise<D2LCourse[]> {
  if (coursesCache && Date.now() - coursesCache.at < 10 * 60_000) return coursesCache.list;
  const v = await apiVersions();
  const list: D2LCourse[] = [];
  let bookmark = '';
  for (let i = 0; i < 5; i++) {
    const data = await getJson<{ PagingInfo?: { Bookmark?: string; HasMoreItems?: boolean }; Items?: { OrgUnit: { Id: number; Name: string; Code?: string }; Access?: { IsActive?: boolean; CanAccess?: boolean; EndDate?: string | null } }[] }>(
      `/d2l/api/lp/${v.lp}/enrollments/myenrollments/?orgUnitTypeId=3${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`,
    );
    for (const item of data.Items ?? []) {
      const ended = item.Access?.EndDate ? Date.parse(item.Access.EndDate) < Date.now() : false;
      list.push({
        id: item.OrgUnit.Id,
        name: item.OrgUnit.Name,
        code: item.OrgUnit.Code ?? '',
        active: Boolean(item.Access?.IsActive ?? true) && item.Access?.CanAccess !== false && !ended,
      });
    }
    if (!data.PagingInfo?.HasMoreItems || !data.PagingInfo.Bookmark) break;
    bookmark = data.PagingInfo.Bookmark;
  }
  coursesCache = { at: Date.now(), list };
  return list;
}

function matchCourse(list: D2LCourse[], query?: string): D2LCourse[] {
  const active = list.filter((c) => c.active);
  if (!query?.trim()) return active.length ? active : list;
  const q = query.toLowerCase();
  const hits = list.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  return hits.length ? hits : active;
}

const ACTIVITY: Record<number, string> = { 1: 'content', 2: 'assignment', 3: 'quiz', 4: 'discussion', 5: 'survey', 6: 'checklist', 7: 'self-assessment' };

function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

export async function dueItems(daysAhead = 14, courseQuery?: string): Promise<D2LDueItem[]> {
  const v = await apiVersions();
  const all = await courses();
  const scope = matchCourse(all, courseQuery);
  const names = new Map(all.map((c) => [c.id, c.name]));
  const start = new Date(Date.now() - 24 * 3600_000);
  const end = new Date(Date.now() + Math.max(1, daysAhead) * 24 * 3600_000);
  const ids = scope.map((c) => c.id).join(',');
  const out: D2LDueItem[] = [];
  const seen = new Set<string>();
  const push = (item: D2LDueItem) => {
    const key = `${item.courseId}|${item.name.toLowerCase()}|${item.due ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  try {
    const data = await getJson<unknown>(`/d2l/api/le/${v.le}/content/myItems/due/?orgUnitIdsCSV=${ids}&startDateTime=${utc(start)}&endDateTime=${utc(end)}`);
    for (const it of page<{ OrgUnitId: number; ItemName: string; DueDate?: string | null; EndDate?: string | null; ActivityType?: number; ItemUrl?: string; DateCompleted?: string | null; IsExempt?: boolean }>(data)) {
      if (it.IsExempt) continue;
      push({
        course: names.get(it.OrgUnitId) ?? `Course ${it.OrgUnitId}`,
        courseId: it.OrgUnitId,
        name: it.ItemName,
        due: it.DueDate ?? it.EndDate ?? null,
        type: ACTIVITY[it.ActivityType ?? 0] ?? 'item',
        completed: Boolean(it.DateCompleted),
        url: it.ItemUrl,
      });
    }
  } catch (e) {
    if (e instanceof D2LAuthError) throw e;
    /* not every Brightspace exposes myItems - fall back to per-course assignment folders */
  }

  // Assignment folders carry due dates even where myItems is thin or disabled.
  for (const c of scope.slice(0, 15)) {
    try {
      const folders = await getJson<{ Id: number; Name: string; DueDate?: string | null; IsHidden?: boolean }[]>(`/d2l/api/le/${v.le}/${c.id}/dropbox/folders/`);
      for (const f of folders) {
        if (f.IsHidden || !f.DueDate) continue;
        const due = Date.parse(f.DueDate);
        if (due < start.getTime() || due > end.getTime()) continue;
        push({ course: c.name, courseId: c.id, name: f.Name, due: f.DueDate, type: 'assignment', completed: false });
      }
    } catch (e) {
      if (e instanceof D2LAuthError) throw e;
    }
  }
  return out.sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity));
}

export async function overdue(): Promise<D2LDueItem[]> {
  const v = await apiVersions();
  const all = await courses();
  const names = new Map(all.map((c) => [c.id, c.name]));
  try {
    const data = await getJson<unknown>(`/d2l/api/le/${v.le}/overdueItems/myItems?orgUnitIdsCSV=${matchCourse(all).map((c) => c.id).join(',')}`);
    return page<{ OrgUnitId: number; ItemName: string; DueDate?: string | null }>(data).map((it) => ({
      course: names.get(it.OrgUnitId) ?? `Course ${it.OrgUnitId}`,
      courseId: it.OrgUnitId,
      name: it.ItemName,
      due: it.DueDate ?? null,
      type: 'overdue',
      completed: false,
    }));
  } catch (e) {
    if (e instanceof D2LAuthError) throw e;
    return [];
  }
}

export async function grades(courseQuery?: string): Promise<{ course: string; final?: string; items: { name: string; grade: string; points?: string }[] }[]> {
  const v = await apiVersions();
  const scope = matchCourse(await courses(), courseQuery).slice(0, 12);
  const out: { course: string; final?: string; items: { name: string; grade: string; points?: string }[] }[] = [];
  for (const c of scope) {
    try {
      const values = await getJson<{ GradeObjectName: string; DisplayedGrade?: string; PointsNumerator?: number | null; PointsDenominator?: number | null }[]>(
        `/d2l/api/le/${v.le}/${c.id}/grades/values/myGradeValues/`,
      );
      let final: string | undefined;
      try {
        const f = await getJson<{ DisplayedGrade?: string }>(`/d2l/api/le/${v.le}/${c.id}/grades/final/values/myGradeValue`);
        final = f.DisplayedGrade?.trim() || undefined;
      } catch { /* final grade often hidden */ }
      out.push({
        course: c.name,
        final,
        items: values.map((g) => ({
          name: g.GradeObjectName,
          grade: (g.DisplayedGrade ?? '').trim() || '-',
          points: g.PointsDenominator ? `${g.PointsNumerator ?? '?'}/${g.PointsDenominator}` : undefined,
        })),
      });
    } catch (e) {
      if (e instanceof D2LAuthError) throw e;
      out.push({ course: c.name, items: [] });
    }
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function announcements(courseQuery?: string, limit = 8): Promise<{ course: string; title: string; date: string | null; text: string }[]> {
  const v = await apiVersions();
  const scope = matchCourse(await courses(), courseQuery).slice(0, 12);
  const out: { course: string; title: string; date: string | null; text: string }[] = [];
  for (const c of scope) {
    try {
      const items = await getJson<{ Title: string; StartDate?: string | null; Body?: { Text?: string; Html?: string }; IsPublished?: boolean }[]>(`/d2l/api/le/${v.le}/${c.id}/news/`);
      for (const n of items) {
        if (n.IsPublished === false) continue;
        const text = n.Body?.Text?.trim() || htmlToText(n.Body?.Html ?? '');
        out.push({ course: c.name, title: n.Title, date: n.StartDate ?? null, text: text.slice(0, 1200) });
      }
    } catch (e) {
      if (e instanceof D2LAuthError) throw e;
    }
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, Math.min(limit, 30));
}

/** Copies upcoming D2L due dates into Ultron's own task list (with reminders), skipping ones already there. */
export async function syncToTasks(daysAhead = 21): Promise<{ added: string[]; skipped: number }> {
  const items = (await dueItems(daysAhead)).filter((i) => !i.completed && i.due && Date.parse(i.due) > Date.now());
  const existing = tasks.listTasks('all').map((t) => t.title.toLowerCase());
  const added: string[] = [];
  let skipped = 0;
  for (const it of items) {
    const title = `${it.name} (${it.course})`;
    if (existing.includes(title.toLowerCase())) { skipped++; continue; }
    const due = new Date(it.due!);
    // Remind the evening before, or 3 hours before if it's due sooner than that.
    const eveningBefore = new Date(due);
    eveningBefore.setDate(eveningBefore.getDate() - 1);
    eveningBefore.setHours(18, 0, 0, 0);
    const remind = eveningBefore.getTime() > Date.now() ? eveningBefore : new Date(Math.max(Date.now() + 60_000, due.getTime() - 3 * 3600_000));
    tasks.addTask({
      title,
      due: due.toISOString(),
      remindAt: remind.toISOString(),
      notes: `From D2L (${it.type}).${it.url ? ` ${baseUrl()}${it.url.startsWith('/') ? it.url : `/${it.url}`}` : ''}`,
      priority: due.getTime() - Date.now() < 48 * 3600_000 ? 'high' : 'normal',
      source: 'ultron',
    });
    existing.push(title.toLowerCase());
    added.push(title);
  }
  return { added, skipped };
}

export function isAuthError(e: unknown): boolean {
  return e instanceof D2LAuthError;
}

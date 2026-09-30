import { shell } from 'electron';
import type { Composio as ComposioClient } from '@composio/core';
import { getSecret } from './secrets';
import { getSettings } from './store';
import { emit } from './brain/events';
import * as connect from './composioConnect';
import * as composioAuth from './composioAuth';

/**
 * Every outside app (Gmail, Calendar, Drive, Notion, Spotify, GitHub, Discord...)
 * goes through Composio: it owns the OAuth apps and token refresh, so a
 * connection is one click in the Apps panel instead of registering a Google
 * Cloud project by hand. The operator's Composio API key is the only secret.
 *
 * Two kinds of key work, and they talk to different backends:
 *   ck_...  Composio Connect (dashboard.composio.dev) - MCP, see composioConnect.ts
 *   ak_...  a developer project (platform.composio.dev) - the @composio/core SDK
 */

export type KeyKind = 'connect' | 'project' | 'none';

export function keyKind(key: string): KeyKind {
  const k = key.trim();
  if (!k) return 'none';
  return /^ck_/i.test(k) ? 'connect' : 'project';
}

function currentKey(): string {
  return getSecret('COMPOSIO_API_KEY').trim();
}

/** Composio Connect credentials, preferring the browser sign-in over a pasted ck_ key. */
function connectAuth(): connect.ConnectAuth | null {
  if (composioAuth.isSignedIn()) return { kind: 'oauth' };
  const key = currentKey();
  return keyKind(key) === 'connect' ? { kind: 'key', key } : null;
}

/** Which backend is in use right now: a signed-in or ck_ Connect account, a project key, or nothing. */
function currentMode(): KeyKind {
  return connectAuth() ? 'connect' : keyKind(currentKey());
}

export interface AppDef {
  slug: string;
  name: string;
  group: 'Google' | 'Apps';
  blurb: string;
  recommended?: boolean;
}

export const APP_CATALOG: AppDef[] = [
  { slug: 'googlesuper', name: 'Google - all apps', group: 'Google', recommended: true, blurb: 'One sign-in: Gmail, Calendar, Drive, Docs, Sheets, Slides, Meet, Photos, Tasks, Classroom' },
  { slug: 'gmail', name: 'Gmail', group: 'Google', blurb: 'Read, search, draft and send email' },
  { slug: 'googlecalendar', name: 'Google Calendar', group: 'Google', blurb: 'Events, schedules, free time' },
  { slug: 'googledrive', name: 'Google Drive', group: 'Google', blurb: 'Find, read and organise files' },
  { slug: 'googledocs', name: 'Google Docs', group: 'Google', blurb: 'Create and edit documents' },
  { slug: 'googlesheets', name: 'Google Sheets', group: 'Google', blurb: 'Read and write spreadsheets' },
  { slug: 'googleslides', name: 'Google Slides', group: 'Google', blurb: 'Build presentations' },
  { slug: 'googletasks', name: 'Google Tasks', group: 'Google', blurb: 'Sync to-dos with Google' },
  { slug: 'googlemeet', name: 'Google Meet', group: 'Google', blurb: 'Create meetings' },
  { slug: 'googlephotos', name: 'Google Photos', group: 'Google', blurb: 'Search your photos' },
  { slug: 'google_classroom', name: 'Google Classroom', group: 'Google', blurb: 'Courses and assignments' },
  { slug: 'google_maps', name: 'Google Maps', group: 'Google', blurb: 'Places, directions, travel times' },
  { slug: 'youtube', name: 'YouTube', group: 'Google', blurb: 'Search videos, playlists, subscriptions' },
  { slug: 'notion', name: 'Notion', group: 'Apps', blurb: 'Pages, databases, notes' },
  { slug: 'spotify', name: 'Spotify', group: 'Apps', blurb: 'Play, queue and search music' },
  { slug: 'github', name: 'GitHub', group: 'Apps', blurb: 'Repos, issues, pull requests' },
  { slug: 'discord', name: 'Discord', group: 'Apps', blurb: 'Your servers and profile' },
  { slug: 'discordbot', name: 'Discord Bot', group: 'Apps', blurb: 'Composio\'s bot, shared with every Composio user - use "Discord - your own bot" below' },
  { slug: 'canva', name: 'Canva', group: 'Apps', blurb: 'Designs, templates and exports' },
  { slug: 'figma', name: 'Figma', group: 'Apps', blurb: 'Files, frames and comments' },
  // Left out: TikTok (Composio has no ready-made login - it needs an own developer app that TikTok must review),
  // Snapchat (Composio has only its ads API) and Epic Games (no Composio toolkit, no public player API).
  { slug: 'instagram', name: 'Instagram', group: 'Apps', blurb: 'Your posts, their stats and your DMs - Creator or Business accounts only' },
];

export type AppConnection = 'connected' | 'pending' | 'expired' | 'failed' | 'none';

export interface AppState extends AppDef {
  status: AppConnection;
  accountIds: string[];
  detail?: string;
}

export interface AppsStatus {
  hasKey: boolean;
  /** Which Composio backend is in use. */
  mode: KeyKind;
  /** How Ultron authenticates: the operator's browser sign-in, or a pasted key. */
  auth: 'oauth' | 'key' | 'none';
  ok: boolean;
  error?: string;
  /** What to do about the error, in plain words. */
  hint?: string;
  userId: string;
  apps: AppState[];
  checkedAt: number;
}

type ComposioModule = typeof import('@composio/core');
let sdkPromise: Promise<ComposioModule> | null = null;
let cached: { key: string; client: ComposioClient } | null = null;
let lastStatus: AppsStatus | null = null;

async function client(): Promise<ComposioClient> {
  const key = currentKey();
  if (!key) throw new Error('No Composio API key yet - add it in the Apps panel.');
  if (cached?.key === key) return cached.client;
  // The SDK ships as ESM only; a dynamic import loads it from the CommonJS main bundle.
  sdkPromise ??= import('@composio/core');
  const { Composio } = await sdkPromise;
  const c = new Composio({ apiKey: key, allowTracking: false });
  cached = { key, client: c };
  return c;
}

function userId(): string {
  return getSettings().composio.userId || 'ultron';
}

const KEY_REJECTED = 'Composio rejected the API key.';

function errorText(e: unknown): string {
  if (e instanceof connect.ConnectError) return e.kind === 'auth' ? KEY_REJECTED : e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthori[sz]ed|invalid api key|api key/i.test(msg)) return KEY_REJECTED;
  return msg.slice(0, 300);
}

/**
 * What to do about a rejected key, by its prefix. Connect keys (ck_) and
 * project keys (ak_) come from different dashboards; user and org keys
 * (uak_, oak_) work with neither of the calls Ultron makes.
 */
export function keyHint(key: string): string {
  const prefix = /^([a-z]{1,4}_)/i.exec(key.trim())?.[1]?.toLowerCase();
  if (prefix === 'ck_') {
    return 'Composio Connect says this key is invalid. A key stops working the moment it is regenerated - copy the current one from dashboard.composio.dev and paste it again.';
  }
  if (prefix === 'ak_') {
    return 'Composio says this project key is invalid - it may have been revoked. Copy a fresh one from platform.composio.dev - open your project, then Settings, then API Keys.';
  }
  return `Ultron takes a Composio Connect key (starts with "ck_", from dashboard.composio.dev) or a project API key (starts with "ak_", from platform.composio.dev)${prefix ? ` - the key you pasted starts with "${prefix}", a different kind of key` : ''}.`;
}

function blankStatus(): AppsStatus {
  const mode = currentMode();
  const auth = connectAuth();
  return {
    hasKey: mode !== 'none',
    mode,
    auth: auth?.kind ?? (mode === 'project' ? 'key' : 'none'),
    ok: false,
    userId: mode === 'connect' ? 'Composio Connect' : userId(),
    apps: APP_CATALOG.map((a) => ({ ...a, status: 'none' as AppConnection, accountIds: [] })),
    checkedAt: Date.now(),
  };
}

async function projectStatus(base: AppsStatus): Promise<void> {
  const c = await client();
  const res = await c.connectedAccounts.list({
    userIds: [base.userId],
    toolkitSlugs: APP_CATALOG.map((a) => a.slug),
    limit: 100,
  });
  const byToolkit = new Map<string, { id: string; status: string; reason: string | null }[]>();
  for (const item of res.items) {
    const slug = item.toolkit?.slug?.toLowerCase();
    if (!slug) continue;
    const list = byToolkit.get(slug) ?? [];
    list.push({ id: item.id, status: String(item.status), reason: item.statusReason ?? null });
    byToolkit.set(slug, list);
  }
  base.apps = base.apps.map((a) => {
    const accounts = byToolkit.get(a.slug) ?? [];
    const active = accounts.filter((x) => x.status === 'ACTIVE');
    let status: AppConnection = 'none';
    if (active.length) status = 'connected';
    else if (accounts.some((x) => x.status === 'INITIATED' || x.status === 'INITIALIZING')) status = 'pending';
    else if (accounts.some((x) => x.status === 'EXPIRED' || x.status === 'INACTIVE')) status = 'expired';
    else if (accounts.some((x) => x.status === 'FAILED')) status = 'failed';
    return {
      ...a,
      status,
      accountIds: (active.length ? active : accounts).map((x) => x.id),
      detail: accounts.find((x) => x.reason)?.reason ?? undefined,
    };
  });
}

async function connectStatus(base: AppsStatus): Promise<void> {
  const states = await connect.listConnections(connectAuth()!, APP_CATALOG.map((a) => a.slug));
  base.apps = base.apps.map((a) => {
    const s = states[a.slug];
    return s ? { ...a, status: s.status, accountIds: s.accountIds, detail: s.detail } : a;
  });
}

export async function appsStatus(): Promise<AppsStatus> {
  const base = blankStatus();
  if (!base.hasKey) {
    lastStatus = base;
    return base;
  }
  try {
    if (base.mode === 'connect') await connectStatus(base);
    else await projectStatus(base);
    base.ok = true;
  } catch (e) {
    base.error = errorText(e);
    if (base.error === KEY_REJECTED) {
      if (base.auth === 'oauth') {
        base.error = 'Your Composio sign-in expired.';
        base.hint = 'Press "Sign in with Composio" again - it takes a few seconds if you are still signed in to Composio in your browser.';
      } else {
        base.hint = keyHint(currentKey());
      }
    }
    // Say exactly what Composio answered - "rejected" alone can't tell a bad key from a Composio-side fault.
    if (e instanceof connect.ConnectError && e.raw) base.hint = `${base.hint ?? base.error} Composio said: "${e.raw}"`;
    console.warn('[ultron] Composio status failed:', e instanceof connect.ConnectError ? `${e.kind}: ${e.raw || e.message}` : e);
  }
  lastStatus = base;
  return base;
}

export function connectedSlugs(): string[] {
  return (lastStatus?.apps ?? []).filter((a) => a.status === 'connected').map((a) => a.slug);
}

function freshStatus(): AppsStatus | null {
  return lastStatus && Date.now() - lastStatus.checkedAt < 60_000 && lastStatus.mode === currentMode() ? lastStatus : null;
}

export async function connectedApps(): Promise<AppState[]> {
  const s = freshStatus() ?? await appsStatus();
  return s.apps.filter((a) => a.status === 'connected');
}

/** Starts OAuth in the operator's real browser; the panel updates when Composio reports it active. */
export async function connectApp(slug: string): Promise<{ ok: boolean; redirectUrl?: string; error?: string; setupUrl?: string }> {
  if (!APP_CATALOG.some((a) => a.slug === slug)) return { ok: false, error: 'Unknown app.' };
  // With a bad key the SDK fails here with a confusing "Couldn't fetch Toolkit" - report the real problem.
  const fresh = freshStatus();
  const status = fresh?.ok ? fresh : await appsStatus();
  if (!status.ok) return { ok: false, error: status.hint ?? status.error ?? 'Composio is not reachable right now.' };
  try {
    if (status.mode === 'connect') {
      const auth = connectAuth()!;
      const out = await connect.startConnection(auth, slug);
      const url = out.url;
      if (!url) {
        const name = APP_CATALOG.find((a) => a.slug === slug)?.name ?? slug;
        // No ready-made login at Composio (Spotify): it needs a one-time setup with the operator's own developer app.
        if (out.error && /managed auth|auth config/i.test(out.error)) {
          return { ok: false, setupUrl: out.setupUrl, error: `Composio has no ready-made login for ${name}, so it needs a one-time setup first: your own ${name} developer app, added in Composio. Open the setup page, then press Connect again.` };
        }
        return { ok: false, setupUrl: out.setupUrl, error: out.error ?? 'Composio did not send a sign-in link for that app - try again in a minute.' };
      }
      await shell.openExternal(url);
      void connect.waitForConnection(auth, slug)
        .catch(() => {})
        .then(() => appsStatus())
        .then((s) => emit('apps:changed', s));
      return { ok: true, redirectUrl: url };
    }
    const c = await client();
    const request = await c.toolkits.authorize(userId(), slug);
    if (request.redirectUrl) await shell.openExternal(request.redirectUrl);
    void request.waitForConnection(5 * 60_000)
      .then(() => appsStatus())
      .catch(() => appsStatus())
      .then((s) => emit('apps:changed', s));
    return { ok: true, redirectUrl: request.redirectUrl ?? undefined };
  } catch (e) {
    const msg = errorText(e);
    const hint = /auth config|managed/i.test(msg)
      ? `${msg} - this app has no Composio-managed login; create an auth config for it at platform.composio.dev first.`
      : msg;
    return { ok: false, error: hint };
  }
}

/** Browser sign-in to Composio Connect - no key needed. The panel refreshes when it finishes. */
export async function signIn(): Promise<{ ok: boolean; error?: string; status?: AppsStatus }> {
  const r = await composioAuth.signIn(connect.oauthConnect);
  if (!r.ok) return r;
  connect.resetConnect();
  lastStatus = null;
  const status = await appsStatus();
  emit('apps:changed', status);
  return { ok: status.ok, error: status.ok ? undefined : status.hint ?? status.error, status };
}

export async function signOut(): Promise<AppsStatus> {
  composioAuth.signOut();
  connect.resetConnect();
  lastStatus = null;
  const status = await appsStatus();
  emit('apps:changed', status);
  return status;
}

export async function disconnectApp(slug: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const status = await appsStatus();
    const app = status.apps.find((a) => a.slug === slug);
    if (!app?.accountIds.length) return { ok: true };
    if (status.mode === 'connect') {
      await connect.removeConnection(connectAuth()!, slug, app.accountIds);
    } else {
      const c = await client();
      for (const id of app.accountIds) await c.connectedAccounts.delete(id);
    }
    emit('apps:changed', await appsStatus());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/* ── For the Hermes agent ───────────────────────────────────────────── */

export interface ActionSummary {
  slug: string;
  app: string;
  description: string;
  params: Record<string, string>;
  required: string[];
}

function describeParam(p: unknown): string {
  const prop = (p ?? {}) as { type?: unknown; description?: string; enum?: unknown[]; default?: unknown };
  const type = Array.isArray(prop.type) ? prop.type.join('|') : String(prop.type ?? 'any');
  const bits = [type];
  if (prop.enum?.length) bits.push(`one of ${prop.enum.slice(0, 8).join('/')}`);
  if (prop.description) bits.push(prop.description.replace(/\s+/g, ' ').slice(0, 160));
  return bits.join(' - ');
}

export interface FoundActions {
  actions: ActionSummary[];
  /** Composio Connect's recommended steps and known pitfalls for this kind of job. */
  plan?: string[];
  pitfalls?: string[];
  notConnected?: string[];
}

function summarize(slug: string, app: string, description: string, schema?: { properties?: Record<string, unknown>; required?: string[] }): ActionSummary {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(schema?.properties ?? {}).slice(0, 14)) params[k] = describeParam(v);
  return { slug, app, description: description.replace(/\s+/g, ' ').slice(0, 300), params, required: schema?.required ?? [] };
}

export async function findActions(query: string, app?: string, limit = 6): Promise<FoundActions> {
  const auth = connectAuth();
  if (auth) {
    try {
      const found = await connect.searchTools(auth, app ? `${query} using ${app}` : query);
      return {
        actions: found.tools.slice(0, Math.min(limit, 10)).map((t) => summarize(t.slug, t.app, t.description, t.schema)),
        plan: found.plan.length ? found.plan : undefined,
        pitfalls: found.pitfalls.length ? found.pitfalls : undefined,
        notConnected: found.notConnected.length ? found.notConnected : undefined,
      };
    } catch (e) {
      throw new Error(errorText(e));
    }
  }
  const c = await client();
  const connected = (await connectedApps()).map((a) => a.slug);
  const toolkits = app ? [app.toLowerCase()] : connected;
  if (!toolkits.length) throw new Error('No apps are connected yet - connect one in the Apps panel first.');
  const tools = await c.tools.getRawComposioTools({ toolkits, search: query, limit: Math.min(limit, 10) });
  return {
    actions: tools.map((t) => summarize(
      t.slug,
      (t as { toolkit?: { slug?: string } }).toolkit?.slug ?? toolkits[0],
      t.description ?? t.name ?? '',
      (t.inputParameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] },
    )),
  };
}

const READ_VERBS = /(^|_)(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|CHECK|QUERY|DESCRIBE|EXPORT|DOWNLOAD|LOOKUP|COUNT|BATCH_GET|PLAY|PAUSE|SKIP|RESUME|NEXT|PREVIOUS|SEEK|SET_VOLUME|TOGGLE_SHUFFLE|SET_REPEAT)(_|$)/;

/** Anything that isn't clearly a read (or music playback control) needs the operator's approval. */
export function isWriteAction(slug: string): boolean {
  const upper = slug.toUpperCase();
  const verbPart = upper.replace(/^[A-Z0-9]+?_/, '');
  return !READ_VERBS.test(verbPart);
}

export async function runAction(slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const auth = connectAuth();
  if (auth) {
    try {
      return await connect.execute(auth, slug, args);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }
  const c = await client();
  try {
    const res = await c.tools.execute(slug, {
      userId: userId(),
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    return res.successful ? { ok: true, data: res.data } : { ok: false, error: res.error ?? 'The action failed.', data: res.data };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

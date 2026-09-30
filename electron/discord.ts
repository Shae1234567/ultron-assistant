import { getSecret } from './secrets';

/**
 * The operator's OWN Discord bot, driven straight through Discord's API.
 *
 * Why not Composio's "Discord Bot": that is one bot shared by every Composio
 * user. Listing its servers from the operator's own Composio account returned
 * 200+ servers that aren't the operator's (27 Sep 2026) - so whatever it is allowed to do
 * in the operator's server, any Composio user could do too. A private bot whose token
 * only this PC holds keeps the server theirs.
 *
 * Setup (the Apps panel walks through it): Discord Developer Portal -> New
 * Application -> Bot -> turn on Server Members + Message Content intents ->
 * Reset Token -> paste it in Apps -> "Add bot to a server".
 */

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 12_000;

/** Composio's shared bot - flagged when it still sits in one of the operator's servers. */
export const SHARED_COMPOSIO_BOT = '1501160137694642207';

export const NOT_SET_UP = 'Ultron\'s own Discord bot is not set up yet. The operator sets it up once in Apps -> "Discord - your own bot" (a free bot from the Discord Developer Portal, made with a parent because Discord\'s developer terms need one under 18). Composio\'s ready-made Discord bot is shared with every Composio user, so Ultron does not manage servers through it.';

/* Discord permission bits (https://discord.com/developers/docs/topics/permissions). */
export const PERMISSIONS = {
  create_invite: 1n << 0n,
  kick_members: 1n << 1n,
  ban_members: 1n << 2n,
  administrator: 1n << 3n,
  manage_channels: 1n << 4n,
  manage_server: 1n << 5n,
  add_reactions: 1n << 6n,
  view_audit_log: 1n << 7n,
  priority_speaker: 1n << 8n,
  stream: 1n << 9n,
  view_channel: 1n << 10n,
  send_messages: 1n << 11n,
  send_tts_messages: 1n << 12n,
  manage_messages: 1n << 13n,
  embed_links: 1n << 14n,
  attach_files: 1n << 15n,
  read_message_history: 1n << 16n,
  mention_everyone: 1n << 17n,
  use_external_emojis: 1n << 18n,
  connect: 1n << 20n,
  speak: 1n << 21n,
  mute_members: 1n << 22n,
  deafen_members: 1n << 23n,
  move_members: 1n << 24n,
  use_voice_activity: 1n << 25n,
  change_nickname: 1n << 26n,
  manage_nicknames: 1n << 27n,
  manage_roles: 1n << 28n,
  manage_webhooks: 1n << 29n,
  manage_expressions: 1n << 30n,
  use_application_commands: 1n << 31n,
  manage_events: 1n << 33n,
  manage_threads: 1n << 34n,
  create_public_threads: 1n << 35n,
  create_private_threads: 1n << 36n,
  send_messages_in_threads: 1n << 38n,
  moderate_members: 1n << 40n,
} as const;
export type PermissionName = keyof typeof PERMISSIONS;

const ALIASES: Record<string, PermissionName> = {
  admin: 'administrator',
  manage_guild: 'manage_server',
  manage_emojis: 'manage_expressions',
  manage_emojis_and_stickers: 'manage_expressions',
  timeout_members: 'moderate_members',
  read_messages: 'view_channel',
  view_channels: 'view_channel',
  see_channel: 'view_channel',
  create_instant_invite: 'create_invite',
  read_history: 'read_message_history',
  mention_everyone_here_and_all_roles: 'mention_everyone',
  send_messages_and_create_posts: 'send_messages',
};

/** What the bot asks for when it is added to a server: everything a server manager needs, never Administrator. */
const BOT_NEEDS: PermissionName[] = [
  'create_invite', 'kick_members', 'ban_members', 'manage_channels', 'manage_server', 'add_reactions', 'view_audit_log',
  'view_channel', 'send_messages', 'manage_messages', 'embed_links', 'attach_files', 'read_message_history',
  'manage_nicknames', 'manage_roles', 'manage_events', 'manage_threads', 'create_public_threads', 'send_messages_in_threads',
  'moderate_members',
];
export const BOT_PERMISSIONS = BOT_NEEDS.reduce((sum, p) => sum | PERMISSIONS[p], 0n);

export const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 } as const;
export type ChannelKind = keyof typeof CHANNEL_TYPES;
export const TYPE_NAME: Record<number, string> = Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));
/**
 * Channels that hold messages. Voice and stage channels have their own text chat ("Text in Voice") - leaving them
 * out made posting in a voice channel fail, and the model then told the operator voice channels have no chat (30 Sep 2026).
 */
export const MESSAGE_TYPES = new Set([0, 2, 5, 13]);

export interface User { id: string; username: string; global_name?: string | null; bot?: boolean }
export interface Guild {
  id: string; name: string; owner_id?: string; description?: string | null; verification_level?: number;
  system_channel_id?: string | null; approximate_member_count?: number; approximate_presence_count?: number;
  default_message_notifications?: number; explicit_content_filter?: number;
}
export interface Overwrite { id: string; type: number; allow: string; deny: string }
export interface Channel {
  id: string; name: string; type: number; parent_id?: string | null; position: number; topic?: string | null;
  nsfw?: boolean; rate_limit_per_user?: number; permission_overwrites?: Overwrite[];
}
export interface Role { id: string; name: string; color: number; position: number; permissions: string; managed: boolean; hoist: boolean; mentionable: boolean }
export interface Member { user: User; nick?: string | null; roles: string[]; communication_disabled_until?: string | null }
export interface Message { id: string; author: User; content: string; timestamp: string; embeds?: unknown[]; attachments?: { filename: string }[] }

export class DiscordError extends Error {
  constructor(message: string, readonly status = 0, readonly code = 0) {
    super(message);
  }
}

function token(): string {
  return getSecret('DISCORD_BOT_TOKEN');
}

export function hasToken(): boolean {
  return Boolean(token());
}

/** A bot token starts with the bot's user id in base64 - which is also its application id (for the invite link). */
export function appIdFromToken(t: string): string | null {
  const first = t.split('.')[0] ?? '';
  const id = Buffer.from(first, 'base64').toString('utf8');
  return /^\d{17,20}$/.test(id) ? id : null;
}

export function inviteUrl(appId: string, guildId?: string): string {
  const q = new URLSearchParams({ client_id: appId, scope: 'bot', permissions: BOT_PERMISSIONS.toString() });
  if (guildId) q.set('guild_id', guildId);
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

interface ErrorBody { message?: string; code?: number; errors?: unknown; retry_after?: number }

/** Discord's error, in words the operator can act on. */
export function explain(status: number, body: ErrorBody | null, path: string): string {
  const code = body?.code ?? 0;
  if (status === 401) return 'Discord rejected the bot token. Make a new one (Developer Portal -> Bot -> Reset Token) and paste it in Apps -> Discord.';
  if (code === 50013) return 'Missing Permissions: the Ultron bot may not do that in this server. Either its role lacks that permission, or what it is changing sits above the bot\'s own role - in Discord, Server Settings -> Roles, drag the Ultron role higher.';
  if (code === 50001) {
    return /\/members(\?|$)/.test(path)
      ? 'Missing Access: turn on "Server Members Intent" for the bot (Developer Portal -> Bot -> Privileged Gateway Intents), then try again.'
      : 'Missing Access: the Ultron bot cannot see that channel.';
  }
  if (code === 10004) return 'The Ultron bot is not in that server - add it from Apps -> Discord ("Add bot to a server").';
  if (code === 10003) return 'That channel no longer exists.';
  if (code === 10011) return 'That role no longer exists.';
  if (code === 10007 || code === 10013) return 'That member is not in the server.';
  if (code === 50034) return 'Discord only bulk-deletes messages younger than 14 days.';
  const detail = body?.errors ? ` ${JSON.stringify(body.errors).slice(0, 300)}` : '';
  return `Discord said: ${body?.message ?? `HTTP ${status}`}${detail}`;
}

/**
 * Rate limits. Building a whole server (roles, categories, a dozen channels, a post in each) hit Discord's limits
 * three runs in a row, and each time the operator had to say "finish it" (30 Sep 2026). So: when Discord says a
 * route has no requests left, the next request waits for its reset; a 429 is waited out and retried (up to four
 * times, each wait at most 30 s) instead of failing the step.
 */
const MAX_WAIT_S = 30;
const MAX_TRIES = 4;
const buckets = new Map<string, number>(); // route -> time it may be used again
let globalUntil = 0;

/** The route Discord counts a request against: the path with its major id kept and other ids blanked. */
export function routeKey(method: string, path: string): string {
  const major = /^\/(channels|guilds|webhooks)\/(\d+)/.exec(path);
  const rest = path.replace(/\/\d{5,}/g, '/:id').replace(/\?.*$/, '');
  return `${method} ${major ? `${major[1]}/${major[2]}` : ''} ${rest}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A long post as Discord-sized messages (2000 characters each), cut at a blank line, else a line break, else a
 * sentence, else a space - never mid-word unless a single word is longer than a message. (A server's rules
 * failed to post at 2000+ characters and were redone by hand, 30 Sep 2026.)
 */
export function splitMessage(text: string, max = 2000): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.search(/[.!?](?=\s)(?![\s\S]*[.!?]\s)/), window.lastIndexOf(' ')]
      .map((i, n) => (i > max * 0.3 ? i + (n === 2 ? 1 : 0) : -1))
      .find((i) => i > 0) ?? max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, reason?: string): Promise<T> {
  const t = token();
  if (!t) throw new DiscordError(NOT_SET_UP);
  const route = routeKey(method, path);
  for (let attempt = 0; ; attempt++) {
    const until = Math.max(globalUntil, buckets.get(route) ?? 0);
    if (until > Date.now()) await sleep(until - Date.now());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bot ${t}`,
          'User-Agent': 'DiscordBot (https://discord.com/developers, 2.0) Ultron',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          // Shows in the server's audit log next to every change the bot makes.
          ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason.slice(0, 400)) } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new DiscordError(ctrl.signal.aborted ? 'Discord did not answer in time.' : `Could not reach Discord: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    // Out of requests on this route: the next one waits for the reset.
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const after = Number(res.headers.get('x-ratelimit-reset-after') ?? 0);
      if (after > 0) buckets.set(route, Date.now() + Math.min(after, MAX_WAIT_S) * 1000 + 100);
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as (T & ErrorBody & { global?: boolean }) | null;
    if (res.ok) return data as T;
    if (res.status === 429) {
      const wait = Number(data?.retry_after ?? res.headers.get('retry-after') ?? 1);
      if (attempt < MAX_TRIES - 1 && wait <= MAX_WAIT_S) {
        const until2 = Date.now() + wait * 1000 + 250;
        if (data?.global) globalUntil = until2;
        else buckets.set(route, until2);
        continue;
      }
      throw new DiscordError(`Discord's rate limit: it asks the bot to wait ${Math.ceil(wait)} s before doing more of this. Try the rest again after that - everything done so far is kept.`, 429, 0);
    }
    throw new DiscordError(explain(res.status, data, path), res.status, data?.code ?? 0);
  }
}

/* ── Finding things by the names people use ─────────────────────────── */

/** "#💬│general", "General" and "general" are the same channel; "alexs server" is "alex's server". */
export function simplify(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The one item a name (or id, or <#mention>) means. Exact names win, then
 * names equal once punctuation is gone, then a unique partial match. Anything
 * ambiguous or missing is an error that lists what does exist.
 */
export function pick<T>(items: T[], wanted: string, what: string, namesOf: (t: T) => string[], idOf: (t: T) => string): T {
  const raw = wanted.trim();
  const id = raw.replace(/[<#@&!>]/g, '');
  const byId = items.find((i) => idOf(i) === id);
  if (byId) return byId;
  const plain = raw.replace(/^[#@]/, '').toLowerCase();
  const exact = items.filter((i) => namesOf(i).some((n) => n.toLowerCase() === plain));
  if (exact.length === 1) return exact[0];
  const key = simplify(raw);
  const same = key ? items.filter((i) => namesOf(i).some((n) => simplify(n) === key)) : [];
  if (same.length === 1) return same[0];
  const partial = same.length ? same : key
    ? items.filter((i) => namesOf(i).some((n) => {
      const s = simplify(n);
      return Boolean(s) && (s.includes(key) || (s.length >= 4 && key.includes(s)));
    }))
    : [];
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : items).slice(0, 30).map((i) => namesOf(i)[0]);
  throw new DiscordError(partial.length
    ? `More than one ${what} matches "${wanted}": ${names.join(', ')}. Say which one.`
    : `No ${what} called "${wanted}". There is: ${names.join(', ') || 'none'}.`);
}

export function memberName(m: Member): string {
  return m.nick || m.user.global_name || m.user.username;
}

const memberNames = (m: Member) => [memberName(m), m.user.username, m.user.global_name ?? '', m.nick ?? ''].filter(Boolean);

/* ── Permissions, colours ───────────────────────────────────────────── */

/** "Manage Messages", "kick members", "admin" -> permission bits; unknown names come back so they can be reported. */
export function permissionBits(names: string[]): { bits: bigint; unknown: string[] } {
  let bits = 0n;
  const unknown: string[] = [];
  for (const raw of names) {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');
    const name = (key in PERMISSIONS ? key : ALIASES[key]) as PermissionName | undefined;
    if (name) bits |= PERMISSIONS[name];
    else if (key) unknown.push(raw);
  }
  return { bits, unknown };
}

export function permissionNames(bits: bigint): PermissionName[] {
  if (bits & PERMISSIONS.administrator) return ['administrator'];
  return (Object.keys(PERMISSIONS) as PermissionName[]).filter((n) => (bits & PERMISSIONS[n]) !== 0n);
}

const COLORS: Record<string, number> = {
  none: 0, default: 0, red: 0xe74c3c, orange: 0xe67e22, yellow: 0xf1c40f, gold: 0xf1c40f, green: 0x2ecc71, lime: 0x7bed9f,
  teal: 0x1abc9c, cyan: 0x00d9ff, blue: 0x3498db, navy: 0x2c3e50, purple: 0x9b59b6, pink: 0xe91e63, magenta: 0xff00ff,
  white: 0xffffff, black: 0x010101, grey: 0x95a5a6, gray: 0x95a5a6, brown: 0x8b5a2b,
};

/** "#ff0000", "ff0000", "0xff0000" or a colour name -> Discord's colour number (0 = no colour); null if unreadable. */
export function parseColor(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (s in COLORS) return COLORS[s];
  const hex = /^(?:#|0x)?([0-9a-f]{6})$/.exec(s);
  return hex ? parseInt(hex[1], 16) : null;
}

export function colorHex(n: number): string {
  return n ? `#${n.toString(16).padStart(6, '0')}` : 'none';
}

/**
 * A channel's permission overwrites with it made private (only the bot, the
 * owner and the given roles can see it) or public again. The bot keeps its
 * own view, or it could not manage the channel afterwards.
 */
export function withPrivacy(existing: Overwrite[], guildId: string, botId: string, roleIds: string[], makePrivate: boolean | null): Overwrite[] {
  const view = PERMISSIONS.view_channel;
  const map = new Map(existing.map((o) => [o.id, { ...o }]));
  const get = (id: string, type: number) => {
    let o = map.get(id);
    if (!o) {
      o = { id, type, allow: '0', deny: '0' };
      map.set(id, o);
    }
    return o;
  };
  if (makePrivate !== null) {
    const everyone = get(guildId, 0);
    if (makePrivate) {
      everyone.deny = (BigInt(everyone.deny) | view).toString();
      everyone.allow = (BigInt(everyone.allow) & ~view).toString();
      const bot = get(botId, 1);
      bot.allow = (BigInt(bot.allow) | view | PERMISSIONS.send_messages | PERMISSIONS.read_message_history).toString();
    } else {
      everyone.deny = (BigInt(everyone.deny) & ~view).toString();
    }
  }
  for (const id of roleIds) {
    const r = get(id, 0);
    r.allow = (BigInt(r.allow) | view).toString();
    r.deny = (BigInt(r.deny) & ~view).toString();
  }
  return [...map.values()].filter((o) => o.allow !== '0' || o.deny !== '0');
}

export function isPrivate(c: Channel, guildId: string): boolean {
  const o = c.permission_overwrites?.find((x) => x.id === guildId);
  return Boolean(o && (BigInt(o.deny) & PERMISSIONS.view_channel));
}

/* ── Reading the server ─────────────────────────────────────────────── */

let meCache: { token: string; user: User } | null = null;

export async function me(): Promise<User> {
  const t = token();
  if (meCache?.token === t) return meCache.user;
  const user = await api<User>('GET', '/users/@me');
  meCache = { token: t, user };
  return user;
}

export function servers(): Promise<Guild[]> {
  return api<Guild[]>('GET', '/users/@me/guilds?limit=200');
}

const GENERIC_SERVER = /^\s*(my|the|our)?\s*(own\s+)?(discord\s*)?(server|guild)?\s*$/i;

/** The server a request means. With the bot in just one server, "my server" (or nothing) means that one. */
export async function server(wanted?: string): Promise<Guild> {
  const all = await servers();
  if (!all.length) throw new DiscordError('The Ultron bot is not in any server yet - add it from Apps -> Discord ("Add bot to a server").');
  const w = (wanted ?? '').trim();
  if (all.length === 1 && GENERIC_SERVER.test(w)) return all[0];
  if (!w) throw new DiscordError(`Which server? The bot is in: ${all.map((g) => g.name).join(', ')}.`);
  return pick(all, w, 'server the Ultron bot is in', (g) => [g.name], (g) => g.id);
}

export function channels(guildId: string): Promise<Channel[]> {
  return api<Channel[]>('GET', `/guilds/${guildId}/channels`);
}

export function roles(guildId: string): Promise<Role[]> {
  return api<Role[]>('GET', `/guilds/${guildId}/roles`);
}

export function pickChannel(all: Channel[], wanted: string, kinds?: Set<number>): Channel {
  const pool = kinds ? all.filter((c) => kinds.has(c.type)) : all;
  return pick(pool, wanted, kinds?.size === 1 && kinds.has(4) ? 'category' : 'channel', (c) => [c.name], (c) => c.id);
}

export function pickRole(all: Role[], wanted: string, guildId: string): Role {
  return pick(all, wanted, 'role', (r) => (r.id === guildId ? ['@everyone', 'everyone'] : [r.name]), (r) => r.id);
}

/** A member by @mention, id, username, display name or nickname. */
export async function findMember(guildId: string, wanted: string): Promise<Member> {
  const id = wanted.replace(/[<@!>]/g, '').trim();
  if (/^\d{17,20}$/.test(id)) return api<Member>('GET', `/guilds/${guildId}/members/${id}`);
  const q = wanted.replace(/^@/, '').trim();
  const found = await api<Member[]>('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(q.slice(0, 32))}&limit=25`);
  if (found.length) return pick(found, q, 'member', memberNames, (m) => m.user.id);
  // Search only matches the start of a name - fall back to the whole list (needs the Server Members intent).
  const everyone = await api<Member[]>('GET', `/guilds/${guildId}/members?limit=1000`);
  return pick(everyone, q, 'member', memberNames, (m) => m.user.id);
}

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

/** For the Apps panel: is the token good, where is the bot, and is Composio's shared bot still hanging around? */
export async function status(): Promise<DiscordStatus> {
  const t = token();
  if (!t) return { configured: false };
  const appId = appIdFromToken(t);
  try {
    const bot = await me();
    const guilds = await servers();
    const sharedBotIn: string[] = [];
    for (const g of guilds.slice(0, 8)) {
      const there = await api('GET', `/guilds/${g.id}/members/${SHARED_COMPOSIO_BOT}`).then(() => true, () => false);
      if (there) sharedBotIn.push(g.name);
    }
    return { configured: true, ok: true, bot: bot.username, servers: guilds.map((g) => ({ id: g.id, name: g.name })), inviteUrl: inviteUrl(bot.id), sharedBotIn };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e), inviteUrl: appId ? inviteUrl(appId) : undefined };
  }
}

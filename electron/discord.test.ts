import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A made-up token whose first part is base64 for the bot id 1234567890123456789, like a real one.
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBcDe.not-a-real-token';
let token = TOKEN;
vi.mock('./secrets', () => ({ getSecret: () => token }));

const dc = await import('./discord');
const { discordTools } = await import('./brain/tools/discord');
const tool = (name: string) => discordTools.find((t) => t.name === name)!;

describe('the bot token', () => {
  it('carries the bot\'s id, which the invite link needs', () => {
    expect(dc.appIdFromToken(TOKEN)).toBe('1234567890123456789');
    expect(dc.appIdFromToken('not a token')).toBeNull();
  });

  it('invites the bot with management permissions but never Administrator', () => {
    const url = new URL(dc.inviteUrl('1234567890123456789', '42'));
    const perms = BigInt(url.searchParams.get('permissions')!);
    expect(url.searchParams.get('scope')).toBe('bot');
    expect(url.searchParams.get('guild_id')).toBe('42');
    expect(perms & dc.PERMISSIONS.administrator).toBe(0n);
    for (const p of ['manage_channels', 'manage_roles', 'manage_server', 'manage_messages', 'kick_members', 'moderate_members'] as const) {
      expect(perms & dc.PERMISSIONS[p], p).not.toBe(0n);
    }
  });
});

describe('finding things by name', () => {
  const servers = [{ id: '1', name: "alex's server" }, { id: '2', name: 'the goats server' }, { id: '3', name: 'Private Hangouts' }];
  const pickServer = (w: string) => dc.pick(servers, w, 'server', (s) => [s.name], (s) => s.id).name;

  it('matches the way people type names', () => {
    expect(pickServer('alexs server')).toBe("alex's server");
    expect(pickServer("Alex's Server")).toBe("alex's server");
    expect(pickServer('goats')).toBe('the goats server');
    expect(pickServer('3')).toBe('Private Hangouts');
  });

  it('says what exists instead of guessing', () => {
    expect(() => pickServer('minecraft')).toThrow(/No server called "minecraft"\. There is: alex's server, the goats server/);
    expect(() => pickServer('server')).toThrow(/More than one server/);
  });

  it('ignores channel decorations', () => {
    const chans = [{ id: 'a', name: '💬│general' }, { id: 'b', name: 'memes' }];
    expect(dc.pick(chans, '#general', 'channel', (c) => [c.name], (c) => c.id).id).toBe('a');
    expect(dc.pick(chans, '<#b>', 'channel', (c) => [c.name], (c) => c.id).id).toBe('b');
  });
});

describe('long messages and rate limits', () => {
  it('cuts a long post at paragraph, line or sentence ends - never mid-word', () => {
    const para = 'The server is for Minecraft and friends. Keep it kind. '.repeat(20).trim();
    const parts = dc.splitMessage([para, para, para].join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 2000 && !/^\s|\s$/.test(p))).toBe(true);
    expect(parts[0].endsWith('.')).toBe(true);
    expect(dc.splitMessage('short')).toEqual(['short']);
  });

  it('counts requests per route the way Discord does', () => {
    expect(dc.routeKey('POST', '/guilds/111111111111111111/channels')).toBe(dc.routeKey('POST', '/guilds/111111111111111111/channels'));
    expect(dc.routeKey('POST', '/channels/222222222222222222/messages')).not.toBe(dc.routeKey('POST', '/channels/333333333333333333/messages'));
    expect(dc.routeKey('PUT', '/guilds/1111111111/members/4444444444/roles/5555555555')).toBe(dc.routeKey('PUT', '/guilds/1111111111/members/6666666666/roles/7777777777'));
  });
});

describe('permissions and colours', () => {
  it('reads permission names the way people say them', () => {
    const { bits, unknown } = dc.permissionBits(['Kick Members', 'manage-messages', 'timeout members', 'fly']);
    expect(bits).toBe(dc.PERMISSIONS.kick_members | dc.PERMISSIONS.manage_messages | dc.PERMISSIONS.moderate_members);
    expect(unknown).toEqual(['fly']);
    expect(dc.permissionNames(dc.PERMISSIONS.administrator | dc.PERMISSIONS.kick_members)).toEqual(['administrator']);
  });

  it('reads colours', () => {
    expect(dc.parseColor('#ff0000')).toBe(0xff0000);
    expect(dc.parseColor('00FF00')).toBe(0x00ff00);
    expect(dc.parseColor('purple')).toBe(0x9b59b6);
    expect(dc.parseColor('none')).toBe(0);
    expect(dc.parseColor('sort of blue')).toBeNull();
  });

  it('makes a channel private without locking the bot out, and public again', () => {
    const view = dc.PERMISSIONS.view_channel;
    const priv = dc.withPrivacy([], 'G', 'BOT', ['R'], true);
    expect(BigInt(priv.find((o) => o.id === 'G')!.deny) & view).toBe(view);
    expect(BigInt(priv.find((o) => o.id === 'BOT')!.allow) & view).toBe(view);
    expect(BigInt(priv.find((o) => o.id === 'R')!.allow) & view).toBe(view);
    const pub = dc.withPrivacy(priv, 'G', 'BOT', [], false);
    expect(pub.find((o) => o.id === 'G')).toBeUndefined();
  });
});

describe('the discord tools', () => {
  type Call = { method: string; path: string; body?: Record<string, unknown> };
  let calls: Call[];
  let fail: { path: string; status: number; body: unknown; times?: number } | null;
  const ROUTES: Record<string, unknown> = {
    'GET /users/@me/guilds?limit=200': [{ id: 'G1', name: "alex's server" }],
    'GET /users/@me': { id: 'BOT', username: 'Ultron' },
    'GET /guilds/G1?with_counts=true': { id: 'G1', name: "alex's server", owner_id: 'OWNER', approximate_member_count: 3 },
    'GET /guilds/G1/channels': [
      { id: 'CAT', name: 'Text Channels', type: 4, position: 0 },
      { id: 'GEN', name: 'general', type: 0, parent_id: 'CAT', position: 0 },
      { id: 'VC', name: '🔊 ⛏️ Main Mine', type: 2, parent_id: 'CAT', position: 1 },
    ],
    'GET /guilds/G1/roles': [
      { id: 'G1', name: '@everyone', color: 0, position: 0, permissions: '1024', managed: false, hoist: false, mentionable: false },
      { id: 'MODS', name: 'Mods', color: 0, position: 1, permissions: '0', managed: false, hoist: false, mentionable: false },
    ],
  };

  beforeEach(() => {
    token = TOKEN;
    calls = [];
    fail = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('https://discord.com/api/v10', '');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ method, path, body });
      if (fail && fail.path === path && (fail.times ?? 1) > 0) {
        fail.times = (fail.times ?? 1) - 1;
        return new Response(JSON.stringify(fail.body), { status: fail.status });
      }
      if (method === 'POST' && path === '/guilds/G1/channels') return new Response(JSON.stringify({ id: 'NEW', ...body }), { status: 201 });
      if (method === 'POST' && /^\/channels\/\w+\/messages$/.test(path)) return new Response(JSON.stringify({ id: `M${calls.length}` }), { status: 200 });
      const hit = ROUTES[`${method} ${path}`];
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response('{"message":"404: Not Found","code":0}', { status: 404 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const ctx = (approve: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      ctx: { approve: async (_kind: string, title: string) => { asked.push(title); return approve; } } as never,
    };
  };

  it('creates a private channel in a category, by names, after the operator approves', async () => {
    const { asked, ctx: c } = ctx(true);
    const out = await tool('discord_channel').run({ action: 'create', server: 'alexs server', name: 'mods-only', category: 'text channels', private: true, visible_to_roles: ['mods'] }, c);
    expect(out).toMatchObject({ ok: true, created: '#mods-only', in_server: "alex's server" });
    expect(asked).toEqual(["Create text channel #mods-only in alex's server?"]);
    const post = calls.find((x) => x.method === 'POST')!;
    expect(post.body).toMatchObject({ name: 'mods-only', type: 0, parent_id: 'CAT' });
    const ow = post.body!.permission_overwrites as { id: string; allow: string; deny: string }[];
    expect(ow.map((o) => o.id).sort()).toEqual(['BOT', 'G1', 'MODS']);
  });

  it('changes nothing when the operator declines', async () => {
    const { ctx: c } = ctx(false);
    const out = await tool('discord_channel').run({ action: 'delete', channel: 'general' }, c);
    expect(out).toEqual({ error: 'The operator declined.' });
    expect(calls.some((x) => x.method !== 'GET')).toBe(false);
  });

  it('turns Discord\'s permission errors into something the operator can fix', async () => {
    fail = { path: '/guilds/G1/channels', status: 403, body: { message: 'Missing Permissions', code: 50013 } };
    const { ctx: c } = ctx(true);
    const out = await tool('discord_server_info').run({}, c) as { error: string };
    expect(out.error).toMatch(/Missing Permissions.*drag the Ultron role higher/);
  });

  it('waits out Discord\'s rate limit instead of failing the step (a server build hit it three runs in a row)', async () => {
    fail = { path: '/guilds/G1/channels', status: 429, body: { message: 'You are being rate limited.', retry_after: 0.05, global: false }, times: 2 };
    const out = await tool('discord_server_info').run({}, ctx(true).ctx) as { error?: string };
    expect(out.error).toBeUndefined();
    expect(calls.filter((x) => x.path === '/guilds/G1/channels')).toHaveLength(3);
  });

  it('says plainly when Discord wants a long wait, and that the work so far is kept', async () => {
    fail = { path: '/guilds/G1/channels', status: 429, body: { message: 'You are being rate limited.', retry_after: 120 }, times: 5 };
    const out = await tool('discord_server_info').run({}, ctx(true).ctx) as { error: string };
    expect(out.error).toMatch(/rate limit.*120 s.*everything done so far is kept/);
  });

  it('posts in a voice channel\'s chat, and splits a long post into Discord-sized messages - asking once', async () => {
    const { asked, ctx: c } = ctx(true);
    const rules = Array.from({ length: 12 }, (_, i) => `Rule ${i + 1}: ${'Be kind to everyone in the server and keep it fun. '.repeat(4).trim()}`).join('\n\n');
    const out = await tool('discord_send_message').run({ channel: 'main mine', text: rules }, c);
    expect(out).toMatchObject({ ok: true, posted_in: '#🔊 ⛏️ Main Mine', messages: 2 });
    expect(asked).toEqual(["Post in #🔊 ⛏️ Main Mine (alex's server) as your bot (2 messages - it is over Discord's 2000-character limit)?"]);
    const posts = calls.filter((x) => x.method === 'POST').map((x) => String(x.body!.content));
    expect(posts.every((p) => p.length <= 2000)).toBe(true);
    expect(posts.join('\n\n')).toBe(rules);
  });

  it('says how to set the bot up when there is no token', async () => {
    token = '';
    const out = await tool('discord_servers').run({}, ctx(true).ctx) as { error: string };
    expect(out.error).toMatch(/not set up yet.*Apps/);
    expect(calls).toHaveLength(0);
  });

  it('marks every tool that changes the server as a write', () => {
    const writes = discordTools.filter((t) => t.writes).map((t) => t.name).sort();
    expect(writes).toEqual(['discord_channel', 'discord_delete_messages', 'discord_invite', 'discord_moderate', 'discord_role', 'discord_send_message', 'discord_server_settings']);
  });
});

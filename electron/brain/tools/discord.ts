import * as dc from '../../discord';
import { A, B, N, S, bool, list, num, obj, str, type AgentTool } from './types';

/*
 * Managing the operator's own Discord server through their own bot. Every tool
 * takes names ("my server", "general", "Mods", "alex_42") - small models
 * garble 19-digit ids - and every change waits for the operator's Approve,
 * with the approval spelling out exactly what will happen.
 */

const SERVER = S('Server name. Optional when the bot is in just one server.');
const REASON = 'Ultron, approved by the server owner';
const DECLINED = { error: 'The operator declined.' };

async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  if (!dc.hasToken()) return { error: dc.NOT_SET_UP };
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const has = (args: Record<string, unknown>, key: string) => args[key] !== undefined && args[key] !== null && args[key] !== '';
const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

function channelLabel(c: { name: string; type: number }): string {
  if (c.type === 4) return `category "${c.name}"`;
  if (c.type === 2 || c.type === 13) return `voice channel "${c.name}"`;
  return `#${c.name}`;
}

function kindOf(args: Record<string, unknown>): dc.ChannelKind {
  const k = str(args, 'type', 'text').toLowerCase().replace(/\s*channel$/, '').trim();
  return (k in dc.CHANNEL_TYPES ? k : k === 'news' ? 'announcement' : 'text') as dc.ChannelKind;
}

function permsFrom(args: Record<string, unknown>, key: string): bigint | { error: string } {
  const { bits, unknown } = dc.permissionBits(list(args, key));
  if (unknown.length) return { error: `Unknown permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use names like: ${Object.keys(dc.PERMISSIONS).join(', ')}.` };
  return bits;
}

function describePerms(bits: bigint): string {
  const names = dc.permissionNames(bits);
  return names.includes('administrator') ? 'ADMINISTRATOR (full control of the server)' : names.join(', ') || 'none';
}

export const discordTools: AgentTool[] = [
  {
    name: 'discord_servers',
    owner: 'hermes',
    description: 'The Discord servers the operator\'s own Ultron bot is in - the servers Ultron can read and manage - plus the link to add the bot to another server.',
    parameters: obj({}),
    label: () => 'discord servers',
    run: async () => guarded(async () => {
      const bot = await dc.me();
      const guilds = await dc.servers();
      return {
        bot: bot.username,
        servers: guilds.map((g) => g.name),
        note: guilds.length ? undefined : 'The bot is in no server yet - the operator adds it from Apps -> Discord.',
        add_bot_to_another_server: dc.inviteUrl(bot.id),
      };
    }),
  },
  {
    name: 'discord_server_info',
    owner: 'hermes',
    description: 'Everything about one of the operator\'s Discord servers: member count, every channel grouped by category (with topics, which are private), every role with its colour and permissions, and the main settings.',
    parameters: obj({ server: SERVER }),
    label: (a) => `discord server info${str(a, 'server') ? ` (${str(a, 'server')})` : ''}`,
    run: async (args) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const [full, chans, roles] = await Promise.all([
        dc.api<dc.Guild>('GET', `/guilds/${g.id}?with_counts=true`),
        dc.channels(g.id),
        dc.roles(g.id),
      ]);
      const show = (c: dc.Channel) => `${dc.TYPE_NAME[c.type] ?? 'channel'} ${c.type === 2 || c.type === 13 ? c.name : `#${c.name}`}${c.topic ? ` - ${c.topic}` : ''}${dc.isPrivate(c, g.id) ? ' (private)' : ''}${c.rate_limit_per_user ? ` (slowmode ${c.rate_limit_per_user}s)` : ''}`;
      const categories = chans.filter((c) => c.type === 4).sort(byPosition);
      const loose = chans.filter((c) => c.type !== 4 && !c.parent_id).sort(byPosition).map(show);
      return {
        server: full.name,
        members: full.approximate_member_count,
        online: full.approximate_presence_count,
        verification_level: ['none', 'low', 'medium', 'high', 'highest'][full.verification_level ?? 0],
        welcome_channel: chans.find((c) => c.id === full.system_channel_id)?.name ?? 'none',
        channels: [
          ...(loose.length ? [{ category: '(no category)', channels: loose }] : []),
          ...categories.map((cat) => ({ category: cat.name, private: dc.isPrivate(cat, g.id) || undefined, channels: chans.filter((c) => c.parent_id === cat.id).sort(byPosition).map(show) })),
        ],
        roles: roles.filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position).map((r) => ({
          name: r.name,
          color: dc.colorHex(r.color),
          bot_role: r.managed || undefined,
          shown_separately: r.hoist || undefined,
          permissions: describePerms(BigInt(r.permissions)),
        })),
        everyone_permissions: describePerms(BigInt(roles.find((r) => r.id === g.id)?.permissions ?? '0')),
        note: 'Roles are listed highest first. The bot can only manage roles and members below its own role.',
      };
    }),
  },
  {
    name: 'discord_read_messages',
    owner: 'hermes',
    description: 'Recent messages in a channel of the operator\'s Discord server, oldest first.',
    parameters: obj({ server: SERVER, channel: S('Channel name, e.g. "general"'), limit: N('How many (default 20, max 50)') }, ['channel']),
    label: (a) => `read discord #${str(a, 'channel').replace(/^#/, '')}`,
    run: async (args) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const ch = dc.pickChannel(await dc.channels(g.id), str(args, 'channel'), dc.MESSAGE_TYPES);
      const limit = Math.max(1, Math.min(50, num(args, 'limit', 20)));
      const msgs = (await dc.api<dc.Message[]>('GET', `/channels/${ch.id}/messages?limit=${limit}`)).reverse();
      const hidden = msgs.some((m) => !m.author.bot) && msgs.filter((m) => !m.author.bot).every((m) => !m.content && !m.attachments?.length && !m.embeds?.length);
      return {
        channel: `#${ch.name}`,
        messages: msgs.map((m) => ({
          id: m.id,
          from: `${m.author.global_name || m.author.username}${m.author.bot ? ' (bot)' : ''}`,
          at: new Date(m.timestamp).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
          text: m.content || (m.attachments?.length ? `[attachment: ${m.attachments.map((x) => x.filename).join(', ')}]` : m.embeds?.length ? '[embed]' : ''),
        })),
        note: hidden ? 'Message text is hidden from the bot: the operator needs to turn on "Message Content Intent" (Developer Portal -> Bot -> Privileged Gateway Intents).' : undefined,
      };
    }),
  },
  {
    name: 'discord_members',
    owner: 'hermes',
    description: 'Members of the operator\'s Discord server with their roles - all of them, or those whose name starts with a search.',
    parameters: obj({ server: SERVER, search: S('Optional start of a username or nickname'), limit: N('Default 100') }),
    label: (a) => `discord members${str(a, 'search') ? `: ${str(a, 'search')}` : ''}`,
    run: async (args) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const limit = Math.max(1, Math.min(200, num(args, 'limit', 100)));
      const q = str(args, 'search').replace(/^@/, '').trim();
      const [members, roles] = await Promise.all([
        dc.api<dc.Member[]>('GET', q ? `/guilds/${g.id}/members/search?query=${encodeURIComponent(q.slice(0, 32))}&limit=${limit}` : `/guilds/${g.id}/members?limit=${limit}`),
        dc.roles(g.id),
      ]);
      const roleName = new Map(roles.map((r) => [r.id, r.name]));
      return {
        count: members.length,
        members: members.map((m) => ({
          name: dc.memberName(m),
          username: m.user.username,
          bot: m.user.bot || undefined,
          owner: m.user.id === g.owner_id || undefined,
          roles: m.roles.map((r) => roleName.get(r) ?? r),
          timed_out_until: m.communication_disabled_until && Date.parse(m.communication_disabled_until) > Date.now() ? m.communication_disabled_until : undefined,
        })),
      };
    }),
  },
  {
    name: 'discord_send_message',
    owner: 'hermes',
    description: 'Post a message in a channel of the operator\'s Discord server (text, announcement, or the chat of a voice or stage channel), as the Ultron bot. A long message is split into Discord-sized parts by itself. Asks the operator first.',
    parameters: obj({ server: SERVER, channel: S('Channel name'), text: S('The message - over 2000 characters is posted as several messages') }, ['channel', 'text']),
    label: (a) => `post in discord #${str(a, 'channel').replace(/^#/, '')}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const text = str(args, 'text').trim();
      if (!text) return { error: 'The message is empty.' };
      const parts = dc.splitMessage(text);
      if (parts.length > 8) return { error: `That is ${text.length} characters - ${parts.length} Discord messages. Keep one post under about 16,000 characters.` };
      const g = await dc.server(str(args, 'server'));
      const ch = dc.pickChannel(await dc.channels(g.id), str(args, 'channel'), dc.MESSAGE_TYPES);
      const many = parts.length > 1 ? ` (${parts.length} messages - it is over Discord's 2000-character limit)` : '';
      if (!(await ctx.approve('discord:send', `Post in #${ch.name} (${g.name}) as your bot${many}?`, text))) return DECLINED;
      const links: string[] = [];
      for (const part of parts) {
        // Never @everyone - the bot is not given that permission anyway.
        const m = await dc.api<dc.Message>('POST', `/channels/${ch.id}/messages`, { content: part, allowed_mentions: { parse: ['users', 'roles'] } });
        links.push(`https://discord.com/channels/${g.id}/${ch.id}/${m.id}`);
      }
      return { ok: true, posted_in: `#${ch.name}`, messages: parts.length, link: links[0] };
    }),
  },
  {
    name: 'discord_channel',
    owner: 'hermes',
    description: 'Create, edit or delete a channel or category in the operator\'s Discord server: name, type, category, topic, slowmode, age-restricted, private (only chosen roles can see it), order. Asks the operator first.',
    parameters: obj({
      action: S('create, edit or delete', { enum: ['create', 'edit', 'delete'] }),
      server: SERVER,
      channel: S('edit/delete: the existing channel or category name'),
      name: S('create: the new channel\'s name. edit: its new name'),
      type: S('create: text (default), voice, category, announcement, forum or stage', { enum: ['text', 'voice', 'category', 'announcement', 'forum', 'stage'] }),
      category: S('The category to put it in; "none" takes it out of its category'),
      topic: S('Channel topic / description'),
      slowmode_seconds: N('Seconds between messages per member, 0 to turn slowmode off'),
      age_restricted: B('Mark it age-restricted (NSFW)'),
      private: B('true: only the owner, the bot and visible_to_roles can see it. false: everyone can see it again'),
      visible_to_roles: A('Role names that can see it (for a private channel)'),
      position: N('Order within its category, 0 = top'),
    }, ['action']),
    label: (a) => `discord ${str(a, 'action')} channel ${str(a, 'name') || str(a, 'channel')}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const action = str(args, 'action');
      const g = await dc.server(str(args, 'server'));
      const [chans, roles, bot] = await Promise.all([dc.channels(g.id), dc.roles(g.id), dc.me()]);
      const roleIds = list(args, 'visible_to_roles').map((r) => dc.pickRole(roles, r, g.id).id);
      const privacy = has(args, 'private') ? bool(args, 'private') : null;

      if (action === 'create') {
        const name = str(args, 'name').trim();
        if (!name) return { error: 'Give the new channel a name.' };
        const kind = kindOf(args);
        const parent = kind !== 'category' && has(args, 'category') && str(args, 'category') !== 'none'
          ? dc.pickChannel(chans, str(args, 'category'), new Set([4])) : undefined;
        const body: Record<string, unknown> = { name, type: dc.CHANNEL_TYPES[kind] };
        if (parent) body.parent_id = parent.id;
        if (has(args, 'topic')) body.topic = str(args, 'topic');
        if (has(args, 'slowmode_seconds')) body.rate_limit_per_user = Math.max(0, Math.min(21600, num(args, 'slowmode_seconds', 0)));
        if (has(args, 'age_restricted')) body.nsfw = bool(args, 'age_restricted');
        if (has(args, 'position')) body.position = num(args, 'position', 0);
        if (privacy || roleIds.length) body.permission_overwrites = dc.withPrivacy([], g.id, bot.id, roleIds, privacy ?? true);
        const detail = [
          parent && `in category "${parent.name}"`,
          body.topic && `topic: ${String(body.topic)}`,
          body.permission_overwrites && `private - visible only to you${roleIds.length ? `, the bot and ${list(args, 'visible_to_roles').join(', ')}` : ' and the bot'}`,
          body.rate_limit_per_user !== undefined && `slowmode: ${String(body.rate_limit_per_user)}s`,
          body.nsfw && 'age-restricted',
        ].filter(Boolean).join('\n');
        if (!(await ctx.approve('discord:create', `Create ${kind} ${kind === 'category' ? `category "${name}"` : kind === 'voice' || kind === 'stage' ? `channel "${name}"` : `channel #${name}`} in ${g.name}?`, detail || '(default settings)'))) return DECLINED;
        const made = await dc.api<dc.Channel>('POST', `/guilds/${g.id}/channels`, body, REASON);
        return { ok: true, created: channelLabel(made), in_server: g.name, link: `https://discord.com/channels/${g.id}/${made.id}` };
      }

      if (!str(args, 'channel').trim()) return { error: 'Say which channel (its current name).' };
      const ch = dc.pickChannel(chans, str(args, 'channel'));

      if (action === 'delete') {
        const inside = chans.filter((c) => c.parent_id === ch.id).length;
        const title = `DELETE ${channelLabel(ch)} from ${g.name}?`;
        const detail = ch.type === 4
          ? `The category goes; its ${inside} channel${inside === 1 ? '' : 's'} stay and move out of it.`
          : 'The channel and every message in it are gone for good.';
        if (!(await ctx.approve('discord:delete', title, detail))) return DECLINED;
        await dc.api('DELETE', `/channels/${ch.id}`, undefined, REASON);
        return { ok: true, deleted: channelLabel(ch), from_server: g.name };
      }

      if (action !== 'edit') return { error: 'action must be create, edit or delete.' };
      const body: Record<string, unknown> = {};
      const changes: string[] = [];
      if (has(args, 'name') && str(args, 'name') !== ch.name) { body.name = str(args, 'name'); changes.push(`name: ${ch.name} -> ${str(args, 'name')}`); }
      if (has(args, 'topic')) { body.topic = str(args, 'topic'); changes.push(`topic: ${str(args, 'topic') || '(none)'}`); }
      if (has(args, 'category')) {
        const none = /^(none|no category|nothing)$/i.test(str(args, 'category'));
        const parent = none ? null : dc.pickChannel(chans, str(args, 'category'), new Set([4]));
        body.parent_id = parent ? parent.id : null;
        changes.push(parent ? `move into category "${parent.name}"` : 'take it out of its category');
      }
      if (has(args, 'slowmode_seconds')) { body.rate_limit_per_user = Math.max(0, Math.min(21600, num(args, 'slowmode_seconds', 0))); changes.push(`slowmode: ${String(body.rate_limit_per_user)}s`); }
      if (has(args, 'age_restricted')) { body.nsfw = bool(args, 'age_restricted'); changes.push(body.nsfw ? 'age-restricted' : 'not age-restricted'); }
      if (has(args, 'position')) { body.position = num(args, 'position', 0); changes.push(`position: ${String(body.position)}`); }
      if (privacy !== null || roleIds.length) {
        body.permission_overwrites = dc.withPrivacy(ch.permission_overwrites ?? [], g.id, bot.id, roleIds, privacy);
        changes.push(privacy === false ? 'make it visible to everyone' : `make it private${roleIds.length ? ` (visible to ${list(args, 'visible_to_roles').join(', ')})` : ''}`);
      }
      if (!changes.length) return { error: 'Nothing to change - give a new name, topic, category, slowmode, privacy or position.' };
      if (!(await ctx.approve('discord:edit', `Change ${channelLabel(ch)} in ${g.name}?`, changes.join('\n')))) return DECLINED;
      const after = await dc.api<dc.Channel>('PATCH', `/channels/${ch.id}`, body, REASON);
      return { ok: true, changed: channelLabel(after), changes };
    }),
  },
  {
    name: 'discord_role',
    owner: 'hermes',
    description: 'Create, edit or delete a role in the operator\'s Discord server, or give/take a role from a member. Roles have a name, colour, permissions, "shown separately" and "mentionable". Asks the operator first.',
    parameters: obj({
      action: S('create, edit, delete, give or take', { enum: ['create', 'edit', 'delete', 'give', 'take'] }),
      server: SERVER,
      role: S('edit/delete/give/take: the existing role name ("everyone" is the @everyone role)'),
      name: S('create: the role name. edit: its new name'),
      color: S('Colour: #ff0000, or a name like red, blue, gold, purple; "none" for no colour'),
      permissions: A('create only: the role\'s full permission list, e.g. ["kick_members","manage_messages"]'),
      add_permissions: A('edit: permissions to turn ON, e.g. ["manage_messages"]'),
      remove_permissions: A('edit: permissions to turn OFF'),
      shown_separately: B('Show members with this role separately in the member list'),
      mentionable: B('Anyone can @mention this role'),
      member: S('give/take: the member (username, display name or nickname)'),
    }, ['action']),
    label: (a) => `discord ${str(a, 'action')} role ${str(a, 'name') || str(a, 'role')}${str(a, 'member') ? ` (${str(a, 'member')})` : ''}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const action = str(args, 'action');
      const g = await dc.server(str(args, 'server'));
      const roles = await dc.roles(g.id);
      const body: Record<string, unknown> = {};
      const details: string[] = [];
      if (has(args, 'color')) {
        const c = dc.parseColor(str(args, 'color'));
        if (c === null) return { error: `Can't read the colour "${str(args, 'color')}" - use #rrggbb or a colour name.` };
        body.color = c;
        details.push(`colour: ${dc.colorHex(c)}`);
      }
      if (has(args, 'shown_separately')) { body.hoist = bool(args, 'shown_separately'); details.push(body.hoist ? 'shown separately' : 'not shown separately'); }
      if (has(args, 'mentionable')) { body.mentionable = bool(args, 'mentionable'); details.push(body.mentionable ? 'mentionable' : 'not mentionable'); }

      if (action === 'create') {
        const name = str(args, 'name').trim();
        if (!name) return { error: 'Give the new role a name.' };
        body.name = name;
        if (has(args, 'permissions') || has(args, 'add_permissions')) {
          const a = permsFrom(args, 'permissions');
          const b = permsFrom(args, 'add_permissions');
          if (typeof a !== 'bigint') return a;
          if (typeof b !== 'bigint') return b;
          body.permissions = (a | b).toString();
          details.push(`permissions: ${describePerms(a | b)}`);
        } else {
          details.push('permissions: same as @everyone');
        }
        if (!(await ctx.approve('discord:create', `Create role "${name}" in ${g.name}?`, details.join('\n')))) return DECLINED;
        const made = await dc.api<dc.Role>('POST', `/guilds/${g.id}/roles`, body, REASON);
        return { ok: true, created_role: made.name, color: dc.colorHex(made.color), permissions: describePerms(BigInt(made.permissions)) };
      }

      if (!str(args, 'role').trim()) return { error: 'Say which role (its current name).' };
      const role = dc.pickRole(roles, str(args, 'role'), g.id);
      const label = role.id === g.id ? '@everyone' : `"${role.name}"`;

      if (action === 'delete') {
        if (role.id === g.id) return { error: 'The @everyone role cannot be deleted.' };
        if (role.managed) return { error: `"${role.name}" belongs to a bot or integration - remove that bot instead.` };
        if (!(await ctx.approve('discord:delete', `DELETE role ${label} from ${g.name}?`, 'Everyone who has it loses it. This cannot be undone.'))) return DECLINED;
        await dc.api('DELETE', `/guilds/${g.id}/roles/${role.id}`, undefined, REASON);
        return { ok: true, deleted_role: role.name };
      }

      if (action === 'give' || action === 'take') {
        if (!str(args, 'member').trim()) return { error: 'Say which member.' };
        if (role.id === g.id || role.managed) return { error: `${label} cannot be given or taken by hand.` };
        const m = await dc.findMember(g.id, str(args, 'member'));
        const who = dc.memberName(m);
        const already = m.roles.includes(role.id);
        if (action === 'give' && already) return { ok: true, note: `${who} already has ${label}.` };
        if (action === 'take' && !already) return { ok: true, note: `${who} does not have ${label}.` };
        const title = action === 'give' ? `Give role ${label} to ${who}?` : `Take role ${label} away from ${who}?`;
        if (!(await ctx.approve('discord:edit', title, `in ${g.name}`))) return DECLINED;
        await dc.api(action === 'give' ? 'PUT' : 'DELETE', `/guilds/${g.id}/members/${m.user.id}/roles/${role.id}`, undefined, REASON);
        return { ok: true, [action === 'give' ? 'gave' : 'took']: role.name, member: who };
      }

      if (action !== 'edit') return { error: 'action must be create, edit, delete, give or take.' };
      if (has(args, 'name') && str(args, 'name') !== role.name && role.id !== g.id) { body.name = str(args, 'name'); details.unshift(`name: ${role.name} -> ${str(args, 'name')}`); }
      if (has(args, 'permissions') || has(args, 'add_permissions') || has(args, 'remove_permissions')) {
        const replace = has(args, 'permissions') ? permsFrom(args, 'permissions') : BigInt(role.permissions);
        const add = permsFrom(args, 'add_permissions');
        const remove = permsFrom(args, 'remove_permissions');
        for (const p of [replace, add, remove]) if (typeof p !== 'bigint') return p;
        const next = ((replace as bigint) | (add as bigint)) & ~(remove as bigint);
        body.permissions = next.toString();
        details.push(`permissions: ${describePerms(next)}`);
      }
      if (!Object.keys(body).length) return { error: 'Nothing to change - give a new name, colour, permissions, shown_separately or mentionable.' };
      if (!(await ctx.approve('discord:edit', `Change role ${label} in ${g.name}?`, details.join('\n')))) return DECLINED;
      const after = await dc.api<dc.Role>('PATCH', `/guilds/${g.id}/roles/${role.id}`, body, REASON);
      return { ok: true, changed_role: after.name, color: dc.colorHex(after.color), permissions: describePerms(BigInt(after.permissions)) };
    }),
  },
  {
    name: 'discord_moderate',
    owner: 'hermes',
    description: 'Moderate a member of the operator\'s Discord server: kick, ban, unban, timeout (mute for some minutes), end_timeout, or set their nickname. Asks the operator first.',
    parameters: obj({
      action: S('kick, ban, unban, timeout, end_timeout or nickname', { enum: ['kick', 'ban', 'unban', 'timeout', 'end_timeout', 'nickname'] }),
      server: SERVER,
      member: S('The member (username, display name or nickname)'),
      minutes: N('timeout: how long (max 40320 = 28 days, default 10)'),
      nickname: S('nickname: the new nickname; empty to clear it'),
      reason: S('Why - shown in the server\'s audit log'),
      delete_message_hours: N('ban: also delete their messages from the last N hours (max 168)'),
    }, ['action', 'member']),
    label: (a) => `discord ${str(a, 'action')} ${str(a, 'member')}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const action = str(args, 'action');
      const g = await dc.server(str(args, 'server'));
      const reason = `${str(args, 'reason') ? `${str(args, 'reason')} - ` : ''}${REASON}`;
      if (action === 'unban') {
        const bans = await dc.api<{ user: dc.User }[]>('GET', `/guilds/${g.id}/bans?limit=1000`);
        const ban = dc.pick(bans, str(args, 'member'), 'banned user', (b) => [b.user.global_name || b.user.username, b.user.username], (b) => b.user.id);
        const who = ban.user.global_name || ban.user.username;
        if (!(await ctx.approve('discord:moderate', `Unban ${who} from ${g.name}?`, 'They will be able to rejoin with an invite.'))) return DECLINED;
        await dc.api('DELETE', `/guilds/${g.id}/bans/${ban.user.id}`, undefined, reason);
        return { ok: true, unbanned: who };
      }
      const full = await dc.api<dc.Guild>('GET', `/guilds/${g.id}`);
      const m = await dc.findMember(g.id, str(args, 'member'));
      const who = dc.memberName(m);
      const bot = await dc.me();
      if (m.user.id === full.owner_id && action !== 'nickname') return { error: `${who} owns the server - the owner cannot be moderated.` };
      if (m.user.id === bot.id) return { error: 'That is the Ultron bot itself.' };
      let title: string;
      let detail = str(args, 'reason') ? `reason: ${str(args, 'reason')}` : '';
      let run: () => Promise<unknown>;
      if (action === 'kick') {
        title = `Kick ${who} from ${g.name}?`;
        detail = [detail, 'They can rejoin with an invite.'].filter(Boolean).join('\n');
        run = () => dc.api('DELETE', `/guilds/${g.id}/members/${m.user.id}`, undefined, reason);
      } else if (action === 'ban') {
        const hours = Math.max(0, Math.min(168, num(args, 'delete_message_hours', 0)));
        title = `BAN ${who} from ${g.name}?`;
        detail = [detail, 'They cannot rejoin until unbanned.', hours ? `Also deletes their messages from the last ${hours} hours.` : ''].filter(Boolean).join('\n');
        run = () => dc.api('PUT', `/guilds/${g.id}/bans/${m.user.id}`, { delete_message_seconds: hours * 3600 }, reason);
      } else if (action === 'timeout') {
        const minutes = Math.max(1, Math.min(40320, num(args, 'minutes', 10)));
        const until = new Date(Date.now() + minutes * 60_000);
        title = `Time out ${who} for ${minutes} minute${minutes === 1 ? '' : 's'}?`;
        detail = [detail, `They can read but not talk until ${until.toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`].filter(Boolean).join('\n');
        run = () => dc.api('PATCH', `/guilds/${g.id}/members/${m.user.id}`, { communication_disabled_until: until.toISOString() }, reason);
      } else if (action === 'end_timeout') {
        title = `End ${who}'s timeout?`;
        run = () => dc.api('PATCH', `/guilds/${g.id}/members/${m.user.id}`, { communication_disabled_until: null }, reason);
      } else if (action === 'nickname') {
        const nick = str(args, 'nickname').trim().slice(0, 32);
        title = nick ? `Set ${who}'s nickname to "${nick}"?` : `Clear ${who}'s nickname?`;
        run = () => dc.api('PATCH', `/guilds/${g.id}/members/${m.user.id}`, { nick: nick || null }, reason);
      } else {
        return { error: 'action must be kick, ban, unban, timeout, end_timeout or nickname.' };
      }
      if (!(await ctx.approve('discord:moderate', title, detail || `in ${g.name}`))) return DECLINED;
      await run();
      return { ok: true, done: `${action.replace('_', ' ')} ${who}`, server: g.name };
    }),
  },
  {
    name: 'discord_delete_messages',
    owner: 'hermes',
    description: 'Delete recent messages in a channel of the operator\'s Discord server - the last N, optionally only one member\'s, or specific message ids from discord_read_messages. Asks the operator first.',
    parameters: obj({
      server: SERVER,
      channel: S('Channel name'),
      count: N('How many of the newest messages (1-100)'),
      from_member: S('Only this member\'s messages'),
      message_ids: A('Exact message ids (from discord_read_messages) instead of a count'),
    }, ['channel']),
    label: (a) => `delete discord messages in #${str(a, 'channel').replace(/^#/, '')}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const ch = dc.pickChannel(await dc.channels(g.id), str(args, 'channel'), dc.MESSAGE_TYPES);
      const recent = await dc.api<dc.Message[]>('GET', `/channels/${ch.id}/messages?limit=100`);
      const ids = list(args, 'message_ids');
      let chosen: dc.Message[];
      let whose = '';
      if (ids.length) {
        chosen = recent.filter((m) => ids.includes(m.id));
      } else {
        let pool = recent;
        if (str(args, 'from_member').trim()) {
          const m = await dc.findMember(g.id, str(args, 'from_member'));
          whose = ` from ${dc.memberName(m)}`;
          pool = recent.filter((x) => x.author.id === m.user.id);
        }
        chosen = pool.slice(0, Math.max(1, Math.min(100, num(args, 'count', 1))));
      }
      if (!chosen.length) return { error: 'No matching messages among the channel\'s latest 100.' };
      const preview = chosen.slice(0, 6).map((m) => `${m.author.global_name || m.author.username}: ${(m.content || '[attachment/embed]').slice(0, 80)}`).join('\n');
      const n = chosen.length;
      if (!(await ctx.approve('discord:delete', `Delete ${n} message${n === 1 ? '' : 's'}${whose} in #${ch.name}?`, `${preview}${n > 6 ? `\n...and ${n - 6} more` : ''}\nThis cannot be undone.`))) return DECLINED;
      const fresh = chosen.filter((m) => Date.now() - Date.parse(m.timestamp) < 13.9 * 86_400_000);
      const old = chosen.filter((m) => !fresh.includes(m));
      if (fresh.length >= 2) await dc.api('POST', `/channels/${ch.id}/messages/bulk-delete`, { messages: fresh.map((m) => m.id) }, REASON);
      else if (fresh.length === 1) await dc.api('DELETE', `/channels/${ch.id}/messages/${fresh[0].id}`, undefined, REASON);
      // Older than 14 days: one by one (Discord's rule), capped so a big clean-up doesn't hit its rate limit.
      for (const m of old.slice(0, 20)) await dc.api('DELETE', `/channels/${ch.id}/messages/${m.id}`, undefined, REASON);
      const done = fresh.length + Math.min(old.length, 20);
      return { ok: true, deleted: done, channel: `#${ch.name}`, not_deleted: n - done || undefined };
    }),
  },
  {
    name: 'discord_server_settings',
    owner: 'hermes',
    description: 'Change the operator\'s Discord server settings: name, description, verification level, welcome (system messages) channel, default notifications, explicit-content filter. Asks the operator first.',
    parameters: obj({
      server: SERVER,
      name: S('New server name'),
      description: S('Server description (Discord only allows it on Community servers)'),
      verification_level: S('none, low, medium, high or highest', { enum: ['none', 'low', 'medium', 'high', 'highest'] }),
      welcome_channel: S('Channel for join messages and boosts; "none" to turn them off'),
      default_notifications: S('all or mentions', { enum: ['all', 'mentions'] }),
      content_filter: S('off, members_without_roles or everyone', { enum: ['off', 'members_without_roles', 'everyone'] }),
    }),
    label: (a) => `discord server settings${str(a, 'server') ? ` (${str(a, 'server')})` : ''}`,
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const body: Record<string, unknown> = {};
      const changes: string[] = [];
      if (has(args, 'name')) { body.name = str(args, 'name'); changes.push(`name: ${g.name} -> ${str(args, 'name')}`); }
      if (has(args, 'description')) { body.description = str(args, 'description'); changes.push(`description: ${str(args, 'description')}`); }
      if (has(args, 'verification_level')) {
        const lvl = ['none', 'low', 'medium', 'high', 'highest'].indexOf(str(args, 'verification_level'));
        if (lvl < 0) return { error: 'verification_level is none, low, medium, high or highest.' };
        body.verification_level = lvl;
        changes.push(`verification level: ${str(args, 'verification_level')}`);
      }
      if (has(args, 'welcome_channel')) {
        const none = /^(none|off)$/i.test(str(args, 'welcome_channel'));
        const ch = none ? null : dc.pickChannel(await dc.channels(g.id), str(args, 'welcome_channel'), new Set([0]));
        body.system_channel_id = ch ? ch.id : null;
        changes.push(ch ? `welcome messages in #${ch.name}` : 'no welcome messages');
      }
      if (has(args, 'default_notifications')) {
        body.default_message_notifications = str(args, 'default_notifications') === 'mentions' ? 1 : 0;
        changes.push(`default notifications: ${str(args, 'default_notifications')}`);
      }
      if (has(args, 'content_filter')) {
        const f = ['off', 'members_without_roles', 'everyone'].indexOf(str(args, 'content_filter'));
        if (f < 0) return { error: 'content_filter is off, members_without_roles or everyone.' };
        body.explicit_content_filter = f;
        changes.push(`explicit content filter: ${str(args, 'content_filter')}`);
      }
      if (!changes.length) return { error: 'Nothing to change.' };
      if (!(await ctx.approve('discord:edit', `Change ${g.name}'s server settings?`, changes.join('\n')))) return DECLINED;
      const after = await dc.api<dc.Guild>('PATCH', `/guilds/${g.id}`, body, REASON);
      return { ok: true, server: after.name, changes };
    }),
  },
  {
    name: 'discord_invite',
    owner: 'hermes',
    description: 'Make an invite link to the operator\'s Discord server. Asks the operator first.',
    parameters: obj({
      server: SERVER,
      channel: S('Channel the invite opens in (default: the welcome channel or the first text channel)'),
      hours: N('How long it works: hours, 0 = never expires (default 24)'),
      max_uses: N('How many people can use it, 0 = unlimited (default 0)'),
    }),
    label: () => 'discord invite link',
    writes: true,
    run: async (args, ctx) => guarded(async () => {
      const g = await dc.server(str(args, 'server'));
      const [full, chans] = await Promise.all([dc.api<dc.Guild>('GET', `/guilds/${g.id}`), dc.channels(g.id)]);
      const texts = chans.filter((c) => c.type === 0).sort(byPosition);
      const ch = str(args, 'channel').trim()
        ? dc.pickChannel(chans, str(args, 'channel'), dc.MESSAGE_TYPES)
        : texts.find((c) => c.id === full.system_channel_id) ?? texts[0];
      if (!ch) return { error: 'The server has no text channel to invite people into.' };
      const hours = Math.max(0, Math.min(168, num(args, 'hours', 24)));
      const uses = Math.max(0, Math.min(100, num(args, 'max_uses', 0)));
      const detail = `opens in #${ch.name}\n${hours ? `expires in ${hours} hours` : 'never expires'}, ${uses ? `${uses} use${uses === 1 ? '' : 's'}` : 'unlimited uses'}\nAnyone with the link can join.`;
      if (!(await ctx.approve('discord:invite', `Make an invite link to ${g.name}?`, detail))) return DECLINED;
      const inv = await dc.api<{ code: string }>('POST', `/channels/${ch.id}/invites`, { max_age: hours * 3600, max_uses: uses, unique: true }, REASON);
      return { ok: true, link: `https://discord.gg/${inv.code}`, expires: hours ? `in ${hours} hours` : 'never', max_uses: uses || 'unlimited' };
    }),
  },
];

export const DISCORD_READS = ['discord_servers', 'discord_server_info', 'discord_read_messages', 'discord_members'];

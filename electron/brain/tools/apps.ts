import * as composio from '../../composio';
import * as telegram from '../../telegram';
import * as discord from '../../discord';
import { S, N, obj, str, num, clip, type AgentTool } from './types';

/* Every action slug apps_find_actions has returned. Small models invent plausible ones ("GOOGLE_SHEET_EDIT" in a
   live test, 26 Sep 2026) - only real ones run, and a made-up one never reaches the operator's Approve button. */
const knownSlugs = new Set<string>();

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 400))
    .join('\n');
}

export const appTools: AgentTool[] = [
  {
    name: 'apps_connected',
    owner: 'hermes',
    description: 'Which of the operator\'s apps are connected right now (Gmail, Calendar, Drive, Docs, Notion, Spotify, GitHub, Discord...).',
    parameters: obj({}),
    label: () => 'check connected apps',
    run: async () => {
      const s = await composio.appsStatus();
      if (!s.hasKey) return { error: 'Composio is not set up yet - the operator needs to press "Sign in with Composio" in the Apps panel.' };
      if (!s.ok) return { error: s.hint ? `${s.error} ${s.hint}` : s.error };
      const connected = s.apps.filter((a) => a.status === 'connected').map((a) => `${a.slug} (${a.name})`);
      const other = s.apps.filter((a) => a.status !== 'connected' && a.status !== 'none').map((a) => `${a.slug}: ${a.status}`);
      return { connected: connected.length ? connected : 'none connected yet', needs_attention: other.length ? other : undefined };
    },
  },
  {
    name: 'apps_find_actions',
    owner: 'hermes',
    description: 'Find the right action for a job in the operator\'s connected apps. Returns action slugs with their parameters, and often a recommended plan and known pitfalls - follow them. Always call this before apps_run_action unless you already know the exact slug and parameters.',
    parameters: obj({
      query: S('What you want to do, in plain words, e.g. "fetch the latest unread emails from gmail", "create a google calendar event", "play a song on spotify"'),
      app: S('Optional app slug to focus on, e.g. gmail, googlecalendar, googledrive, notion, spotify, github, discord, youtube'),
      limit: N('Default 6'),
    }, ['query']),
    label: (a) => `find actions: ${str(a, 'query')}${str(a, 'app') ? ` (${str(a, 'app')})` : ''}`,
    run: async (args) => {
      try {
        const found = await composio.findActions(str(args, 'query'), str(args, 'app') || undefined, num(args, 'limit', 6));
        for (const a of found.actions) knownSlugs.add(String(a.slug).toUpperCase());
        if (!found.actions.length) return { error: 'No matching actions - try other words, or check which apps are connected.' };
        return {
          ...found,
          note: found.notConnected?.length ? `Not connected yet: ${found.notConnected.join(', ')} - the operator must connect these in the Apps panel before they can be used.` : undefined,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: 'apps_run_action',
    owner: 'hermes',
    description: 'Run an app action by its slug (from apps_find_actions) with its arguments. Reading is immediate; anything that sends, creates, edits or deletes asks the operator first.',
    parameters: obj({
      action: S('Action slug, e.g. GMAIL_FETCH_EMAILS'),
      arguments: { type: 'object', description: 'Arguments for the action, matching its parameters' },
    }, ['action']),
    label: (a) => `run ${str(a, 'action')}`,
    run: async (args, ctx) => {
      const slug = str(args, 'action').trim().toUpperCase();
      if (!/^[A-Z0-9_]+$/.test(slug)) return { error: 'Invalid action slug.' };
      // Composio's Discord bot is one bot shared by every Composio user; with the operator's own bot set up, use that.
      if (slug.startsWith('DISCORDBOT_') && discord.hasToken()) {
        return { error: 'Use the discord_ tools for the operator\'s Discord server - they go through their own private bot. Composio\'s Discord bot is shared with every Composio user.' };
      }
      // Small models invent plausible slugs ("GOOGLE_SHEET_EDIT") - bounce them before anything asks the operator.
      if (!knownSlugs.has(slug)) {
        return { error: `"${slug}" is not an action apps_find_actions returned. Call apps_find_actions for this job and use one of its exact slugs.` };
      }
      const actionArgs = (args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) as Record<string, unknown>;
      if (composio.isWriteAction(slug)) {
        const ok = await ctx.approve(`app:${slug}`, `Allow ${slug.replace(/_/g, ' ').toLowerCase()}?`, describeArgs(actionArgs) || '(no arguments)');
        if (!ok) return { error: 'The operator declined.' };
      }
      const r = await composio.runAction(slug, actionArgs);
      return r.ok ? { ok: true, data: clip(r.data, 7000) } : { error: r.error, data: r.data ? clip(r.data, 1500) : undefined };
    },
  },
  {
    name: 'telegram_send',
    owner: 'hermes',
    description: 'Send a Telegram message through the operator\'s own bot (needs a bot token in Settings). Asks the operator first.',
    parameters: obj({ chat_id: S('Chat id from telegram_recent_chats'), text: S('Message') }, ['chat_id', 'text']),
    label: () => 'telegram message',
    run: async (args, ctx) => {
      if (!telegram.hasToken()) return { error: 'No Telegram bot token configured.' };
      const ok = await ctx.approve('telegram', 'Send this Telegram message?', `to chat ${str(args, 'chat_id')}:\n${str(args, 'text')}`);
      if (!ok) return { error: 'The operator declined.' };
      return telegram.sendMessage(str(args, 'chat_id'), str(args, 'text'));
    },
  },
  {
    name: 'telegram_recent_chats',
    owner: 'hermes',
    description: 'Chats the operator\'s Telegram bot has recently seen (to find a chat id).',
    parameters: obj({}),
    label: () => 'telegram chats',
    run: async () => (telegram.hasToken() ? telegram.getRecentChats() : { error: 'No Telegram bot token configured.' }),
  },
];

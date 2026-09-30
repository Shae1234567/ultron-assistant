import { getSecret } from './secrets';

/**
 * Real Telegram connector, via Telegram's Bot API.
 *
 * Setup an operator needs (for Settings UI copy):
 *  1. In the Telegram app, message @BotFather and send /newbot, follow the
 *     prompts to name the bot. BotFather replies with a bot token - that's
 *     TELEGRAM_BOT_TOKEN.
 *  2. Message the new bot at least once (or add it to a group and send a
 *     message there) - Telegram bots can only see chats that have messaged
 *     them first, there is no way to look up a chat by username or phone
 *     number.
 *  3. Call getRecentChats() to find the resulting chat id, then use it with
 *     sendMessage().
 */

const TIMEOUT_MS = 10000;

function botToken(): string {
  return getSecret('TELEGRAM_BOT_TOKEN');
}

export function hasToken(): boolean {
  return Boolean(botToken());
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function apiFetch<T>(method: string, body?: unknown): Promise<{ ok: boolean; result?: T; error?: string }> {
  const token = botToken();
  if (!token) return { ok: false, error: 'No TELEGRAM_BOT_TOKEN set.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => null)) as TelegramEnvelope<T> | null;
    if (!res.ok || !data || !data.ok) {
      const desc = data?.description;
      return { ok: false, error: desc ?? `Telegram responded ${res.status}.` };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Confirms the token is real and returns the bot's own username. */
export async function verify(): Promise<{ ok: boolean; botUsername?: string; error?: string }> {
  if (!hasToken()) return { ok: false, error: 'No TELEGRAM_BOT_TOKEN set.' };
  const { ok, result, error } = await apiFetch<{ username?: string }>('getMe');
  if (!ok) return { ok: false, error };
  return { ok: true, botUsername: result?.username };
}

/** Sends a text message to a chat id. Requires that the chat has messaged the bot at least once. */
export async function sendMessage(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!hasToken()) return { ok: false, error: 'No TELEGRAM_BOT_TOKEN set.' };
  const trimmed = text.trim();
  if (!chatId) return { ok: false, error: 'No chat id given.' };
  if (!trimmed) return { ok: false, error: 'Message is empty.' };
  const { ok, error } = await apiFetch('sendMessage', { chat_id: chatId, text: trimmed });
  if (!ok) return { ok: false, error };
  return { ok: true };
}

/**
 * Distinct chats that have messaged this bot, derived from recent updates.
 * Telegram bots only ever see chats that have messaged them first - there is
 * no API to look up an arbitrary user or group by name. The operator must
 * message their bot (or add it to a group and post there) before it will
 * show up here.
 */
export async function getRecentChats(): Promise<{ ok: boolean; chats: { id: string; name: string; lastMessage?: string }[]; error?: string }> {
  if (!hasToken()) return { ok: false, chats: [], error: 'No TELEGRAM_BOT_TOKEN set.' };
  interface Chat { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string }
  interface Message { chat: Chat; text?: string; date: number }
  interface Update { update_id: number; message?: Message; edited_message?: Message }
  const { ok, result, error } = await apiFetch<Update[]>('getUpdates', { limit: 100 });
  if (!ok) return { ok: false, chats: [], error };
  const byId = new Map<string, { id: string; name: string; lastMessage?: string; date: number }>();
  for (const u of result ?? []) {
    const msg = u.message ?? u.edited_message;
    if (!msg) continue;
    const chat = msg.chat;
    const id = String(chat.id);
    const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    const name = chat.title || fullName || chat.username || id;
    const existing = byId.get(id);
    if (!existing || msg.date >= existing.date) {
      byId.set(id, { id, name, lastMessage: msg.text, date: msg.date });
    }
  }
  return { ok: true, chats: Array.from(byId.values()).map(({ id, name, lastMessage }) => ({ id, name, lastMessage })) };
}

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { savedProvider, type UltronOAuthProvider } from './composioAuth';

/**
 * Composio Connect - the consumer side of Composio (dashboard.composio.dev).
 *
 * It only speaks MCP, at connect.composio.dev. Two ways in: the operator's
 * browser sign-in (OAuth, composioAuth.ts - the reliable one) or a "ck_" key
 * sent as an x-consumer-api-key header. The developer SDK Ultron uses for
 * project keys ("ak_") rejects ck_ keys with a 401, and Composio itself
 * rejects ck_ keys once they've been regenerated - which is why pasted keys
 * kept "not working". Apps connected in Connect (for Claude, Cursor...) are
 * shared by every client on the account, so Ultron gets them for free.
 *
 * Everything goes through Composio's meta-tools:
 *   COMPOSIO_SEARCH_TOOLS         find the right action + its schema + a plan
 *   COMPOSIO_GET_TOOL_SCHEMAS     full schema for an action
 *   COMPOSIO_MULTI_EXECUTE_TOOL   run actions
 *   COMPOSIO_MANAGE_CONNECTIONS   list / add / remove app connections
 *   COMPOSIO_WAIT_FOR_CONNECTIONS wait for an OAuth sign-in to finish
 */

export const CONNECT_ENDPOINT = 'https://connect.composio.dev/mcp';

/** How Ultron proves who it is to Composio Connect: the operator's browser sign-in, or a ck_ key. */
export type ConnectAuth = { kind: 'oauth' } | { kind: 'key'; key: string };

function authId(auth: ConnectAuth): string {
  return auth.kind === 'key' ? `key:${auth.key}` : 'oauth';
}

async function sdk() {
  // The SDK ships ESM + CJS; loaded lazily so a project-key setup never pays for it.
  const [{ Client: McpClient }, { StreamableHTTPClientTransport }, { UnauthorizedError }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/auth.js'),
  ]);
  return { McpClient, StreamableHTTPClientTransport, UnauthorizedError };
}

let cached: { id: string; client: Client } | null = null;
let pending: { id: string; promise: Promise<Client> } | null = null;

/** Which header a ck_ key worked with last time, so later connects skip straight to it. */
let keyHeaderStyle: 'consumer' | 'bearer' | null = null;

async function open(auth: ConnectAuth): Promise<Client> {
  const { McpClient, StreamableHTTPClientTransport } = await sdk();
  if (auth.kind === 'oauth') {
    const client = new McpClient({ name: 'ultron', version: '2.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(CONNECT_ENDPOINT), { authProvider: savedProvider() }), { timeout: 30_000 });
    return client;
  }
  // Composio documents x-consumer-api-key, but its auth layer talks in bearer tokens - try the documented
  // header first and the bearer form second before calling the key bad.
  const styles: ('consumer' | 'bearer')[] = keyHeaderStyle === 'bearer' ? ['bearer', 'consumer'] : ['consumer', 'bearer'];
  let lastError: unknown;
  for (const style of styles) {
    const headers: Record<string, string> = style === 'consumer' ? { 'x-consumer-api-key': auth.key } : { Authorization: `Bearer ${auth.key}` };
    const client = new McpClient({ name: 'ultron', version: '2.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(CONNECT_ENDPOINT), { requestInit: { headers } }), { timeout: 30_000 });
      keyHeaderStyle = style;
      return client;
    } catch (e) {
      lastError = e;
      await client.close().catch(() => {});
      if (classify(e).kind !== 'auth') throw e;
    }
  }
  throw lastError;
}

async function clientFor(auth: ConnectAuth): Promise<Client> {
  const id = authId(auth);
  if (cached?.id === id) return cached.client;
  if (pending?.id === id) return pending.promise;
  const promise = open(auth)
    .then((client) => {
      const previous = cached?.client;
      cached = { id, client };
      void previous?.close().catch(() => {});
      return client;
    })
    .finally(() => { if (pending?.promise === promise) pending = null; });
  pending = { id, promise };
  return promise;
}

/**
 * One connect attempt for the browser sign-in. Without tokens the SDK registers
 * Ultron, opens the browser (through the provider) and throws Unauthorized -
 * we hand back finishAuth for the code the browser returns.
 */
export async function oauthConnect(provider: UltronOAuthProvider): Promise<{ finishAuth: (code: string) => Promise<void> } | 'connected'> {
  const { McpClient, StreamableHTTPClientTransport, UnauthorizedError } = await sdk();
  const transport = new StreamableHTTPClientTransport(new URL(CONNECT_ENDPOINT), { authProvider: provider });
  const client = new McpClient({ name: 'ultron', version: '2.1.0' });
  try {
    await client.connect(transport, { timeout: 60_000 });
    await client.close().catch(() => {});
    return 'connected';
  } catch (e) {
    if (e instanceof UnauthorizedError || /unauthori[sz]ed/i.test(e instanceof Error ? e.message : String(e))) {
      return { finishAuth: (code: string) => transport.finishAuth(code) };
    }
    throw e;
  }
}

export function resetConnect(): void {
  const c = cached?.client;
  cached = null;
  pending = null;
  void c?.close().catch(() => {});
}

export class ConnectError extends Error {
  /** What Composio actually said, for the operator - never contains the key. */
  readonly raw: string;
  constructor(message: string, readonly kind: 'auth' | 'network' | 'composio', raw = '') {
    super(message);
    this.raw = raw;
  }
}

function classify(e: unknown): ConnectError {
  if (e instanceof ConnectError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const raw = msg.replace(/ck_[A-Za-z0-9_-]+/g, 'ck_…').replace(/\s+/g, ' ').slice(0, 240);
  const code = (e as { code?: number })?.code;
  if (code === 401 || code === 403 || /\b40[13]\b|unauthori[sz]ed|invalid consumer api key|forbidden/i.test(msg)) {
    return new ConnectError('Composio Connect refused the credentials.', 'auth', raw);
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|timed out|timeout/i.test(msg)) {
    return new ConnectError('Could not reach Composio Connect (network).', 'network', raw);
  }
  return new ConnectError(msg.slice(0, 300), 'composio', raw);
}

/** Pulls the JSON envelope out of an MCP tool result and turns Composio-side failures into errors. */
export function unwrap(res: { content?: unknown; isError?: boolean }): unknown {
  const items = Array.isArray(res.content) ? res.content : [];
  let parsed: unknown;
  let firstText = '';
  for (const item of items) {
    const t = item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' ? String((item as { text?: unknown }).text ?? '') : '';
    if (!t) continue;
    if (!firstText) firstText = t;
    try {
      parsed = JSON.parse(t);
      break;
    } catch {
      /* not the JSON payload - Composio appends plain-text notes after it */
    }
  }
  const env = parsed as { successful?: boolean; error?: unknown; data?: unknown } | undefined;
  const envError = env && typeof env === 'object' ? env.error : undefined;
  // A batch where an action failed still carries that action's own error ("Unable to parse range: Sheet1!A1:B4").
  // Throwing here left only "1 out of 1 tools failed" - nothing an agent can fix its arguments from (live test, 26 Sep 2026).
  const results = (env as { data?: { results?: unknown } } | undefined)?.data?.results;
  const perAction = Array.isArray(results) && results.some((r) => r !== null && typeof r === 'object' && 'response' in r);
  if (perAction) return parsed;
  if (res.isError || env?.successful === false || (envError !== undefined && envError !== null && envError !== '')) {
    const detail = typeof envError === 'string' ? envError : envError ? JSON.stringify(envError) : firstText;
    throw new ConnectError((detail || 'Composio reported an error.').slice(0, 400), 'composio');
  }
  return parsed ?? firstText;
}

export async function callMeta(auth: ConnectAuth, name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let client: Client;
    try {
      client = await clientFor(auth);
    } catch (e) {
      resetConnect();
      throw classify(e);
    }
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true });
      return unwrap(res as { content?: unknown; isError?: boolean });
    } catch (e) {
      if (e instanceof ConnectError) throw e;
      // A dropped or expired MCP session: reconnect once and retry.
      if (attempt === 0 && /session|closed|404|not connected|ECONNRESET/i.test(e instanceof Error ? e.message : String(e))) {
        resetConnect();
        continue;
      }
      throw classify(e);
    }
  }
}

/* ── Response parsing (pure, unit-tested against real responses) ───────── */

export type Connection = 'connected' | 'pending' | 'expired' | 'failed' | 'none';

export interface ToolkitState {
  status: Connection;
  accountIds: string[];
  detail?: string;
}

function lower(v: unknown): string {
  return String(v ?? '').toLowerCase();
}

/** Maps one toolkit entry of a COMPOSIO_MANAGE_CONNECTIONS "list" result. */
export function toolkitState(entry: unknown): ToolkitState {
  const e = (entry ?? {}) as { status?: unknown; accounts?: { id?: unknown; status?: unknown; alias?: unknown; user_info?: { email?: unknown; name?: unknown } }[]; error?: unknown };
  const accounts = Array.isArray(e.accounts) ? e.accounts : [];
  const active = accounts.filter((a) => lower(a.status) === 'active');
  const st = lower(e.status);
  let status: Connection = 'none';
  if (active.length || st === 'active') status = 'connected';
  else if (accounts.some((a) => lower(a.status) === 'expired' || lower(a.status) === 'inactive') || st === 'expired') status = 'expired';
  else if (accounts.some((a) => lower(a.status) === 'failed') || st === 'failed') status = 'failed';
  // "initiated" with no account is a sign-in that was started and never finished - it can be started again.
  else if (accounts.length && (st === 'initiated' || accounts.some((a) => lower(a.status) === 'initiated'))) status = 'pending';
  const who = active[0]?.user_info?.email ?? active[0]?.user_info?.name ?? active[0]?.alias;
  return {
    status,
    accountIds: (active.length ? active : accounts).map((a) => String(a.id ?? '')).filter(Boolean),
    detail: who ? String(who) : typeof e.error === 'string' ? e.error : undefined,
  };
}

export function listResults(payload: unknown): Record<string, unknown> {
  const p = payload as { data?: { results?: Record<string, unknown> }; results?: Record<string, unknown> };
  return p?.data?.results ?? p?.results ?? {};
}

/** The OAuth link from an "add" result - Composio names it redirect_url, but look around a little. */
export function findRedirect(payload: unknown): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown, keyHint: string, depth: number) => {
    if (found || depth > 7 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (/^https:\/\//.test(v) && /redirect|auth|link|url/i.test(keyHint)) found = v;
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, keyHint, depth + 1); return; }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      // Prefer the canonical key when it exists at this level.
      const exact = entries.find(([k, x]) => /^redirect_?url$/i.test(k) && typeof x === 'string' && /^https:\/\//.test(x));
      if (exact) { found = exact[1] as string; return; }
      for (const [k, x] of entries) walk(x, k, depth + 1);
    }
  };
  walk(payload, '', 0);
  return found;
}

/**
 * What an "add" said: a sign-in link, or why there is none. Some apps have no
 * Composio-managed login (Spotify, checked 26 Sep 2026): the answer is status
 * "failed" plus a message pointing at a one-time setup page - Ultron used to
 * hide that behind "try again in a minute".
 */
export function connectionOutcome(payload: unknown, slug: string): { url?: string; error?: string; setupUrl?: string } {
  const url = findRedirect(payload);
  if (url) return { url };
  const results = listResults(payload);
  const entry = (results[slug] ?? Object.values(results)[0]) as { error_message?: unknown } | undefined;
  const message = typeof entry?.error_message === 'string' ? entry.error_message : '';
  if (!message) return {};
  const link = /\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s)]+)/.exec(message);
  // The message is written for an AI agent ("Show the user this link...") - keep the part meant for people.
  const error = message.split(/\s+Show the user\b/i)[0].trim();
  return { error, setupUrl: link?.[1] ?? link?.[2] };
}

export interface FoundTool {
  slug: string;
  app: string;
  description: string;
  schema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface SearchSummary {
  tools: FoundTool[];
  plan: string[];
  pitfalls: string[];
  notConnected: string[];
  sessionId?: string;
}

/** Flattens a COMPOSIO_SEARCH_TOOLS result into what an agent needs to act. */
export function searchSummary(payload: unknown): SearchSummary {
  const data = ((payload as { data?: unknown })?.data ?? payload ?? {}) as {
    results?: { primary_tool_slugs?: string[]; related_tool_slugs?: string[]; recommended_plan_steps?: string[]; known_pitfalls?: string[] }[];
    tool_schemas?: Record<string, { toolkit?: string; description?: string; input_schema?: FoundTool['schema'] }>;
    toolkit_connection_statuses?: { toolkit?: string; has_active_connection?: boolean }[];
    session?: { id?: string };
  };
  const results = Array.isArray(data.results) ? data.results : [];
  const schemas = data.tool_schemas ?? {};
  const order: string[] = [];
  for (const r of results) for (const s of [...(r.primary_tool_slugs ?? []), ...(r.related_tool_slugs ?? [])]) if (!order.includes(s)) order.push(s);
  for (const s of Object.keys(schemas)) if (!order.includes(s)) order.push(s);
  const tools = order.slice(0, 10).map((slug) => {
    const s = schemas[slug] ?? {};
    return {
      slug,
      app: lower(s.toolkit) || lower(slug.split('_')[0]),
      description: String(s.description ?? '').replace(/\s+/g, ' ').slice(0, 300),
      schema: s.input_schema,
    };
  });
  return {
    tools,
    plan: results.flatMap((r) => r.recommended_plan_steps ?? []).slice(0, 8),
    pitfalls: results.flatMap((r) => r.known_pitfalls ?? []).slice(0, 6),
    notConnected: (data.toolkit_connection_statuses ?? []).filter((t) => t.has_active_connection === false && t.toolkit).map((t) => String(t.toolkit)),
    sessionId: data.session?.id,
  };
}

/** One action's outcome from a COMPOSIO_MULTI_EXECUTE_TOOL result. */
export function executeOutcome(payload: unknown): { ok: boolean; data?: unknown; error?: string } {
  const data = ((payload as { data?: unknown })?.data ?? payload ?? {}) as { results?: unknown[] };
  const first = (Array.isArray(data.results) ? data.results[0] : undefined) as
    | { response?: { successful?: boolean; data?: unknown; error?: unknown }; error?: unknown; successful?: boolean; data?: unknown }
    | undefined;
  if (!first) return { ok: true, data };
  const r = first.response ?? first;
  const err = r.error ?? first.error;
  if (r.successful === false || (err !== undefined && err !== null && err !== '')) {
    return { ok: false, error: typeof err === 'string' ? err : JSON.stringify(err ?? 'The action failed.').slice(0, 400), data: r.data };
  }
  return { ok: true, data: r.data ?? r };
}

/* ── Operations ───────────────────────────────────────────────────────── */

let session: { id: string; at: number } | null = null;

function sessionArg(): Record<string, unknown> {
  // Composio correlates a workflow's meta-tool calls by session; a fresh one every half hour keeps plans relevant.
  return session && Date.now() - session.at < 30 * 60_000 ? { id: session.id } : { generate_id: true };
}

export async function listConnections(auth: ConnectAuth, slugs: string[]): Promise<Record<string, ToolkitState>> {
  const out: Record<string, ToolkitState> = {};
  const read = async (names: string[]) => {
    const payload = await callMeta(auth, 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits: names.map((name) => ({ name, action: 'list' })) });
    const results = listResults(payload);
    for (const n of names) out[n] = toolkitState(results[n]);
  };
  try {
    await read(slugs);
  } catch (e) {
    if (e instanceof ConnectError && e.kind !== 'composio') throw e;
    // One unknown toolkit can fail the whole batch - fall back to asking one at a time.
    await Promise.all(slugs.map((s) => read([s]).catch(() => { out[s] = { status: 'none', accountIds: [] }; })));
  }
  return out;
}

export async function startConnection(auth: ConnectAuth, slug: string): Promise<{ url?: string; error?: string; setupUrl?: string }> {
  const payload = await callMeta(auth, 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: slug, action: 'add' }] });
  return connectionOutcome(payload, slug);
}

/** Resolves when the sign-in finishes (or after ~5 minutes of waiting). */
export async function waitForConnection(auth: ConnectAuth, slug: string): Promise<void> {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    try {
      await callMeta(auth, 'COMPOSIO_WAIT_FOR_CONNECTIONS', { toolkits: [slug], mode: 'any' }, 150_000);
    } catch {
      /* the wait itself can time out - check the state below */
    }
    const state = (await listConnections(auth, [slug]).catch(() => ({} as Record<string, ToolkitState>)))[slug];
    if (state && (state.status === 'connected' || state.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

export async function removeConnection(auth: ConnectAuth, slug: string, accountIds: string[]): Promise<void> {
  if (!accountIds.length) return;
  await callMeta(auth, 'COMPOSIO_MANAGE_CONNECTIONS', {
    toolkits: accountIds.map((account_id) => ({ name: slug, action: 'remove', account_id })),
  });
}

export async function searchTools(auth: ConnectAuth, useCase: string): Promise<SearchSummary> {
  const payload = await callMeta(auth, 'COMPOSIO_SEARCH_TOOLS', {
    queries: [{ use_case: useCase.slice(0, 1000) }],
    session: sessionArg(),
    model: 'ultron-team',
  });
  const summary = searchSummary(payload);
  if (summary.sessionId) session = { id: summary.sessionId, at: Date.now() };
  // Search returns full schemas for the main tools only - fetch the rest the agent is likely to use.
  const missing = summary.tools.filter((t) => !t.schema?.properties).slice(0, 4).map((t) => t.slug);
  if (missing.length) {
    try {
      const more = await callMeta(auth, 'COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: missing, ...(session ? { session_id: session.id } : {}) });
      const extra = searchSummary({ data: { tool_schemas: (more as { data?: { tool_schemas?: unknown } })?.data?.tool_schemas ?? {} } });
      for (const t of summary.tools) {
        const found = extra.tools.find((x) => x.slug === t.slug);
        if (found?.schema?.properties) t.schema = found.schema;
      }
    } catch {
      /* schemas are a convenience - the agent can still try with the description */
    }
  }
  return summary;
}

export async function execute(auth: ConnectAuth, slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const payload = await callMeta(auth, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug: slug, arguments: args }],
    sync_response_to_workbench: false,
    thought: `Ultron team running ${slug}`,
    current_step: slug,
    ...(session ? { session_id: session.id } : {}),
  }, 120_000);
  return executeOutcome(payload);
}

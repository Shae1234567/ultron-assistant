import { describe, expect, it } from 'vitest';
import { executeOutcome, findRedirect, listResults, searchSummary, toolkitState, unwrap } from './composioConnect';

// Shapes copied from real Composio Connect responses (account details trimmed).
const LIST = {
  data: {
    message: 'Processed 3 toolkits: 2 active, 1 initiated',
    results: {
      gmail: { toolkit: 'gmail', status: 'active', accounts: [{ id: 'gmail_x', alias: 'personal', status: 'active', is_default: true, user_info: { email: 'me@example.com' } }] },
      notion: { toolkit: 'notion', status: 'active', accounts: [{ id: 'notion_y', status: 'active', user_info: { name: 'Composio' } }] },
      spotify: { toolkit: 'spotify', status: 'initiated', accounts: [] },
    },
  },
  error: null,
  successful: true,
};

const SEARCH = {
  data: {
    results: [{
      use_case: 'fetch the latest emails from gmail inbox',
      recommended_plan_steps: ['[Required] [Step]: List candidate recent emails using GMAIL_FETCH_EMAILS'],
      known_pitfalls: ['[GMAIL_FETCH_EMAILS] Results aren’t guaranteed newest-first'],
      primary_tool_slugs: ['GMAIL_FETCH_EMAILS'],
      related_tool_slugs: ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_LIST_LABELS'],
      toolkits: ['gmail'],
    }],
    toolkit_connection_statuses: [{ toolkit: 'gmail', has_active_connection: true }, { toolkit: 'spotify', has_active_connection: false }],
    tool_schemas: {
      GMAIL_FETCH_EMAILS: { toolkit: 'GMAIL', tool_slug: 'GMAIL_FETCH_EMAILS', description: 'Fetches a list of email messages.', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } } }, hasFullSchema: true },
      GMAIL_LIST_LABELS: { toolkit: 'GMAIL', tool_slug: 'GMAIL_LIST_LABELS', description: 'Retrieves all labels...', hasFullSchema: false },
    },
    session: { id: 'pond', generate_id: true },
  },
  error: null,
  successful: true,
};

describe('Composio Connect parsing', () => {
  it('reads the JSON envelope and ignores the plain-text notes after it', () => {
    const res = { content: [{ type: 'text', text: JSON.stringify(LIST) }, { type: 'text', text: 'No exact fit? Add a custom MCP...' }] };
    expect(unwrap(res)).toEqual(LIST);
  });

  it('turns Composio-side failures into errors', () => {
    expect(() => unwrap({ content: [{ type: 'text', text: JSON.stringify({ data: null, error: 'Toolkit not found', successful: false }) }] })).toThrow('Toolkit not found');
    expect(() => unwrap({ isError: true, content: [{ type: 'text', text: 'Invalid consumer API key' }] })).toThrow('Invalid consumer API key');
  });

  it('maps connection states - an abandoned sign-in with no account is just not connected', () => {
    const results = listResults(LIST);
    expect(toolkitState(results.gmail)).toEqual({ status: 'connected', accountIds: ['gmail_x'], detail: 'me@example.com' });
    expect(toolkitState(results.notion).status).toBe('connected');
    expect(toolkitState(results.spotify)).toEqual({ status: 'none', accountIds: [], detail: undefined });
    expect(toolkitState(undefined).status).toBe('none');
    expect(toolkitState({ status: 'initiated', accounts: [{ id: 'a', status: 'initiated' }] }).status).toBe('pending');
    expect(toolkitState({ accounts: [{ id: 'b', status: 'EXPIRED' }] }).status).toBe('expired');
  });

  it('summarizes a tool search with schemas, plan, pitfalls, missing connections and the session', () => {
    const s = searchSummary(SEARCH);
    expect(s.tools.map((t) => t.slug)).toEqual(['GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_LIST_LABELS']);
    expect(s.tools[0].schema?.properties).toHaveProperty('max_results');
    expect(s.tools[0].app).toBe('gmail');
    expect(s.tools[2].schema).toBeUndefined();
    expect(s.plan[0]).toContain('GMAIL_FETCH_EMAILS');
    expect(s.pitfalls).toHaveLength(1);
    expect(s.notConnected).toEqual(['spotify']);
    expect(s.sessionId).toBe('pond');
  });

  it('finds the sign-in link in an add result', () => {
    expect(findRedirect({ data: { results: { spotify: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/abc' } } } })).toBe('https://connect.composio.dev/link/abc');
    expect(findRedirect({ data: { results: { spotify: { auth: { link: 'https://accounts.spotify.com/authorize?x=1' } } } } })).toBe('https://accounts.spotify.com/authorize?x=1');
    expect(findRedirect({ data: { message: 'see http://insecure.example' } })).toBeUndefined();
  });

  it('reads an executed action outcome', () => {
    expect(executeOutcome({ data: { results: [{ response: { successful: true, data: { messages: [] } } }] } })).toEqual({ ok: true, data: { messages: [] } });
    expect(executeOutcome({ data: { results: [{ response: { successful: false, error: 'Missing message_id' } }] } })).toMatchObject({ ok: false, error: 'Missing message_id' });
  });
});

describe('connectionOutcome', async () => {
  const { connectionOutcome } = await import('./composioConnect');

  it('explains an app with no Composio-managed login and finds its setup page (Spotify, 26 Sep 2026)', () => {
    const payload = { data: { message: 'All connection attempts failed', results: { spotify: { toolkit: 'spotify', status: 'failed', error_message: "Composio does not have managed auth for 'spotify', so the user must set up their own auth config before connecting. Show the user this link and ask them to complete the setup there: [Set up spotify](https://dashboard.composio.dev/~/org/connect/apps/spotify?open=true). Once they have finished, call COMPOSIO_MANAGE_CONNECTIONS again with 'spotify' to connect." } } }, successful: true };
    const r = connectionOutcome(payload, 'spotify');
    expect(r.url).toBeUndefined();
    expect(r.setupUrl).toBe('https://dashboard.composio.dev/~/org/connect/apps/spotify?open=true');
    expect(r.error).toBe("Composio does not have managed auth for 'spotify', so the user must set up their own auth config before connecting.");
  });

  it('returns the sign-in link when there is one', () => {
    expect(connectionOutcome({ data: { results: { gmail: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/abc' } } } }, 'gmail'))
      .toEqual({ url: 'https://connect.composio.dev/link/abc' });
  });
});

describe('a failed action keeps its own error', async () => {
  const { unwrap, executeOutcome } = await import('./composioConnect');

  it('passes the per-action error through instead of "1 out of 1 tools failed" (live test, 26 Sep 2026)', () => {
    const body = { data: { results: [{ response: { successful: false, data: {}, error: 'Unable to parse range: Sheet1!A1:B4' }, tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', index: 0 }] }, error: '1 out of 1 tools failed', successful: false };
    const payload = unwrap({ isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] });
    expect(executeOutcome(payload)).toMatchObject({ ok: false, error: 'Unable to parse range: Sheet1!A1:B4' });
  });

  it('still throws a plain error that has no per-action detail', () => {
    expect(() => unwrap({ isError: true, content: [{ type: 'text', text: JSON.stringify({ successful: false, error: 'Invalid session' }) }] })).toThrow('Invalid session');
  });
});

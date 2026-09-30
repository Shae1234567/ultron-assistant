import http from 'node:http';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getInternalSecret, setInternalSecret } from './secrets';

/**
 * "Sign in with Composio" - the same OAuth flow Claude and Cursor use to reach
 * Composio Connect, so Ultron needs no API key at all. Composio Connect runs a
 * standard MCP authorization server (dynamic client registration, PKCE,
 * refresh tokens), discovered from its /.well-known metadata by the MCP SDK.
 *
 * The browser redirects back to a one-shot listener on 127.0.0.1; tokens are
 * kept encrypted in the secrets store and refreshed by the SDK on its own.
 */

// Fixed ports so the registered redirect URI can be reused between sign-ins.
const PORTS = [47651, 47652, 47653, 47654];

interface Stored {
  redirect?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
  savedAt?: number;
}

function read(): Stored {
  try {
    return JSON.parse(getInternalSecret('COMPOSIO_OAUTH') || '{}') as Stored;
  } catch {
    return {};
  }
}

function update(patch: Partial<Stored>): void {
  setInternalSecret('COMPOSIO_OAUTH', JSON.stringify({ ...read(), ...patch }));
}

export function isSignedIn(): boolean {
  return Boolean(read().tokens?.access_token);
}

export function signOut(): void {
  setInternalSecret('COMPOSIO_OAUTH', null);
}

export class UltronOAuthProvider implements OAuthClientProvider {
  constructor(private readonly redirect: string, private readonly onAuthorize?: (url: URL) => void) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Ultron',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid profile email offline_access',
    };
  }

  state(): string {
    const s = crypto.randomBytes(16).toString('hex');
    update({ state: s });
    return s;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const s = read();
    // A registration belongs to its redirect URI - if the callback port changed, register again.
    return s.redirect === this.redirect ? s.client : undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    update({ client: info, redirect: this.redirect });
  }

  tokens(): OAuthTokens | undefined {
    return read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    update({ tokens, savedAt: Date.now() });
  }

  redirectToAuthorization(url: URL): void {
    // Outside the sign-in flow a browser must never pop up on its own - the operator signs in again from Apps.
    if (!this.onAuthorize) throw new Error('The Composio sign-in has expired - sign in again from the Apps panel.');
    this.onAuthorize(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    update({ verifier: codeVerifier });
  }

  codeVerifier(): string {
    const v = read().verifier;
    if (!v) throw new Error('The sign-in expired - start it again from the Apps panel.');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') return signOut();
    const s = read();
    if (scope === 'client') delete s.client;
    if (scope === 'tokens') delete s.tokens;
    if (scope === 'verifier') delete s.verifier;
    setInternalSecret('COMPOSIO_OAUTH', JSON.stringify(s));
  }
}

/** The provider for everyday calls: saved tokens, never interactive. */
export function savedProvider(): UltronOAuthProvider {
  return new UltronOAuthProvider(read().redirect ?? `http://127.0.0.1:${PORTS[0]}/callback`);
}

function listen(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      if (i >= PORTS.length) return reject(new Error('Could not open a local port for the sign-in callback.'));
      const server = http.createServer();
      server.once('error', () => tryPort(i + 1));
      server.listen(PORTS[i], '127.0.0.1', () => resolve({ server, port: PORTS[i] }));
    };
    tryPort(0);
  });
}

function page(ok: boolean, message: string): string {
  const color = ok ? '#00d9ff' : '#ff5c7a';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ultron</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#05080d;color:#cfefff;font-family:Segoe UI,system-ui,sans-serif">
<div style="text-align:center;border:1px solid ${color}55;padding:40px 56px;box-shadow:0 0 40px ${color}22">
<div style="letter-spacing:.3em;color:${color};font-size:13px">ULTRON</div>
<h1 style="font-weight:600;font-size:22px;margin:14px 0 8px">${message}</h1>
<p style="opacity:.7;margin:0">You can close this tab and go back to Ultron.</p></div></body></html>`;
}

let inFlight: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Runs the whole browser sign-in. `connectAndVerify` performs an MCP connect
 * with the given provider: the first attempt triggers registration and opens
 * the browser; the second, after the code exchange, proves the tokens work.
 */
export function signIn(
  connectAndVerify: (provider: UltronOAuthProvider) => Promise<{ finishAuth: (code: string) => Promise<void> } | 'connected'>,
): Promise<{ ok: boolean; error?: string }> {
  inFlight ??= run(connectAndVerify).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(
  connectAndVerify: (provider: UltronOAuthProvider) => Promise<{ finishAuth: (code: string) => Promise<void> } | 'connected'>,
): Promise<{ ok: boolean; error?: string }> {
  const { server, port } = await listen();
  const redirect = `http://127.0.0.1:${port}/callback`;
  let settle!: (r: { code?: string; error?: string }) => void;
  const callback = new Promise<{ code?: string; error?: string }>((resolve) => { settle = resolve; });
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirect);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    const expected = read().state;
    let outcome: { code?: string; error?: string };
    if (error) outcome = { error: `Composio said: ${error}` };
    else if (!code) outcome = { error: 'The sign-in came back without a code.' };
    else if (expected && state !== expected) outcome = { error: 'The sign-in response did not match this request - try again.' };
    else outcome = { code };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(Boolean(outcome.code), outcome.code ? 'Ultron is connected to Composio' : 'Sign-in did not finish'));
    settle(outcome);
  });
  const timer = setTimeout(() => settle({ error: 'The sign-in timed out after 5 minutes.' }), 5 * 60_000);
  try {
    const provider = new UltronOAuthProvider(redirect, (u) => void shell.openExternal(u.toString()));
    const first = await connectAndVerify(provider);
    if (first === 'connected') return { ok: true };
    const result = await callback;
    if (!result.code) return { ok: false, error: result.error };
    await first.finishAuth(result.code);
    const second = await connectAndVerify(new UltronOAuthProvider(redirect));
    return second === 'connected' ? { ok: true } : { ok: false, error: 'Signed in, but Composio still refused the connection.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

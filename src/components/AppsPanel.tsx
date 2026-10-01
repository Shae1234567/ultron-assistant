import { useEffect, useState } from 'react';
import { Overlay } from './Overlay';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import type { AddonsReport, AppState, DiscordStatus, WebLogins } from '../types';

const STATUS: Record<AppState['status'], { label: string; cls: string }> = {
  connected: { label: 'CONNECTED', cls: 'chip--good' },
  pending: { label: 'FINISH SIGN-IN', cls: '' },
  expired: { label: 'EXPIRED', cls: 'chip--bad' },
  failed: { label: 'FAILED', cls: 'chip--bad' },
  none: { label: 'NOT CONNECTED', cls: 'chip--muted' },
};

function AppCard({ app, busy, onConnect, onDisconnect }: { app: AppState; busy: boolean; onConnect: () => void; onDisconnect: () => void }) {
  const st = STATUS[app.status];
  return (
    <div className={`conn-card app-card ${app.status === 'connected' ? 'app-card--connected' : ''} ${app.recommended && app.status !== 'connected' ? 'app-card--recommended' : ''}`}>
      {app.recommended && <span className="conn-card__free">RECOMMENDED</span>}
      <div className="conn-card__name">{app.name}</div>
      <div className="app-card__blurb">{app.blurb}</div>
      <div className="app-card__row">
        <span className={`chip ${st.cls}`} title={app.detail}>{st.label}</span>
        <span style={{ marginLeft: 'auto' }}>
          {app.status === 'connected' ? (
            <button className="mini-btn mini-btn--danger" onClick={onDisconnect} disabled={busy}>DISCONNECT</button>
          ) : (
            <button className="mini-btn" onClick={onConnect} disabled={busy}>{busy ? 'OPENING...' : app.status === 'none' ? 'CONNECT' : 'RECONNECT'}</button>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * The operator's own Discord bot. Composio's ready-made Discord bot is one bot shared by every Composio
 * user, so anything it may do in your server, strangers could do too - this one only answers to your token.
 */
function DiscordSection() {
  const [st, setSt] = useState<DiscordStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { void ultron.discord.status().then(setSt); }, []);

  const save = async (value: string) => {
    setBusy(true);
    setMsg({ text: value ? 'Checking the token with Discord...' : 'Removing the token...' });
    const res = await ultron.secrets.set('DISCORD_BOT_TOKEN', value);
    setSt(await ultron.discord.status());
    setBusy(false);
    setDraft('');
    setConfirming(false);
    setMsg(res.ok ? { text: value ? `${res.detail ?? 'Saved'}.` : 'Token removed - Ultron can no longer reach your server.' } : { text: res.error ?? 'Discord did not accept that token.', bad: true });
  };

  const refresh = async () => {
    setBusy(true);
    setSt(await ultron.discord.status());
    setBusy(false);
  };

  const portal = () => void ultron.app.openExternal('https://discord.com/developers/applications');
  const servers = st?.servers ?? [];
  const chip = !st?.configured
    ? { cls: 'chip--muted', text: 'NOT SET UP' }
    : st.ok
      ? { cls: 'chip--good', text: `BOT "${(st.bot ?? '').toUpperCase()}" - ${servers.length ? `IN ${servers.map((s) => s.name.toUpperCase()).join(', ')}` : 'NOT IN A SERVER YET'}` }
      : { cls: 'chip--bad', text: 'TOKEN PROBLEM' };

  return (
    <>
      <div className="divider" />
      <div className="subhead">DISCORD - YOUR OWN BOT</div>
      <div className="field">
        <div className={`chip ${chip.cls}`} style={{ marginBottom: 6 }}><span className="dot" /> {chip.text}</div>
        {st?.configured && !st.ok && st.error && msg?.text !== st.error && <div className="alert-strip alert-strip--warn" style={{ marginBottom: 8 }}><span className="dot" />{st.error}</div>}
        {st?.sharedBotIn && st.sharedBotIn.length > 0 && (
          <div className="alert-strip alert-strip--warn" style={{ marginBottom: 8 }}>
            <span className="dot" />Composio's shared bot is still in {st.sharedBotIn.join(', ')} - anyone using Composio could reach your server through it.
            In Discord, right-click "Composio" in the member list and choose Kick, then press DISCONNECT on "Discord Bot" in the list above.
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="hud-input"
            type="password"
            placeholder={st?.configured ? 'paste a new bot token to replace it' : 'paste your bot token'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) void save(draft.trim()); }}
            aria-label="Discord bot token"
          />
          <button className="hud-btn" onClick={() => void save(draft.trim())} disabled={busy || !draft.trim()}>Save &amp; test</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {st?.ok && st.inviteUrl && <button className="hud-btn hud-btn--active" onClick={() => void ultron.app.openExternal(st.inviteUrl!)}>Add bot to a server</button>}
          {st?.configured && <button className="hud-btn" onClick={() => void refresh()} disabled={busy}>Check again</button>}
          {st?.configured && !confirming && <button className="hud-btn" onClick={() => setConfirming(true)}>Remove token</button>}
          {confirming && (
            <>
              <button className="hud-btn hud-btn--danger" onClick={() => void save('')}>Yes, remove it</button>
              <button className="hud-btn" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          )}
        </div>
        {msg && <div className={`alert-strip ${msg.bad ? 'alert-strip--warn' : 'alert-strip--info'}`} style={{ marginTop: 8 }}><span className="dot" />{msg.text}</div>}
        {!st?.ok ? (
          <div className="field__hint">
            Lets Hermes run your server - channels, roles, members, messages - asking you before every change. One-time setup, about 10 minutes.
            Do it with a parent: Discord's developer terms need a parent to agree for anyone under 18.
            <br />1. Open the <span className="link-btn" onClick={portal}>Discord Developer Portal</span>, sign in, press New Application, name it Ultron.
            <br />2. Installation page: set Install Link to None. Bot page: turn Public Bot OFF (only you can add it), and turn ON Server Members Intent and Message Content Intent. Save.
            <br />3. Bot page: press Reset Token, copy the token, paste it above and press Save &amp; test.
            <br />4. Press Add bot to a server, pick your server, Authorize.
            <br />The token is stored encrypted on this PC and never shown again. Treat it like a password - anyone with it controls the bot.
          </div>
        ) : (
          <div className="field__hint">
            Ask things like "add a memes channel to my server", "make a Mods role that can kick people" or "what's been said in #general".
            Every change asks you first. The bot never gets Administrator, and it can only manage roles below its own - in Discord,
            Server Settings, Roles, drag "Ultron" near the top.
          </div>
        )}
      </div>
    </>
  );
}

/** Open-source add-ons installed in ~/UltronTools: what each does, whether it's there, and Hindsight's switch. */
function AddonsSection() {
  const [r, setR] = useState<AddonsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = useStore((s) => s.settings);
  const [askAgent, setAskAgent] = useState(Boolean(settings?.addons?.askBrowserAgent));
  useEffect(() => { void ultron.addons.status().then(setR); }, []);
  const toggleAsk = async () => setAskAgent(await ultron.addons.setAskBrowserAgent(!askAgent));
  const toggle = async () => {
    if (!r) return;
    setBusy(true);
    setR(await ultron.addons.setHindsight(!r.hindsight.enabled));
    setBusy(false);
  };
  const h = r?.hindsight;
  return (
    <>
      <div className="divider" />
      <div className="subhead">ADD-ONS - OPEN-SOURCE PROJECTS ULTRON USES</div>
      <div className="field">
        {(r?.addons ?? []).map((a) => (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
            <span className={`chip ${a.installed ? 'chip--good' : 'chip--muted'}`} style={{ minWidth: 92, justifyContent: 'center' }}><span className="dot" /> {a.installed ? 'INSTALLED' : 'NOT FOUND'}</span>
            <span style={{ fontSize: 12 }}>
              <span className="link-btn" onClick={() => void ultron.app.openExternal(a.repo)}>{a.name}</span>
              <span className="field__hint" style={{ margin: 0, display: 'inline' }}> - {a.detail}</span>
            </span>
          </div>
        ))}
        {h?.installed && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
            <button className={`hud-btn ${h.enabled ? 'hud-btn--active' : ''}`} onClick={() => void toggle()} disabled={busy}>
              {h.enabled ? 'Hindsight memory - ON' : 'Turn on Hindsight memory'}
            </button>
            <span className="mono" style={{ fontSize: 11, color: h.running ? 'var(--green)' : 'var(--dim)' }}>
              {h.running ? 'running' : h.enabled ? 'starts with your next message' : 'off'}
            </span>
          </div>
        )}
        {r?.addons.some((a) => a.id === 'browser-use' && a.installed) && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
            <button className={`hud-btn ${askAgent ? 'hud-btn--active' : ''}`} onClick={() => void toggleAsk()}>
              {askAgent ? 'Browser agent asks me first - ON' : 'Ask me before the browser agent runs'}
            </button>
          </div>
        )}
        <div className="field__hint">
          Ultron picks the right add-on by itself from what you ask - a video gets its transcript read, a science job gets its guide,
          a long look-up on one website goes to the browser agent. Installed in your UltronTools folder, each in its own space - nothing
          system-wide. Hindsight runs on this PC with the local model (about 1 GB of memory while on). The browser agent works in a fresh
          browser that is signed in to nothing, stays on one site and never downloads.
        </div>
      </div>
    </>
  );
}

/** The agents' own browser: sites signed in to once stay signed in for Daedalus and every browsing agent. */
function WebsitesSection() {
  const [web, setWeb] = useState<WebLogins | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void ultron.web.status().then(setWeb);
    return ultron.web.onChanged(setWeb);
  }, []);

  const signIn = async () => {
    const r = await ultron.web.signIn();
    setMsg(r.ok
      ? { text: 'The agents\' browser is open - sign in to the sites you want, then close that window. The list here updates when you do.' }
      : { text: r.error ?? 'Could not open the browser.', bad: true });
    setWeb(await ultron.web.status());
  };

  const clear = async () => {
    setConfirming(false);
    setWeb(await ultron.web.clear());
    setMsg({ text: 'Every website login in the agents\' browser is gone.' });
  };

  const sites = web?.sites ?? [];
  return (
    <>
      <div className="divider" />
      <div className="subhead">WEBSITES - FOR THE AGENTS' OWN BROWSER</div>
      <div className="field">
        <div className={`chip ${sites.length ? 'chip--good' : 'chip--muted'}`} style={{ marginBottom: 6 }}>
          <span className="dot" /> {web?.signInOpen ? 'SIGN-IN WINDOW OPEN' : sites.length ? `${sites.length} SITE${sites.length > 1 ? 'S' : ''} REMEMBERED` : 'NO SITES SIGNED IN YET'}
        </div>
        {sites.length > 0 && (
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginBottom: 8, lineHeight: 1.5 }}>{sites.slice(0, 24).join(' · ')}{sites.length > 24 ? ` +${sites.length - 24} more` : ''}</div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="hud-btn hud-btn--active" onClick={() => void signIn()}>Sign in to websites</button>
          {sites.length > 0 && !confirming && <button className="hud-btn" onClick={() => setConfirming(true)}>Forget all website logins</button>}
          {confirming && (
            <>
              <button className="hud-btn hud-btn--danger" onClick={() => void clear()}>Yes, sign the agents out everywhere</button>
              <button className="hud-btn" onClick={() => setConfirming(false)}>Cancel</button>
            </>
          )}
        </div>
        {msg && <div className={`alert-strip ${msg.bad ? 'alert-strip--warn' : 'alert-strip--info'}`} style={{ marginTop: 8 }}><span className="dot" />{msg.text}</div>}
        <div className="field__hint">
          Daedalus (and any agent that browses) works in Ultron's own browser. Sign in once to Google, Canva, Notion, GitHub - whatever you
          want them to build in - typing your own passwords, and they stay signed in, even after a restart. Posting, sending, sharing and
          deleting always ask you first; buying, paying and creating accounts are never done for you.
        </div>
      </div>
    </>
  );
}

export function AppsPanel({ onClose }: { onClose: () => void }) {
  const apps = useStore((s) => s.apps);
  const setApps = useStore((s) => s.setApps);
  const d2l = useStore((s) => s.d2l);
  const setD2L = useStore((s) => s.setD2L);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [keyDraft, setKeyDraft] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean; link?: string } | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [d2lUrl, setD2lUrl] = useState(settings?.d2l.baseUrl ?? '');
  const [d2lBusy, setD2lBusy] = useState(false);
  const [d2lProblem, setD2lProblem] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void ultron.apps.status().then(setApps);
    void ultron.d2l.status().then(setD2L);
  }, [setApps, setD2L]);

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setMsg({ text: 'Checking the key with Composio...' });
    const res = await ultron.secrets.set('COMPOSIO_API_KEY', value);
    if (res.ok) {
      setKeyDraft('');
      setMsg({ text: res.detail ?? 'Saved.' });
      setApps(await ultron.apps.status());
    } else {
      setMsg({ text: res.error ?? 'Composio did not accept that key.', bad: true });
    }
  };

  const connect = async (slug: string) => {
    setBusySlug(slug);
    const res = await ultron.apps.connect(slug);
    setBusySlug(null);
    setMsg(res.ok
      ? { text: 'Finish signing in in your browser - this panel updates by itself when it goes through.' }
      : { text: res.error ?? 'Could not start the connection.', bad: true, link: res.setupUrl });
    setApps(await ultron.apps.status());
  };

  const disconnect = async (slug: string) => {
    setBusySlug(slug);
    const res = await ultron.apps.disconnect(slug);
    setBusySlug(null);
    if (!res.ok) setMsg({ text: res.error ?? 'Could not disconnect.', bad: true });
    setApps(await ultron.apps.status());
  };

  const d2lSignIn = async () => {
    setD2lProblem(null);
    if (!d2lUrl.trim()) {
      setD2lProblem('Type your school\'s D2L address first - the web address you open D2L at, e.g. myschool.brightspace.com.');
      return;
    }
    setD2lBusy(true);
    let base = settings?.d2l.baseUrl ?? '';
    if (settings && d2lUrl.trim() !== base) {
      const saved = await ultron.settings.save({ d2l: { baseUrl: d2lUrl.trim() } });
      setSettings(saved);
      base = saved.d2l.baseUrl;
      // Shown the way Ultron will use it: "myschool.brightspace.com" becomes "https://myschool.brightspace.com".
      setD2lUrl(base || d2lUrl);
    }
    if (!base) {
      setD2lBusy(false);
      setD2lProblem(`"${d2lUrl.trim()}" doesn't look like a web address. Open D2L in your browser and copy the address from the top bar.`);
      return;
    }
    const s = await ultron.d2l.signIn();
    setD2L(s);
    setD2lBusy(false);
    if (!s.signedIn) setD2lProblem(s.error ?? 'Not signed in yet - finish signing in in the D2L window, or press Sign in again.');
  };

  const google = apps?.apps.filter((a) => a.group === 'Google') ?? [];
  const others = apps?.apps.filter((a) => a.group === 'Apps') ?? [];
  const connectedCount = apps?.apps.filter((a) => a.status === 'connected').length ?? 0;

  const signedIn = apps?.auth === 'oauth';
  const statusText = !apps?.hasKey
    ? 'NOT CONNECTED TO COMPOSIO YET'
    : apps.ok
      ? (signedIn ? 'SIGNED IN WITH COMPOSIO' : apps.mode === 'connect' ? 'COMPOSIO CONNECT KEY WORKING' : 'COMPOSIO PROJECT KEY WORKING')
      : `PROBLEM: ${apps.error ?? 'unknown'}`;

  const signIn = async () => {
    setSigningIn(true);
    setMsg({ text: 'Composio is opening in your browser - approve Ultron there. This panel updates by itself when it finishes.' });
    const res = await ultron.apps.signIn();
    setSigningIn(false);
    setApps(res.status ?? await ultron.apps.status());
    setMsg(res.ok
      ? { text: 'Signed in with Composio - your connected apps are below.' }
      : { text: res.error ?? 'The sign-in did not finish.', bad: true });
  };

  const signOut = async () => {
    setApps(await ultron.apps.signOut());
    setMsg({ text: 'Signed out of Composio on this PC. Your apps stay connected in your Composio account.' });
  };

  return (
    <Overlay title="Apps" meta={`${connectedCount} CONNECTED`} onClose={onClose}>
      <div className="subhead">COMPOSIO - HOW ULTRON REACHES YOUR APPS</div>
      <div className="field">
        <div className={`chip ${apps?.hasKey && apps.ok ? 'chip--good' : 'chip--bad'}`} style={{ marginBottom: 8 }}>
          <span className="dot" /> {statusText}
        </div>
        {apps?.hasKey && !apps.ok && apps.hint && msg?.text !== apps.hint && (
          <div className="alert-strip alert-strip--warn" style={{ marginBottom: 8 }}><span className="dot" />{apps.hint}</div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          {signedIn ? (
            <button className="hud-btn" onClick={() => void signOut()}>Sign out</button>
          ) : (
            <button className="hud-btn hud-btn--active" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? 'Waiting for browser...' : 'Sign in with Composio'}
            </button>
          )}
          <span className="field__hint" style={{ margin: 0 }}>
            {signedIn
              ? 'Using your Composio account - apps you connected there (for Claude, Cursor...) work here too.'
              : 'Recommended - no key needed. Uses your Composio account in the browser, the same way Claude connects.'}
          </span>
        </div>
        {!signedIn && (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="hud-input"
                type="password"
                placeholder={apps?.hasKey ? 'or paste a new key to replace the current one' : 'or paste a Composio key'}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
              />
              <button className="hud-btn" onClick={() => void saveKey()} disabled={!keyDraft.trim()}>Save &amp; test</button>
            </div>
            <div className="field__hint">
              Keys work too: a Composio Connect key (starts with ck_, from <span className="link-btn" onClick={() => void ultron.app.openExternal('https://dashboard.composio.dev')}>dashboard.composio.dev</span>)
              or a developer project key (starts with ak_, from <span className="link-btn" onClick={() => void ultron.app.openExternal('https://platform.composio.dev')}>platform.composio.dev</span>).
              A regenerated Connect key stops working immediately, which is why signing in is more reliable. Everything is stored encrypted on this PC.
            </div>
          </>
        )}
      </div>

      {msg && (
        <div className={`alert-strip ${msg.bad ? 'alert-strip--warn' : 'alert-strip--info'}`} style={{ marginBottom: 12 }}>
          <span className="dot" />{msg.text}
          {msg.link && (
            <> {' '}<span className="link-btn" onClick={() => void ultron.app.openExternal(msg.link!)}>OPEN SETUP</span></>
          )}
        </div>
      )}

      {apps?.hasKey && (
        <>
          <div className="subhead">GOOGLE</div>
          <div className="app-grid">
            {google.map((a) => (
              <AppCard key={a.slug} app={a} busy={busySlug === a.slug} onConnect={() => void connect(a.slug)} onDisconnect={() => void disconnect(a.slug)} />
            ))}
          </div>
          <div className="subhead">APPS</div>
          <div className="app-grid">
            {others.map((a) => (
              <AppCard key={a.slug} app={a} busy={busySlug === a.slug} onConnect={() => void connect(a.slug)} onDisconnect={() => void disconnect(a.slug)} />
            ))}
          </div>
        </>
      )}

      <div className="divider" />
      <div className="subhead">D2L BRIGHTSPACE - SCHOOL</div>
      <div className="field">
        <div className={`chip ${d2l?.signedIn ? 'chip--good' : 'chip--muted'}`} style={{ marginBottom: 6 }}>
          <span className="dot" /> {d2l?.signedIn ? `SIGNED IN${d2l.user ? ` AS ${d2l.user.toUpperCase()}` : ''}` : 'NOT SIGNED IN'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="hud-input"
            value={d2lUrl}
            placeholder="your school's D2L address, e.g. myschool.brightspace.com"
            onChange={(e) => { setD2lUrl(e.target.value); setD2lProblem(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !d2l?.signedIn) void d2lSignIn(); }}
            aria-label="D2L address"
          />
          {d2l?.signedIn ? (
            <>
              <button className="hud-btn" onClick={() => void ultron.d2l.open()}>Open D2L</button>
              <button className="hud-btn hud-btn--danger" onClick={() => void ultron.d2l.signOut().then(setD2L)}>Sign out</button>
            </>
          ) : (
            <button className="hud-btn hud-btn--active" onClick={() => void d2lSignIn()} disabled={d2lBusy}>{d2lBusy ? 'Waiting for sign-in...' : 'Sign in to D2L'}</button>
          )}
        </div>
        {(d2lProblem || (!d2l?.signedIn && d2l?.error && d2lUrl.trim())) && (
          <div className="alert-strip alert-strip--warn" style={{ marginTop: 8 }}><span className="dot" />{d2lProblem ?? d2l?.error}</div>
        )}
        <div className="field__hint">
          For schools that use D2L Brightspace. Type the address you open D2L at, then press Sign in: a normal D2L window
          opens and you sign in yourself with your school account (plus any 2-step check). Ultron never sees your password -
          it only keeps the signed-in session, and uses it to read what's due, grades and announcements. You stay signed in
          after closing Ultron. Hermes checks it when you ask; Chronos can turn due dates into reminders.
        </div>
      </div>

      <DiscordSection />

      <AddonsSection />

      <WebsitesSection />

      <div className="divider" />
      <div className="field__hint" style={{ marginTop: 0 }}>
        Weather is built in (Open-Meteo, no account needed). Obsidian is Ultron's own memory vault - see the Memory panel.
      </div>
    </Overlay>
  );
}

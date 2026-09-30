import { useEffect, useState } from 'react';
import { Overlay } from './Overlay';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { relTime } from '../services/format';
import type { MemoryHit, VaultNote, VaultStats } from '../types';

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const feed = useStore((s) => s.memoryFeed);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [recent, setRecent] = useState<VaultNote[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [profile, setProfile] = useState('');
  const [profileDirty, setProfileDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    void ultron.vault.stats().then(setStats);
    void ultron.vault.recent(14).then(setRecent);
  };

  useEffect(() => {
    reload();
    void ultron.vault.profile().then(setProfile);
  }, []);

  useEffect(() => { if (feed.length) reload(); }, [feed.length]);

  const search = async () => {
    const q = query.trim();
    if (!q) { setHits(null); return; }
    setBusy(true);
    setHits(await ultron.vault.search(q));
    setBusy(false);
  };

  const open = async (rel?: string) => {
    const res = await ultron.vault.open(rel);
    if (res.hint) setMsg(res.hint);
    else if (!res.ok) setMsg(res.error ?? 'Could not open the vault.');
  };

  const saveProfile = async () => {
    const res = await ultron.vault.saveProfile(profile);
    setProfileDirty(false);
    setMsg(res.ok ? 'Profile saved - Ultron uses it from the next message.' : 'Could not save the profile.');
  };

  return (
    <Overlay title="Memory" meta="OBSIDIAN VAULT" onClose={onClose}>
      <div className="stat-row">
        <div className="stat"><span className="stat__value">{stats?.memories ?? '-'}</span><span className="stat__label">TOPIC NOTES</span></div>
        <div className="stat"><span className="stat__value">{stats?.journalDays ?? '-'}</span><span className="stat__label">JOURNAL DAYS</span></div>
        <div className="stat"><span className="stat__value">{stats?.research ?? '-'}</span><span className="stat__label">RESEARCH</span></div>
        <div className="stat"><span className="stat__value">{stats?.teamRuns ?? '-'}</span><span className="stat__label">TEAM RUNS</span></div>
        <div className="stat"><span className="stat__value" style={{ fontSize: 13, paddingTop: 5 }}>{stats?.lastUpdated ? relTime(stats.lastUpdated) : 'never'}</span><span className="stat__label">LAST WRITE</span></div>
      </div>

      <div className="field">
        <span className="field__label">Vault</span>
        <div className="mono" style={{ fontSize: 11, color: 'var(--cyan)', wordBreak: 'break-all', marginBottom: 6 }}>{stats?.root ?? '...'}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="hud-btn hud-btn--active" onClick={() => void open()}>Open in Obsidian</button>
          <button className="hud-btn" onClick={() => void ultron.vault.reveal()}>Show folder</button>
          <button className="hud-btn" onClick={() => void ultron.vault.choose().then((r) => { if (r.ok) reload(); })}>Move vault...</button>
          <button className="hud-btn" onClick={async () => { setMsg('Re-indexing...'); setStats(await ultron.vault.reindex()); setMsg('Search index rebuilt.'); }}>Re-index</button>
        </div>
        <div className="field__hint">
          Ultron writes here after every message: the conversation goes into the day's journal, and Mnemosyne files anything
          worth remembering into topic notes linked with [[wikilinks]]. Edit anything in Obsidian - Ultron reads your changes.
        </div>
      </div>

      {msg && <div className="alert-strip alert-strip--info" style={{ marginBottom: 12 }}><span className="dot" />{msg}</div>}

      <div className="field">
        <span className="field__label">Search memory</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="hud-input"
            value={query}
            placeholder="e.g. tryouts, math teacher, what I said about the history project"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          />
          <button className="hud-btn" onClick={() => void search()} disabled={busy}>{busy ? '...' : 'Search'}</button>
        </div>
        {hits && (
          <div style={{ marginTop: 8, border: '1px solid var(--cyan-20)', maxHeight: 260, overflowY: 'auto' }}>
            {hits.length === 0 ? (
              <div className="empty-note">Nothing in memory matches that yet.</div>
            ) : (
              hits.map((h) => (
                <div key={h.rel + h.text.slice(0, 20)} className="memory-hit" onClick={() => void open(h.rel)} title="Open in Obsidian">
                  <div className="memory-hit__title">{h.rel.replace(/\.md$/, '')} <span style={{ color: 'var(--dim)' }}>{Math.round(h.score * 100)}%</span></div>
                  <div className="memory-hit__text">{h.text.slice(0, 260)}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {feed.length > 0 && (
        <div className="field">
          <span className="field__label">Just learned (this session)</span>
          {feed.slice(0, 8).map((u) => (
            <div key={u.at} className="mono" style={{ fontSize: 11, color: 'var(--white)', padding: '3px 0' }}>
              <span style={{ color: 'var(--dim)' }}>{relTime(u.at)} </span>
              {u.saved.map((s) => `${s.created ? 'new note' : `+${s.added}`} ${s.title}`).join(' · ')}
              {u.profileAdded ? ` · profile +${u.profileAdded}` : ''}
            </div>
          ))}
        </div>
      )}

      <div className="field">
        <span className="field__label">Recently written</span>
        {recent.length === 0 ? (
          <div className="empty-note" style={{ padding: 0 }}>Nothing yet - talk to Ultron and it starts filling up.</div>
        ) : (
          recent.map((n) => (
            <div key={n.rel} className="memory-hit" style={{ padding: '5px 8px' }} onClick={() => void open(n.rel)}>
              <div className="memory-hit__title">{n.rel.replace(/\.md$/, '')} <span style={{ color: 'var(--dim)' }}>{relTime(n.mtime)}</span></div>
            </div>
          ))
        )}
      </div>

      <div className="field">
        <span className="field__label">Operator profile (always in Ultron's mind)</span>
        <textarea
          className="hud-input"
          rows={10}
          style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5 }}
          value={profile}
          onChange={(e) => { setProfile(e.target.value); setProfileDirty(true); }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="hud-btn hud-btn--active" onClick={() => void saveProfile()} disabled={!profileDirty}>Save profile</button>
        </div>
        <div className="field__hint">Profile/Operator.md in the vault. Mnemosyne adds dated lines under "Learned by Ultron" when something big changes.</div>
      </div>
    </Overlay>
  );
}

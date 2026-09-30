import { useEffect, useMemo, useState } from 'react';
import { HexPanel } from './hud/HexPanel';
import { ArcMeter } from './hud/ArcMeter';
import { useStore } from '../state/store';
import { refreshNews, enqueueRelevance, startAutoRefresh } from '../services/newsFeed';
import { ALL_REGIONS } from '../types';
import type { Article } from '../types';
import { ultron } from '../services/bridge';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function NewsItem({ article }: { article: Article }) {
  const relevance = useStore((s) => s.relevance[article.id]);
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    setExpanded((v) => !v);
    if (!relevance) enqueueRelevance(article);
  };

  return (
    <div className="news-item" onClick={toggle}>
      <div className="news-item__meta">
        <span className="news-item__region">{article.region}</span>
        <span className="news-item__source">{article.source}</span>
        <span className="news-item__time">{timeAgo(article.publishedAt)}</span>
      </div>
      <div className="news-item__title">{article.title}</div>

      {relevance?.status === 'pending' && (
        <div className="relevance relevance--pending">
          <span className="dot dot--live" style={{ display: 'inline-block', marginRight: 6 }} />
          analysing relevance...
        </div>
      )}
      {relevance?.status === 'done' && (
        <div className="relevance">
          <span className="relevance__tag">WHY THIS MATTERS TO YOU</span>
          {relevance.text}
        </div>
      )}
      {relevance?.status === 'failed' && (
        <div className="relevance relevance--pending" style={{ borderLeftColor: 'var(--red)', color: '#ffb3bb' }}>
          {relevance.text}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <button
            className="hud-btn"
            onClick={(e) => { e.stopPropagation(); void ultron.app.openExternal(article.url); }}
          >
            Open source
          </button>
          {relevance?.status === 'failed' && (
            <button
              className="hud-btn"
              onClick={(e) => { e.stopPropagation(); enqueueRelevance(article); }}
            >
              Retry analysis
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function NewsPanel() {
  const articles = useStore((s) => s.articles);
  const quota = useStore((s) => s.quota);
  const loading = useStore((s) => s.newsLoading);
  const error = useStore((s) => s.newsError);
  const lastFetch = useStore((s) => s.lastFetch);
  const regionFilter = useStore((s) => s.regionFilter);
  const setRegionFilter = useStore((s) => s.setRegionFilter);
  const setOverlay = useStore((s) => s.setOverlay);
  const settings = useStore((s) => s.settings);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  // First fetch once settings are loaded, then keep the auto-refresh running.
  useEffect(() => {
    if (!settings) return;
    void ultron.news.hasKey().then((ok) => {
      setHasKey(ok);
      if (ok) void refreshNews(false);
      else void ultron.news.quota().then((q) => useStore.getState().setNews({ quota: q }));
    });
    return startAutoRefresh();
  }, [settings]);

  const regionsPresent = useMemo(() => {
    const set = new Set(articles.map((a) => a.region));
    return ALL_REGIONS.filter((r) => set.has(r));
  }, [articles]);

  const visible = useMemo(
    () => (regionFilter === 'ALL' ? articles : articles.filter((a) => a.region === regionFilter)),
    [articles, regionFilter],
  );

  const used = quota?.used ?? 0;
  const cap = quota?.cap ?? 100;
  const nearCap = used >= cap * 0.8;

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setKeySaving(true);
    setKeyMsg(null);
    try {
      const res = await ultron.secrets.set('GNEWS_API_KEY', value);
      if (res.ok) {
        setKeyDraft('');
        setHasKey(true);
        setKeyMsg('Saved.');
        setTimeout(() => { setKeyOpen(false); setKeyMsg(null); }, 900);
        void refreshNews(true);
      } else {
        setKeyMsg(res.error ?? 'Could not save.');
      }
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <HexPanel
      title="Intelligence"
      meta={lastFetch
        ? new Date(lastFetch).toLocaleTimeString('en-CA', { hour12: false, hour: '2-digit', minute: '2-digit' })
        : '--:--'}
      scroll={false}
      actions={
        <>
          <button
            className={`news-key-toggle ${keyOpen ? 'news-key-toggle--open' : ''}`}
            style={{ marginLeft: 8 }}
            onClick={() => setKeyOpen((v) => !v)}
            title="Set GNews API key"
            aria-label="Set GNews API key"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="hud-btn"
            style={{ marginLeft: 6 }}
            onClick={() => void refreshNews(true)}
            disabled={loading || hasKey === false}
          >
            {loading ? 'Syncing' : 'Refresh'}
          </button>
        </>
      }
    >
      {/* small, collapsible - never a modal, keeps the panel's footprint unchanged when closed */}
      <div className={`news-key-row ${keyOpen ? 'news-key-row--open' : ''}`}>
        <div className="news-key-row__inner">
          <div className="news-key-row__content">
            <input
              className="hud-input"
              type="password"
              placeholder={hasKey ? 'paste a new key to replace' : 'paste your free GNews key'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
            />
            <button className="hud-btn" onClick={() => void saveKey()} disabled={!keyDraft.trim() || keySaving}>
              {keySaving ? '...' : 'Save'}
            </button>
            <span
              className="link-btn"
              style={{ fontSize: 10, whiteSpace: 'nowrap' }}
              onClick={() => void ultron.app.openExternal('https://gnews.io/register')}
            >
              get a key
            </span>
            {keyMsg && <span className="mono" style={{ fontSize: 10, color: keyMsg === 'Saved.' ? 'var(--green)' : 'var(--red)' }}>{keyMsg}</span>}
          </div>
        </div>
      </div>

      {/* quota + region controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
        borderBottom: '1px solid var(--cyan-20)', flex: '0 0 auto',
      }}>
        <ArcMeter
          value={cap ? used / cap : 0}
          size={62}
          readout={`${used}`}
          label="REQ/DAY"
          color={nearCap ? 'var(--red)' : 'var(--cyan)'}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="label-xs">GNEWS FREE TIER</div>
          <div className="mono" style={{ fontSize: 11, color: nearCap ? 'var(--red)' : 'var(--cyan)', marginTop: 2 }}>
            {used} / {cap} requests used today
          </div>
          <div className="mono" style={{ fontSize: 9.5, color: 'var(--dimmer)', marginTop: 2 }}>
            {settings ? `${settings.news.categories.length} req per sync - auto every ${settings.news.autoRefreshMinutes} min` : ''}
          </div>
          <div className="mono" style={{ fontSize: 9.5, color: 'var(--dimmer)', marginTop: 1 }}>
            + Hacker News - free, no key, no cap
          </div>
        </div>
      </div>

      {regionsPresent.length > 1 && (
        <div className="tag-row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--cyan-20)', flex: '0 0 auto' }}>
          <span
            className={`chip ${regionFilter === 'ALL' ? '' : 'chip--muted'}`}
            onClick={() => setRegionFilter('ALL')}
          >
            ALL {articles.length}
          </span>
          {regionsPresent.map((r) => (
            <span
              key={r}
              className={`chip ${regionFilter === r ? '' : 'chip--muted'}`}
              onClick={() => setRegionFilter(r)}
            >
              {r}
            </span>
          ))}
        </div>
      )}

      {hasKey === false && (
        <div className="alert-strip alert-strip--warn">
          <span className="dot" />
          No GNEWS_API_KEY found.
          <button className="link-btn" onClick={() => setOverlay({ kind: 'settings' })}>Add one in Settings</button>
        </div>
      )}
      {error && hasKey !== false && (
        <div className="alert-strip alert-strip--warn" style={{ display: 'block', lineHeight: 1.5 }}>
          <span className="dot" style={{ display: 'inline-block', marginRight: 6 }} />
          {error}
          {/activat/i.test(error) && (
            <>
              {' '}
              <span
                className="link-btn"
                onClick={() => void ultron.app.openExternal('https://gnews.io/dashboard')}
              >
                Open GNews dashboard
              </span>
            </>
          )}
        </div>
      )}

      <div className="panel-body" style={{ flex: '1 1 auto' }}>
        {visible.length === 0 ? (
          <div className="empty-note">
            {hasKey === false ? (
              <>
                The feed needs a free GNews key (100 requests/day, no card required).
                <br /><br />
                1. Sign up at <span className="link-btn" onClick={() => void ultron.app.openExternal('https://gnews.io/register')}>gnews.io/register</span>
                <br />
                2. Copy your API key
                <br />
                3. Paste it with the + button above, or in Settings
              </>
            ) : loading ? (
              'Syncing headlines...'
            ) : (
              'No headlines yet. Hit Refresh.'
            )}
          </div>
        ) : (
          visible.map((a) => <NewsItem key={a.id} article={a} />)
        )}
      </div>
    </HexPanel>
  );
}

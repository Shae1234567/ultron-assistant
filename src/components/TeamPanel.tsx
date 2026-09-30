import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { clockTime } from '../services/format';
import type { AgentId, AgentInfo, BrowserFrame } from '../types';

const STATUS_LABEL = { idle: 'STANDBY', working: 'WORKING', waiting: 'NEEDS YOU', done: 'DONE', error: 'FAILED' } as const;
const HELPER_LABEL = { working: 'on it', done: 'done', failed: 'failed' } as const;

function colorOf(info: AgentInfo[], id: AgentId): string {
  return info.find((a) => a.id === id)?.color ?? '#00d9ff';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Every agent's and helper's browser tab, live - open tabs first, newest first. */
function LiveBrowsers({ info }: { info: AgentInfo[] }) {
  const browsers = useStore((s) => s.browsers);
  const [zoom, setZoom] = useState<string | null>(null);
  const [, tick] = useState(0);

  // Re-render every couple of seconds so the "live" dots go quiet when a tab stops moving.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const frames = Object.values(browsers).sort((a, b) => Number(Boolean(a.closed)) - Number(Boolean(b.closed)) || b.at - a.at);
  if (!frames.length) return null;
  const open = frames.filter((f) => !f.closed).length;
  const zoomed: BrowserFrame | undefined = zoom ? browsers[zoom] : undefined;

  return (
    <>
      <div className="section-label">
        LIVE BROWSERS
        <span className="section-label__meta">{open ? `${open} open` : 'finished'} - click to enlarge</span>
      </div>
      <div className="browser-grid">
        {frames.slice(0, 8).map((f) => {
          const live = !f.closed && Date.now() - f.at < 6000;
          return (
            <button
              key={f.id}
              className={`browser-tile ${f.closed ? 'browser-tile--closed' : ''}`}
              style={{ '--agent': colorOf(info, f.agent) } as CSSProperties}
              onClick={() => setZoom(f.id)}
              title={`${f.title}\n${f.url}`}
            >
              <img className="browser-tile__img" src={f.image} alt={f.title || f.url} draggable={false} />
              <span className="browser-tile__label">
                <span className={`browser-tile__dot ${live ? 'browser-tile__dot--live' : ''}`} />
                {f.label}
              </span>
              <span className="browser-tile__url">{hostOf(f.url)}</span>
            </button>
          );
        })}
      </div>
      {zoomed && (
        <div className="browser-lightbox" onClick={() => setZoom(null)} role="dialog" aria-label="Browser view">
          <div className="browser-lightbox__frame" style={{ '--agent': colorOf(info, zoomed.agent) } as CSSProperties} onClick={(e) => e.stopPropagation()}>
            <div className="browser-lightbox__bar">
              <span className="browser-lightbox__label">{zoomed.label}</span>
              <span className="browser-lightbox__url">{zoomed.url}</span>
              <button className="mini-btn" onClick={() => void ultron.app.openExternal(zoomed.url)}>OPEN IN MY BROWSER</button>
              <button className="mini-btn" onClick={() => setZoom(null)}>CLOSE</button>
            </div>
            <img src={zoomed.image} alt={zoomed.title} draggable={false} />
          </div>
        </div>
      )}
    </>
  );
}

export function TeamPanel() {
  const info = useStore((s) => s.agentsInfo);
  const team = useStore((s) => s.team);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const live = team.phase !== 'idle';

  const working = info.filter((a) => {
    const st = team.agents[a.id]?.status;
    return st === 'working' || st === 'waiting';
  });
  const helpersWorking = team.helpers.filter((h) => h.status === 'working').length;

  const setMode = async (mode: 'auto' | 'full') => {
    if (!settings || settings.team.mode === mode) return;
    setSettings(await ultron.settings.save({ team: { mode } }));
  };

  const recent = team.log.slice(-40);
  const nameOf = (id: AgentId) => (info.find((a) => a.id === id)?.name ?? id).toUpperCase();

  return (
    <>
      <div className={`phase-strip ${live ? 'phase-strip--live' : ''}`}>
        <span className={`dot ${live ? 'dot--live' : ''}`} />
        <span title={team.timings.map((t) => `${t.label.toLowerCase()}: ${(t.ms / 1000).toFixed(1)}s`).join('\n')}>
          {live
            ? `${team.phaseLabel || 'WORKING'}${working.length ? ` - ${working.map((a) => a.name.toUpperCase()).join(', ')}` : ''}${helpersWorking ? ` + ${helpersWorking} HELPER${helpersWorking > 1 ? 'S' : ''}` : ''}`
            : team.timings.length
              ? `DONE IN ${(team.timings.reduce((n, t) => n + t.ms, 0) / 1000).toFixed(0)}s - ${team.timings.filter((t) => t.ms >= 1000).map((t) => `${t.label.replace(/^(ATHENA|ULTRON) /, '').toLowerCase()} ${(t.ms / 1000).toFixed(0)}s`).join(' · ')}`
              : 'TEAM STANDING BY'}
        </span>
        <span className="phase-strip__mode" title="Auto: Ultron pulls in whoever the task needs. Full: every specialist works on every task.">
          <span className={`chip ${settings?.team.mode === 'auto' ? '' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => void setMode('auto')}>AUTO</span>
          <span className={`chip ${settings?.team.mode === 'full' ? '' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => void setMode('full')}>FULL TEAM</span>
        </span>
      </div>

      <div className="panel-body" style={{ flex: '1 1 auto' }}>
        <div className="agent-grid">
          {info.map((a) => {
            const card = team.agents[a.id];
            const status = card?.status ?? 'idle';
            const helpers = team.helpers.filter((h) => h.parent === a.id);
            return (
              <div
                key={a.id}
                className={`agent-card agent-card--${status}`}
                style={{ '--agent': a.color } as CSSProperties}
                title={a.summary}
              >
                <div className="agent-card__head">
                  <span className="agent-card__name">{a.name.toUpperCase()}</span>
                  <span className="agent-card__title">{a.title}</span>
                  <span className="agent-card__status">{STATUS_LABEL[status]}</span>
                </div>
                <div className={`agent-card__task ${card?.task ? '' : 'agent-card__task--muted'}`}>
                  {card?.task || a.summary}
                </div>
                {helpers.length > 0 && (
                  <div className="helper-row">
                    {helpers.slice(0, 6).map((h) => (
                      <span key={h.id} className={`helper-chip helper-chip--${h.status}`} title={`${h.name} - ${HELPER_LABEL[h.status]}\n${h.task}${h.report ? `\n\n${h.report}` : ''}`}>
                        {h.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <LiveBrowsers info={info} />

        {team.plan.length > 0 && (
          <>
            <div className="section-label">
              PLAN
              {team.planNote && <span className="section-label__meta">{team.planNote}</span>}
            </div>
            {team.plan.map((st) => (
              <div
                key={st.id}
                className={`plan-step plan-step--${st.status ?? 'queued'}`}
                style={{ '--agent': colorOf(info, st.agent) } as CSSProperties}
              >
                <span className="plan-step__mark" />
                <span className="plan-step__agent">{nameOf(st.agent)}</span>
                <span className="plan-step__task">{st.task}</span>
              </div>
            ))}
          </>
        )}

        <div className="section-label">
          ACTIVITY
          <span className="section-label__meta">{recent.length ? `${team.log.length} actions` : 'quiet'}</span>
        </div>
        {recent.length === 0 ? (
          <div className="empty-note" style={{ paddingTop: 2 }}>
            Ask for something real - "what's going viral on TikTok and Reddit this week", "what's due on D2L this
            week", "tidy my Downloads folder", "play some lo-fi on Spotify" - and watch the team split it up, build helpers and browse here.
          </div>
        ) : (
          <div className="activity">
            {recent.map((l) => (
              <div
                key={l.id}
                className={`activity__line ${l.kind ? `activity__line--${l.kind}` : ''}`}
                style={{ '--agent': colorOf(info, l.agent) } as CSSProperties}
              >
                <span className="activity__time">{clockTime(l.at)}</span>
                <span className="activity__agent">{nameOf(l.agent)}{l.sub ? ` > ${l.sub.toUpperCase()}` : ''}</span>
                <span className="activity__text">{l.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

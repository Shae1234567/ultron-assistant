import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { GlitchText } from './hud/GlitchText';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const date = now.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  return (
    <div className="readout">
      <span className="readout__label">TIME</span>
      <span className="readout__value">
        {hh}:{mm}
        <span style={{ opacity: 0.55 }}>:{ss}</span>
      </span>
      <span className="readout__value" style={{ color: 'var(--dim)', fontSize: 11 }}>{date}</span>
    </div>
  );
}

export function TopBar() {
  const brain = useStore((s) => s.brain);
  const apps = useStore((s) => s.apps);
  const d2l = useStore((s) => s.d2l);
  const setOverlay = useStore((s) => s.setOverlay);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => ultron.win.onState(({ maximized: m }) => setMaximized(m)), []);

  const link = brain === null
    ? { label: 'PROBING', cls: 'chip--muted' }
    : brain.active
      ? { label: brain.label, cls: 'chip--good' }
      : { label: 'BRAIN OFFLINE', cls: 'chip--bad' };
  const connected = apps?.apps.filter((a) => a.status === 'connected').length ?? 0;
  const modules: { name: string; on: boolean }[] = [
    { name: 'BRAIN', on: Boolean(brain?.active) },
    { name: 'VOICE', on: typeof window !== 'undefined' && 'speechSynthesis' in window },
    { name: 'MEMORY', on: true },
    { name: connected ? `APPS ${connected}` : 'APPS', on: connected > 0 },
    { name: 'D2L', on: Boolean(d2l?.signedIn) },
  ];

  return (
    <div className="topbar">
      <div className="topbar__drag">
        <div>
          <div className="brand"><GlitchText>ULTRON</GlitchText></div>
          <div className="brand__sub">COMMAND CENTER v2.0</div>
        </div>

        <Clock />

        <div className="readout">
          <span className="readout__label">LINK</span>
          <span className={`chip ${link.cls}`}>
            <span className="dot dot--live" />
            {link.label}
          </span>
        </div>

        <div className="readout" style={{ gap: 5 }}>
          <span className="readout__label">MODULES</span>
          {modules.map((m) => (
            <span key={m.name} className={`chip ${m.on ? '' : 'chip--muted'}`}>{m.name}</span>
          ))}
        </div>

        {brain?.model && (
          <div className="readout">
            <span className="readout__label">MODEL</span>
            <span className="readout__value" style={{ fontSize: 11 }}>{brain.model}</span>
          </div>
        )}
      </div>

      <div className="topbar__nodrag">
        <button className="hud-btn" onClick={() => setOverlay({ kind: 'apps' })}>Apps</button>
        <button className="hud-btn" onClick={() => setOverlay({ kind: 'memory' })}>Memory</button>
        <button className="hud-btn" onClick={() => setOverlay({ kind: 'settings' })}>Settings</button>
        <button className="winbtn" title="Minimize" aria-label="Minimize window" onClick={() => void ultron.win.minimize()}>
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1" fill="currentColor" /></svg>
        </button>
        <button className="winbtn" title="Maximize" aria-label={maximized ? 'Restore window' : 'Maximize window'} aria-pressed={maximized} onClick={() => void ultron.win.maximize()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
            {maximized && <rect x="3.5" y="3.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />}
          </svg>
        </button>
        <button className="winbtn winbtn--close" title="Close to tray" aria-label="Close window to tray" onClick={() => void ultron.win.close()}>
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M1.5 1.5 L9.5 9.5 M9.5 1.5 L1.5 9.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { providerShort } from '../services/providers';
import { HexPanel } from './hud/HexPanel';
import { ArcMeter } from './hud/ArcMeter';
import { BarSpectrum } from './hud/BarSpectrum';
import { FilePanel } from './FilePanel';
import { TeamPanel } from './TeamPanel';
import { TasksPanel } from './TasksPanel';
import { useStore, type RightTab } from '../state/store';
import { ultron } from '../services/bridge';
import { checkHardwareThresholds } from '../services/hardwareAlerts';
import type { VaultStats } from '../types';

const TABS: { id: RightTab; label: string }[] = [
  { id: 'team', label: 'Team' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'system', label: 'System' },
];

// Module scope: SystemStatus unmounts on every tab switch, so component state
// would reset "Uptime" to zero each time the operator glances at another tab.
const APP_STARTED = Date.now();

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '5px 14px', borderBottom: '1px solid rgba(0,217,255,0.07)' }}>
      <span className="label-xs" style={{ minWidth: 78 }}>{label}</span>
      <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: tone === 'good' ? 'var(--green)' : tone === 'bad' ? 'var(--red)' : 'var(--white)' }}>
        {value}
      </span>
    </div>
  );
}

function SystemStatus() {
  const brain = useStore((s) => s.brain);
  const quota = useStore((s) => s.quota);
  const tasks = useStore((s) => s.tasks);
  const apps = useStore((s) => s.apps);
  const d2l = useStore((s) => s.d2l);
  const setOverlay = useStore((s) => s.setOverlay);
  const [versions, setVersions] = useState<{ electron: string; chrome: string; node: string } | null>(null);
  const [vault, setVault] = useState<VaultStats | null>(null);
  const [uptime, setUptime] = useState(0);
  const [hw, setHw] = useState<{ cpuPercent: number; ramPercent: number; ramUsedGB: number; ramTotalGB: number } | null>(null);

  useEffect(() => {
    void ultron.app.versions().then(setVersions);
    void ultron.vault.stats().then(setVault);
    const id = setInterval(() => setUptime(Math.floor((Date.now() - APP_STARTED) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const poll = () => {
      void ultron.system.hardwareStats().then((s) => {
        setHw(s);
        checkHardwareThresholds({ cpuPercent: s.cpuPercent, ramPercent: s.ramPercent });
      });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const brainOk = Boolean(brain?.active);
  const open = tasks.filter((t) => !t.done).length;
  const connected = apps?.apps.filter((a) => a.status === 'connected').length ?? 0;
  const hh = String(Math.floor(uptime / 3600)).padStart(2, '0');
  const mm = String(Math.floor((uptime % 3600) / 60)).padStart(2, '0');
  const ss = String(uptime % 60).padStart(2, '0');

  return (
    <>
      <div style={{ display: 'flex', gap: 8, padding: '12px 10px', justifyContent: 'space-around', borderBottom: '1px solid var(--cyan-20)', flex: '0 0 auto' }}>
        <ArcMeter value={brainOk ? 1 : 0} size={68} readout={brain?.active ? providerShort(brain.active) : 'X'} label="BRAIN"
          color={brainOk ? 'var(--green)' : 'var(--red)'} />
        <ArcMeter value={Math.min(1, open / 10)} size={68} readout={`${open}`} label="TASKS" />
        <ArcMeter value={quota ? quota.used / quota.cap : 0} size={68} readout={`${quota?.used ?? 0}`} label="API/DAY" />
        <ArcMeter value={(hw?.cpuPercent ?? 0) / 100} size={68} readout={hw ? `${hw.cpuPercent}` : '--'} label="CPU"
          color={hw && hw.cpuPercent >= 90 ? 'var(--red)' : undefined} />
        <ArcMeter value={(hw?.ramPercent ?? 0) / 100} size={68} readout={hw ? `${hw.ramPercent}` : '--'} label="RAM"
          color={hw && hw.ramPercent >= 90 ? 'var(--red)' : undefined} />
      </div>

      <div style={{ padding: '8px 12px 2px', flex: '0 0 auto' }}>
        <div className="label-xs" style={{ marginBottom: 4 }}>SIGNAL</div>
        <BarSpectrum bars={40} height={40} live seed={3} />
      </div>

      <div className="panel-body" style={{ flex: '1 1 auto' }}>
        <Row label="Brain" value={brainOk ? `${brain!.label} - ${brain!.model}` : 'no brain available'} tone={brainOk ? 'good' : 'bad'} />
        <Row
          label="Gemini"
          value={!brain?.gemini.configured ? 'no key' : brain.gemini.valid ? `ok - ${brain.gemini.model}` : (brain.gemini.error ?? 'not verified')}
          tone={brain?.gemini.valid ? 'good' : brain?.gemini.configured ? 'bad' : undefined}
        />
        <Row
          label="Local"
          value={!brain?.ollama.running ? (brain?.ollama.error ?? 'offline') : brain.ollama.modelInstalled ? `${brain.ollama.activeModel} @ ${brain.ollama.host}` : `"${brain.ollama.activeModel}" not downloaded`}
          tone={brain?.ollama.running && brain.ollama.modelInstalled ? 'good' : 'bad'}
        />
        <Row label="Vault" value={vault ? `${vault.notes} notes - ${vault.root}` : '...'} />
        <Row label="Apps" value={apps?.hasKey ? `${connected} connected via Composio` : 'Composio not set up'} tone={connected ? 'good' : undefined} />
        <Row label="D2L" value={d2l?.signedIn ? `signed in${d2l.user ? ` as ${d2l.user}` : ''}` : 'not signed in'} tone={d2l?.signedIn ? 'good' : undefined} />
        <Row label="News" value={quota ? `${quota.used}/${quota.cap} requests today` : 'not initialised'} />
        <Row label="Uptime" value={`${hh}:${mm}:${ss}`} />
        {hw && <Row label="Memory" value={`${hw.ramUsedGB} GB / ${hw.ramTotalGB} GB used`} tone={hw.ramPercent >= 90 ? 'bad' : undefined} />}
        {versions && <Row label="Runtime" value={`Electron ${versions.electron} / Chromium ${versions.chrome} / Node ${versions.node}`} />}
        <div style={{ padding: '10px 12px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="hud-btn" onClick={() => setOverlay({ kind: 'brain' })}>Brain setup</button>
          <button className="hud-btn" onClick={() => setOverlay({ kind: 'apps' })}>Apps</button>
          <button className="hud-btn" onClick={() => setOverlay({ kind: 'settings' })}>Settings</button>
        </div>
      </div>
    </>
  );
}

export function SystemPanel() {
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);
  const openTasks = useStore((s) => s.tasks.filter((t) => !t.done).length);
  const teamLive = useStore((s) => s.team.phase !== 'idle');

  return (
    <HexPanel title="Systems" meta={tab.toUpperCase()} scroll={false}>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'tab--active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'tasks' && openTasks > 0 ? ` ${openTasks}` : ''}
            {t.id === 'team' && teamLive ? ' *' : ''}
          </button>
        ))}
      </div>
      {tab === 'team' && <TeamPanel />}
      {tab === 'tasks' && <TasksPanel />}
      {tab === 'files' && <FilePanel />}
      {tab === 'system' && <SystemStatus />}
    </HexPanel>
  );
}

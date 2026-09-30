import { useEffect, useState } from 'react';
import { Overlay } from './Overlay';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';

const RECOMMENDED = [
  { model: 'qwen3.5:4b', size: '3.4 GB', why: 'Default. Fits entirely in a 6 GB GPU - fast, tool-capable, can see images.' },
  { model: 'qwen3.5:9b', size: '6.6 GB', why: 'Smarter, but spills past 6 GB of VRAM onto the CPU - noticeably slower.' },
  { model: 'nomic-embed-text', size: '274 MB', why: 'Powers memory search (meaning, not just keywords).' },
];

interface Pull { model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }

export function BrainSetup({ onClose }: { onClose: () => void }) {
  const brain = useStore((s) => s.brain);
  const setBrain = useStore((s) => s.setBrain);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [pulls, setPulls] = useState<Record<string, Pull>>({});

  useEffect(() => ultron.ollama.onPullProgress((p) => {
    setPulls((prev) => ({ ...prev, [p.model]: p }));
    if (p.done) void ultron.brain.recheck().then(setBrain);
  }), [setBrain]);

  useEffect(() => { void ultron.brain.recheck().then(setBrain); }, [setBrain]);

  const saveKey = async () => {
    const value = key.trim();
    if (!value) return;
    setMsg({ text: 'Testing the key with Google...' });
    const res = await ultron.secrets.set('GEMINI_API_KEY', value);
    setMsg(res.ok ? { text: res.detail ?? 'Saved.' } : { text: res.error ?? 'Gemini did not accept the key.', bad: true });
    if (res.ok) setKey('');
    setBrain(await ultron.brain.status());
  };

  const useModel = async (model: string) => {
    if (!settings) return;
    setSettings(await ultron.settings.save({ ollama: { ...settings.ollama, model } }));
    setBrain(await ultron.brain.recheck());
  };

  const g = brain?.gemini;
  const o = brain?.ollama;
  const installed = new Set((o?.models ?? []).map((m) => m.replace(/:latest$/, '')));

  return (
    <Overlay title="Brain" meta={brain?.label ?? 'CHECKING'} onClose={onClose}>
      <div className="field__hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Ultron has two brains. <strong style={{ color: 'var(--cyan)' }}>Gemini</strong> (hosted, far smarter) does the heavy
        lifting when its key works; the <strong style={{ color: 'var(--cyan)' }}>local model</strong> (Ollama, free, private)
        handles background jobs and takes over automatically if Gemini is rate-limited or offline.
      </div>

      <div className="subhead">GEMINI</div>
      <div className="field">
        <div className={`chip ${g?.valid ? 'chip--good' : g?.configured ? 'chip--bad' : 'chip--muted'}`} style={{ marginBottom: 6 }}>
          <span className="dot" />
          {g?.valid ? `WORKING - ${g.model}` : g?.configured ? `KEY PROBLEM: ${g.error ?? 'not verified yet'}` : 'NO KEY'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="hud-input"
            type="password"
            placeholder={g?.configured ? 'paste a new key to replace it' : 'paste your Gemini API key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
          />
          <button className="hud-btn hud-btn--active" onClick={() => void saveKey()} disabled={!key.trim()}>Save &amp; test</button>
        </div>
        <div className="field__hint">
          Free from <span className="link-btn" onClick={() => void ultron.app.openExternal('https://aistudio.google.com/apikey')}>aistudio.google.com/apikey</span>.
          The key is tested the moment you save it, and Ultron picks the newest Flash model your key can use - so Google
          retiring a model name can't break it again.
        </div>
        {msg && <div className={`alert-strip ${msg.bad ? 'alert-strip--warn' : 'alert-strip--info'}`} style={{ marginTop: 8 }}><span className="dot" />{msg.text}</div>}
      </div>

      <div className="divider" />
      <div className="subhead">LOCAL MODEL (OLLAMA)</div>
      <div className="field">
        <div className={`chip ${o?.running && o.modelInstalled ? 'chip--good' : 'chip--bad'}`} style={{ marginBottom: 8 }}>
          <span className="dot" />
          {!o ? 'CHECKING' : !o.running ? 'OLLAMA NOT RUNNING' : o.modelInstalled ? `ONLINE - ${o.activeModel}` : `"${o.activeModel}" NOT DOWNLOADED`}
        </div>
        {!o?.running && (
          <div className="field__hint" style={{ marginBottom: 10 }}>
            Start Ollama from the Start menu (or run <span className="mono" style={{ color: 'var(--green)' }}>ollama serve</span>).
            Not installed? <span className="link-btn" onClick={() => void ultron.app.openExternal('https://ollama.com/download')}>ollama.com/download</span>
          </div>
        )}
        {RECOMMENDED.map((r) => {
          const has = installed.has(r.model);
          const pull = pulls[r.model];
          const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : 0;
          const active = settings?.ollama.model === r.model;
          const isChat = r.model !== 'nomic-embed-text';
          return (
            <div key={r.model} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,217,255,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ color: 'var(--white)', fontSize: 12 }}>{r.model}</span>
                <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>{r.size}</span>
                {active && <span className="chip chip--good">IN USE</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                  {has && isChat && !active && <button className="mini-btn" onClick={() => void useModel(r.model)}>USE</button>}
                  {!has && (
                    <button className="mini-btn" disabled={!o?.running || Boolean(pull && !pull.done && !pull.error)} onClick={() => void ultron.ollama.pull(r.model)}>
                      {pull && !pull.done && !pull.error ? `${pct}%` : 'DOWNLOAD'}
                    </button>
                  )}
                  {has && !isChat && <span className="chip chip--good">INSTALLED</span>}
                </span>
              </div>
              <div className="field__hint" style={{ marginTop: 2 }}>{pull?.error ? `Download failed: ${pull.error}` : r.why}</div>
              {pull && !pull.done && !pull.error && pull.total ? <div className="progress"><div className="progress__fill" style={{ width: `${pct}%` }} /></div> : null}
            </div>
          );
        })}
        {o?.running && o.models.length > 0 && (
          <div className="field" style={{ marginTop: 12 }}>
            <span className="field__label">Or pick any installed model</span>
            <select className="hud-input" value={settings?.ollama.model ?? ''} onChange={(e) => void useModel(e.target.value)}>
              {!o.models.some((m) => m === settings?.ollama.model) && settings?.ollama.model && (
                <option value={settings.ollama.model}>{settings.ollama.model} (not downloaded)</option>
              )}
              {o.models.filter((m) => !/embed/i.test(m)).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
        <div className="field__hint">
          Want a much bigger brain without a bigger GPU? Run <span className="mono" style={{ color: 'var(--green)' }}>ollama signin</span> once
          in a terminal, then download <span className="mono" style={{ color: 'var(--green)' }}>qwen3.5:397b-cloud</span> - a 397B model that runs on
          Ollama's servers (free tier with usage limits, needs internet).
        </div>
      </div>
    </Overlay>
  );
}

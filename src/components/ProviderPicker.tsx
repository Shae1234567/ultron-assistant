import { useState } from 'react';
import { ultron } from '../services/bridge';
import type { BrainStatus, SecretName, Settings } from '../types';

/**
 * Choosing Ultron's AI: which provider answers, its key and its model. Used by Settings and by the first-run setup.
 * Keys are typed into drafts here and saved (encrypted on this PC) by the parent's Save / Finish button.
 */

export type KeyDrafts = Partial<Record<SecretName, string>>;
type Choice = Settings['brain'];

const CHOICES: [Choice, string][] = [
  ['auto', 'AUTOMATIC'],
  ['gemini', 'GEMINI'],
  ['anthropic', 'CLAUDE'],
  ['openai', 'OPENAI-COMPATIBLE'],
  ['ollama', 'LOCAL ONLY'],
];

const OPENAI_PRESETS: { name: string; url: string; keyUrl?: string; example: string }[] = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', example: 'the model name from your OpenAI account' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', example: 'a model id from openrouter.ai/models' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', example: 'a model from your Groq console' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', example: 'e.g. deepseek-chat' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1', example: 'the model loaded in LM Studio (no key needed)' },
];

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];

function Key({ name, label, has, value, onChange, hint }: { name: SecretName; label: string; has: boolean; value: string; onChange: (v: string) => void; hint: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className={`chip ${has ? 'chip--good' : 'chip--muted'}`} style={{ marginBottom: 6 }}>
        <span className="dot" /> {has ? 'KEY SAVED' : 'NO KEY'}
      </div>
      <input
        className="hud-input"
        type="password"
        placeholder={has ? 'paste a new key to replace it' : 'paste the key'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={name}
      />
      <div className="field__hint">{hint}</div>
    </div>
  );
}

const link = (url: string, text: string) => <span className="link-btn" onClick={() => void ultron.app.openExternal(url)}>{text}</span>;

export function ProviderPicker({ draft, patch, keys, setKey, hasKey, brain, only }: {
  draft: Settings;
  patch: (fn: (d: Settings) => Settings) => void;
  keys: KeyDrafts;
  setKey: (name: SecretName) => (v: string) => void;
  hasKey: Record<SecretName, boolean> | null;
  brain: BrainStatus | null;
  /** First-run setup: show only the chosen provider's fields. */
  only?: boolean;
}) {
  const [models, setModels] = useState<{ openai?: string[]; anthropic?: string[] }>({});
  const [check, setCheck] = useState<{ text: string; bad?: boolean } | null>(null);
  const show = (p: Choice) => !only || draft.brain === p || (draft.brain === 'auto' && p === 'gemini');

  const loadModels = async (p: 'openai' | 'anthropic') => {
    const name: SecretName = p === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (keys[name]?.trim()) {
      setCheck({ text: 'Save first - the key is checked once it is saved.', bad: true });
      return;
    }
    setCheck({ text: 'Checking...' });
    const r = await ultron.brain.checkCloud(p);
    if (r?.models?.length) {
      setModels((m) => ({ ...m, [p]: r.models }));
      setCheck({ text: `The key works - ${r.models.length} models available.` });
    } else setCheck({ text: r?.error ?? 'No key saved yet, or the service did not answer.', bad: true });
  };

  const g = brain?.gemini;
  const geminiModels = g?.models ?? [];

  return (
    <>
      <div className="field">
        <span className="field__label">Which AI answers</span>
        <div className="tag-row">
          {CHOICES.map(([v, label]) => (
            <span key={v} className={`chip ${draft.brain === v ? 'chip--good' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => patch((d) => ({ ...d, brain: v }))}>{label}</span>
          ))}
        </div>
        <div className="field__hint">
          {draft.brain === 'auto' && 'Automatic: the first of Gemini, Claude and OpenAI-compatible that has a key; a local model (Ollama), if installed, is the backup and does background jobs.'}
          {draft.brain === 'gemini' && 'Gemini: free key, generous free tier, and Google Search built in. The easiest start.'}
          {draft.brain === 'anthropic' && 'Claude: Anthropic\'s models - excellent at tools and reasoning. Paid by usage on your Anthropic account.'}
          {draft.brain === 'openai' && 'Any service with an OpenAI-style API: OpenAI, OpenRouter (hundreds of models, some free), Groq, DeepSeek, or LM Studio on this PC.'}
          {draft.brain === 'ollama' && 'Local only: a model running on this PC through Ollama - free and private, but needs a decent graphics card and is much less capable.'}
          {brain && !only && <> Now: <span className="mono" style={{ color: brain.active ? 'var(--green)' : 'var(--red)' }}>{brain.active ? `${brain.label} - ${brain.model}` : 'no AI available yet'}</span>.</>}
        </div>
      </div>

      {show('gemini') && (
        <>
          <Key
            name="GEMINI_API_KEY" label="Gemini API key" has={Boolean(hasKey?.GEMINI_API_KEY)} value={keys.GEMINI_API_KEY ?? ''} onChange={setKey('GEMINI_API_KEY')}
            hint={<>Free at {link('https://aistudio.google.com/apikey', 'aistudio.google.com/apikey')} (sign in with Google, press Create API key). {g?.configured && (g.valid ? <span style={{ color: 'var(--green)' }}>Working - {g.model}.</span> : <span style={{ color: 'var(--red)' }}>{g.error ?? 'Not verified yet.'}</span>)}</>}
          />
          {!only && (
            <div className="field">
              <span className="field__label">Gemini model</span>
              <select className="hud-input" value={draft.gemini.model} onChange={(e) => patch((d) => ({ ...d, gemini: { model: e.target.value } }))}>
                <option value="">Automatic - newest Flash ({g?.model ?? 'needs a working key'})</option>
                {geminiModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
        </>
      )}

      {show('anthropic') && (
        <>
          <Key
            name="ANTHROPIC_API_KEY" label="Claude (Anthropic) API key" has={Boolean(hasKey?.ANTHROPIC_API_KEY)} value={keys.ANTHROPIC_API_KEY ?? ''} onChange={setKey('ANTHROPIC_API_KEY')}
            hint={<>From {link('https://console.anthropic.com/settings/keys', 'console.anthropic.com')} (needs credit on the account). {brain?.anthropic.configured && (brain.anthropic.valid === false ? <span style={{ color: 'var(--red)' }}>{brain.anthropic.error ?? 'Key refused.'}</span> : brain.anthropic.valid ? <span style={{ color: 'var(--green)' }}>Working.</span> : null)}</>}
          />
          <div className="field">
            <span className="field__label">Claude model</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="hud-input" list="claude-models" value={draft.anthropic.model} onChange={(e) => patch((d) => ({ ...d, anthropic: { model: e.target.value.trim() } }))} />
              {!only && <button className="hud-btn" onClick={() => void loadModels('anthropic')}>Check key</button>}
            </div>
            <datalist id="claude-models">{[...new Set([...CLAUDE_MODELS, ...(models.anthropic ?? [])])].map((m) => <option key={m} value={m} />)}</datalist>
            <div className="field__hint">claude-opus-5-5 is the smartest; claude-sonnet-5-5 costs half as much; claude-haiku-4-5 is the fastest and cheapest.</div>
          </div>
        </>
      )}

      {show('openai') && (
        <>
          <div className="field">
            <span className="field__label">OpenAI-compatible service</span>
            <div className="tag-row">
              {OPENAI_PRESETS.map((p) => (
                <span key={p.name} className={`chip ${draft.openai.baseUrl === p.url ? 'chip--good' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => patch((d) => ({ ...d, openai: { ...d.openai, baseUrl: p.url } }))}>{p.name.toUpperCase()}</span>
              ))}
            </div>
            <input className="hud-input" style={{ marginTop: 6 }} value={draft.openai.baseUrl} onChange={(e) => patch((d) => ({ ...d, openai: { ...d.openai, baseUrl: e.target.value.trim() } }))} aria-label="OpenAI-compatible base URL" />
            <div className="field__hint">
              The address of the service's API (it ends in /v1).
              {(() => { const p = OPENAI_PRESETS.find((x) => x.url === draft.openai.baseUrl); return p?.keyUrl ? <> Get a key at {link(p.keyUrl, p.keyUrl.replace(/^https:\/\//, ''))}.</> : null; })()}
            </div>
          </div>
          <Key
            name="OPENAI_API_KEY" label="API key for that service" has={Boolean(hasKey?.OPENAI_API_KEY)} value={keys.OPENAI_API_KEY ?? ''} onChange={setKey('OPENAI_API_KEY')}
            hint={<>Not needed for LM Studio or another server on this PC. {brain?.openai.configured && (brain.openai.valid === false ? <span style={{ color: 'var(--red)' }}>{brain.openai.error ?? 'Key refused.'}</span> : brain.openai.valid ? <span style={{ color: 'var(--green)' }}>Working.</span> : null)}</>}
          />
          <div className="field">
            <span className="field__label">Model</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="hud-input" list="openai-models" placeholder={OPENAI_PRESETS.find((x) => x.url === draft.openai.baseUrl)?.example ?? 'model name'} value={draft.openai.model} onChange={(e) => patch((d) => ({ ...d, openai: { ...d.openai, model: e.target.value.trim() } }))} />
              {!only && <button className="hud-btn" onClick={() => void loadModels('openai')}>Load models</button>}
            </div>
            <datalist id="openai-models">{(models.openai ?? []).map((m) => <option key={m} value={m} />)}</datalist>
            <div className="field__hint">Pick a model that supports tool calling - Ultron's agents act through tools.</div>
          </div>
        </>
      )}

      {show('ollama') && only && (
        <div className="field__hint">
          Install Ollama from {link('https://ollama.com/download', 'ollama.com/download')}, then open Settings - Brain setup to download a model
          (qwen3.5:4b needs about 3.4 GB and a 6 GB graphics card).
        </div>
      )}

      {check && <div className={`alert-strip ${check.bad ? 'alert-strip--warn' : 'alert-strip--info'}`} style={{ marginTop: 6 }}><span className="dot" />{check.text}</div>}
    </>
  );
}

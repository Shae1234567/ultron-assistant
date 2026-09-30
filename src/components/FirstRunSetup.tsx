import { useEffect, useState } from 'react';
import { Overlay } from './Overlay';
import { ProviderPicker, type KeyDrafts } from './ProviderPicker';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import type { SecretName, Settings } from '../types';

/**
 * The first thing a new install shows: who you are, which AI Ultron runs on, and where to connect apps.
 * Everything here can be changed later in Settings; Skip leaves the defaults.
 */
export function FirstRunSetup({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const brain = useStore((s) => s.brain);
  const setBrain = useStore((s) => s.setBrain);
  const setOverlay = useStore((s) => s.setOverlay);

  const [draft, setDraft] = useState<Settings | null>(settings);
  const [keys, setKeys] = useState<KeyDrafts>({});
  const [hasKey, setHasKey] = useState<Record<SecretName, boolean> | null>(null);
  const [interests, setInterests] = useState((settings?.profile.interests ?? []).join(', '));
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void ultron.secrets.status().then(setHasKey); }, []);
  useEffect(() => { if (!draft && settings) setDraft(settings); }, [settings, draft]);
  if (!draft) return null;

  const patch = (fn: (d: Settings) => Settings) => setDraft(fn(draft));
  const setKey = (name: SecretName) => (v: string) => setKeys((k) => ({ ...k, [name]: v }));

  const finish = async (then?: 'apps') => {
    setSaving(true);
    const profile = { ...draft.profile, interests: interests.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) };
    const next = await ultron.settings.save({ ...draft, profile, setupDone: true });
    setSettings(next);
    const problems: string[] = [];
    for (const [name, value] of Object.entries(keys) as [SecretName, string][]) {
      if (!value?.trim()) continue;
      const res = await ultron.secrets.set(name, value.trim());
      if (!res.ok) problems.push(res.error ?? `${name} was not accepted`);
    }
    setKeys({});
    setHasKey(await ultron.secrets.status());
    const b = await ultron.brain.recheck();
    setBrain(b);
    setSaving(false);
    if (problems.length) {
      setStatus({ text: `${problems.join(' | ')} - fix the key and press Finish again.`, bad: true });
      return;
    }
    if (then === 'apps') setOverlay({ kind: 'apps' });
    else onClose();
  };

  const skip = async () => {
    setSettings(await ultron.settings.save({ ...draft, setupDone: true }));
    onClose();
  };

  return (
    <Overlay
      title="Welcome to Ultron"
      meta="FIRST-TIME SETUP"
      onClose={() => void skip()}
      footer={
        <>
          {status && <span className="mono" style={{ fontSize: 11, color: status.bad ? 'var(--red)' : 'var(--green)', marginRight: 'auto', maxWidth: '70%' }}>{status.text}</span>}
          <button className="hud-btn" onClick={() => void skip()} disabled={saving}>Skip for now</button>
          <button className="hud-btn hud-btn--active" onClick={() => void finish()} disabled={saving}>{saving ? 'Checking...' : 'Finish'}</button>
        </>
      }
    >
      <div className="field__hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Three quick things. Everything stays on this PC: your settings, your memory vault, and your keys (encrypted by Windows).
        You can change any of it later in Settings.
      </div>

      <div className="subhead">1 - ABOUT YOU</div>
      <div className="field">
        <span className="field__label">What should Ultron call you?</span>
        <input className="hud-input" value={draft.profile.name} placeholder="your first name" onChange={(e) => patch((d) => ({ ...d, profile: { ...d.profile, name: e.target.value } }))} />
      </div>
      <div className="field">
        <span className="field__label">Your city</span>
        <input className="hud-input" value={draft.profile.location} placeholder="e.g. Toronto, Canada - for weather and local news" onChange={(e) => patch((d) => ({ ...d, profile: { ...d.profile, location: e.target.value } }))} />
      </div>
      <div className="field">
        <span className="field__label">Interests (optional)</span>
        <input className="hud-input" value={interests} placeholder="e.g. soccer, history, coding" onChange={(e) => setInterests(e.target.value)} />
      </div>
      <div className="field">
        <span className="field__label">Age</span>
        <div className="tag-row">
          <span className={`chip ${draft.profile.under18 ? 'chip--good' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => patch((d) => ({ ...d, profile: { ...d.profile, under18: true } }))}>UNDER 18</span>
          <span className={`chip ${!draft.profile.under18 ? 'chip--good' : 'chip--muted'}`} style={{ cursor: 'pointer' }} onClick={() => patch((d) => ({ ...d, profile: { ...d.profile, under18: false } }))}>18 OR OVER</span>
        </div>
        <div className="field__hint">Under 18: Ultron stays a tool, not a companion, and teaches and explains schoolwork instead of writing it for you to hand in.</div>
      </div>

      <div className="divider" />
      <div className="subhead">2 - YOUR AI</div>
      <ProviderPicker draft={draft} patch={patch} keys={keys} setKey={setKey} hasKey={hasKey} brain={brain} only />

      <div className="divider" />
      <div className="subhead">3 - YOUR APPS (OPTIONAL)</div>
      <div className="field__hint" style={{ marginBottom: 8 }}>
        Ultron can work in Gmail, Google Calendar, Docs, Drive, Notion, GitHub, Spotify, Instagram and more - you pick which ones.
        It uses Composio: you sign in with a free Composio account, then press Connect next to each app you want. Ultron asks you
        before it sends, posts or deletes anything.
      </div>
      <button className="hud-btn" onClick={() => void finish('apps')} disabled={saving}>Finish and open the Apps panel</button>
    </Overlay>
  );
}

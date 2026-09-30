import { useEffect, useState } from 'react';
import { Overlay } from './Overlay';
import { ultron } from '../services/bridge';

export function FileEditor({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void ultron.files.read(path).then((res) => {
      if (cancelled) return;
      if (res.ok) { setContent(res.content ?? ''); setOriginal(res.content ?? ''); }
      else setError(res.error ?? 'Could not open file.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [path]);

  const dirty = content !== original;
  const name = path.split(/[\/]/).pop() ?? path;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await ultron.files.write(path, content);
      if (res.ok) { setOriginal(content); setSaved(true); setTimeout(() => setSaved(false), 1800); }
      else setError(res.error ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      title={name}
      meta={dirty ? 'UNSAVED' : 'EDIT'}
      onClose={onClose}
      footer={
        <>
          {saved && <span className="mono" style={{ fontSize: 11, color: 'var(--green)', marginRight: 'auto' }}>Saved.</span>}
          {error && <span className="mono" style={{ fontSize: 11, color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
          <button className="hud-btn" onClick={() => setContent(original)} disabled={!dirty || saving}>Revert</button>
          <button className="hud-btn hud-btn--active" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="empty-note">Opening...</div>
      ) : error && !content ? (
        <div className="empty-note" style={{ color: 'var(--red)' }}>{error}</div>
      ) : (
        <>
          <textarea
            className="hud-input"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 420, resize: 'vertical',
              fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre',
            }}
          />
          <div className="field__hint" style={{ marginTop: 8 }}>
            <span className="mono" style={{ color: 'var(--cyan)' }}>{path}</span>
          </div>
        </>
      )}
    </Overlay>
  );
}

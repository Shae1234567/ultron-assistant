import { useState } from 'react';
import { ultron } from '../services/bridge';

/** The four single-purpose operations this panel can run on copied text. */
type ClipboardAction = 'translate' | 'summarise' | 'explain' | 'fix';

const ACTION_LABELS: Record<ClipboardAction, string> = {
  translate: 'Translate',
  summarise: 'Summarise',
  explain: 'Explain',
  fix: 'Fix',
};

/** Each instruction is deliberately narrow - one operation, nothing else,
 *  and an explicit "reply with ONLY the result" clause so the panel can
 *  show the model's output directly with no stripping/parsing needed. */
const ACTION_INSTRUCTIONS: Record<ClipboardAction, string> = {
  translate:
    "Translate the following text to English if it isn't already, or to French if it "
    + 'already is English - detect and pick the more useful direction. Reply with ONLY '
    + 'the translation, no commentary.',
  summarise:
    'Summarise the following text in a few concise sentences, capturing only the key '
    + 'points. Reply with ONLY the summary, no commentary, no preamble like "Here is a summary".',
  explain:
    'Explain the following text in plain, simple language, as if to someone unfamiliar '
    + 'with the subject. Reply with ONLY the explanation, no commentary, no preamble.',
  fix:
    'Fix the grammar, spelling, and punctuation of the following text without changing '
    + 'its meaning, tone, or intent. Reply with ONLY the corrected text, no commentary.',
};

const PREVIEW_LENGTH = 120;

/**
 * Floating action panel shown when new clipboard text is detected. Anchored
 * to a fixed corner of the viewport rather than the actual cursor position -
 * tracking real OS-level cursor coordinates isn't easily available from the
 * renderer process, and a fixed corner is unobtrusive enough not to need it.
 */
export function ClipboardPanel({ text, onClose }: { text: string; onClose: () => void }): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const preview = text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;

  async function runAction(action: ClipboardAction): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await ultron.brain.once({ system: ACTION_INSTRUCTIONS[action], user: text, tier: 'main', temperature: 0.3 });
      if (!res.ok) throw new Error(res.error);
      setResult(res.text.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function copyResult(): Promise<void> {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can be denied by the OS/browser permission model -
      // not worth surfacing as a hard error, the copy button just stays put.
    }
  }

  const showResultView = result !== null || error !== null;

  return (
    <div
      className="holo-panel"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        width: 300,
        padding: '12px 14px',
        zIndex: 9999,
        fontFamily: 'var(--font-ui)',
        color: 'var(--white)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 10,
          letterSpacing: '0.18em',
          color: 'var(--cyan)',
          textShadow: 'var(--text-glow)',
          marginBottom: 8,
        }}
      >
        CLIPBOARD INTEL
      </div>

      <div
        style={{
          fontSize: 12,
          color: 'var(--dim)',
          background: 'rgba(0, 217, 255, 0.06)',
          border: '1px solid var(--cyan-20)',
          padding: '6px 8px',
          marginBottom: 10,
          maxHeight: 60,
          overflow: 'hidden',
        }}
      >
        {preview}
      </div>

      {!showResultView && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 6,
            }}
          >
            {(Object.keys(ACTION_LABELS) as ClipboardAction[]).map((action) => (
              <button
                key={action}
                disabled={loading}
                onClick={() => void runAction(action)}
                style={{
                  border: '1px solid var(--cyan-35)',
                  color: 'var(--cyan)',
                  padding: '6px 4px',
                  fontSize: 12,
                  letterSpacing: '0.04em',
                  background: 'rgba(0, 217, 255, 0.04)',
                  opacity: loading ? 0.5 : 1,
                  cursor: loading ? 'default' : 'pointer',
                }}
              >
                {ACTION_LABELS[action]}
              </button>
            ))}
          </div>
          {loading && (
            <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 8 }}>Thinking...</div>
          )}
          <button
            onClick={onClose}
            style={{
              marginTop: 8,
              fontSize: 11,
              color: 'var(--dim)',
              width: '100%',
              textAlign: 'center',
              padding: '4px 0',
            }}
          >
            Close
          </button>
        </>
      )}

      {showResultView && (
        <>
          <div
            style={{
              fontSize: 12,
              color: error ? 'var(--red)' : 'var(--white)',
              maxHeight: 180,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              marginBottom: 10,
            }}
          >
            {error ?? result}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {result && (
              <button
                onClick={() => void copyResult()}
                style={{
                  flex: 1,
                  border: '1px solid var(--cyan-35)',
                  color: 'var(--cyan)',
                  padding: '6px 4px',
                  fontSize: 12,
                  background: 'rgba(0, 217, 255, 0.04)',
                }}
              >
                {copied ? 'Copied' : 'Copy result'}
              </button>
            )}
            <button
              onClick={onClose}
              style={{
                flex: 1,
                border: '1px solid var(--cyan-20)',
                color: 'var(--dim)',
                padding: '6px 4px',
                fontSize: 12,
                background: 'none',
              }}
            >
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

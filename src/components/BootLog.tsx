import { useEffect, useRef, useState, type CSSProperties } from 'react';

// NOTE: `src/styles/bootlog.css` must be imported once globally (e.g. in
// `src/main.tsx`, alongside the existing `boot.css` import) - not done here.

type CheckKey = 'memory' | 'settings' | 'brain' | 'voice';
type CheckStatus = 'pending' | 'ok' | 'warn';

const CHECK_ORDER: CheckKey[] = ['memory', 'settings', 'brain', 'voice'];
const CHECK_LABEL: Record<CheckKey, string> = {
  memory: 'MEMORY',
  settings: 'SETTINGS',
  brain: 'BRAIN',
  voice: 'VOICE (TTS)',
};

// Fixed column every label+dots run pads out to, so lines don't reflow as
// they type (mirrors the proposal's "28ch fixed column" intent).
const DOT_COLUMN = 24;

function padLabel(label: string): string {
  const dots = '.'.repeat(Math.max(1, DOT_COLUMN - label.length));
  return `${label}${dots}`;
}

interface BootLogProps {
  bootChecks: Record<CheckKey, CheckStatus>;
}

/**
 * Typed-out terminal-style log rendered under the boot checks. One line per
 * check, in a fixed order, each appearing only once that check actually
 * leaves 'pending' - never before, never on a fixed timer. When a latency
 * number is shown, it's a real performance.now() delta captured the instant
 * this component observes the pending -> settled transition; if a check was
 * already settled before this component mounted, no number is fabricated
 * for it.
 */
export function BootLog({ bootChecks }: BootLogProps) {
  const mountedAt = useRef(performance.now());
  const prevChecks = useRef<Record<CheckKey, CheckStatus>>(bootChecks);
  const [elapsedByCheck, setElapsedByCheck] = useState<Partial<Record<CheckKey, number>>>({});
  const [doneTyping, setDoneTyping] = useState<Partial<Record<CheckKey, boolean>>>({});

  useEffect(() => {
    const prev = prevChecks.current;
    const now = performance.now();
    const updates: Partial<Record<CheckKey, number>> = {};

    for (const key of CHECK_ORDER) {
      if (prev[key] === 'pending' && bootChecks[key] !== 'pending') {
        updates[key] = Math.round(now - mountedAt.current);
      }
    }

    if (Object.keys(updates).length > 0) {
      setElapsedByCheck((cur) => ({ ...cur, ...updates }));
    }
    prevChecks.current = bootChecks;
  }, [bootChecks]);

  const lines = CHECK_ORDER.filter((key) => bootChecks[key] !== 'pending');

  return (
    <div className="bootlog">
      {lines.map((key) => {
        const status = bootChecks[key];
        const statusText = status === 'ok' ? 'OK' : 'WARN';
        const prefixText = `> ${padLabel(CHECK_LABEL[key])} `;
        const elapsed = elapsedByCheck[key];
        const elapsedText = elapsed !== undefined ? `  ${elapsed}ms` : '';
        const fullLength = prefixText.length + statusText.length + elapsedText.length;
        // Per-line reveal, capped well under the 400ms ceiling.
        const duration = Math.min(380, Math.max(120, fullLength * 14));
        const isDone = doneTyping[key] === true;

        return (
          <div key={key} className="bootlog-line">
            <span
              className="bootlog-typewriter"
              style={
                {
                  '--bootlog-chars': fullLength,
                  animationDuration: `${duration}ms`,
                } as CSSProperties
              }
              onAnimationEnd={() => setDoneTyping((cur) => ({ ...cur, [key]: true }))}
            >
              <span className="bootlog-prefix">{prefixText}</span>
              <span className={`bootlog-status bootlog-status--${status}`}>{statusText}</span>
              {elapsedText && <span className="bootlog-elapsed">{elapsedText}</span>}
            </span>
            {!isDone && <span className="bootlog-cursor" />}
          </div>
        );
      })}
    </div>
  );
}

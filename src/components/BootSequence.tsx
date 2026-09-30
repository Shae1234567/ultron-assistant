import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { GlitchText } from './hud/GlitchText';
import { BootLog } from './BootLog';
import { playBootChime } from '../services/sfx';

const CHECK_LABEL: Record<string, string> = {
  memory: 'MEMORY VAULT',
  settings: 'SETTINGS',
  brain: 'BRAIN',
  voice: 'VOICE (TTS)',
};
const CHECK_ORDER = ['memory', 'settings', 'brain', 'voice'] as const;

// The boot screen never shows for less than this (so it never flashes even
// when every check resolves instantly), and never blocks longer than this
// (so a hung check can't strand the operator on the boot screen forever).
const MIN_MS = 1500;
const MAX_MS = 5000;

/**
 * The intro. Every line on it reflects a real startup check App.tsx is
 * already running (vault, settings, brain probe, TTS support) - nothing here
 * is a decorative fake progress bar.
 */
export function BootSequence() {
  const booting = useStore((s) => s.booting);
  const bootChecks = useStore((s) => s.bootChecks);
  const finishBoot = useStore((s) => s.finishBoot);
  const [exiting, setExiting] = useState(false);
  const mountedAt = useRef(Date.now());

  useEffect(() => { if (booting) playBootChime(); }, [booting]);

  useEffect(() => {
    const allSettled = CHECK_ORDER.every((k) => bootChecks[k] !== 'pending');
    const elapsed = Date.now() - mountedAt.current;

    if (allSettled && elapsed >= MIN_MS) {
      setExiting(true);
      return;
    }
    const remaining = allSettled ? 0 : Math.max(0, MIN_MS - elapsed);
    const cap = Math.max(0, MAX_MS - elapsed);
    const t = setTimeout(() => setExiting(true), Math.min(remaining || cap, cap));
    return () => clearTimeout(t);
  }, [bootChecks]);

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(finishBoot, 520); // matches the CSS fade-out duration
    return () => clearTimeout(t);
  }, [exiting, finishBoot]);

  if (!booting) return null;

  return (
    <div className={`boot ${exiting ? 'boot--exit' : ''}`}>
      <div className="boot__grid" />
      <div className="boot__scan" />

      <div className="boot__mark">
        <svg viewBox="0 0 1024 1024" className="boot__hex">
          <defs>
            <linearGradient id="bootRing" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#eaf7ff" />
              <stop offset="55%" stopColor="#00d9ff" />
              <stop offset="100%" stopColor="#0891b2" />
            </linearGradient>
            <radialGradient id="bootCore" cx="42%" cy="38%" r="60%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#8fefff" />
              <stop offset="70%" stopColor="#00b8dc" />
              <stop offset="100%" stopColor="#004a5c" stopOpacity="0.15" />
            </radialGradient>
          </defs>
          <polygon
            className="boot__hex-outline"
            points="512,60 880,270 880,754 512,964 144,754 144,270"
            fill="none" stroke="url(#bootRing)" strokeWidth="7"
          />
          <circle className="boot__hex-core" cx="512" cy="512" r="168" fill="url(#bootCore)" />
          <circle className="boot__hex-core-ring" cx="512" cy="512" r="196" fill="none" stroke="#eaf7ff" strokeWidth="5" opacity="0.85" />
          <path
            d="M 430 440 L 430 560 A 82 82 0 0 0 594 560 L 594 440"
            fill="none" stroke="#03131a" strokeWidth="34" strokeLinecap="round"
            className="boot__u"
          />
        </svg>
      </div>

      <div className="boot__wordmark"><GlitchText>ULTRON</GlitchText></div>
      <div className="boot__subtitle">COMMAND CENTER — INITIALIZING</div>

      <div className="boot__checks">
        {CHECK_ORDER.map((key, i) => {
          const status = bootChecks[key];
          return (
            <div
              key={key}
              className={`boot__check boot__check--${status}`}
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <span className="boot__check-dot" />
              <span className="boot__check-label">{CHECK_LABEL[key]}</span>
              <span className="boot__check-status">
                {status === 'pending' ? '...' : status === 'ok' ? 'OK' : 'WARN'}
              </span>
            </div>
          );
        })}
      </div>

      <BootLog bootChecks={bootChecks} />
    </div>
  );
}

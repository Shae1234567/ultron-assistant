import { useEffect, useRef } from 'react';
import type { CoreState } from '../types';
import { getLevel, micActive } from '../services/audio';
import { isRenderActive } from '../services/visibility';
import { OrbRings } from './hud/OrbRings';
import { ParticleField } from './hud/ParticleField';

interface Props {
  state: CoreState;
}

const GLYPH: Record<CoreState, string> = {
  idle: 'ULTRON',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'RESPONDING',
  offline: 'OFFLINE',
};

/**
 * The centre of the interface. Rings are declarative SVG + CSS; the core
 * itself is driven by a rAF loop so it can react to real mic amplitude
 * without pushing 60 state updates a second through React.
 */
export function CoreOrb({ state }: Props) {
  const coreRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const smoothed = useRef(0);

  useEffect(() => {
    const tick = (t: number) => {
      // Unfocused/hidden: skip the style writes but keep the loop alive so it
      // resumes instantly on refocus with no re-subscribe logic anywhere.
      if (!isRenderActive()) {
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const p = t / 1000;

      // Amplitude source: real mic level while listening, synthetic otherwise.
      let drive: number;
      if ((state === 'listening' || state === 'speaking') && micActive()) {
        drive = getLevel();
      } else if (state === 'speaking') {
        drive = 0.34 + 0.3 * Math.abs(Math.sin(p * 7.5)) + 0.12 * Math.sin(p * 19);
      } else if (state === 'thinking') {
        drive = 0.28 + 0.22 * Math.abs(Math.sin(p * 4.2));
      } else if (state === 'offline') {
        drive = 0.06 + 0.05 * Math.sin(p * 1.1);
      } else {
        drive = 0.12 + 0.09 * Math.sin(p * 1.35) + 0.03 * Math.sin(p * 3.7);
      }

      const ease = state === 'listening' ? 0.35 : 0.12;
      smoothed.current += (drive - smoothed.current) * ease;
      const v = smoothed.current;

      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + v * 0.42})`;
        coreRef.current.style.opacity = String(0.78 + v * 0.22);
      }
      if (ringRef.current) {
        ringRef.current.style.transform = `scale(${1 + v * 0.72})`;
        ringRef.current.style.opacity = String(0.24 + v * 0.66);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [state]);

  return (
    <div className={`orb orb--${state}`}>
      <div className="orb__layer orb__sweep" />
      <OrbRings state={state} />
      <ParticleField state={state} />
      <div className="orb__halo" />
      <div className="orb__core-ring" ref={ringRef} />
      <div className="orb__core" ref={coreRef} />
      <div className="orb__center-text">
        <div className="glyph">{GLYPH[state]}</div>
      </div>
    </div>
  );
}

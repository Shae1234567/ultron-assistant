import type { ReactNode } from 'react';

/**
 * HoloFrame - wraps children in a holographic frame: an animated
 * traveling-energy border (.holo-border-anim from hologram.css) plus
 * HUD-style corner brackets. `active` swaps in a brighter, faster
 * animation state, e.g. while something wrapped inside is "live" versus
 * idle/standby.
 *
 * Usage:
 *   <HoloFrame active={isSpeaking}>
 *     <Waveform ... />
 *   </HoloFrame>
 *
 * All animation is CSS keyframes (border rotation + corner glow) driving
 * `transform`/`opacity` only - no JS animation loop, no measurement, no
 * ResizeObserver. The only per-render React work is a couple of class
 * name string concatenations.
 *
 * NOTE: hologram.css is not yet wired into the global stylesheet import
 * list. Whoever adopts this component needs to add, once, globally:
 *   import './styles/hologram.css';
 * alongside the other imports in src/main.tsx.
 */

interface Props {
  children: ReactNode;
  active?: boolean;
}

export function HoloFrame({ children, active }: Props) {
  const borderCls = active ? 'holo-border-anim holo-border-anim--active' : 'holo-border-anim';

  return (
    <div className={borderCls} style={{ position: 'relative' }}>
      <div
        className={active ? 'holo-frame__inner holo-frame__inner--active' : 'holo-frame__inner'}
        style={{ position: 'relative', background: 'var(--panel)' }}
      >
        <span className="holo-frame__bracket holo-frame__bracket--tl" aria-hidden="true" />
        <span className="holo-frame__bracket holo-frame__bracket--tr" aria-hidden="true" />
        <span className="holo-frame__bracket holo-frame__bracket--bl" aria-hidden="true" />
        <span className="holo-frame__bracket holo-frame__bracket--br" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/**
 * ScanLines - a subtle animated hologram scan sweep, rendered as an
 * absolutely-positioned overlay. Drop it inside any `position: relative`
 * container as a sibling of the real content (last child is fine, it
 * doesn't intercept pointer events):
 *
 *   <div style={{ position: 'relative' }}>
 *     ...panel content...
 *     <ScanLines />
 *   </div>
 *
 * Pure CSS animation (see .holo-scan / @keyframes holoScan in
 * hologram.css) - no requestAnimationFrame, no timers, no state. Idle
 * cost is whatever the browser compositor spends on one `transform`/
 * `opacity` animation per instance, which is effectively free.
 *
 * NOTE: hologram.css is not yet wired into the global stylesheet import
 * list (see src/main.tsx). Whoever adopts this component needs to add
 *   import './styles/hologram.css';
 * once, globally, alongside the other style imports there.
 */
export function ScanLines() {
  return (
    <div
      className="holo-scan"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * GlitchText - renders text that occasionally "glitches" like an unstable
 * holographic readout: two duplicate text layers briefly jump sideways
 * with a clipped slice, tinted cyan/white, then settle back. CSS-only -
 * driven entirely by @keyframes on ::before/::after, no JS animation
 * loop and no per-frame work, so it's idle-cost-free when off-screen or
 * paused (the animation just isn't ticking between glitch windows).
 *
 * Usage:
 *   <GlitchText className="panel-head__title">SYSTEM ONLINE</GlitchText>
 *
 * The real text stays selectable/readable (::before/::after read the
 * label from a CSS custom property so nothing needs `content: attr()`
 * tricks that would fight with React); the glitch layers are decorative
 * only and hidden from screen readers.
 *
 * NOTE: hologram.css is not yet wired into the global stylesheet import
 * list. Whoever adopts this component needs to add, once, globally:
 *   import './styles/hologram.css';
 * alongside the other imports in src/main.tsx. This component does not
 * import the stylesheet itself (matching how other components in this
 * codebase rely on the global CSS imports in main.tsx rather than
 * per-component imports).
 */

interface Props {
  children: string;
  className?: string;
}

export function GlitchText({ children, className }: Props) {
  const cls = className ? `holo-glitch-text ${className}` : 'holo-glitch-text';
  return (
    <span className={cls} data-text={children}>
      <span aria-hidden="true" className="holo-glitch-text__layer holo-glitch-text__layer--a">
        {children}
      </span>
      <span aria-hidden="true" className="holo-glitch-text__layer holo-glitch-text__layer--b">
        {children}
      </span>
      <span className="holo-glitch-text__base">{children}</span>
    </span>
  );
}

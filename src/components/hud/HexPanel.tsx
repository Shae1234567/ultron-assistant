import type { ReactNode, CSSProperties } from 'react';

interface Props {
  title?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  scroll?: boolean;
}

/**
 * The one panel shell used everywhere: clipped corners, hairline glow border,
 * targeting brackets, optional header strip.
 */
export function HexPanel({
  title, meta, actions, children, className = '', bodyClassName = '', style, scroll = true,
}: Props) {
  return (
    <div className={`hud-panel ${className}`} style={style}>
      <div className="hud-panel__inner">
        {title && (
          <div className="panel-head">
            <span className="panel-head__title">{title}</span>
            <span className="panel-head__rule" />
            {meta && <span className="panel-head__meta">{meta}</span>}
            {actions}
          </div>
        )}
        <div
          className={`${scroll ? 'panel-body' : ''} ${bodyClassName}`}
          style={scroll ? undefined : { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          {children}
        </div>
      </div>
      <span className="hud-panel__bracket hud-panel__bracket--tr" />
      <span className="hud-panel__bracket hud-panel__bracket--bl" />
    </div>
  );
}

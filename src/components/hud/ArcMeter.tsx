interface Props {
  value: number;        // 0..1
  size?: number;
  stroke?: number;
  label?: string;
  readout?: string;
  color?: string;
  gapDeg?: number;      // opening at the bottom
}

/** Circular arc gauge - the workhorse readout of the whole interface. */
export function ArcMeter({
  value, size = 76, stroke = 4, label, readout, color = 'var(--cyan)', gapDeg = 70,
}: Props) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2 - 6;
  const c = size / 2;
  const sweep = 360 - gapDeg;
  const circumference = 2 * Math.PI * r;
  const arcLen = (sweep / 360) * circumference;

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: `0 0 ${size}px` }}>
      <svg width={size} height={size} style={{ transform: `rotate(${90 + gapDeg / 2}deg)` }}>
        <circle
          cx={c} cy={c} r={r} fill="none"
          stroke="rgba(0,217,255,0.14)" strokeWidth={stroke}
          strokeDasharray={`${arcLen} ${circumference}`} strokeLinecap="butt"
        />
        <circle
          cx={c} cy={c} r={r} fill="none"
          stroke={color} strokeWidth={stroke}
          strokeDasharray={`${arcLen * clamped} ${circumference}`} strokeLinecap="butt"
          style={{ filter: `drop-shadow(0 0 5px ${color})`, transition: 'stroke-dasharray 0.55s cubic-bezier(0.4,0,0.2,1)' }}
        />
        {/* tick marks around the arc */}
        {Array.from({ length: 24 }).map((_, i) => {
          const a = (i / 24) * sweep * (Math.PI / 180);
          const inner = r - 7;
          const outer = r - 3;
          return (
            <line
              key={i}
              x1={c + Math.cos(a) * inner} y1={c + Math.sin(a) * inner}
              x2={c + Math.cos(a) * outer} y2={c + Math.sin(a) * outer}
              stroke={i / 24 <= clamped ? color : 'rgba(0,217,255,0.18)'}
              strokeWidth={1}
            />
          );
        })}
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: size > 70 ? 15 : 12, color,
          textShadow: `0 0 8px ${color}`, lineHeight: 1,
        }}>{readout}</span>
        {label && (
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 7, fontWeight: 700,
            letterSpacing: '0.16em', color: 'var(--dim)', marginTop: 3,
          }}>{label}</span>
        )}
      </div>
    </div>
  );
}

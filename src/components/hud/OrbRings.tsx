import { useMemo } from 'react';
import type { CoreState } from '../../types';

const C = 200; // centre of the 400x400 viewBox

const spinStyle = (durationSec: number, reverse = false) => ({
  transformOrigin: `${C}px ${C}px`,
  transformBox: 'view-box' as const,
  animation: `${reverse ? 'spin-ccw' : 'spin-cw'} ${durationSec}s linear infinite`,
});

const polar = (r: number, deg: number) => {
  const a = (deg - 90) * (Math.PI / 180);
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
};

const dash = (r: number, segments: number, dutyCycle: number) => {
  const circumference = 2 * Math.PI * r;
  const seg = circumference / segments;
  return `${seg * dutyCycle} ${seg * (1 - dutyCycle)}`;
};

interface Props { state: CoreState }

/** Concentric instrument rings. Pure SVG + CSS so it costs almost nothing to run. */
export function OrbRings({ state }: Props) {
  const busy = state === 'thinking';
  const listening = state === 'listening';
  const stroke = state === 'offline' ? 'var(--red)' : 'var(--cyan)';

  const ticks = useMemo(
    () =>
      Array.from({ length: 90 }, (_, i) => {
        const deg = (i / 90) * 360;
        const major = i % 5 === 0;
        const outer = 191;
        const inner = major ? 180 : 185.5;
        const a = polar(outer, deg);
        const b = polar(inner, deg);
        return { ...{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, major, key: i };
      }),
    [],
  );

  const nodes = useMemo(
    () => Array.from({ length: 16 }, (_, i) => ({ key: i, ...polar(139, (i / 16) * 360) })),
    [],
  );

  const labels = useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => {
        const deg = (i / 8) * 360;
        const p = polar(166, deg);
        return { key: i, x: p.x, y: p.y, text: String(Math.round(deg)).padStart(3, '0') };
      }),
    [],
  );

  return (
    <svg className="orb__layer" viewBox="0 0 400 400" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eaf7ff" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#00d9ff" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#00d9ff" stopOpacity="0.12" />
        </linearGradient>
        <filter id="orbGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g filter="url(#orbGlow)" stroke={stroke} fill="none">
        {/* outer hairline */}
        <circle cx={C} cy={C} r={196} strokeWidth={0.6} opacity={0.28} />

        {/* graduated tick ring */}
        <g style={spinStyle(120, true)} opacity={0.7}>
          {ticks.map((t) => (
            <line
              key={t.key}
              x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              strokeWidth={t.major ? 1.5 : 0.7}
              opacity={t.major ? 0.95 : 0.42}
            />
          ))}
        </g>

        {/* marching dashes */}
        <circle
          cx={C} cy={C} r={174} strokeWidth={1} opacity={0.5}
          strokeDasharray="3 9"
          style={{ ...spinStyle(46), }}
        />

        {/* heavy segmented arc - four blades */}
        <circle
          cx={C} cy={C} r={158} strokeWidth={9} opacity={0.85}
          stroke="url(#arcGrad)"
          strokeDasharray={dash(158, 4, 0.17)}
          strokeLinecap="butt"
          style={spinStyle(busy ? 3.4 : 15)}
        />

        {/* counter arc */}
        <circle
          cx={C} cy={C} r={148} strokeWidth={2} opacity={0.55}
          strokeDasharray={dash(148, 3, 0.24)}
          style={spinStyle(busy ? 5 : 26, true)}
        />

        {/* node ring */}
        <g style={spinStyle(70)}>
          <circle cx={C} cy={C} r={139} strokeWidth={0.6} opacity={0.3} />
          {nodes.map((n, i) => (
            <circle
              key={n.key}
              cx={n.x} cy={n.y} r={3.4}
              strokeWidth={1.1}
              fill="rgba(0,217,255,0.18)"
              opacity={0.9}
              style={{
                animation: `pulse-soft ${2.2 + (i % 4) * 0.35}s ease-in-out ${(i % 7) * 0.18}s infinite`,
              }}
            />
          ))}
        </g>

        {/* instrument bezel with bearing labels */}
        <circle cx={C} cy={C} r={124} strokeWidth={0.8} opacity={0.35} />
        <circle
          cx={C} cy={C} r={116} strokeWidth={5} opacity={0.7}
          strokeDasharray={dash(116, 24, 0.55)}
          style={spinStyle(listening ? 8 : 34, true)}
        />

        {/* radial spokes */}
        <g opacity={0.5} style={spinStyle(90)}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const a = polar(104, deg);
            const b = polar(96, deg);
            return <line key={deg} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={1.4} />;
          })}
        </g>

        {/* inner dashed ring */}
        <circle
          cx={C} cy={C} r={92} strokeWidth={1} opacity={0.6}
          strokeDasharray="2 6"
          style={spinStyle(busy ? 6 : 20, true)}
        />

        {/* corner brackets around the core */}
        <g opacity={0.85} style={spinStyle(busy ? 9 : 55)}>
          {[45, 135, 225, 315].map((deg) => {
            const p1 = polar(76, deg - 9);
            const p2 = polar(76, deg + 9);
            const p3 = polar(68, deg + 9);
            return (
              <path
                key={deg}
                d={`M ${p1.x} ${p1.y} A 76 76 0 0 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y}`}
                strokeWidth={1.6}
                fill="none"
              />
            );
          })}
        </g>
      </g>

      {/* bearing readouts - deliberately outside the glow filter so text stays crisp */}
      <g style={spinStyle(120, true)}>
        {labels.map((l) => (
          <text
            key={l.key}
            x={l.x} y={l.y}
            fill={stroke}
            opacity={0.5}
            fontSize={7}
            fontFamily="var(--font-mono)"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {l.text}
          </text>
        ))}
      </g>
    </svg>
  );
}

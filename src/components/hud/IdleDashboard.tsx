import { useEffect, useState, type CSSProperties } from 'react';
import { providerLabel } from '../../services/providers';
import { useStore } from '../../state/store';
import { dueLabel } from '../../services/format';

/** One small holographic readout tile - thin cyan border, mono value, label-xs heading. */
function Tile({ label, value, tone, style, title }: {
  label: string;
  value: string;
  tone?: 'good' | 'bad' | 'warn';
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <div
      className="idle-dashboard__tile"
      title={title}
      style={{
        width: 132,
        minHeight: 64,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        border: '1px solid var(--cyan-20, rgba(0,217,255,0.2))',
        background: 'rgba(6,16,22,0.55)',
        backdropFilter: 'blur(2px)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <span className="label-xs">{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 12,
          lineHeight: 1.25,
          wordBreak: 'break-word',
          whiteSpace: 'pre-line',
          color: tone === 'good' ? 'var(--green)' : tone === 'bad' ? 'var(--red)' : tone === 'warn' ? '#ffc857' : 'var(--white)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const at = (x: number, y: number): CSSProperties => ({
  position: 'absolute', top: '50%', left: '50%', transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
});

/**
 * Ambient tiles around the core orb while it's idle - all real data: the
 * clock, which brain is live, current weather for the operator's location,
 * and the next task on the list.
 */
export function IdleDashboard() {
  const coreState = useStore((s) => s.coreState);
  const brain = useStore((s) => s.brain);
  const weather = useStore((s) => s.weather);
  const tasks = useStore((s) => s.tasks);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const visible = coreState === 'idle';
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const brainValue = !brain ? 'probing' : brain.active ? `${providerLabel(brain.active).toUpperCase()}\n${brain.model ?? ''}` : 'offline';

  const next = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity))[0];
  const nextDue = next ? dueLabel(next, now) : null;
  const nextValue = next ? `${next.title.length > 38 ? `${next.title.slice(0, 36)}...` : next.title}${nextDue ? `\n${nextDue.text}` : ''}` : 'nothing open';

  return (
    <div
      className="idle-dashboard"
      style={{ position: 'absolute', inset: 0, pointerEvents: visible ? 'auto' : 'none', opacity: visible ? 1 : 0, transition: 'opacity 300ms ease' }}
    >
      <Tile label="DATE / TIME" value={`${dateStr}\n${timeStr}`} style={at(-165, -110)} />
      <Tile label="BRAIN" value={brainValue} tone={brain ? (brain.active ? 'good' : 'bad') : undefined} style={at(165, -110)} />
      <Tile
        label="WEATHER"
        value={weather ? `${weather.tempC}°C  ${weather.condition}\nfeels ${weather.feelsLikeC}°  wind ${weather.windKph}` : 'no reading'}
        title={weather?.place}
        style={at(-165, 110)}
      />
      <Tile
        label="NEXT UP"
        value={nextValue}
        tone={nextDue?.tone === 'late' ? 'bad' : nextDue?.tone === 'soon' ? 'warn' : undefined}
        style={at(165, 110)}
      />
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { getWaveform, micActive } from '../../services/audio';
import { isRenderActive } from '../../services/visibility';

interface Props {
  height?: number;
  live?: boolean;
  amplitude?: number;   // multiplier for the idle signal
  color?: string;
  className?: string;
}

/** Oscilloscope trace - real mic samples when listening, breathing sine when idle. */
export function Waveform({ height = 58, live = true, amplitude = 1, color = '#00d9ff', className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const POINTS = 220;

    const draw = (t: number) => {
      if (!isRenderActive()) {
        raf.current = requestAnimationFrame(draw);
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      const mid = h / 2;
      ctx.clearRect(0, 0, w, h);

      // centre line
      ctx.strokeStyle = 'rgba(0,217,255,0.16)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      const usingMic = live && micActive();
      const samples = usingMic ? getWaveform(POINTS) : null;
      const p = t / 1000;

      ctx.beginPath();
      for (let i = 0; i < POINTS; i++) {
        const x = (i / (POINTS - 1)) * w;
        let v: number;
        if (samples) {
          v = samples[i] * 0.9;
        } else {
          const envelope = 0.5 + 0.28 * Math.sin(p * 0.7 + i * 0.012);
          v =
            envelope *
            (Math.sin(i * 0.09 + p * 2.4) * 0.5 +
              Math.sin(i * 0.031 - p * 1.3) * 0.32 +
              Math.sin(i * 0.21 + p * 4.1) * 0.14) *
            amplitude;
        }
        const y = mid - v * mid * 0.92;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.shadowColor = color;
      ctx.shadowBlur = 9 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;

      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf.current); ro.disconnect(); };
  }, [live, amplitude, color]);

  return <canvas ref={ref} className={className} style={{ width: '100%', height, display: 'block' }} />;
}

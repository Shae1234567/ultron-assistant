import { useEffect, useRef } from 'react';
import { getSpectrum, micActive } from '../../services/audio';
import { isRenderActive } from '../../services/visibility';

interface Props {
  bars?: number;
  height?: number;
  live?: boolean;   // true = drive from mic when available
  seed?: number;
  className?: string;
}

/**
 * Live bar chart. Uses real mic spectrum when the mic is open, otherwise a
 * layered-sine ambient signal so the HUD is never visually dead.
 */
export function BarSpectrum({ bars = 34, height = 54, live = true, seed = 1, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  const values = useRef<number[]>(new Array(bars).fill(0.1));

  useEffect(() => {
    values.current = new Array(bars).fill(0.1);
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Rebuilt only on resize, not per bar per frame - a linear gradient was
    // previously allocated up to `bars` times every single frame.
    let barGradient: CanvasGradient;
    const resize = () => {
      const { width, height: h } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
      grad.addColorStop(0, 'rgba(0,217,255,0.30)');
      grad.addColorStop(0.65, 'rgba(0,217,255,0.85)');
      grad.addColorStop(1, 'rgba(234,247,255,0.98)');
      barGradient = grad;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (t: number) => {
      if (!isRenderActive()) {
        raf.current = requestAnimationFrame(draw);
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const usingMic = live && micActive();
      const spectrum = usingMic ? getSpectrum(bars) : null;

      const gap = Math.max(1 * dpr, (w / bars) * 0.28);
      const bw = (w - gap * (bars - 1)) / bars;

      for (let i = 0; i < bars; i++) {
        let target: number;
        if (spectrum) {
          target = spectrum[i];
        } else {
          const p = t / 1000;
          target =
            0.16 +
            0.13 * Math.sin(p * 1.7 + i * 0.42 + seed) +
            0.1 * Math.sin(p * 0.83 - i * 0.27 + seed * 2) +
            0.07 * Math.sin(p * 3.1 + i * 0.9);
          target = Math.max(0.04, target);
        }
        // ease toward target so bars feel weighted, not jittery
        values.current[i] += (target - values.current[i]) * (spectrum ? 0.4 : 0.09);
        const v = Math.max(0.02, Math.min(1, values.current[i]));
        const bh = v * h;
        const x = i * (bw + gap);

        ctx.fillStyle = barGradient;
        ctx.fillRect(x, h - bh, bw, bh);

        // bright cap
        ctx.fillStyle = 'rgba(234,247,255,0.9)';
        ctx.fillRect(x, h - bh, bw, Math.max(1, 1.4 * dpr));
      }
      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf.current); ro.disconnect(); };
  }, [bars, live, seed]);

  return <canvas ref={ref} className={className} style={{ width: '100%', height, display: 'block' }} />;
}

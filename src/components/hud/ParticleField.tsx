import { useEffect, useRef } from 'react';
import type { CoreState } from '../../types';
import { isRenderActive } from '../../services/visibility';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; white: boolean;
}

interface Props { state: CoreState }

/** Pre-renders a soft radial-gradient dot once, reused via drawImage for
 *  every particle every frame - a per-particle ctx.shadowBlur (a software
 *  blur pass on every single fill call) was the single most expensive thing
 *  this canvas did, at up to ~100 particles/frame. */
function makeGlowSprite(rgb: string, size = 48): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.4, `rgba(${rgb},0.7)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Ambient drifting motes plus a radial burst whenever the core changes state.
 * Canvas rather than DOM nodes so a burst of 90 particles costs nothing.
 */
export function ParticleField({ state }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const burstQueued = useRef(false);
  const raf = useRef(0);

  // Queue a burst on every state transition (skips the very first mount)
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    burstQueued.current = true;
  }, [state]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cyanSprite = makeGlowSprite('0,217,255');
    const whiteSprite = makeGlowSprite('234,247,255');

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const spawnBurst = (cx: number, cy: number, radius: number) => {
      const count = 78;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
        const speed = (0.9 + Math.random() * 2.6) * dpr;
        const r0 = radius * (0.22 + Math.random() * 0.1);
        particles.current.push({
          x: cx + Math.cos(a) * r0,
          y: cy + Math.sin(a) * r0,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 0,
          maxLife: 42 + Math.random() * 44,
          size: (0.7 + Math.random() * 1.5) * dpr,
          white: Math.random() < 0.28,
        });
      }
    };

    const spawnAmbient = (cx: number, cy: number, radius: number) => {
      const a = Math.random() * Math.PI * 2;
      const r0 = radius * (0.3 + Math.random() * 0.62);
      particles.current.push({
        x: cx + Math.cos(a) * r0,
        y: cy + Math.sin(a) * r0,
        vx: -Math.sin(a) * 0.18 * dpr,
        vy: Math.cos(a) * 0.18 * dpr,
        life: 0,
        maxLife: 150 + Math.random() * 130,
        size: (0.5 + Math.random() * 1.1) * dpr,
        white: Math.random() < 0.16,
      });
    };

    const draw = () => {
      // Unfocused/hidden: hold the last frame and skip all canvas work, but
      // keep rAF alive so it resumes the instant focus returns.
      if (!isRenderActive()) {
        raf.current = requestAnimationFrame(draw);
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) / 2;
      ctx.clearRect(0, 0, w, h);

      if (burstQueued.current) { burstQueued.current = false; spawnBurst(cx, cy, radius); }
      if (particles.current.length < 26 && Math.random() < 0.25) spawnAmbient(cx, cy, radius);

      const next: Particle[] = [];
      for (const p of particles.current) {
        p.life += 1;
        if (p.life >= p.maxLife) continue;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.977;
        p.vy *= 0.977;

        const t = p.life / p.maxLife;
        const alpha = (1 - t) * (1 - t) * 0.9;
        const sprite = p.white ? whiteSprite : cyanSprite;
        const d = p.size * (1 - t * 0.45) * 6; // sprite covers well past the glow radius
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, p.x - d / 2, p.y - d / 2, d, d);
        next.push(p);
      }
      ctx.globalAlpha = 1;
      particles.current = next;
      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf.current); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} className="orb__layer" style={{ zIndex: 2 }} />;
}

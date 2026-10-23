// Restrained, Siri-like voice orb: a soft, matte, mostly monochrome sphere. Only real
// audio levels move it — a slight swell, a faint halo and two slow low-alpha light lobes
// (system blue → teal). Perfect circle, no wobble, no gloss.
import { useEffect, useRef } from 'react';
import type { OrbState } from './runner.ts';

interface Props {
  state: OrbState;
  micLevel?: () => number;
  outLevel?: () => number;
  size?: number;
  className?: string;
}

// Low-saturation tints per state [r,g,b].
const TINT: Record<OrbState, [number, number, number]> = {
  connecting: [176, 180, 188],
  listening: [128, 160, 204],
  user: [104, 172, 190],
  assistant: [72, 136, 214],
  thinking: [128, 152, 196],
  muted: [182, 184, 190],
  offline: [190, 192, 196],
};

export function VoiceOrb({ state, micLevel, outLevel, size = 200, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lv = useRef({ mic: micLevel, out: outLevel });
  lv.current = { mic: micLevel, out: outLevel };
  const pad = Math.round(size * 0.35);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = size + pad * 2;
    canvas.width = W * dpr;
    canvas.height = W * dpr;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let level = 0;
    let phase = 0;
    let last = performance.now();
    const tint = [...TINT[stateRef.current]] as number[];

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      const target = TINT[st];
      for (let i = 0; i < 3; i++) tint[i] += (target[i] - tint[i]) * 0.05;
      let raw = 0;
      if (st === 'user') raw = lv.current.mic?.() ?? 0;
      else if (st === 'assistant') raw = lv.current.out?.() ?? 0;
      else if (st === 'listening') raw = (lv.current.mic?.() ?? 0) * 0.25;
      level += (raw - level) * (raw > level ? 0.3 : 0.06);
      // Lobes drift slowly; faster when someone is speaking or thinking.
      const speed = reduced ? 0 : st === 'thinking' ? 1.4 : st === 'connecting' ? 0.5 : 0.35 + level * 1.2;
      phase += dt * speed;

      const cx = W / 2;
      const cy = W / 2;
      const breathe = reduced ? 0 : st === 'connecting' || st === 'thinking' ? Math.sin(phase * 2.4) * 0.012 : 0;
      const R = (size / 2) * (0.94 + breathe + level * 0.06);
      const [r, gg, b] = tint;
      g.clearRect(0, 0, W, W);

      // Faint halo, only noticeable while audio is present.
      const haloA = 0.06 + level * 0.16;
      const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * (1.18 + level * 0.25));
      halo.addColorStop(0, `rgba(${r | 0},${gg | 0},${b | 0},${haloA})`);
      halo.addColorStop(1, `rgba(${r | 0},${gg | 0},${b | 0},0)`);
      g.fillStyle = halo;
      g.fillRect(0, 0, W, W);

      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();

      // Matte body: light center → tinted edge.
      const body = g.createRadialGradient(cx, cy - R * 0.25, R * 0.1, cx, cy, R);
      body.addColorStop(0, `rgb(${mix(r, 255, 0.82)},${mix(gg, 255, 0.82)},${mix(b, 255, 0.84)})`);
      body.addColorStop(1, `rgb(${mix(r, 255, 0.3)},${mix(gg, 255, 0.3)},${mix(b, 255, 0.3)})`);
      g.fillStyle = body;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);

      // Two soft light lobes (blue / teal) circling inside.
      const lobes: [number, number, number, number][] = [
        [72, 136, 214, 0],
        [70, 176, 196, Math.PI],
      ];
      for (const [lr, lg, lb, off] of lobes) {
        const a = phase + off;
        const lx = cx + Math.cos(a) * R * 0.38;
        const ly = cy + Math.sin(a * 0.8) * R * 0.32 + R * 0.12;
        const alpha = st === 'connecting' || st === 'muted' || st === 'offline' ? 0.08 : 0.16 + level * 0.34;
        const lg2 = g.createRadialGradient(lx, ly, 0, lx, ly, R * 0.85);
        lg2.addColorStop(0, `rgba(${lr},${lg},${lb},${alpha})`);
        lg2.addColorStop(1, `rgba(${lr},${lg},${lb},0)`);
        g.fillStyle = lg2;
        g.fillRect(cx - R, cy - R, R * 2, R * 2);
      }

      // Soft top light (no hard specular).
      const top = g.createLinearGradient(0, cy - R, 0, cy + R);
      top.addColorStop(0, 'rgba(255,255,255,0.35)');
      top.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.fillStyle = top;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
      g.restore();

      // Hairline rim.
      g.beginPath();
      g.arc(cx, cy, R - 0.5, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,0.06)';
      g.lineWidth = 1;
      g.stroke();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, pad]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className}
      style={{ width: size + pad * 2, height: size + pad * 2, margin: -pad, pointerEvents: 'none' }}
      data-orb-state={state}
    />
  );
}

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

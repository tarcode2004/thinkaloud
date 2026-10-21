// Synchronized session player: one virtual clock (session ms) drives rrweb replay, audio, pointer/gaze overlay,
// transcript and timeline. Works without replay/audio (virtual clock only).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { Captions, Eye, MousePointer2, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { SessionEvent, Step, TaskResult } from '@thinkaloud/shared';
import { cn } from '../ui/index.tsx';
import { clock, OUTCOME_META } from './format.ts';
import type { FlatPoint, Note } from './types.ts';

// ── Clock ───────────────────────────────────────────────────────────────────

export interface PlayerClock {
  t: number;
  playing: boolean;
  speed: number;
  duration: number;
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (s: number) => void;
  /** Live (unthrottled) time ref for render loops. */
  tRef: React.RefObject<number>;
  /** Monotonic counter bumped on every seek (lets media re-sync). */
  seekGen: number;
}

export function usePlayerClock(duration: number, initialT = 0, audio?: React.RefObject<HTMLAudioElement | null>, audioStart = 0): PlayerClock {
  const tRef = useRef(Math.min(initialT, duration));
  const [t, setT] = useState(tRef.current);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [seekGen, setSeekGen] = useState(0);
  const speedRef = useRef(1);
  const playingRef = useRef(false);
  const lastPush = useRef(0);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      let next = tRef.current + dt * speedRef.current;
      const a = audio?.current;
      if (a && a.readyState >= 2) {
        const rel = (next - audioStart) / 1000;
        const aDur = isFinite(a.duration) ? a.duration : Infinity;
        if (rel >= 0 && rel < aDur) {
          if (a.paused) {
            a.currentTime = Math.max(0, rel);
            a.playbackRate = speedRef.current;
            void a.play().catch(() => {});
          } else if (Math.abs(a.currentTime - rel) < 1.5) {
            next = audioStart + a.currentTime * 1000; // audio is the master clock while it plays
          } else a.currentTime = rel;
        } else if (!a.paused) a.pause();
      }
      if (next >= duration) {
        next = duration;
        playingRef.current = false;
        setPlaying(false);
        audio?.current?.pause();
      }
      tRef.current = next;
      if (now - lastPush.current > 50 || next === duration) {
        lastPush.current = now;
        setT(next);
      }
      if (playingRef.current) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, audio, audioStart]);

  const seek = useCallback(
    (v: number) => {
      const nt = Math.max(0, Math.min(duration, v));
      tRef.current = nt;
      setT(nt);
      setSeekGen((g) => g + 1);
      const a = audio?.current;
      if (a && a.readyState >= 1) {
        const rel = (nt - audioStart) / 1000;
        if (rel >= 0) a.currentTime = rel;
        else a.pause();
      }
    },
    [duration, audio, audioStart],
  );
  const play = useCallback(() => {
    if (tRef.current >= duration - 50) seek(0);
    playingRef.current = true;
    setPlaying(true);
  }, [duration, seek]);
  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    audio?.current?.pause();
    setT(tRef.current);
  }, [audio]);
  const setSpeed = useCallback(
    (s: number) => {
      speedRef.current = s;
      setSpeedState(s);
      if (audio?.current) audio.current.playbackRate = s;
    },
    [audio],
  );
  return { t, playing, speed, duration, seek, play, pause, toggle: () => (playingRef.current ? pause() : play()), setSpeed, tRef, seekGen };
}

// ── Stage: rrweb replay or pointer-only fallback ────────────────────────────

interface RREvent {
  type: number;
  timestamp: number;
  data?: { href?: string; width?: number; height?: number };
}

export function Stage({
  clock: c,
  replay,
  startedAt,
  points,
  showMouse,
  showGaze,
  events,
  viewport,
}: {
  clock: PlayerClock;
  replay: RREvent[] | null;
  startedAt: number;
  points: { mouse: FlatPoint[]; gaze: FlatPoint[] };
  showMouse: boolean;
  showGaze: boolean;
  events: SessionEvent[];
  viewport: { w: number; h: number };
}) {
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const replayer = useRef<Replayer | null>(null);
  const [box, setBox] = useState({ w: 800, h: 500 });
  const [replayErr, setReplayErr] = useState(false);
  const meta = useMemo(() => replay?.find((e) => e.type === 4)?.data, [replay]);
  const vw = meta?.width || viewport.w || 1280;
  const vh = meta?.height || viewport.h || 800;
  const offset = replay?.length ? replay[0].timestamp - startedAt : 0;
  const replayEnd = replay?.length ? replay[replay.length - 1].timestamp - replay[0].timestamp : 0;
  const hasReplay = Boolean(replay && replay.length > 1 && !replayErr);

  // Fit the recorded viewport into the stage.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(box.w / vw, box.h / vh);
  const left = (box.w - vw * scale) / 2;
  const top = (box.h - vh * scale) / 2;

  // Mount replayer
  useEffect(() => {
    if (!replay || replay.length < 2 || !host.current) return;
    let r: Replayer;
    try {
      r = new Replayer(replay as never, { root: host.current, skipInactive: false, showWarning: false, mouseTail: false, triggerFocus: false, speed: 1 });
      r.pause(Math.max(0, c.tRef.current - offset));
      replayer.current = r;
    } catch (e) {
      console.warn('replay failed', e);
      setReplayErr(true);
      return;
    }
    return () => {
      r.destroy();
      replayer.current = null;
      if (host.current) host.current.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay]);

  // Sync replayer to the clock
  useEffect(() => {
    const r = replayer.current;
    if (!r) return;
    const rel = Math.max(0, Math.min(replayEnd, c.tRef.current - offset));
    try {
      if (c.playing && c.tRef.current >= offset && rel < replayEnd) {
        r.setConfig({ speed: c.speed });
        r.play(rel);
      } else r.pause(rel);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.playing, c.seekGen, c.speed]);

  // Drift correction while playing + paused scrubbing
  useEffect(() => {
    const r = replayer.current;
    if (!r) return;
    const rel = c.t - offset;
    if (!c.playing) return;
    if (rel < 0 || rel > replayEnd) return;
    if (Math.abs(r.getCurrentTime() - rel) > 600) {
      try {
        r.play(rel);
      } catch {
        /* ignore */
      }
    }
  }, [c.t, c.playing, offset, replayEnd]);

  // Overlay drawing (mouse when there's no replay, gaze always)
  const sortedMouse = points.mouse;
  const sortedGaze = points.gaze;
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(vw * scale * dpr);
    cv.height = Math.round(vh * scale * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw * scale, vh * scale);
    const now = c.t;
    const pos = (p: FlatPoint) => [(p.x / (p.vw || vw)) * vw * scale, (p.y / (p.vh || vh)) * vh * scale] as const;
    const windowed = (arr: FlatPoint[], span: number) => {
      // binary search for last index <= now
      let lo = 0;
      let hi = arr.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t <= now) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const out: FlatPoint[] = [];
      for (let i = idx; i >= 0 && now - arr[i].t <= span; i--) out.push(arr[i]);
      return out.reverse();
    };
    if (showGaze && sortedGaze.length) {
      const g = windowed(sortedGaze, 900);
      g.forEach((p, i) => {
        const [x, y] = pos(p);
        const a = ((i + 1) / g.length) * 0.22;
        const rad = 34 * scale + 10;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, rad);
        grd.addColorStop(0, `rgba(48,176,199,${a})`);
        grd.addColorStop(1, 'rgba(48,176,199,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      });
      const last = g[g.length - 1];
      if (last) {
        const [x, y] = pos(last);
        ctx.strokeStyle = 'rgba(48,176,199,.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (showMouse && sortedMouse.length && !hasReplay) {
      const m = windowed(sortedMouse, 1200);
      if (m.length > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        m.forEach((p, i) => {
          const [x, y] = pos(p);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      const last = m[m.length - 1];
      if (last) {
        const [x, y] = pos(last);
        // macOS-like arrow cursor
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 17);
        ctx.lineTo(4.5, 13);
        ctx.lineTo(7.5, 19.5);
        ctx.lineTo(10, 18.4);
        ctx.lineTo(7, 12);
        ctx.lineTo(12.5, 12);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    // Click ripples
    if (!hasReplay)
      for (const e of events) {
        if (e.kind !== 'app.click' || e.t > now || now - e.t > 700) continue;
        const d = e.data as { x?: number; y?: number; vw?: number; vh?: number };
        if (d.x == null || d.y == null) continue;
        const x = (d.x / (d.vw || vw)) * vw * scale;
        const y = (d.y / (d.vh || vh)) * vh * scale;
        const f = (now - e.t) / 700;
        ctx.strokeStyle = `rgba(0,113,227,${1 - f})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 6 + f * 18, 0, Math.PI * 2);
        ctx.stroke();
      }
  }, [c.t, scale, vw, vh, showGaze, showMouse, sortedGaze, sortedMouse, hasReplay, events]);

  // Current path (for fallback URL bar)
  const currentPath = useMemo(() => {
    let p = '';
    for (const e of events) {
      if (e.t > c.t) break;
      if (e.kind === 'app.navigate') p = String((e.data as { path?: string }).path ?? '');
    }
    return p;
  }, [events, c.t]);
  // Sub-second gaps (probe boots right after the session starts) are not worth a "starts at 0:00" overlay.
  const beforeReplay = hasReplay && offset >= 1000 && c.t < offset;

  return (
    <div ref={outer} className="relative h-full w-full overflow-hidden">
      <div
        className="absolute overflow-hidden rounded-[6px] bg-white shadow-[0_0_0_0.5px_rgba(255,255,255,.12)]"
        style={{ left, top, width: vw * scale, height: vh * scale, background: hasReplay ? '#fff' : '#1c1c1e' }}
      >
        <div
          ref={host}
          className="ta-replay origin-top-left"
          style={{ width: vw, height: vh, transform: `scale(${scale})`, display: hasReplay ? 'block' : 'none', pointerEvents: 'none' }}
        />
        {!hasReplay && (
          <div className="absolute inset-0 flex flex-col">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
              <span className="flex gap-1">
                <i className="size-2 rounded-full bg-white/15" />
                <i className="size-2 rounded-full bg-white/15" />
                <i className="size-2 rounded-full bg-white/15" />
              </span>
              <span className="mx-auto max-w-[60%] truncate rounded-[6px] bg-white/[0.06] px-3 py-0.5 text-[11px] text-white/50 tabular-nums">{currentPath || 'No page loaded'}</span>
            </div>
            <div className="flex flex-1 items-center justify-center text-center">
              <div className="text-[13px] text-white/40">
                No screen recording for this session
                <div className="mt-0.5 text-[12px] text-white/25">Pointer, gaze and clicks are shown from captured events</div>
              </div>
            </div>
          </div>
        )}
        {beforeReplay && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-[13px] text-white/60">Screen recording starts at {clock(offset)}</div>
        )}
        <canvas ref={canvas} className="pointer-events-none absolute inset-0" style={{ width: vw * scale, height: vh * scale }} />
      </div>
    </div>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

const MARKERS: Record<string, { color: string; label: string }> = {
  'app.error': { color: '#ff3b30', label: 'Error' },
  'app.network_error': { color: '#ff3b30', label: 'Network error' },
  'app.crash': { color: '#ff3b30', label: 'App crash' },
  'app.rage_click': { color: '#ff9f0a', label: 'Rage click' },
  'app.dead_click': { color: '#ffcc00', label: 'Dead click' },
  'moderator.probe': { color: '#5ac8fa', label: 'Probe' },
  'moderator.nudge': { color: '#a2a2f0', label: 'Nudge' },
};

export function Timeline({ clock: c, events, steps, results, notes }: { clock: PlayerClock; events: SessionEvent[]; steps: Step[]; results: TaskResult[]; notes: Note[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number; label?: string } | null>(null);
  const D = Math.max(1, c.duration);
  const x = (t: number) => `${(Math.max(0, Math.min(D, t)) / D) * 100}%`;
  const titles = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);

  // Task segments from task.start → task.end
  const segments = useMemo(() => {
    const out: { stepId: string; start: number; end: number; outcome?: string }[] = [];
    const open = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'task.start' && e.stepId) open.set(e.stepId, e.t);
      if (e.kind === 'task.end' && e.stepId) {
        const s = open.get(e.stepId) ?? e.t - Number((e.data as { durationMs?: number }).durationMs ?? 0);
        const r = results.find((x) => x.stepId === e.stepId);
        out.push({ stepId: e.stepId, start: s, end: e.t, outcome: r?.outcome ?? String((e.data as { outcome?: string }).outcome ?? '') });
        open.delete(e.stepId);
      }
    }
    for (const [stepId, s] of open) out.push({ stepId, start: s, end: D });
    return out;
  }, [events, results, D]);
  const stepTicks = useMemo(() => events.filter((e) => e.kind === 'step.enter' && e.stepId), [events]);
  const markers = useMemo(() => events.filter((e) => MARKERS[e.kind]), [events]);

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * D;
  };
  const labelAt = (t: number) => {
    const seg = segments.find((s) => t >= s.start && t <= s.end);
    if (seg) return titles.get(seg.stepId)?.title;
    let last: SessionEvent | undefined;
    for (const e of stepTicks) if (e.t <= t) last = e;
    return last?.stepId ? titles.get(last.stepId)?.title : undefined;
  };
  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    c.seek(timeAt(e.clientX));
  };
  return (
    <div className="select-none">
      <div
        ref={track}
        className="group relative h-10 cursor-pointer touch-none"
        onPointerDown={onDown}
        onPointerMove={(e) => {
          const t = timeAt(e.clientX);
          const r = track.current!.getBoundingClientRect();
          setHover({ x: e.clientX - r.left, t, label: labelAt(t) });
          if (e.buttons === 1) c.seek(t);
        }}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-label="Session timeline"
        aria-valuemin={0}
        aria-valuemax={D}
        aria-valuenow={c.t}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') c.seek(c.t + 5000);
          if (e.key === 'ArrowLeft') c.seek(c.t - 5000);
        }}
      >
        {/* markers row */}
        {markers.map((m, i) => (
          <span
            key={i}
            className="absolute top-0 size-[7px] -translate-x-1/2 rounded-full"
            style={{ left: x(m.t), background: MARKERS[m.kind].color }}
            title={`${MARKERS[m.kind].label} · ${clock(m.t)}`}
          />
        ))}
        {notes.map((n) => (
          <span key={n.id} className="absolute top-[-1px] h-[9px] w-[3px] -translate-x-1/2 rounded-full bg-white" style={{ left: x(n.t) }} title={`Note · ${n.text}`} />
        ))}
        {/* base track */}
        <div className="absolute inset-x-0 top-[16px] h-[6px] rounded-full bg-white/[0.12]" />
        {segments.map((s) => (
          <div
            key={s.stepId + s.start}
            className="absolute top-[16px] h-[6px] rounded-full"
            style={{ left: x(s.start), width: `calc(${x(s.end)} - ${x(s.start)})`, background: s.outcome ? OUTCOME_META[s.outcome as keyof typeof OUTCOME_META]?.color ?? '#8e8e93' : '#8e8e93', opacity: 0.55 }}
          />
        ))}
        <div className="absolute left-0 top-[16px] h-[6px] rounded-l-full bg-white/80 mix-blend-overlay" style={{ width: x(c.t) }} />
        {stepTicks.map((e, i) => (
          <span key={i} className="absolute top-[13px] h-[12px] w-px bg-white/30" style={{ left: x(e.t) }} />
        ))}
        {/* playhead */}
        <div className="absolute top-[11px] size-4 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,.5)] transition-transform group-hover:scale-110" style={{ left: x(c.t) }} />
        {hover && (
          <div className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-[8px] bg-black/80 px-2 py-1 text-[11px] text-white tabular-nums backdrop-blur" style={{ left: hover.x }}>
            {clock(hover.t)}
            {hover.label && <span className="text-white/60"> · {hover.label}</span>}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/45">
        {[...new Set(markers.map((m) => MARKERS[m.kind].label))].map((l) => {
          const color = Object.values(MARKERS).find((m) => m.label === l)!.color;
          return (
            <span key={l} className="inline-flex items-center gap-1.5">
              <i className="size-1.5 rounded-full" style={{ background: color }} />
              {l}
            </span>
          );
        })}
        {notes.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <i className="h-2 w-[3px] rounded-full bg-white" />
            Note
          </span>
        )}
      </div>
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

export function Controls({
  clock: c,
  showMouse,
  setShowMouse,
  showGaze,
  setShowGaze,
  hasGaze,
  hasMouse,
  audioState,
  captions,
  setCaptions,
}: {
  clock: PlayerClock;
  showMouse: boolean;
  setShowMouse: (v: boolean) => void;
  showGaze: boolean;
  setShowGaze: (v: boolean) => void;
  hasGaze: boolean;
  hasMouse: boolean;
  audioState: string;
  captions: boolean;
  setCaptions: (v: boolean) => void;
}) {
  const btn = 'inline-flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10';
  const chip = (on: boolean) => cn('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors', on ? 'bg-white/[0.16] text-white' : 'text-white/45 hover:text-white/75');
  return (
    <div className="flex items-center gap-1">
      <button className={btn} onClick={() => c.seek(c.t - 10_000)} aria-label="Back 10 seconds">
        <RotateCcw className="size-[18px]" strokeWidth={1.75} />
      </button>
      <button className="inline-flex size-10 items-center justify-center rounded-full bg-white text-black transition-transform active:scale-95" onClick={c.toggle} aria-label={c.playing ? 'Pause' : 'Play'}>
        {c.playing ? <Pause className="size-[18px]" fill="currentColor" strokeWidth={0} /> : <Play className="ml-0.5 size-[18px]" fill="currentColor" strokeWidth={0} />}
      </button>
      <button className={btn} onClick={() => c.seek(c.t + 10_000)} aria-label="Forward 10 seconds">
        <RotateCw className="size-[18px]" strokeWidth={1.75} />
      </button>
      <span className="ml-2 whitespace-nowrap text-[13px] font-medium text-white tabular-nums">
        {clock(c.t)} <span className="text-white/40">/ {clock(c.duration)}</span>
      </span>
      <span className="ml-3 hidden truncate text-[11px] text-white/35 md:inline">{audioState}</span>
      <div className="ml-auto flex items-center gap-1">
        <button className={chip(captions)} onClick={() => setCaptions(!captions)} aria-pressed={captions}>
          <Captions className="size-3.5" strokeWidth={1.75} /> Captions
        </button>
        {hasMouse && (
          <button className={chip(showMouse)} onClick={() => setShowMouse(!showMouse)} aria-pressed={showMouse}>
            <MousePointer2 className="size-3.5" strokeWidth={1.75} /> Pointer
          </button>
        )}
        {hasGaze && (
          <button className={chip(showGaze)} onClick={() => setShowGaze(!showGaze)} aria-pressed={showGaze}>
            <Eye className="size-3.5" strokeWidth={1.75} /> Gaze
          </button>
        )}
        <div className="ml-2 inline-flex rounded-full bg-white/[0.08] p-0.5">
          {[1, 2, 4].map((s) => (
            <button key={s} onClick={() => c.setSpeed(s)} className={cn('rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums transition-colors', c.speed === s ? 'bg-white/90 text-black' : 'text-white/60 hover:text-white')}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

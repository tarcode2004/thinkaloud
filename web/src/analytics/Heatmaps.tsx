import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { api } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { FullPageSpinner, Spinner, cn } from '../ui/index.tsx';
import { ResultsPage, useResults } from './ResultsRoutes.tsx';
import { Dot, Empty, Panel, Segmented, Switch } from './components.tsx';
import { OUTCOME_META, pct, secs } from './format.ts';
import type { HeatmapData } from './types.ts';

type Kind = 'click' | 'gaze' | 'mouse';

export default function Heatmaps() {
  const { studyId, base, includePreview } = useResults();
  const [stepId, setStepId] = useState<string>('');
  const [path, setPath] = useState<string>('');
  const [kind, setKind] = useState<Kind>('click');
  const [variantId, setVariantId] = useState<string>('');
  const [radiusByKind, setRadiusByKind] = useState<Record<Kind, number>>({ click: 28, mouse: 24, gaze: 70 });
  const radius = radiusByKind[kind];
  const setRadius = (r: number) => setRadiusByKind((m) => ({ ...m, [kind]: r }));
  const [showDots, setShowDots] = useState(true);
  const [view, setView] = useState<'heat' | 'first'>('heat');

  const q = useAsync(
    () =>
      api.get<HeatmapData>(
        `/api/studies/${studyId}/heatmap?kind=${kind}${stepId ? `&stepId=${encodeURIComponent(stepId)}` : ''}${path ? `&path=${encodeURIComponent(path)}` : ''}${variantId ? `&variantId=${variantId}` : ''}${includePreview ? '&includePreview=1' : ''}`,
      ),
    [studyId, stepId, path, kind, variantId, includePreview],
  );
  const data = q.data;
  // Default to the first task and its most-used page.
  useEffect(() => {
    if (data && !stepId && data.tasks[0]) setStepId(data.tasks[0].stepId);
  }, [data, stepId]);
  useEffect(() => {
    if (data && !path && data.paths[0] && stepId && data.stepId === stepId) setPath(data.paths[0].path);
  }, [data, path, stepId]);

  if (!data && q.loading) return <FullPageSpinner />;
  if (!data) return <ResultsPage title="Heatmaps"><Empty title="Heatmaps couldn't load">{q.error?.message}</Empty></ResultsPage>;

  const selectCls = 'h-8 max-w-[260px] rounded-full bg-fill px-3 text-[13px] text-label outline-none focus:ring-4 focus:ring-brand-500/20';
  return (
    <ResultsPage title="Heatmaps" subtitle="Where participants clicked, moved and looked on each page, per task." wide>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select value={stepId} onChange={(e) => (setStepId(e.target.value), setPath(''))} className={selectCls} aria-label="Task">
          <option value="">All steps</option>
          {data.tasks.map((t) => (
            <option key={t.stepId} value={t.stepId}>
              {t.title}
            </option>
          ))}
        </select>
        <select value={path} onChange={(e) => setPath(e.target.value)} className={selectCls} aria-label="Page">
          <option value="">All pages</option>
          {data.paths.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path} ({p.count})
            </option>
          ))}
          {path && !data.paths.some((p) => p.path === path) && <option value={path}>{path}</option>}
        </select>
        <Segmented
          options={[
            { value: 'click', label: 'Clicks' },
            { value: 'mouse', label: 'Pointer' },
            { value: 'gaze', label: 'Gaze' },
          ]}
          value={kind}
          onChange={(k) => setKind(k as Kind)}
        />
        {data.variants.length > 1 && (
          <Segmented options={[{ value: '', label: 'All variants' }, ...data.variants.map((v) => ({ value: v.id, label: v.name.split(/\s[—-]\s/)[0] }))]} value={variantId} onChange={setVariantId} />
        )}
        <div className="ml-auto flex items-center gap-4">
          {q.loading && <Spinner className="size-4" />}
          {stepId && (
            <Segmented
              size="sm"
              options={[
                { value: 'heat', label: 'Density' },
                { value: 'first', label: 'First click' },
              ]}
              value={view}
              onChange={setView}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel className="overflow-hidden p-4">
          {view === 'first' && stepId && <FirstClickPages data={data} onPick={setPath} />}
          <HeatStage data={data} radius={radius} showDots={showDots && kind === 'click'} mode={view === 'first' && stepId ? 'first' : 'heat'} />
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-[12px] text-tertiary">
            <span className="inline-flex items-center gap-2">
              Fewer
              <span className="h-1.5 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(0,113,227,.12), #0071e3, #003a75)' }} />
              More
            </span>
            <label className="inline-flex items-center gap-2">
              Radius
              <input type="range" min={10} max={120} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="w-24 accent-[#0071e3]" />
            </label>
            {kind === 'click' && <Switch checked={showDots} onChange={setShowDots} label="Individual clicks" />}
            <span className="ml-auto">
              {data.snapshot ? (
                <>
                  Background from{' '}
                  <Link className="text-brand-500 hover:underline" to={`${base}/sessions/${data.snapshot.sessionId}?t=${Math.round(data.snapshot.t)}`}>
                    a session replay
                  </Link>
                </>
              ) : (
                'No screen recording for this page; showing a blank viewport'
              )}
            </span>
          </div>
        </Panel>
        <SidePanel data={data} kind={kind} stepId={stepId} />
      </div>
    </ResultsPage>
  );
}

// ── Stage: background snapshot + density canvas ─────────────────────────────

function HeatStage({ data, radius, showDots, mode }: { data: HeatmapData; radius: number; showDots: boolean; mode: 'heat' | 'first' }) {
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(900);
  const [bgState, setBgState] = useState<'none' | 'loading' | 'ready' | 'failed'>('none');
  const vw = data.viewport.w;
  const vh = data.viewport.h;
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = w / vw;
  const h = vh * scale;

  // Background: rrweb snapshot at the referenced moment.
  const snap = data.snapshot;
  useEffect(() => {
    if (!snap || !host.current) {
      setBgState('none');
      return;
    }
    let cancelled = false;
    let r: Replayer | null = null;
    setBgState('loading');
    api
      .get<{ type: number; timestamp: number; data?: { width?: number } }[]>(`/api/sessions/${snap.sessionId}/replay`)
      .then((evs) => {
        if (cancelled || !host.current || evs.length < 2) return setBgState('failed');
        host.current.innerHTML = '';
        r = new Replayer(evs as never, { root: host.current, showWarning: false, mouseTail: false, triggerFocus: false });
        r.pause(Math.max(0, snap.timestamp - evs[0].timestamp));
        // Hide the replay cursor in the background.
        host.current.querySelectorAll<HTMLElement>('.replayer-mouse').forEach((m) => (m.style.display = 'none'));
        setBgState('ready');
      })
      .catch(() => setBgState('failed'));
    return () => {
      cancelled = true;
      r?.destroy();
    };
  }, [snap?.sessionId, snap?.timestamp]);

  // Density: accumulate alpha blobs, then colorize with a single-hue ramp.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'first') {
      for (const f of data.firstClicks.filter((x) => !data.path || x.path === data.path)) {
        const x = f.nx * W;
        const y = f.ny * H;
        const color = f.outcome === 'success' ? '#34c759' : f.outcome ? '#ff3b30' : '#8e8e93';
        ctx.beginPath();
        ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      return;
    }
    const pts = data.points;
    if (!pts.length) return;
    // Gaussian kernel density on a float grid (no 8-bit alpha clipping), then colorize and upscale.
    const CELL = 4;
    const gw = Math.ceil(W / CELL);
    const gh = Math.ceil(H / CELL);
    const grid = new Float32Array(gw * gh);
    const sigma = Math.max(1.5, (radius * dpr * Math.max(0.6, scale)) / CELL / 2);
    const kr = Math.ceil(sigma * 3);
    const kernel = new Float32Array((2 * kr + 1) ** 2);
    for (let dy = -kr; dy <= kr; dy++) for (let dx = -kr; dx <= kr; dx++) kernel[(dy + kr) * (2 * kr + 1) + dx + kr] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    for (const p of pts) {
      const cx = Math.round((p.nx * W) / CELL);
      const cy = Math.round((p.ny * H) / CELL);
      for (let dy = -kr; dy <= kr; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= gh) continue;
        for (let dx = -kr; dx <= kr; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= gw) continue;
          grid[y * gw + x] += kernel[(dy + kr) * (2 * kr + 1) + dx + kr];
        }
      }
    }
    let max = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
    if (!max) return;
    const off = document.createElement('canvas');
    off.width = gw;
    off.height = gh;
    const o = off.getContext('2d')!;
    const img = o.createImageData(gw, gh);
    const d = img.data;
    // Single-hue ramp: light blue (low) → system blue → deep navy (high); alpha grows with density.
    const stops = [
      [0, [61, 151, 255, 0]],
      [0.28, [61, 151, 255, 64]],
      [0.45, [0, 113, 227, 140]],
      [1, [0, 58, 117, 200]],
    ] as const;
    for (let i = 0; i < grid.length; i++) {
      const v = Math.sqrt(grid[i] / max); // sqrt keeps sparse areas visible without flattening hot spots
      if (v <= 0.015) continue;
      let k = 1;
      while (k < stops.length - 1 && v > stops[k][0]) k++;
      const [a0, c0] = stops[k - 1];
      const [a1, c1] = stops[k];
      const f = (v - a0) / (a1 - a0);
      const j = i * 4;
      d[j] = c0[0] + (c1[0] - c0[0]) * f;
      d[j + 1] = c0[1] + (c1[1] - c0[1]) * f;
      d[j + 2] = c0[2] + (c1[2] - c0[2]) * f;
      d[j + 3] = c0[3] + (c1[3] - c0[3]) * f;
    }
    o.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, gw * CELL, gh * CELL);
    if (showDots) {
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.nx * W, p.ny * H, 3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = p.dead ? '#ff3b30' : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = p.dead ? '#ffffff' : '#003a75';
        ctx.stroke();
      }
    }
  }, [data, w, h, radius, showDots, scale, mode]);

  return (
    <div ref={outer} className="relative w-full overflow-hidden rounded-[12px] bg-fill ring-1 ring-black/[0.06]" style={{ height: h }}>
      <div className="absolute inset-0" style={{ opacity: bgState === 'ready' ? 0.92 : 0 }}>
        <div ref={host} className="pointer-events-none origin-top-left" style={{ width: vw, height: vh, transform: `scale(${scale})` }} />
      </div>
      {bgState !== 'ready' && (
        <div className="absolute inset-0 flex items-start justify-center pt-6">
          <span className="rounded-full bg-white/70 px-3 py-1 text-[12px] text-tertiary">{bgState === 'loading' ? 'Loading page snapshot…' : `${vw}×${vh} viewport`}</span>
        </div>
      )}
      <canvas ref={canvas} className="pointer-events-none absolute inset-0" style={{ width: w, height: h }} />
      {!data.points.length && mode === 'heat' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-[12px] bg-white/90 px-4 py-2 text-[13px] text-secondary shadow-sm">No {data.kind === 'click' ? 'clicks' : data.kind === 'gaze' ? 'gaze samples' : 'pointer samples'} for this selection</span>
        </div>
      )}
    </div>
  );
}

function FirstClickPages({ data, onPick }: { data: HeatmapData; onPick: (p: string) => void }) {
  const byPath = new Map<string, number>();
  for (const f of data.firstClicks) byPath.set(f.path, (byPath.get(f.path) ?? 0) + 1);
  const here = data.path ? byPath.get(data.path) ?? 0 : data.firstClicks.length;
  const others = [...byPath.entries()].filter(([p]) => p !== data.path).sort((a, b) => b[1] - a[1]);
  if (!others.length) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-1 text-[13px] text-secondary">
      <span className="tabular-nums">
        {here} of {data.firstClicks.length} first clicks happened on this page.
      </span>
      {others.slice(0, 3).map(([p, n]) => (
        <button key={p} onClick={() => onPick(p)} className="rounded-full bg-brand-500/10 px-2.5 py-0.5 text-[12px] font-medium text-brand-600 hover:bg-brand-500/15 tabular-nums">
          Show {p} ({n})
        </button>
      ))}
    </div>
  );
}

// ── Side panel ──────────────────────────────────────────────────────────────

function SidePanel({ data, kind, stepId }: { data: HeatmapData; kind: Kind; stepId: string }) {
  const dead = data.points.filter((p) => p.dead).length;
  const fcMs = data.firstClicks.map((f) => f.ms).filter((x): x is number => x != null).sort((a, b) => a - b);
  const medFc = fcMs.length ? fcMs[Math.floor(fcMs.length / 2)] : null;
  // Only meaningful when the task's click rule targets something people can click first.
  const onTarget = data.firstClicks.some((f) => f.onTarget) ? data.firstClicks.filter((f) => f.onTarget != null) : [];
  const correct = onTarget.filter((f) => f.onTarget).length;
  const totalFc = data.firstClicks.length;
  const succAfter = (pred: (f: HeatmapData['firstClicks'][number]) => boolean) => {
    const xs = data.firstClicks.filter((f) => pred(f) && f.outcome);
    return xs.length ? xs.filter((f) => f.outcome === 'success').length / xs.length : null;
  };
  const stat = (label: string, value: string, sub?: string) => (
    <div>
      <div className="text-[12px] text-secondary">{label}</div>
      <div className="text-[22px] font-semibold tracking-[-0.015em] text-label tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-tertiary">{sub}</div>}
    </div>
  );
  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <div className="grid grid-cols-2 gap-4">
          {stat(kind === 'click' ? 'Clicks' : 'Samples', data.points.length.toLocaleString())}
          {stat('Participants', String(data.sessions))}
          {kind === 'click' && stat('Misclicks', data.points.length ? pct(dead / data.points.length) : '—', 'Clicks that changed nothing')}
          {stepId && stat('Time to first click', secs(medFc), 'Median')}
        </div>
        {kind === 'gaze' && <p className="mt-4 text-[12px] leading-relaxed text-tertiary">Webcam gaze is accurate to roughly 100–200 px. Read it at the level of page regions, not individual words or buttons.</p>}
      </Panel>
      {stepId && (
        <Panel className="overflow-hidden">
          <div className="px-5 pb-2 pt-4">
            <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-label">First click</h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-tertiary">
              {onTarget.length
                ? `${correct} of ${onTarget.length} first clicks hit the target set in the task's click rule.`
                : 'Where each participant clicked first in this task, and how the task ended for them.'}
            </p>
          </div>
          {onTarget.length > 0 && (
            <div className="grid grid-cols-2 gap-4 border-t border-separator px-5 py-3">
              {stat('Correct first click', pct(correct / onTarget.length))}
              {stat('Success after correct', pct(succAfter((f) => f.onTarget === true)), `vs ${pct(succAfter((f) => f.onTarget === false))} otherwise`)}
            </div>
          )}
          <div className="border-t border-separator">
            {data.firstClickTargets.slice(0, 8).map((g) => (
              <div key={g.selector + g.target} className="flex items-center gap-3 border-b border-separator/70 px-5 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-label">
                    {g.onTarget && <Dot color="#34c759" className="mr-1.5 align-middle" />}
                    {g.target}
                  </div>
                  <div className="truncate text-[11px] text-tertiary">{g.selector}</div>
                </div>
                <div className="text-right text-[12px] tabular-nums">
                  <div className="font-medium text-label">{totalFc ? pct(g.count / totalFc) : '—'}</div>
                  <div className="text-tertiary">{g.withOutcome ? `${pct(g.successes / g.withOutcome)} succeeded` : ''}</div>
                </div>
              </div>
            ))}
            {!data.firstClickTargets.length && <div className="px-5 py-4 text-[13px] text-tertiary">No clicks recorded for this task.</div>}
          </div>
          <div className="flex gap-4 border-t border-separator px-5 py-2.5 text-[11px] text-tertiary">
            <span className="inline-flex items-center gap-1.5">
              <Dot color={OUTCOME_META.success.color} /> Task succeeded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Dot color={OUTCOME_META.failure.color} /> Did not succeed
            </span>
          </div>
        </Panel>
      )}
      <p className={cn('px-1 text-[12px] leading-relaxed text-tertiary')}>
        Positions are normalized to each participant's viewport. Pages that scroll are shown as the visible viewport, so content below the fold isn't represented.
      </p>
    </div>
  );
}

// Optional eye-tracking calibration: 9-point click calibration + 5-point validation (mean error px).
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/index.tsx';
import { EyeTracker } from './eyetracking.ts';

const CAL_POINTS: [number, number][] = [
  [0.08, 0.1], [0.5, 0.1], [0.92, 0.1],
  [0.08, 0.5], [0.5, 0.5], [0.92, 0.5],
  [0.08, 0.9], [0.5, 0.9], [0.92, 0.9],
];
const VAL_POINTS: [number, number][] = [
  [0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75],
];
const CLICKS_PER_POINT = 3;

export interface CalibrationResult {
  errorPx: number;
  points: number;
}

type Phase = 'loading' | 'position' | 'calibrate' | 'validate' | 'result' | 'nodata' | 'failed';

export function Calibration({ onDone, onSkip }: { onDone: (eye: EyeTracker, r: CalibrationResult) => void; onSkip: () => void }) {
  const eye = useRef<EyeTracker | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [pt, setPt] = useState(0);
  const [clicks, setClicks] = useState(0);
  const [vpt, setVpt] = useState(-1);
  const [errorPx, setErrorPx] = useState<number | null>(null);

  useEffect(() => {
    const e = new EyeTracker();
    eye.current = e;
    let cancelled = false;
    e.start()
      .then(() => {
        if (cancelled) return;
        setPhase('position');
      })
      .catch((x) => {
        if (cancelled) return;
        setErr((x as Error).message);
        console.warn('[eyetracking] unavailable:', (x as Error).message);
        setPhase('failed');
        e.stop();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the camera preview inside the space reserved for it in the layout.
  const previewSlot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase !== 'position') return;
    const place = () => previewSlot.current && eye.current?.positionPreview('center', previewSlot.current.getBoundingClientRect());
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [phase]);

  const skip = () => {
    eye.current?.stop();
    onSkip();
  };

  const startCal = () => {
    eye.current?.positionPreview('corner');
    setPt(0);
    setClicks(0);
    setPhase('calibrate');
  };

  const clickPoint = (x: number, y: number) => {
    eye.current?.record(x, y);
    const c = clicks + 1;
    if (c >= CLICKS_PER_POINT) {
      if (pt + 1 >= CAL_POINTS.length) void validate();
      else {
        setPt(pt + 1);
        setClicks(0);
      }
    } else setClicks(c);
  };

  const validate = async () => {
    setPhase('validate');
    eye.current?.positionPreview('hidden');
    const errs: number[] = [];
    for (let i = 0; i < VAL_POINTS.length; i++) {
      setVpt(i);
      const [fx, fy] = VAL_POINTS[i];
      const tx = fx * window.innerWidth;
      const ty = fy * window.innerHeight;
      await sleep(700); // settle
      const t0 = performance.now();
      while (performance.now() - t0 < 1400) {
        const l = eye.current?.latest;
        if (l && l.at > t0) errs.push(Math.hypot(l.x - tx, l.y - ty));
        await sleep(60);
      }
    }
    if (errs.length < 3) {
      // No usable predictions (face lost, too dark…): say so instead of reporting a fake accuracy.
      setPhase('nodata');
      return;
    }
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    setErrorPx(Math.round(mean));
    setPhase('result');
  };

  const quality = errorPx == null ? '' : errorPx < 150 ? 'Good' : errorPx < 260 ? 'Fair' : 'Low';

  if (phase === 'calibrate' || phase === 'validate') {
    const [fx, fy] = phase === 'calibrate' ? CAL_POINTS[pt] : VAL_POINTS[Math.max(0, vpt)];
    return (
      <div className="fixed inset-0 z-50 cursor-crosshair bg-canvas" data-testid="calibration-stage">
        <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center px-4" aria-live="polite">
          <div className="max-w-[640px] rounded-[18px] bg-surface/95 px-6 py-3 text-center shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_16px_rgba(0,0,0,.06)]">
            <p className="text-[24px] font-semibold leading-snug tracking-[-0.015em] text-label">
              {phase === 'calibrate' ? `Look at the dot and click it ${CLICKS_PER_POINT} times` : 'Now just look at each dot. No clicking.'}
            </p>
            <p className="mt-1 text-[17px] tabular-nums text-secondary">
              {phase === 'calibrate'
                ? `Dot ${pt + 1} of ${CAL_POINTS.length} · ${clicks} of ${CLICKS_PER_POINT} clicks`
                : `Dot ${Math.max(0, vpt) + 1} of ${VAL_POINTS.length}`}
            </p>
          </div>
        </div>
        <button
          aria-label="Calibration point"
          disabled={phase === 'validate'}
          onClick={(e) => clickPoint(e.clientX, e.clientY)}
          className="absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500 transition-[left,top,transform] duration-300 ease-apple active:scale-90"
          style={{ left: `${fx * 100}%`, top: `${fy * 100}%`, opacity: phase === 'calibrate' ? 0.35 + (clicks / CLICKS_PER_POINT) * 0.65 : 1 }}
        >
          <span className="absolute inset-[14px] rounded-full bg-white" />
        </button>
        <button onClick={skip} className="absolute bottom-6 right-6 rounded-full bg-fill px-5 py-2.5 text-[15px] font-medium text-label hover:bg-black/10">
          Skip eye tracking
        </button>
      </div>
    );
  }

  return (
    <div data-testid="calibration">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Set up eye tracking</h1>
      {phase === 'loading' && <p className="mt-3 text-[17px] text-secondary">Starting your camera… This can take a few seconds.</p>}
      {phase === 'position' && (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-secondary">Center your face in the preview, about an arm’s length from the screen, in good light. Then you’ll click nine dots while looking at them.</p>
          <div ref={previewSlot} className="my-6 h-[240px] w-full" data-testid="camera-preview-slot" />
          <div className="flex gap-3">
            <Button size="lg" onClick={startCal}>
              Start calibration
            </Button>
            <Button size="lg" variant="secondary" onClick={skip}>
              Skip
            </Button>
          </div>
        </>
      )}
      {phase === 'result' && (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-secondary">
            Accuracy: <span className="font-semibold text-label">{quality}</span> <span className="tabular-nums text-tertiary">(about {errorPx}px)</span>
          </p>
          <div className="mt-8 flex gap-3">
            <Button size="lg" onClick={() => eye.current && onDone(eye.current, { errorPx: errorPx ?? 9999, points: CAL_POINTS.length })} data-testid="calibration-continue">
              Continue
            </Button>
            <Button size="lg" variant="secondary" onClick={startCal}>
              Calibrate again
            </Button>
          </div>
        </>
      )}
      {phase === 'nodata' && (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-secondary">We couldn’t follow your eyes this time. Check that your face is well lit and centered, then try again — or continue without eye tracking.</p>
          <div className="mt-8 flex gap-3">
            <Button size="lg" onClick={() => setPhase('position')}>
              Try again
            </Button>
            <Button size="lg" variant="secondary" onClick={skip}>
              Continue without
            </Button>
          </div>
        </>
      )}
      {phase === 'failed' && (
        <>
          <p className="mt-3 text-[17px] leading-relaxed text-secondary">Eye tracking isn’t available on this device. That’s fine — you can continue without it.</p>
          <Button size="lg" className="mt-8" onClick={onSkip}>
            Continue without eye tracking
          </Button>
        </>
      )}
      {phase === 'loading' && (
        <Button size="lg" variant="secondary" className="mt-8" onClick={skip}>
          Skip
        </Button>
      )}
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

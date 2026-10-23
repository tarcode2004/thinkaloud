import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../ui/index.tsx';

export interface CoachStep {
  /** CSS selector of the element the step points at (`[data-tour="..."]`). */
  target: string;
  title: string;
  body: string;
}

const TOUR_KEY = 'ta.tour.study.v1';
const OPEN_EVENT = 'ta:tour-open';

function seen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === 'done';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(TOUR_KEY, 'done');
  } catch {
    /* private mode: the tour just shows again next time */
  }
}

/** Replay the tour (e.g. from a "Show me around" link). */
export function openTour() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const W = 300;

/**
 * A short, dismissible tour: one opaque popover at a time, anchored under its target, with no
 * dimming overlay so the page stays readable. Shows once per browser unless replayed.
 */
export default function CoachMarks({ steps, autoStart }: { steps: CoachStep[]; autoStart: boolean }) {
  const [i, setI] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (autoStart && !seen()) {
      const t = setTimeout(() => setI(0), 600);
      return () => clearTimeout(t);
    }
  }, [autoStart]);
  useEffect(() => {
    const open = () => setI(0);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);

  const step = i === null ? null : steps[i];
  const measure = useCallback(() => {
    if (!step) return setRect(null);
    const el = document.querySelector(step.target);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);
  useLayoutEffect(() => {
    measure();
    if (!step) return;
    document.querySelector(step.target)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure, step]);

  const close = useCallback(() => {
    markSeen();
    setI(null);
  }, []);
  useEffect(() => {
    if (i === null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [i, close]);

  if (i === null || !step) return null;
  const vw = window.innerWidth;
  const left = rect ? Math.min(Math.max(12, rect.left + rect.width / 2 - W / 2), vw - W - 12) : vw / 2 - W / 2;
  const top = rect ? rect.bottom + 12 : 120;
  const arrowLeft = rect ? Math.min(Math.max(20, rect.left + rect.width / 2 - left), W - 20) : W / 2;
  const last = i === steps.length - 1;

  return (
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] rounded-full ring-2 ring-brand-500 ring-offset-2 ring-offset-canvas transition-all duration-300 motion-reduce:transition-none"
          style={{ left: rect.left - 2, top: rect.top - 2, width: rect.width + 4, height: rect.height + 4 }}
        />
      )}
      <div
        role="dialog"
        aria-label={`Tour, step ${i + 1} of ${steps.length}: ${step.title}`}
        data-testid="coach-mark"
        className="fixed z-[61] rounded-[18px] bg-surface p-4 shadow-[0_12px_40px_rgba(0,0,0,.18)] ring-1 ring-black/[0.06] animate-[ta-fade_.2s_ease-out] motion-reduce:animate-none"
        style={{ left, top, width: W }}
      >
        <span aria-hidden className="absolute -top-[6px] size-3 rotate-45 bg-surface ring-1 ring-black/[0.06] [clip-path:polygon(0_0,100%_0,0_100%)]" style={{ left: arrowLeft - 6 }} />
        <div className="flex items-start justify-between gap-3">
          <div className="text-[12px] font-medium tabular-nums text-tertiary">{i + 1} of {steps.length}</div>
          <button onClick={close} aria-label="Close tour" className="-mr-1 -mt-1 rounded-full p-1 text-tertiary transition-colors hover:bg-fill hover:text-label">
            <X className="size-3.5" strokeWidth={2.25} />
          </button>
        </div>
        <h3 className="mt-1 text-[15px] font-semibold text-label">{step.title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-secondary">{step.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <button onClick={close} className="text-[13px] text-secondary hover:text-label">Skip tour</button>
          <div className="flex gap-2">
            {i > 0 && <Button variant="secondary" size="sm" onClick={() => setI(i - 1)}>Back</Button>}
            <Button size="sm" onClick={() => (last ? close() : setI(i + 1))} data-testid="coach-next">{last ? 'Done' : 'Next'}</Button>
          </div>
        </div>
      </div>
    </>
  );
}

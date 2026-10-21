// Results area: mounted by the researcher StudyLayout at /studies/:studyId/results/*
import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation, useParams } from 'react-router';
import { FullPageSpinner, cn } from '../ui/index.tsx';

const Overview = lazy(() => import('./Overview.tsx'));
const SessionsList = lazy(() => import('./SessionsList.tsx'));
const SessionDetail = lazy(() => import('./SessionDetail.tsx'));
const Heatmaps = lazy(() => import('./Heatmaps.tsx'));
const Insights = lazy(() => import('./Insights.tsx'));

interface ResultsCtx {
  studyId: string;
  base: string;
  level: 0.9 | 0.95;
  setLevel: (l: 0.9 | 0.95) => void;
  includePreview: boolean;
  setIncludePreview: (v: boolean) => void;
}
const Ctx = createContext<ResultsCtx | null>(null);
export const useResults = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useResults outside ResultsRoutes');
  return c;
};

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const NAV = [
  { to: '', label: 'Overview', end: true },
  { to: 'sessions', label: 'Sessions' },
  { to: 'heatmaps', label: 'Heatmaps' },
  { to: 'insights', label: 'Insights' },
];

export function ResultsNav() {
  const { base } = useResults();
  const loc = useLocation();
  return (
    <nav className="inline-flex rounded-[9px] bg-black/[0.06] p-[2px]" aria-label="Results sections">
      {NAV.map((n) => {
        const to = n.to ? `${base}/${n.to}` : base;
        const active = n.end ? loc.pathname.replace(/\/$/, '') === base : loc.pathname.startsWith(to);
        return (
          <NavLink
            key={n.label}
            to={to}
            end={n.end}
            className={cn(
              'rounded-[7px] px-3.5 py-1 text-[13px] font-medium transition-all duration-200 ease-apple',
              active ? 'bg-white text-label shadow-[0_1px_3px_rgba(0,0,0,.12),0_0_0_0.5px_rgba(0,0,0,.04)]' : 'text-secondary hover:text-label',
            )}
          >
            {n.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Standard page frame for results pages: title row with segmented section nav. */
export function ResultsPage({ title, subtitle, actions, children, wide }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('mx-auto px-6 pb-20 pt-8 lg:px-10', wide ? 'max-w-[1440px]' : 'max-w-[1200px]')}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="mb-4">
            <ResultsNav />
          </div>
          <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">{title}</h1>
          {subtitle && <p className="mt-1 text-[15px] text-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export default function ResultsRoutes() {
  const { studyId = '' } = useParams();
  const loc = useLocation();
  // Base = everything up to and including "/results".
  const base = useMemo(() => {
    const i = loc.pathname.indexOf('/results');
    return i >= 0 ? loc.pathname.slice(0, i + '/results'.length) : `/studies/${studyId}/results`;
  }, [loc.pathname, studyId]);
  const [level, setLevelState] = useState<0.9 | 0.95>(() => readPref('ta.results.level', 0.9));
  const [includePreview, setPreviewState] = useState<boolean>(() => readPref('ta.results.preview', false));
  const value: ResultsCtx = {
    studyId,
    base,
    level,
    setLevel: (l) => (setLevelState(l), writePref('ta.results.level', l)),
    includePreview,
    setIncludePreview: (v) => (setPreviewState(v), writePref('ta.results.preview', v)),
  };
  return (
    <Ctx.Provider value={value}>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="sessions" element={<SessionsList />} />
          <Route path="sessions/:sessionId" element={<SessionDetail />} />
          <Route path="heatmaps" element={<Heatmaps />} />
          <Route path="insights" element={<Insights />} />
          <Route path="*" element={<Overview />} />
        </Routes>
      </Suspense>
    </Ctx.Provider>
  );
}

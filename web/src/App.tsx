import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { FullPageSpinner } from './ui/index.tsx';

// Area owners: participant/ (participant runtime), researcher/ (dashboard), analytics/ (results).
const ParticipantApp = lazy(() => import('./participant/ParticipantApp.tsx'));
const ResearcherRoutes = lazy(() => import('./researcher/ResearcherRoutes.tsx'));

export function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/s/:token/*" element={<ParticipantApp />} />
        <Route path="/*" element={<ResearcherRoutes />} />
      </Routes>
    </Suspense>
  );
}

import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import { FullPageSpinner } from '../ui/index.tsx';
import { AuthProvider, RequireAuth, useAuth } from './auth.tsx';
import AppShell from './AppShell.tsx';
import Landing from './Landing.tsx';
import { LoginPage, SignupPage } from './AuthPages.tsx';
import StudiesPage from './StudiesPage.tsx';
import StudyLayout from './study/StudyLayout.tsx';
import Overview from './study/Overview.tsx';
import ProtocolEditorRoute, { ProtocolsIndex } from './protocol/ProtocolEditor.tsx';
import ConsentPage from './consent/ConsentPage.tsx';
import AppsPage from './study/AppsPage.tsx';
import VariantsPage from './study/VariantsPage.tsx';
import RecruitPage from './study/RecruitPage.tsx';
import BillingPage from './billing/BillingPage.tsx';

const ResultsRoutes = lazy(() => import('../analytics/ResultsRoutes.tsx'));

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to="/studies" replace />;
  return <Landing />;
}

function NotFound() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-24 text-center">
      <h1 className="text-[34px] font-bold tracking-[-0.022em]">Page not found</h1>
      <p className="mt-2 text-[15px] text-secondary">The page you are looking for does not exist.</p>
      <Link to="/" className="mt-6 text-[15px] text-brand-500 hover:underline">Go home</Link>
    </div>
  );
}

export default function ResearcherRoutes() {
  return (
    <AuthProvider>
      {/* SF Symbols-like icon weight across the researcher app */}
      <div className="h-full [&_svg.lucide]:[stroke-width:1.75]">
        <Routes>
          <Route index element={<Home />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route path="studies" element={<StudiesPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="studies/:studyId" element={<StudyLayout />}>
              <Route index element={<Overview />} />
              <Route path="protocols" element={<ProtocolsIndex />} />
              <Route path="protocols/:protocolId" element={<ProtocolEditorRoute />} />
              <Route path="consent" element={<ConsentPage />} />
              <Route path="apps" element={<AppsPage />} />
              <Route path="variants" element={<VariantsPage />} />
              <Route path="recruit" element={<RecruitPage />} />
              <Route path="results/*" element={<Suspense fallback={<FullPageSpinner />}><ResultsRoutes /></Suspense>} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </AuthProvider>
  );
}

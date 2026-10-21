import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BookOpen, ChevronsUpDown, FlaskConical, LayoutGrid, LogOut, Menu as MenuIcon, X } from 'lucide-react';
import { cn } from '../ui/index.tsx';
import { Logo, Menu, MenuItem } from './components/index.tsx';
import { useAuth } from './auth.tsx';
import { rApi, STATUS_META, type StudySummary } from './lib.ts';

/** Fire after creating/renaming/deleting a study so the sidebar refreshes. */
export function notifyStudiesChanged() {
  window.dispatchEvent(new Event('ta:studies-changed'));
}

export default function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="material sticky top-0 hidden h-screen w-60 shrink-0 border-r lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <aside className="material absolute inset-y-0 left-0 w-64 border-r" onClick={(e) => e.stopPropagation()}>
            <Sidebar />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="material sticky top-0 z-30 flex h-12 items-center gap-3 border-b px-4 lg:hidden">
          <button onClick={() => setMobileOpen((o) => !o)} className="rounded-full p-1.5 hover:bg-black/[0.05]" aria-label="Menu">
            {mobileOpen ? <X className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
          <Logo />
        </div>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [recent, setRecent] = useState<StudySummary[]>([]);
  useEffect(() => {
    const load = () => rApi.studies().then((r) => setRecent([...r.studies].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6)), () => {});
    load();
    window.addEventListener('ta:studies-changed', load);
    return () => window.removeEventListener('ta:studies-changed', load);
  }, []);
  const initials = (user?.name || user?.email || '?').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-5">
        <Link to="/studies"><Logo /></Link>
      </div>
      <nav className="space-y-px px-3 py-1">
        <SideLink to="/studies" end icon={<LayoutGrid className="size-4" />}>Studies</SideLink>
      </nav>
      {recent.length > 0 && (
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3">
          <div className="px-2.5 pb-1 text-[11px] font-semibold text-tertiary">Recent</div>
          <div className="space-y-px">
            {recent.map((s) => (
              <NavLink
                key={s.id}
                to={`/studies/${s.id}`}
                className={({ isActive }) =>
                  cn('flex items-center gap-2 rounded-[7px] px-2.5 py-[5px] text-[13px] transition-colors', isActive ? 'bg-black/[0.06] text-label' : 'text-label/80 hover:bg-black/[0.03]')
                }
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_META[s.status]?.dot ?? 'bg-tertiary')} />
                <span className="truncate">{s.name}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
      {recent.length === 0 && <div className="flex-1" />}
      <div className="border-t border-separator p-3">
        <a href="#guide" onClick={(e) => { e.preventDefault(); nav('/studies?guide=1'); }} className="flex items-center gap-2 rounded-[7px] px-2.5 py-[5px] text-[13px] text-label/80 hover:bg-black/[0.03]">
          <BookOpen className="size-4 text-secondary" /> Quick-start guide
        </a>
        <Menu
          className="bottom-full mb-1.5 w-56"
          trigger={({ toggle }) => (
            <button onClick={toggle} className="mt-1 flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left hover:bg-black/[0.03]" data-testid="user-menu">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#8e8e93] text-[11px] font-semibold text-white">{initials}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-label">{user?.name}</span>
                <span className="block truncate text-[11px] text-secondary">{user?.email}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<FlaskConical className="size-4" />} onClick={() => { close(); nav('/studies'); }}>All studies</MenuItem>
              <MenuItem
                icon={<LogOut className="size-4" />}
                onClick={async () => {
                  close();
                  await logout();
                  nav('/', { replace: true });
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}

function SideLink({ to, icon, children, end }: { to: string; icon: React.ReactNode; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('flex items-center gap-2 rounded-[7px] px-2.5 py-[5px] text-[13px] transition-colors [&_svg]:text-brand-500', isActive ? 'bg-black/[0.06] text-label' : 'text-label/80 hover:bg-black/[0.03]')
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

// "Sign in with Google" via Google Identity Services (GIS). The button is Google's own, rendered by
// their script so it follows Google's branding rules. It hands us an ID token (JWT) that the server
// verifies (POST /api/auth/google). Nothing renders unless the server reports a GOOGLE_CLIENT_ID.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';

export interface AuthProviders {
  google: { clientId: string; oneTap: boolean } | null;
}

let providersPromise: Promise<AuthProviders> | null = null;
/** Which sign-in providers the server offers (cached for the page's lifetime; none on any error). */
export function useAuthProviders(): AuthProviders | null {
  const [p, setP] = useState<AuthProviders | null>(null);
  useEffect(() => {
    providersPromise ??= api.get<AuthProviders>('/api/auth/providers').catch(() => ({ google: null }));
    let alive = true;
    void providersPromise.then((r) => alive && setP(r?.google?.clientId ? r : { google: null }));
    return () => {
      alive = false;
    };
  }, []);
  return p;
}

// Minimal typing for the parts of GIS we use (https://developers.google.com/identity/gsi/web/reference/js-reference).
interface GisId {
  initialize(o: Record<string, unknown>): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GisId } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisPromise: Promise<GisId> | null = null;
function loadGis(): Promise<GisId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  gisPromise ??= new Promise<GisId>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('gis')));
    s.onerror = () => reject(new Error('gis'));
    document.head.appendChild(s);
  }).catch((e) => {
    gisPromise = null; // allow a retry on the next mount
    throw e;
  });
  return gisPromise;
}

/**
 * Google's button, full width of its container (GIS caps it at 400 px). `onCredential` receives the ID token.
 * One Tap is shown only when the server enables it (GOOGLE_ONE_TAP) and `oneTap` is set.
 */
export function GoogleSignInButton({
  clientId,
  mode,
  oneTap = false,
  disabled = false,
  onCredential,
  children,
}: {
  clientId: string;
  mode: 'login' | 'signup';
  oneTap?: boolean;
  disabled?: boolean;
  onCredential: (credential: string) => void;
  /** Shown between the button and the "or" separator (e.g. an error line). */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let ro: ResizeObserver | undefined;
    loadGis().then(
      (gis) => {
        if (!alive || !box.current) return;
        gis.initialize({
          client_id: clientId,
          callback: (r: { credential?: string }) => r.credential && cb.current(r.credential),
          context: mode === 'signup' ? 'signup' : 'signin',
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          use_fedcm_for_prompt: true,
        });
        let width = 0;
        const render = () => {
          const el = box.current;
          if (!el) return;
          const w = Math.max(200, Math.min(400, Math.floor(el.clientWidth)));
          if (w === width) return;
          width = w;
          el.replaceChildren();
          gis.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: mode === 'signup' ? 'signup_with' : 'signin_with', logo_alignment: 'center', width: w });
        };
        render();
        ro = new ResizeObserver(render);
        ro.observe(box.current);
        if (oneTap) gis.prompt();
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
      ro?.disconnect();
      window.google?.accounts?.id?.cancel();
    };
  }, [clientId, mode, oneTap]);

  if (failed) return <p className="mb-5 text-center text-[13px] text-secondary">Google sign-in isn’t available right now. Use your email instead.</p>;
  return (
    <>
      <div
        ref={box}
        data-testid="google-signin"
        aria-disabled={disabled || undefined}
        className={'flex h-11 w-full items-center justify-center transition-opacity duration-200 ' + (disabled ? 'pointer-events-none opacity-50' : '')}
      />
      {children}
      <OrSeparator />
    </>
  );
}

/** Hairline "or" separator between Google and the email form. */
function OrSeparator() {
  return (
    <div className="my-5 flex items-center gap-3 text-[13px] text-tertiary" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-separator" />
      or
      <span className="h-px flex-1 bg-separator" />
    </div>
  );
}

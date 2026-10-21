// Participant runtime at /s/:token — flow: landing → consent → device check →
// (eye-tracking calibration) → session → done | withdrawn | error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ConsentRecord, DeviceInfo, PublicLinkInfo, StartSessionResponse } from '@thinkaloud/shared';
import { ApiError } from '../lib/api.ts';
import { pApi } from './api.ts';
import { audioContext } from './media.ts';
import { SessionRunner } from './runner.ts';
import { SessionView } from './SessionView.tsx';
import { Calibration, type CalibrationResult } from './Calibration.tsx';
import type { EyeTracker } from './eyetracking.ts';
import { Consent, DeviceCheck, Done, ErrorScreen, Landing, Loading, Shell, Unavailable, Withdrawn, type ConsentChoice, type DeviceResult } from './screens.tsx';

type Phase = 'loading' | 'landing' | 'unavailable' | 'consent' | 'device' | 'calibrate' | 'session' | 'done' | 'withdrawn' | 'error';

function deviceInfo(): DeviceInfo {
  return {
    userAgent: navigator.userAgent,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    screenW: window.screen.width,
    screenH: window.screen.height,
    dpr: window.devicePixelRatio || 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
  };
}

export default function ParticipantApp() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const preview = params.get('preview') === '1';
  const variantId = params.get('variant') ?? undefined;
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<PublicLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consentErr, setConsentErr] = useState<string | null>(null);
  const [start, setStart] = useState<StartSessionResponse | null>(null);
  const [consent, setConsent] = useState<ConsentRecord | null>(null);
  const [runner, setRunner] = useState<SessionRunner | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const device = useRef<DeviceResult | null>(null);
  const eye = useRef<EyeTracker | null>(null);
  const calibration = useRef<CalibrationResult | null>(null);
  const audioEl = useRef<HTMLAudioElement>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const i = await pApi.link(token);
      setInfo(i);
      document.title = i.title || i.studyName;
      setPhase(i.available || preview ? 'landing' : 'unavailable');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setPhase('unavailable');
      else {
        setError('We couldn’t load this study. Check your connection and try again.');
        setPhase('error');
      }
    }
  }, [token, preview]);

  useEffect(() => void load(), [load]);

  // Warn before closing the tab mid-session.
  useEffect(() => {
    if (phase !== 'session') return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [phase]);

  const accept = async (c: ConsentChoice) => {
    if (!info) return;
    setBusy(true);
    setConsentErr(null);
    audioContext(); // unlock audio on this user gesture
    const rec: ConsentRecord = {
      version: info.consent.version,
      acceptedAt: Date.now(),
      audio: c.voice,
      screen: c.screen && info.consent.recordScreen,
      eyeTracking: c.eyeTracking && info.consent.offerEyeTracking,
      ageConfirmed: c.ageConfirmed,
    };
    const urlParams: Record<string, string> = {};
    params.forEach((v, k) => {
      if (k !== 'preview' && k !== 'variant') urlParams[k] = v;
    });
    try {
      const res = await pApi.start(token, { urlParams, device: deviceInfo(), consent: rec, ...(preview ? { preview: true, variantId } : {}) });
      setStart(res);
      setConsent(rec);
      setPhase('device');
    } catch (e) {
      setConsentErr(e instanceof ApiError ? e.message : 'Could not start the session. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const launch = useCallback(
    (s: StartSessionResponse, c: ConsentRecord) => {
      const mic = device.current?.mic ?? null;
      const r = new SessionRunner({
        auth: { sessionId: s.session.id, secret: s.secret },
        start: s,
        consent: c,
        mic,
        audioEl: audioEl.current!,
        eye: eye.current,
        calibration: calibration.current,
        onFinished: (url) => {
          setRedirectUrl(url);
          setPhase('done');
        },
      });
      (window as unknown as { __taRunner?: SessionRunner }).__taRunner = r;
      setRunner(r);
      setPhase('session');
      void r.start();
    },
    [],
  );

  const afterDevice = (d: DeviceResult) => {
    device.current = d;
    audioContext();
    void audioEl.current?.play().catch(() => {});
    if (!start || !consent) return;
    if (!d.mic && !start.protocol.moderation.allowTextFallback) {
      setError('This study needs a working microphone to talk with the moderator.');
      setPhase('error');
      return;
    }
    if (consent.eyeTracking) setPhase('calibrate');
    else launch(start, consent);
  };

  const withdraw = async () => {
    if (!runner) return;
    try {
      await runner.withdraw();
    } catch {
      /* the server may be unreachable; local capture has stopped regardless */
    }
    setPhase('withdrawn');
  };

  useEffect(() => () => runner?.dispose(), [runner]);

  const body = (() => {
    switch (phase) {
      case 'loading':
        return <Loading />;
      case 'unavailable':
        return <Unavailable info={info} />;
      case 'landing':
        return <Landing info={info!} onStart={() => setPhase('consent')} />;
      case 'consent':
        return <Consent info={info!} onAccept={accept} busy={busy} error={consentErr} />;
      case 'device':
        return <DeviceCheck wantVoice={Boolean(consent?.audio)} allowTextFallback={start?.protocol.moderation.allowTextFallback ?? true} onDone={afterDevice} />;
      case 'calibrate':
        return (
          <Calibration
            onDone={(e, r) => {
              eye.current = e;
              calibration.current = r;
              e.positionPreview('hidden');
              e.stopMoveTraining();
              launch(start!, consent!);
            }}
            onSkip={() => {
              eye.current = null;
              launch(start!, { ...consent!, eyeTracking: false });
            }}
          />
        );
      case 'done':
        return <Done redirectUrl={redirectUrl} />;
      case 'withdrawn':
        return <Withdrawn />;
      case 'error':
        return <ErrorScreen message={error ?? 'Unexpected error.'} onRetry={() => void load()} />;
      default:
        return null;
    }
  })();

  return (
    <>
      <audio ref={audioEl} autoPlay playsInline className="hidden" data-testid="moderator-audio" />
      {phase === 'session' && runner && start ? (
        <SessionView runner={runner} title={start.protocol.title || info?.title || ''} preview={preview || start.session.urlParams?.preview === '1'} onWithdraw={withdraw} />
      ) : (
        <Shell preview={preview} wide={phase === 'consent'}>
          {body}
        </Shell>
      )}
    </>
  );
}

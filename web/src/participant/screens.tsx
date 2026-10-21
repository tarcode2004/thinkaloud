// Pre- and post-session screens: landing, consent, device check, done, withdrawn, error.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import { Check, Headphones, Volume2 } from 'lucide-react';
import type { PublicLinkInfo } from '@thinkaloud/shared';
import { Button, cn, Spinner } from '../ui/index.tsx';
import { LevelMeter, playChime } from './media.ts';

const ICON = { strokeWidth: 1.75 } as const;

export function Shell({ children, preview, wide }: { children: ReactNode; preview?: boolean; wide?: boolean }) {
  return (
    <div className="min-h-full bg-canvas">
      {preview && (
        <div className="flex h-7 items-center justify-center gap-2 bg-label text-[12px] font-medium text-white/90" data-testid="preview-banner">
          <span className="size-1.5 rounded-full bg-sys-orange" /> Preview — data excluded from results
        </div>
      )}
      <div className={cn('mx-auto px-5 pb-16 pt-12 sm:pt-20 [animation:ta-sheet_.45s_cubic-bezier(.32,.72,0,1)]', wide ? 'max-w-[720px]' : 'max-w-[600px]')}>{children}</div>
    </div>
  );
}

export function Landing({ info, onStart }: { info: PublicLinkInfo; onStart: () => void }) {
  return (
    <div data-testid="landing">
      <p className="text-[15px] font-medium text-secondary">{info.studyName}</p>
      <h1 className="mt-2 text-[40px] font-bold leading-[1.08] tracking-[-0.028em] text-label sm:text-[48px]">{info.title}</h1>
      <p className="mt-5 max-w-[520px] text-[19px] leading-relaxed text-secondary">
        You’ll try out a website while an AI moderator asks you a few questions by voice. There are no right or wrong answers — we’re testing the product, not you.
      </p>
      <dl className="mt-10 overflow-hidden rounded-[18px] bg-surface">
        <Row label="Time">About {info.estimatedMinutes} minutes</Row>
        <Row label="You’ll need">A microphone, ideally headphones</Row>
        <Row label="Moderator">An AI voice — you can type instead</Row>
      </dl>
      <div className="mt-10 flex items-center gap-4">
        <Button size="lg" onClick={onStart} data-testid="get-started">
          Get started
        </Button>
        <span className="text-[13px] text-tertiary">You can stop at any time.</span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-separator px-5 py-3.5 last:border-0">
      <dt className="text-[15px] text-secondary">{label}</dt>
      <dd className="text-right text-[15px] text-label">{children}</dd>
    </div>
  );
}

const REASONS: Record<string, string> = {
  closed: 'This study has closed.',
  paused: 'This study is paused at the moment. Please try again later.',
  full: 'This study has reached the number of participants it needs.',
  expired: 'This link has expired.',
  draft: 'This study hasn’t started yet.',
  inactive: 'This link is no longer active.',
};

export function Unavailable({ info }: { info: PublicLinkInfo | null }) {
  return (
    <div data-testid="unavailable">
      {info && <p className="text-[15px] font-medium text-secondary">{info.studyName}</p>}
      <h1 className="mt-2 text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">{info ? 'This study isn’t available' : 'Link not found'}</h1>
      <p className="mt-4 text-[17px] leading-relaxed text-secondary">
        {info ? REASONS[info.unavailableReason ?? 'inactive'] ?? REASONS.inactive : 'Please check that you copied the whole link.'} Thank you for your interest.
      </p>
    </div>
  );
}

export interface ConsentChoice {
  voice: boolean;
  screen: boolean;
  eyeTracking: boolean;
  ageConfirmed: boolean;
}

export function Consent({ info, onAccept, busy, error }: { info: PublicLinkInfo; onAccept: (c: ConsentChoice) => void; busy: boolean; error?: string | null }) {
  const c = info.consent;
  const [voice, setVoice] = useState(true);
  const [screen, setScreen] = useState(c.recordScreen);
  const [eye, setEye] = useState(false);
  const [age, setAge] = useState(false);
  const html = useMemo(() => marked.parse(c.text || '', { async: false }) as string, [c.text]);
  const ok = !c.ageGate || age;
  return (
    <div data-testid="consent">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Before we start</h1>
      <div className="prose-ta mt-6 rounded-[18px] bg-surface px-6 py-5 text-[15px] leading-relaxed text-label [&_h2:first-child]:hidden" dangerouslySetInnerHTML={{ __html: html }} />

      <h2 className="mb-2 ml-5 mt-10 text-[13px] text-secondary">Your choices</h2>
      <div className="overflow-hidden rounded-[18px] bg-surface">
        <SwitchRow checked={voice} onChange={setVoice} label="Talk with the moderator using my microphone" detail={`Your voice is ${c.storeAudio ? 'recorded and ' : ''}transcribed. Turn this off to type instead.`} testId="opt-voice" />
        {c.recordScreen && <SwitchRow checked={screen} onChange={setScreen} label="Record my activity on the website" detail="Clicks, scrolling and pages visited. Text you type is masked." testId="opt-screen" />}
        {c.offerEyeTracking && <SwitchRow checked={eye} onChange={setEye} label="Use my webcam to estimate where I look" detail="Optional. Processed on your device — no video is stored." testId="opt-eye" />}
        {c.ageGate && <SwitchRow checked={age} onChange={setAge} label="I am 18 years or older" testId="opt-age" />}
      </div>
      <p className="mx-5 mt-2 text-[13px] leading-relaxed text-tertiary">The moderator is an AI. Voice is processed by OpenAI to run the conversation. Consent version {c.version}.</p>

      {error && <p className="mt-6 text-[14px] text-sys-red">{error}</p>}
      <div className="mt-8 flex items-center gap-4">
        <Button size="lg" disabled={!ok} loading={busy} onClick={() => onAccept({ voice, screen, eyeTracking: eye, ageConfirmed: age })} data-testid="accept-consent">
          I agree, continue
        </Button>
        {!ok && <span className="text-[13px] text-tertiary">Please confirm your age to continue.</span>}
      </div>
    </div>
  );
}

function SwitchRow({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: string; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-4 border-b border-separator px-5 py-3.5 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-label">{label}</span>
        {detail && <span className="mt-0.5 block text-[13px] leading-snug text-secondary">{detail}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className={cn('relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 ease-apple', checked ? 'bg-sys-green' : 'bg-black/[0.09]')}
      >
        <span className={cn('absolute left-0 top-[2px] size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,.15),0_1px_1px_rgba(0,0,0,.06)] transition-transform duration-200 ease-apple', checked ? 'translate-x-[22px]' : 'translate-x-[2px]')} />
      </button>
    </label>
  );
}

// ── Device check ─────────────────────────────────────────────────────────────

export interface DeviceResult {
  mic: MediaStream | null;
}

type Check = 'pending' | 'ok' | 'fail';

export function DeviceCheck({ wantVoice, allowTextFallback, onDone }: { wantVoice: boolean; allowTextFallback: boolean; onDone: (r: DeviceResult) => void }) {
  const [micState, setMicState] = useState<Check>(wantVoice ? 'pending' : 'fail');
  const [micErr, setMicErr] = useState<string | null>(null);
  const [heard, setHeard] = useState(false);
  const [speaker, setSpeaker] = useState<'idle' | 'playing' | 'played' | 'confirmed'>('idle');
  const stream = useRef<MediaStream | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const support = useMemo(
    () => ({
      webrtc: typeof RTCPeerConnection !== 'undefined',
      media: Boolean(navigator.mediaDevices?.getUserMedia),
      recorder: typeof MediaRecorder !== 'undefined',
    }),
    [],
  );
  const browserOk = support.webrtc && support.media;

  const requestMic = async () => {
    setMicErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      stream.current = s;
      setMicState('ok');
    } catch (e) {
      setMicState('fail');
      const name = (e as Error).name;
      setMicErr(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser’s address bar, then try again.' : name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not be started.');
    }
  };

  useEffect(() => {
    if (wantVoice && browserOk) void requestMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live level meter.
  useEffect(() => {
    if (micState !== 'ok' || !stream.current) return;
    const m = new LevelMeter(stream.current);
    let raf = 0;
    let loud = 0;
    const loop = () => {
      const l = m.read();
      if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0.02, Math.min(1, l * 1.4))})`;
      if (l > 0.08) loud++;
      if (loud > 8) setHeard(true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      m.dispose();
    };
  }, [micState]);

  const testSpeaker = async () => {
    setSpeaker('playing');
    await playChime();
    setSpeaker('played');
  };

  const canVoice = micState === 'ok';
  const canContinue = browserOk && (canVoice || allowTextFallback);

  return (
    <div data-testid="device-check">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Check your audio</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">A quick check so the moderator can hear you and you can hear them.</p>

      <div className="mt-8 overflow-hidden rounded-[18px] bg-surface">
        {wantVoice && (
          <div className="border-b border-separator px-5 py-4">
            <div className="flex items-center gap-3">
              <StatusDot s={micState === 'ok' ? (heard ? 'ok' : 'pending') : micState} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] text-label">Microphone</p>
                <p className="text-[13px] text-secondary">{micState === 'ok' ? (heard ? 'We can hear you.' : 'Say a few words to test it.') : micState === 'pending' ? 'Waiting for permission…' : micErr ?? 'Not available.'}</p>
              </div>
              {micState === 'fail' && (
                <Button size="sm" variant="secondary" onClick={requestMic}>
                  Try again
                </Button>
              )}
            </div>
            {micState === 'ok' && (
              <div className="ml-7 mt-3 h-1.5 overflow-hidden rounded-full bg-fill" data-testid="mic-meter">
                <div ref={bar} className={cn('h-full origin-left rounded-full transition-colors', heard ? 'bg-sys-green' : 'bg-brand-500')} style={{ transform: 'scaleX(0.02)' }} />
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 border-b border-separator px-5 py-4">
          <StatusDot s={speaker === 'confirmed' ? 'ok' : 'pending'} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-label">Speakers</p>
            <p className="text-[13px] text-secondary">{speaker === 'played' ? 'Did you hear a short chime?' : speaker === 'confirmed' ? 'Sound works.' : 'Play a short sound.'}</p>
          </div>
          {speaker === 'played' ? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={testSpeaker}>
                Play again
              </Button>
              <Button size="sm" onClick={() => setSpeaker('confirmed')} data-testid="heard-chime">
                I heard it
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" icon={<Volume2 className="size-4" {...ICON} />} loading={speaker === 'playing'} onClick={testSpeaker} data-testid="play-chime">
              Play
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3 px-5 py-4">
          <StatusDot s={browserOk ? 'ok' : 'fail'} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-label">Browser</p>
            <p className="text-[13px] text-secondary">{browserOk ? 'Your browser is supported.' : 'Please open this link in a recent version of Chrome, Edge, Safari or Firefox.'}</p>
          </div>
        </div>
      </div>

      <p className="mx-5 mt-3 flex items-start gap-2 text-[13px] leading-snug text-tertiary">
        <Headphones className="mt-px size-4 shrink-0" {...ICON} /> Headphones work best — they stop the moderator’s voice from being picked up by your microphone. Find a quiet spot if you can.
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={!canContinue} onClick={() => onDone({ mic: canVoice ? stream.current : null })} data-testid="device-continue">
          {canVoice || !wantVoice ? 'Continue' : 'Continue by typing'}
        </Button>
        {!canContinue && wantVoice && <span className="text-[13px] text-tertiary">This study needs a working microphone.</span>}
      </div>
    </div>
  );
}

function StatusDot({ s }: { s: Check }) {
  if (s === 'ok')
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-sys-green text-white">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    );
  return <span className={cn('size-4 shrink-0 rounded-full border-[1.5px]', s === 'fail' ? 'border-sys-red bg-sys-red/10' : 'border-black/15')} />;
}

// ── Terminal screens ─────────────────────────────────────────────────────────

export function Done({ redirectUrl }: { redirectUrl: string | null }) {
  const [left, setLeft] = useState(5);
  useEffect(() => {
    if (!redirectUrl) return;
    const id = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(id);
  }, [redirectUrl]);
  useEffect(() => {
    if (redirectUrl && left <= 0) window.location.href = redirectUrl;
  }, [left, redirectUrl]);
  return (
    <div data-testid="done">
      <span className="flex size-12 items-center justify-center rounded-full bg-sys-green text-white">
        <Check className="size-6" strokeWidth={2.5} />
      </span>
      <h1 className="mt-6 text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Thank you</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">Your session is complete and your responses have been saved. Your feedback genuinely helps make the product better.</p>
      {redirectUrl ? (
        <p className="mt-8 text-[15px] text-secondary">
          Taking you back in {Math.max(0, left)}s…{' '}
          <a className="text-brand-500 hover:underline" href={redirectUrl}>
            Continue now
          </a>
        </p>
      ) : (
        <p className="mt-8 text-[15px] text-tertiary">You can close this window now.</p>
      )}
    </div>
  );
}

export function Withdrawn() {
  return (
    <div data-testid="withdrawn">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">You’ve left the study</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">Everything recorded in this session has been deleted. Thanks for your time — you can close this window.</p>
    </div>
  );
}

export function ErrorScreen({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div data-testid="error">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Something went wrong</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">{message}</p>
      {onRetry && (
        <Button size="lg" className="mt-8" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
      <Spinner className="size-6 text-tertiary" />
      {label && <p className="text-[13px] text-tertiary">{label}</p>}
    </div>
  );
}

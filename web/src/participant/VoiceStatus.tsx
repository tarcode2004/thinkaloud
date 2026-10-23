// Conversation status next to the voice orb: tells the participant at a glance whether the
// moderator heard them, is preparing a reply, is speaking, or is waiting for them — so a few
// seconds of silence after an answer never leaves them wondering whether to repeat themselves.
import { cn } from '../ui/index.tsx';
import type { VoiceStatus } from './runner.ts';

export const STATUS_LABEL: Record<VoiceStatus, string> = {
  connecting: 'Connecting…',
  muted: 'Microphone off',
  offline: 'On-screen mode',
  speaking: 'Speaking',
  listening: 'Listening…',
  heard: 'Got it — thinking…',
  thinking: 'One moment…',
  slow: 'Still thinking — no need to repeat',
  your_turn: 'Your turn — just talk',
  idle: 'Listening',
};

/** Shorter wording for the slim task dock. */
const COMPACT_LABEL: Partial<Record<VoiceStatus, string>> = {
  heard: 'Got it…',
  slow: 'Still thinking…',
  your_turn: 'Your turn',
};

const ACTIVE: VoiceStatus[] = ['heard', 'slow', 'your_turn', 'listening'];

export function StatusLabel({ status, compact, live, className }: { status: VoiceStatus; compact?: boolean; live?: boolean; className?: string }) {
  const text = (compact && COMPACT_LABEL[status]) || STATUS_LABEL[status];
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2 font-medium transition-colors duration-300', ACTIVE.includes(status) ? 'text-secondary' : 'text-tertiary', className)}
      data-testid="orb-label"
      data-status={status}
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    >
      <Indicator status={status} />
      <span className="truncate">{text}</span>
    </span>
  );
}

function Indicator({ status }: { status: VoiceStatus }) {
  if (status === 'heard' || status === 'thinking' || status === 'slow')
    return (
      <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-[4px] rounded-full bg-current [animation:ta-dot_1.2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.16}s` }} />
        ))}
      </span>
    );
  if (status === 'speaking')
    return (
      <span className="flex h-3 shrink-0 items-center gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-full w-[2px] origin-center rounded-full bg-brand-500/70 [animation:ta-bar_.9s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </span>
    );
  if (status === 'your_turn') return <span className="size-[7px] shrink-0 rounded-full bg-sys-green" aria-hidden />;
  if (status === 'listening') return <span className="size-[7px] shrink-0 rounded-full bg-sys-teal [animation:ta-pulse_1.6s_ease-in-out_infinite]" aria-hidden />;
  return null;
}

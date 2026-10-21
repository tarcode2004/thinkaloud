// rrweb DOM recording, started only when the host config says recordScreen=true.
import { record } from '@rrweb/record';
import { post, state } from './bridge.ts';

let stopFn: (() => void) | undefined;
let buf: unknown[] = [];
let timer: ReturnType<typeof setInterval> | undefined;

export function flushRrweb() {
  if (!buf.length) return;
  const events = buf;
  buf = [];
  post({ type: 'rrweb', events });
}

export function startRecording(maskAllInputs: boolean) {
  if (stopFn) return;
  try {
    stopFn =
      record({
        emit(event) {
          if (!state.paused) buf.push(event);
          if (buf.length > 2000) flushRrweb();
        },
        maskAllInputs: maskAllInputs !== false,
        maskInputOptions: { password: true, email: true, tel: true },
        blockClass: 'rr-block',
        maskTextClass: 'rr-mask',
        inlineStylesheet: true,
        recordCanvas: false,
        collectFonts: false,
        checkoutEveryNms: 2 * 60 * 1000,
        sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' },
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headMetaSocial: true, headMetaRobots: true, headMetaVerification: true },
      }) || undefined;
    timer = setInterval(flushRrweb, 2000);
  } catch {
    stopFn = undefined;
  }
}

export function resnapshot() {
  try {
    if (stopFn) record.takeFullSnapshot(true);
  } catch {
    /* ignore */
  }
}

export function stopRecording() {
  try {
    stopFn?.();
  } catch {
    /* ignore */
  }
  stopFn = undefined;
  if (timer) clearInterval(timer);
  flushRrweb();
}

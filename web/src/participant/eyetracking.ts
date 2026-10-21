// Optional webcam eye tracking (WebGazer, GPLv3 — processed on device; only gaze points leave the browser).
// Lazy-loaded so participants who don't opt in never download TensorFlow.
/* eslint-disable @typescript-eslint/no-explicit-any */

const FACE_MESH_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619';

type GazeListener = (x: number, y: number) => void;

export class EyeTracker {
  private wg: any = null;
  private listener: GazeListener | null = null;
  private lastEmit = 0;
  /** Min ms between gaze samples delivered to the listener (throttle). */
  sampleMs = 100;
  latest: { x: number; y: number; at: number } | null = null;
  running = false;
  /**
   * CPU throttle: WebGazer runs face-mesh inference on every animation frame (~60/s). With
   * `frameMs` > 0 we run one inference, pause, and resume after `frameMs` (the session uses ~10 fps).
   * 0 during calibration: WebGazer ignores calibration clicks while paused.
   */
  frameMs = 0;
  /** Frames actually processed (tests / diagnostics). */
  frames = 0;
  private suspended = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private frameStart = 0;

  async start(): Promise<void> {
    const wg = await startWebgazer();
    this.wg = wg;
    // WebGazer is a singleton with one gaze listener: the tracker that started last owns it.
    wg.setGazeListener((data: { x: number; y: number } | null) => {
      this.frames++;
      this.throttle();
      if (!data) return;
      const now = performance.now();
      this.latest = { x: data.x, y: data.y, at: now };
      if (now - this.lastEmit < this.sampleMs) return;
      this.lastEmit = now;
      this.listener?.(data.x, data.y);
    });
    this.running = true;
  }

  /** Called once per processed frame: pause WebGazer's loop and schedule the next frame. */
  private throttle() {
    const wg = this.wg;
    if (!wg || !this.running || this.frameMs <= 0) return;
    wg.pause();
    if (this.resumeTimer || this.suspended) return;
    const wait = Math.max(0, this.frameMs - (performance.now() - this.frameStart));
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.running || this.suspended) return;
      this.frameStart = performance.now();
      void wg.resume();
    }, wait);
  }

  /** Stop processing frames while gaze isn't needed (e.g. the app is hidden); resume with `false`. */
  setSuspended(suspended: boolean) {
    if (suspended === this.suspended || !this.running) return;
    this.suspended = suspended;
    if (suspended) {
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.pause();
    } else {
      this.frameStart = performance.now();
      this.resume();
    }
  }

  get isSuspended() {
    return this.suspended;
  }

  /**
   * Camera preview placement. 'center' fills `anchor` (a placeholder in the page layout); 'corner'
   * is a small preview between the calibration dot rows (never on top of a dot); 'hidden' keeps the
   * video running for the tracker but shows and draws nothing. It never intercepts clicks.
   */
  positionPreview(mode: 'center' | 'corner' | 'hidden', anchor?: DOMRect) {
    const el = document.getElementById('webgazerVideoContainer');
    if (!el) return;
    el.style.transition = 'opacity .3s ease';
    el.style.borderRadius = '16px';
    el.style.overflow = 'hidden';
    el.style.zIndex = '60';
    el.style.pointerEvents = 'none';
    el.style.boxShadow = '0 1px 2px rgba(0,0,0,.04), 0 8px 28px rgba(0,0,0,.08)';
    if (mode === 'hidden') {
      this.wg?.showVideoPreview(false);
      // No overlay drawing while nobody sees it (saves CPU); the video keeps feeding the tracker.
      this.wg?.showFaceOverlay(false);
      this.wg?.showFaceFeedbackBox(false);
      el.style.opacity = '0';
      return;
    }
    this.wg?.showVideoPreview(true);
    el.style.opacity = '1';
    el.style.position = 'fixed';
    el.style.transformOrigin = 'center center';
    const w = el.offsetWidth || 320;
    const h = el.offsetHeight || 240;
    if (mode === 'center') {
      const r = anchor ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const scale = Math.min(1, r.width / w, r.height / h);
      el.style.top = `${r.top + r.height / 2}px`;
      el.style.left = `${r.left + r.width / 2}px`;
      el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    } else {
      // Calibration dots sit at 10 % / 50 % / 90 % of the height: 30 % is free.
      const scale = Math.min(0.55, (window.innerHeight * 0.3) / h);
      el.style.top = '30%';
      el.style.left = '50%';
      el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }
  }

  /** Explicit calibration sample at a screen position (in addition to WebGazer's click listener). */
  record(x: number, y: number) {
    try {
      this.wg?.recordScreenPosition(x, y, 'click');
    } catch {
      /* ignore */
    }
  }

  /** Stop learning from mouse movement after calibration (keeps clicks), reduces drift + CPU. */
  stopMoveTraining() {
    try {
      this.wg?.removeMouseEventListeners();
    } catch {
      /* ignore */
    }
  }

  onGaze(fn: GazeListener | null) {
    this.listener = fn;
  }

  pause() {
    try {
      this.wg?.pause();
    } catch {
      /* ignore */
    }
  }
  resume() {
    try {
      void this.wg?.resume();
    } catch {
      /* ignore */
    }
  }

  stop() {
    shared = null;
    this.running = false;
    this.listener = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    try {
      this.wg?.pause();
      this.wg?.end();
    } catch {
      /* ignore */
    }
    // Make sure the webcam light turns off.
    const v = document.getElementById('webgazerVideoFeed') as HTMLVideoElement | null;
    (v?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    document.getElementById('webgazerVideoContainer')?.remove();
  }
}

/**
 * WebGazer (and the face mesh WASM inside it) is a page-wide singleton: starting it twice — e.g. a
 * remount, or React StrictMode running effects twice in development — corrupts its init
 * ("Module.arguments has been replaced…"). All trackers share one start.
 */
let shared: Promise<any> | null = null;
function startWebgazer(): Promise<any> {
  if (!shared) {
    shared = (async () => {
      // WebGazer's face mesh dependency is a classic script (see faceMeshShim.ts): load it first.
      await loadScript(`${FACE_MESH_CDN}/face_mesh.js`, () => Boolean((window as any).FaceMesh));
      const mod: any = await import('webgazer');
      const wg = mod.default ?? mod;
      wg.params.faceMeshSolutionPath = FACE_MESH_CDN;
      wg.params.camConstraints = { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } };
      wg.saveDataAcrossSessions(false);
      wg.applyKalmanFilter(true);
      wg.setRegression('ridge');
      await withTimeout(Promise.resolve(wg.begin()), 45000, 'Eye tracker did not start');
      wg.showPredictionPoints(false);
      wg.showVideoPreview(true);
      wg.showFaceOverlay(true);
      wg.showFaceFeedbackBox(true);
      // Wait until face mesh produces predictions.
      const t0 = Date.now();
      while (!wg.isReady() && Date.now() - t0 < 30000) await sleep(200);
      if (!wg.isReady()) throw new Error('Camera not ready');
      return wg;
    })();
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}

function loadScript(src: string, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.crossOrigin = 'anonymous';
      el.onload = () => (ready() ? resolve() : reject(new Error('Face mesh script loaded without FaceMesh')));
      el.onerror = () => reject(new Error('Could not load the face mesh script'));
      document.head.appendChild(el);
    }),
    30000,
    'Face mesh script timeout',
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(to);
        resolve(v);
      },
      (e) => {
        clearTimeout(to);
        reject(e);
      },
    );
  });
}

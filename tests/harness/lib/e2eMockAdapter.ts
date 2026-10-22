// Adapter onto the shared in-page mock from tests/e2e/mockRealtime.ts (MOCK_REALTIME, used by
// participant-mock.spec.ts), so harness scenarios can also run against it: `--mock e2e`.
// Same offline guarantees: the token route and the SDP exchange are served locally and every other
// request to api.openai.com is aborted. Differences from the harness's own mock (lib/mockRealtime.ts):
// no semantic-VAD hold emulation (each chunk is its own turn), no barge-in, and its scripted model
// follows briefs only (no instruction-dependent deflection), so it exercises the runner's state
// machine, not the moderator's conversational judgement.
import type { BrowserContext, Page } from '@playwright/test';
import { MOCK_REALTIME } from '../../e2e/mockRealtime.ts';
import type { MockStats } from './mockRealtime.ts';

/** Out-of-band classification rules for the e2e mock (regex → label), tried in order. */
const RULES: [string, string][] = [
  ['\\?\\s*$', 'ADDRESSED'],
  ["\\b(skip|give up|überspringen)\\b", 'SKIP'],
  ["\\b(i'?m done|i am done|found it|i was able to find it|that'?s it|finished|fertig)\\b", 'DONE'],
  ["\\b(i (don'?t|can'?t) (see|find)|nothing here|whatever|stupid)\\b", 'STUCK'],
];

export class E2eMockAdapter {
  readonly stats: MockStats = { responses: 0, oob: 0, toolCalls: 0, interruptions: 0, blockedRequests: [] };
  readonly moderator = { decisions: [] as { t: number; why: string; out: string }[] };
  moderatorAudio = false;
  private page!: Page;
  private timer: ReturnType<typeof setInterval> | null = null;
  private configured = false;
  constructor(readonly language: string) {}

  async attach(context: BrowserContext, page: Page) {
    this.page = page;
    await context.addInitScript(MOCK_REALTIME);
    await page.route('**/api/p/sessions/*/realtime-token', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: 'ek_harness_mock', expiresAt: Date.now() + 600_000, model: 'mock-realtime', voice: 'marin', transcription: { model: 'mock-asr', language: this.language } }) }),
    );
    await page.route('https://api.openai.com/**', (r) => {
      const u = r.request().url();
      if (u.startsWith('https://api.openai.com/v1/realtime/calls')) return r.fulfill({ status: 201, contentType: 'application/sdp', body: 'v=0\r\n' });
      this.stats.blockedRequests.push(u);
      return r.abort('blockedbyclient');
    });
    this.timer = setInterval(() => {
      if (page.isClosed()) return void (this.timer && clearInterval(this.timer));
      void page
        .evaluate(() => Boolean((window as unknown as { __mockRt?: { state: { playing: unknown } } }).__mockRt?.state.playing))
        .then((p) => (this.moderatorAudio = p))
        .catch(() => {});
    }, 200);
  }

  private async configure() {
    if (this.configured) return;
    this.configured = await this.page
      .evaluate((rules) => {
        const m = (window as unknown as { __mockRt?: { config: { rules: [string, string][] } } }).__mockRt;
        if (!m) return false;
        m.config.rules = rules;
        return true;
      }, RULES)
      .catch(() => false);
  }

  /** The e2e mock takes a whole utterance (speech_started → ms → speech_stopped → transcript): sent at the chunk start. */
  userSpeechStart() {}
  userSpeechEnd() {}
  userSpeechChunk(text: string, durMs: number) {
    void this.configure().then(() =>
      this.page.evaluate(([t, ms]) => (window as unknown as { __mockRt?: { userSays: (t: string, ms?: number) => Promise<void> } }).__mockRt?.userSays(t as string, ms as number), [text, durMs] as const).catch(() => {}),
    );
  }
}

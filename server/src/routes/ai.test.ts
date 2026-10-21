import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { DEFAULT_INTRO, starterProtocol, type Protocol } from '@thinkaloud/shared';

// Mock OpenAI Responses endpoint; the SDK honours OPENAI_BASE_URL.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ai-test-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = 'sk-test';

let queue: string[] = [];
const requests: Record<string, unknown>[] = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const text = queue.shift() ?? '{}';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'gpt-5-mini',
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      }),
    );
  });
});

let base = '';
let server: http.Server;
let lintProtocol: typeof import('./ai.ts').lintProtocol;
let ProtocolSchema: typeof import('../lib/protocolSchema.ts').ProtocolSchema;

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
  const ai = await import('./ai.ts');
  const { errorMiddleware } = await import('../lib/http.ts');
  ({ ProtocolSchema } = await import('../lib/protocolSchema.ts'));
  lintProtocol = ai.lintProtocol;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => ((req.user = { id: 'u', email: 'u@x', name: 'U', createdAt: 0 }), next()));
  app.use('/api/ai', ai.aiRouter);
  app.use(errorMiddleware);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai`;
});
after(() => {
  server?.close();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

const modelDraft = {
  title: 'Checkout study',
  researchGoals: ['Find checkout friction'],
  productContext: 'An online shop',
  intro: 'Hello and welcome!', // missing AI disclosure → must be replaced
  closing: 'Thanks!',
  randomizeTasks: false,
  estimatedMinutes: '25',
  steps: [
    { id: 'warmup', type: 'question', title: 'Warm-up', question: { id: 'warmup_q', prompt: 'How do you usually shop online?', kind: 'open', required: false } },
    { id: 'first_impression', type: 'instruction', title: 'First impressions', script: 'Look around…', showApp: true, exploreSeconds: 45 },
    {
      id: 'task_buy', type: 'task', title: 'Buy', instruction: 'Imagine you need a gift for a friend…', successCriteria: 'Order confirmation shown',
      successRules: [{ type: 'url_matches', pattern: '^/checkout/success' }], probes: ['What did you expect?'], askSEQ: null, timeLimitSec: null,
    },
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Overall', questions: ['How would you describe the experience?'] },
  ],
};

test('generate-protocol: structured output request + methodology post-processing', async () => {
  queue = ['not json', JSON.stringify(modelDraft)]; // first attempt invalid → retried
  requests.length = 0;
  const { status, json } = await post('/generate-protocol', { goal: 'Evaluate checkout', productName: 'Acme', includeSUS: true, style: 'think_aloud_concurrent', durationMinutes: 30 });
  assert.equal(status, 200, JSON.stringify(json));
  const p = json.protocol as Protocol;
  assert.equal(ProtocolSchema.safeParse(p).success, true);
  assert.equal(requests.length, 2, 'retried once after invalid output');
  const fmt = (requests[0].text as any).format;
  assert.equal(fmt.type, 'json_schema');
  assert.equal(fmt.schema.type, 'object');
  assert.match(String(requests[0].instructions), /NEVER reveal the solution path/);
  assert.equal(p.intro, DEFAULT_INTRO);
  assert.equal(p.estimatedMinutes, 30);
  assert.deepEqual(p.steps.map((s) => s.id), ['warmup', 'first_impression', 'task_buy', 'sus', 'wrapup']);
  const task = p.steps[2];
  assert.ok(task.type === 'task' && task.askSEQ === true && task.timeLimitSec === 300 && task.startPath === '/');
  assert.equal(p.moderation.voice, 'marin');
});

test('refine-protocol merges partial output and keeps consent', async () => {
  const original = starterProtocol('Acme');
  const refined = { ...original, title: 'Refined', moderation: { language: 'de' } } as Record<string, unknown>;
  delete refined.consent;
  queue = [JSON.stringify({ protocol: refined, changes: ['Renamed', 'German'] })];
  const { status, json } = await post('/refine-protocol', { protocol: original, instruction: 'Rename and switch to German' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.protocol.title, 'Refined');
  assert.equal(json.protocol.moderation.language, 'de');
  assert.equal(json.protocol.moderation.voice, original.moderation.voice);
  assert.deepEqual(json.protocol.consent, original.consent);
  assert.deepEqual(json.changes, ['Renamed', 'German']);
});

test('review-protocol merges lint + AI issues and drops unknown step ids', async () => {
  queue = [JSON.stringify({ issues: [{ stepId: 'task_1', severity: 'High', message: 'Scenario lacks motivation', suggestion: 'Add why' }, { stepId: 'ghost', severity: 'low', message: 'x', suggestion: 'y' }] })];
  const { status, json } = await post('/review-protocol', { protocol: starterProtocol('Acme') });
  assert.equal(status, 200);
  const ai = json.issues.find((i: any) => i.message === 'Scenario lacks motivation');
  assert.equal(ai.severity, 'high');
  assert.equal(ai.stepId, 'task_1');
  assert.equal(json.issues.find((i: any) => i.message === 'x').stepId, undefined);
  assert.ok(json.issues.some((i: any) => /placeholder/.test(i.message)), 'lint flags the starter "…" placeholders');
});

test('lint flags leading questions, UI-revealing tasks and missing disclosure', () => {
  const p = starterProtocol('Acme');
  p.intro = 'Hi there.';
  p.steps = [
    { id: 't', type: 'task', title: 'T', instruction: 'Click the "Add to cart" button.', successCriteria: 'ok', successRules: [{ type: 'text_visible', text: 'Add to cart' }], askSEQ: true, timeLimitSec: 60 },
    { id: 'i', type: 'interview', title: 'I', goal: 'g', questions: ['Was it easy to find?'] },
  ];
  const msgs = lintProtocol(p).map((i) => `${i.severity}:${i.stepId ?? '-'}:${i.message}`);
  assert.ok(msgs.some((m) => m.startsWith('high:-:') && /AI/.test(m)));
  assert.ok(msgs.some((m) => m.startsWith('high:t:') && /UI elements/.test(m)));
  assert.ok(msgs.some((m) => m.startsWith('high:t:') && /the very label/.test(m)));
  assert.ok(msgs.some((m) => m.startsWith('medium:i:') && /leading/.test(m)));
  // A well-formed starter protocol (minus placeholders) is clean of high-severity issues.
  const good = starterProtocol('Acme');
  for (const s of good.steps) if (s.type === 'task') (s.instruction = 'Imagine a friend has a birthday soon. Find a gift under 30 dollars.'), (s.successCriteria = 'A gift under $30 is in the basket');
  assert.equal(lintProtocol(good).filter((i) => i.severity === 'high').length, 0);
});

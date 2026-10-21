import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchQuote, quoteMatchScore, verifyInsights, type SessionCorpus } from './verify.ts';

const corpus: SessionCorpus[] = [
  {
    sessionId: 's_1',
    participantCode: 'P-AAAA',
    variantId: 'v_a',
    lines: [
      { t: 5_000, speaker: 'moderator', text: 'Please go ahead and find the shipping options.' },
      { t: 12_000, speaker: 'participant', text: "Okay, I'm looking for where shipping is... I don't see it anywhere." },
      { t: 90_000, speaker: 'participant', text: 'The promo code field is really hard to find, honestly.' },
    ],
    events: [{ t: 40_000, kind: 'app.rage_click' }],
  },
];
const known = { stepIds: new Set(['task_1']), variantIds: new Set(['v_a']) };

test('quote match score tolerates punctuation, case and ellipses', () => {
  assert.equal(quoteMatchScore("I don't see it ANYWHERE!", "Okay, I'm looking for where shipping is... I don't see it anywhere."), 1);
  assert.ok(quoteMatchScore('I love the checkout', "I don't see it anywhere") < 0.5);
  assert.equal(quoteMatchScore('looking for where shipping … see it anywhere', "Okay, I'm looking for where shipping is... I don't see it anywhere."), 1);
});

test('matchQuote prefers utterances near the cited time and reports relocations', () => {
  const m = matchQuote('promo code field is really hard to find', 95_000, corpus[0].lines)!;
  assert.equal(m.line.t, 90_000);
  assert.equal(m.near, true);
  const far = matchQuote('promo code field is really hard to find', 400_000, corpus[0].lines)!;
  assert.equal(far.near, false);
  assert.equal(matchQuote('completely fabricated sentence about pricing', 12_000, corpus[0].lines), null);
  assert.equal(matchQuote('okay', 12_000, corpus[0].lines), null); // single word: not verifiable
});

test('verifyInsights drops fabricated quotes, insights without evidence, unknown sessions; validates ids', () => {
  const { insights, verification } = verifyInsights(
    [
      {
        title: 'Shipping hard to find',
        body: 'x',
        severity: 'major',
        tags: ['Navigation'],
        stepId: 'task_1',
        variantId: 'v_nope',
        evidence: [
          { session: 'P-AAAA', tSec: 13, quote: "I don't see it anywhere", eventKind: null }, // ok (by code)
          { session: 's_1', tSec: 13, quote: 'shipping is impossible and the site is broken', eventKind: null }, // fabricated
          { session: 's_unknown', tSec: 1, quote: "I don't see it anywhere", eventKind: null }, // unknown session
          { session: 's_1', tSec: 41, quote: null, eventKind: 'app.rage_click' }, // behaviour evidence ok
        ],
      },
      {
        title: 'Hallucinated',
        body: 'y',
        severity: 'critical',
        tags: [],
        stepId: null,
        variantId: null,
        evidence: [{ session: 's_1', tSec: 12, quote: 'I would pay double for this', eventKind: null }],
      },
      {
        title: 'Promo code',
        body: 'z',
        severity: 'minor',
        tags: [],
        stepId: 'bogus',
        variantId: 'v_a',
        evidence: [{ session: 's_1', tSec: 300, quote: 'promo code field is really hard to find', eventKind: null }], // wrong time
      },
    ],
    corpus,
    known,
  );
  assert.equal(insights.length, 2);
  const a = insights.find((i) => i.title === 'Shipping hard to find')!;
  assert.equal(a.evidence.length, 2);
  assert.equal(a.droppedEvidence, 2);
  assert.equal(a.evidence[0].sessionId, 's_1');
  assert.equal(a.evidence[0].t, 12_000);
  assert.equal(a.variantId, null); // unknown variant id removed
  assert.equal(a.stepId, 'task_1');
  assert.deepEqual(a.tags, ['navigation']);
  const p = insights.find((i) => i.title === 'Promo code')!;
  assert.equal(p.evidence[0].timeCorrected, true);
  assert.equal(p.evidence[0].t, 90_000);
  assert.equal(p.stepId, null);
  assert.equal(verification.insightsProposed, 3);
  assert.equal(verification.insightsKept, 2);
  assert.equal(verification.evidenceDropped, 3);
  assert.equal(verification.timestampsCorrected, 1);
});

test('moderator speech is never accepted as evidence', () => {
  const { insights } = verifyInsights(
    [{ title: 'm', body: '', severity: 'info', tags: [], stepId: null, variantId: null, evidence: [{ session: 's_1', tSec: 5, quote: 'go ahead and find the shipping options', eventKind: null }] }],
    corpus,
    known,
  );
  assert.equal(insights.length, 0);
});

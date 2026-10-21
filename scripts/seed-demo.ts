// Demo data: researcher account + "Fern & Co checkout study" (A/B) with ~24 realistic sessions.
// Run: npx tsx --env-file=.env scripts/seed-demo.ts   (respects DATA_DIR)
// Idempotent: re-running replaces the demo study.
import fs from 'node:fs';
import path from 'node:path';
import type { ClickData, Protocol, Step, TaskOutcome } from '@thinkaloud/shared';
import { DEFAULT_CONSENT, DEFAULT_MODERATION, DEFAULT_CLOSING, DEFAULT_INTRO, INSTRUMENTS, newId } from '@thinkaloud/shared';
import { db, json, tx } from '../server/src/db.ts';
import { hashPassword } from '../server/src/lib/auth.ts';
import { paths } from '../server/src/lib/paths.ts';
import { corpusForStudy, saveSynthesis, verifyInsights, type ProposedInsight } from '../server/src/analytics/synthesis.ts';

const EMAIL = 'demo@thinkaloud.dev';
const PASSWORD = 'demo12345';
const STUDY_NAME = 'Fern & Co checkout study';

// ── Deterministic RNG ───────────────────────────────────────────────────────
let seed = 20261021;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const logNormal = (median: number, sigma: number) => median * Math.exp(sigma * gauss());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const code = () => 'P-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rnd() * 32)]).join('');

// ── Fake storefront pages (1280×800 layout) ─────────────────────────────────
interface El {
  sel: string;
  tag: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  interactive: boolean;
  kind?: 'button' | 'link' | 'input' | 'card' | 'text' | 'image' | 'heading' | 'muted';
}
const VW = 1280;
const VH = 800;
const el = (sel: string, tag: string, text: string, x: number, y: number, w: number, h: number, interactive: boolean, kind?: El['kind']): El => ({
  sel, tag, text, x, y, w, h, interactive, kind,
});
const NAV: El[] = [
  el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
  el('nav > a:nth-child(1)', 'a', 'Plants', 520, 22, 60, 24, true, 'link'),
  el('nav > a:nth-child(2)', 'a', 'Pots', 600, 22, 50, 24, true, 'link'),
  el('nav > a:nth-child(3)', 'a', 'Care guides', 670, 22, 100, 24, true, 'link'),
  el('a.cart-link', 'a', 'Cart', 1180, 22, 60, 24, true, 'link'),
];
const PAGES: Record<string, { title: string; els: El[] }> = {
  '/': {
    title: 'Fern & Co — Plants delivered',
    els: [
      ...NAV,
      el('h1.hero-title', 'h1', 'Bring the outdoors in', 80, 200, 560, 60, false, 'heading'),
      el('p.hero-sub', 'p', 'Healthy, happy plants delivered to your door.', 80, 280, 520, 28, false, 'muted'),
      el('a.btn-shop', 'a', 'Shop plants', 80, 340, 160, 48, true, 'button'),
      el('div.hero-image', 'div', '', 700, 120, 520, 400, false, 'image'),
      el('a.tile-petsafe', 'a', 'Pet-safe plants', 80, 580, 340, 160, true, 'card'),
      el('a.tile-lowlight', 'a', 'Low light', 470, 580, 340, 160, true, 'card'),
      el('a.tile-new', 'a', 'New arrivals', 860, 580, 340, 160, true, 'card'),
    ],
  },
  '/plants': {
    title: 'All plants — Fern & Co',
    els: [
      ...NAV,
      el('h1', 'h1', 'All plants', 40, 90, 300, 44, false, 'heading'),
      el('label.filter-pet', 'label', 'Pet-safe', 40, 200, 180, 30, true, 'input'),
      el('label.filter-price', 'label', 'Under $40', 40, 250, 180, 30, true, 'input'),
      el('label.filter-light', 'label', 'Low light', 40, 300, 180, 30, true, 'input'),
      el('a.card-calathea', 'a', 'Calathea Orbifolia $34', 280, 170, 280, 320, true, 'card'),
      el('a.card-monstera', 'a', 'Monstera Deliciosa $58', 600, 170, 280, 320, true, 'card'),
      el('a.card-snake', 'a', 'Snake Plant $29', 920, 170, 280, 320, true, 'card'),
      el('a.card-palm', 'a', 'Parlor Palm $32', 280, 520, 280, 240, true, 'card'),
      el('a.card-pothos', 'a', 'Golden Pothos $24', 600, 520, 280, 240, true, 'card'),
      el('a.card-fig', 'a', 'Fiddle Leaf Fig $65', 920, 520, 280, 240, true, 'card'),
    ],
  },
  '/plants/calathea-orbifolia': {
    title: 'Calathea Orbifolia — Fern & Co',
    els: [
      ...NAV,
      el('div.gallery', 'div', '', 60, 100, 560, 620, false, 'image'),
      el('h1', 'h1', 'Calathea Orbifolia', 700, 120, 480, 44, false, 'heading'),
      el('p.price', 'p', '$34', 700, 180, 120, 36, false, 'heading'),
      el('span.badge-pet', 'span', 'Pet-safe', 700, 240, 110, 28, false, 'muted'),
      el('p.desc', 'p', 'Broad, silver-striped leaves. Loves indirect light and humidity.', 700, 290, 480, 60, false, 'muted'),
      el('select.size', 'select', 'Size: Medium (6")', 700, 390, 300, 44, true, 'input'),
      el('button.add-to-cart', 'button', 'Add to cart', 700, 470, 300, 52, true, 'button'),
    ],
  },
  '/plants/monstera-deliciosa': {
    title: 'Monstera Deliciosa — Fern & Co',
    els: [
      ...NAV,
      el('div.gallery', 'div', '', 60, 100, 560, 620, false, 'image'),
      el('h1', 'h1', 'Monstera Deliciosa', 700, 120, 480, 44, false, 'heading'),
      el('p.price', 'p', '$58', 700, 180, 120, 36, false, 'heading'),
      el('p.desc', 'p', 'Iconic split leaves. Toxic to pets if ingested.', 700, 290, 480, 60, false, 'muted'),
      el('button.add-to-cart', 'button', 'Add to cart', 700, 470, 300, 52, true, 'button'),
    ],
  },
  '/cart': {
    title: 'Your cart — Fern & Co',
    els: [
      ...NAV,
      el('h1', 'h1', 'Your cart', 40, 90, 300, 44, false, 'heading'),
      el('div.line-item', 'div', 'Calathea Orbifolia — Medium   $34.00', 40, 180, 760, 100, false, 'text'),
      el('button.qty', 'button', 'Qty 1', 620, 210, 80, 36, true, 'input'),
      el('button.remove', 'button', 'Remove', 720, 210, 80, 36, true, 'link'),
      el('div.summary', 'div', 'Subtotal $34.00', 880, 180, 360, 160, false, 'text'),
      el('button.checkout', 'button', 'Checkout', 880, 370, 360, 52, true, 'button'),
    ],
  },
  '/checkout/shipping': {
    title: 'Shipping — Checkout',
    els: [
      el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
      el('ol.steps', 'ol', '1 Shipping  ·  2 Payment  ·  3 Review', 400, 22, 480, 24, false, 'muted'),
      el('h1', 'h1', 'Shipping address', 40, 90, 400, 40, false, 'heading'),
      el('input#name', 'input', 'Full name', 40, 160, 520, 44, true, 'input'),
      el('input#address', 'input', 'Street address', 40, 220, 520, 44, true, 'input'),
      el('input#zip', 'input', 'ZIP code', 40, 280, 250, 44, true, 'input'),
      el('input#city', 'input', 'City', 310, 280, 250, 44, true, 'input'),
      el('p.ship-note', 'p', 'Delivery options are shown at the next step.', 40, 350, 520, 24, false, 'muted'),
      el('div.summary', 'div', 'Order summary  ·  Calathea Orbifolia $34.00', 880, 90, 360, 220, false, 'text'),
      el('button.continue', 'button', 'Continue to payment', 880, 680, 360, 52, true, 'button'),
    ],
  },
  '/checkout/payment': {
    title: 'Payment — Checkout',
    els: [
      el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
      el('ol.steps', 'ol', '1 Shipping  ·  2 Payment  ·  3 Review', 400, 22, 480, 24, false, 'muted'),
      el('h1', 'h1', 'Payment', 40, 90, 400, 40, false, 'heading'),
      el('label.ship-standard', 'label', 'Standard shipping (free, 5–7 days)', 40, 160, 520, 44, true, 'input'),
      el('label.ship-express', 'label', 'Express shipping ($12, 1–2 days)', 40, 214, 520, 44, true, 'input'),
      el('input#card', 'input', 'Card number', 40, 300, 520, 44, true, 'input'),
      el('input#exp', 'input', 'MM / YY', 40, 360, 250, 44, true, 'input'),
      el('input#cvc', 'input', 'CVC', 310, 360, 250, 44, true, 'input'),
      el('div.summary', 'div', 'Order summary  ·  Calathea Orbifolia $34.00', 880, 90, 360, 220, false, 'text'),
      el('button.back', 'button', 'Back', 40, 680, 140, 52, true, 'link'),
      el('button.continue', 'button', 'Review order', 880, 680, 360, 52, true, 'button'),
    ],
  },
  '/checkout/review': {
    title: 'Review — Checkout',
    els: [
      el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
      el('ol.steps', 'ol', '1 Shipping  ·  2 Payment  ·  3 Review', 400, 22, 480, 24, false, 'muted'),
      el('h1', 'h1', 'Review your order', 40, 90, 400, 40, false, 'heading'),
      el('div.review-items', 'div', 'Calathea Orbifolia — Medium   $34.00', 40, 160, 760, 220, false, 'text'),
      el('div.summary', 'div', 'Order summary   Subtotal $34.00   Shipping Free   Total $34.00', 880, 90, 360, 260, false, 'text'),
      el('a.have-code', 'a', 'Have a code?', 1110, 365, 120, 20, true, 'link'),
      el('input#promo', 'input', 'Promo code', 880, 400, 250, 40, true, 'input'),
      el('button.apply', 'button', 'Apply', 1140, 400, 100, 40, true, 'button'),
      el('button.place-order', 'button', 'Place order', 880, 680, 360, 52, true, 'button'),
    ],
  },
  '/checkout': {
    title: 'Checkout — Fern & Co',
    els: [
      el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
      el('h1', 'h1', 'Checkout', 40, 80, 400, 40, false, 'heading'),
      el('input#name', 'input', 'Full name', 40, 140, 520, 40, true, 'input'),
      el('input#address', 'input', 'Street address', 40, 190, 520, 40, true, 'input'),
      el('input#zip', 'input', 'ZIP code', 40, 240, 250, 40, true, 'input'),
      el('input#city', 'input', 'City', 310, 240, 250, 40, true, 'input'),
      el('label.ship-standard', 'label', 'Standard shipping (free, 5–7 days)', 40, 310, 520, 40, true, 'input'),
      el('label.ship-express', 'label', 'Express shipping ($12, 1–2 days)', 40, 356, 520, 40, true, 'input'),
      el('input#card', 'input', 'Card number', 40, 440, 520, 40, true, 'input'),
      el('input#exp', 'input', 'MM / YY', 40, 490, 250, 40, true, 'input'),
      el('input#cvc', 'input', 'CVC', 310, 490, 250, 40, true, 'input'),
      el('div.summary', 'div', 'Order summary   Subtotal $34.00   Shipping Free   Total $34.00', 880, 80, 360, 220, false, 'text'),
      el('input#promo', 'input', 'Promo code', 880, 320, 250, 40, true, 'input'),
      el('button.apply', 'button', 'Apply', 1140, 320, 100, 40, true, 'button'),
      el('button.place-order', 'button', 'Place order', 880, 680, 360, 52, true, 'button'),
    ],
  },
  '/order/confirmed': {
    title: 'Order confirmed — Fern & Co',
    els: [
      el('a.logo', 'a', 'Fern & Co', 40, 20, 140, 28, true, 'heading'),
      el('h1', 'h1', 'Thank you! Your order is confirmed.', 340, 300, 600, 50, false, 'heading'),
      el('p', 'p', 'Order #FC-20418 · A confirmation email is on its way.', 400, 370, 480, 24, false, 'muted'),
    ],
  },
};
const findEl = (p: string, sel: string) => {
  const e = PAGES[p].els.find((x) => x.sel === sel);
  if (!e) throw new Error(`no element ${sel} on ${p}`);
  return e;
};

// ── rrweb serialization (synthetic DOM per page) ───────────────────────────
let nodeId = 1;
type RNode = Record<string, unknown>;
const textNode = (t: string): RNode => ({ type: 3, textContent: t, id: nodeId++ });
const elemNode = (tagName: string, attributes: Record<string, string>, childNodes: RNode[] = []): RNode => ({ type: 2, tagName, attributes, childNodes, id: nodeId++ });
const STYLE: Record<NonNullable<El['kind']>, string> = {
  button: 'background:#2f5d3a;color:#fff;border-radius:999px;font:600 15px system-ui;display:flex;align-items:center;justify-content:center;',
  link: 'color:#2f5d3a;font:500 14px system-ui;display:flex;align-items:center;',
  input: 'background:#fff;border:1px solid #cfd6cf;border-radius:10px;color:#7a847b;font:14px system-ui;display:flex;align-items:center;padding-left:12px;box-sizing:border-box;',
  card: 'background:#eef2ec;border-radius:16px;font:600 15px system-ui;color:#1f2a20;display:flex;align-items:flex-end;padding:16px;box-sizing:border-box;',
  text: 'background:#fafbf9;border:1px solid #e3e8e2;border-radius:12px;font:14px system-ui;color:#1f2a20;padding:16px;box-sizing:border-box;',
  image: 'background:linear-gradient(160deg,#cfe3cf,#9fc4a3);border-radius:20px;',
  heading: 'font:700 30px Georgia,serif;color:#1f2a20;',
  muted: 'font:14px system-ui;color:#647064;',
};
function pageSnapshot(p: string, idMap: Map<string, number>) {
  nodeId = 1;
  const page = PAGES[p];
  const doc: RNode = { type: 0, childNodes: [] as RNode[], id: nodeId++ };
  const doctype: RNode = { type: 1, name: 'html', publicId: '', systemId: '', id: nodeId++ };
  const head = elemNode('head', {}, [elemNode('title', {}, [textNode(page.title)])]);
  const kids: RNode[] = page.els.map((e) => {
    const style = `position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;${STYLE[e.kind ?? 'text']}${e.sel === 'a.logo' ? 'font:700 22px Georgia,serif;' : ''}`;
    const n = elemNode(e.tag === 'select' ? 'div' : e.tag === 'input' ? 'div' : e.tag, { class: e.sel.replace(/[^a-z0-9-]+/gi, ' ').trim(), style }, e.text ? [textNode(e.text)] : []);
    idMap.set(e.sel, n.id as number);
    return n;
  });
  const body = elemNode('body', { style: `margin:0;position:relative;width:${VW}px;height:${VH}px;background:#fbfcfa;overflow:hidden;font-family:system-ui;` }, kids);
  const html = elemNode('html', { lang: 'en' }, [head, body]);
  (doc.childNodes as RNode[]).push(doctype, html);
  return { node: doc, bodyId: body.id as number };
}

// ── Utterance library ───────────────────────────────────────────────────────
const SAY = {
  firstImpression: [
    "Okay, so it's a plant shop. Looks pretty clean, I like the photos.",
    "It's an online plant store, I think. The big 'Shop plants' button is the obvious thing.",
    "Looks like you can buy houseplants here. There's a section for pet-safe plants, which is nice because I have a cat.",
    "Fern and Co. Plants, pots, care guides. Pretty standard shop, feels calm.",
  ],
  findGood: [
    "I'm going to look for a pet-safe filter... there it is, pet-safe.",
    "Calathea, thirty-four dollars, and it says pet-safe. Perfect, that's the one.",
    "Under forty dollars... okay the price filter helps.",
    "I'll just add it to the cart. Easy enough.",
  ],
  findBad: [
    "I'm not sure which of these are safe for cats, nothing says it on the cards.",
    "The Monstera looks nice but it's fifty-eight, that's over budget.",
    "I'd expect to see a little paw icon or something on the product cards.",
    "Hmm, I'm going back and forth between pages here.",
  ],
  checkoutAGood: [
    "Okay, shipping address first. Name, street, zip.",
    "Payment page, and here's the shipping speed. A bit late to ask that, but fine.",
    "Review order, place order. Done, that worked.",
  ],
  checkoutABad: [
    "Wait, where do I pick the shipping speed? I guess it's on the next page?",
    "Why is the review button not doing anything? I filled everything in.",
    "It says something went wrong. Did my payment go through or not?",
    "I'm clicking back to shipping because I thought I missed something.",
    "Honestly at this point I would probably give up and buy it somewhere else.",
    "Three pages just to buy one plant feels like a lot.",
  ],
  checkoutBGood: [
    "Oh nice, everything's on one page. Address, shipping, card.",
    "I like that I can see the total the whole time.",
    "Standard shipping is free, I'll take that.",
    "Place order. That was quick.",
  ],
  checkoutBBad: [
    "It's a long form, I'm scrolling to check I didn't miss anything.",
    "I wasn't sure if express was selected by default, so I double checked.",
  ],
  promoAGood: [
    "I'd expect the promo code to be in the cart... no. Okay, maybe on the review page.",
    "Oh, 'Have a code?' — that's tiny, I almost missed it.",
    "Applied, ten percent off. Okay.",
  ],
  promoABad: [
    "I'd expect the promo code to be in the cart, but there's nothing here.",
    "Is it under the order summary? I'm clicking on it but nothing happens.",
    "I really can't find where to put the code. I'd probably email support.",
    "Oh, 'Have a code?' — that's tiny, I completely missed it.",
  ],
  promoBGood: [
    "The promo box is right there under the summary, easy.",
    "Typed FERN10, applied. Total went down, good.",
  ],
  promoBBad: ["I typed it but I'm not sure it applied, the total changed only a little."],
  wrapA: [
    'The checkout felt long. Too many steps for one plant.',
    'Mostly fine, but the promo code was really hidden.',
    'I liked the plants, the checkout was the frustrating part.',
  ],
  wrapB: [
    'Really smooth. Checkout on one page is how it should be.',
    'Quick and simple, I would use it again.',
    'Easy. Only thing is the product cards could show pet-safe more clearly.',
  ],
};
const NUDGES = ['What are you thinking right now?', 'What are you looking for?', 'Keep talking — what is on your mind?'];

// ── Protocols ───────────────────────────────────────────────────────────────
function makeProtocol(variant: 'A' | 'B'): Protocol {
  const steps: Step[] = [
    {
      id: 'warmup', type: 'question', title: 'Warm-up',
      question: { id: 'warmup_q', prompt: 'How do you usually buy houseplants today?', kind: 'open', required: false, allowFollowUp: true },
    },
    { id: 'first_impression', type: 'instruction', title: 'First impressions', script: 'Take a moment to look at the home page and tell me what you think this site is for.', showApp: true, exploreSeconds: 30 },
    {
      id: 'task_find', type: 'task', title: 'Find a pet-safe plant',
      instruction: 'You have a cat and want a plant for your living room that is safe for pets and costs less than $40. Find one you like and add it to your cart.',
      startPath: '/', successCriteria: 'A pet-safe plant under $40 (e.g. Calathea Orbifolia or Parlor Palm) is in the cart.',
      successRules: [{ type: 'click_matches', selector: 'button.add-to-cart' }], optimalPathLength: 3, timeLimitSec: 300, askSEQ: true,
      probes: ['How did you decide which plant was pet-safe?'],
    },
    {
      id: 'task_checkout', type: 'task', title: 'Check out',
      instruction: 'Now buy the plant in your cart with free standard shipping. Use the test card details on the card in front of you.',
      startPath: '/cart', successCriteria: 'Order confirmation page reached with standard shipping.',
      successRules: [{ type: 'url_matches', pattern: '^/order/confirmed' }], optimalPathLength: variant === 'A' ? 5 : 3, timeLimitSec: 300, askSEQ: true,
      probes: ['What did you expect to happen when you clicked continue?'],
    },
    {
      id: 'task_promo', type: 'task', title: 'Apply a promo code',
      instruction: 'A friend gave you the code FERN10. Use it on your next order before paying.',
      startPath: variant === 'A' ? '/checkout/review' : '/checkout', successCriteria: 'Promo code FERN10 applied (10% discount shown).',
      successRules: [{ type: 'click_matches', selector: 'button.apply' }], optimalPathLength: 1, timeLimitSec: 180, askSEQ: true,
    },
    { id: 'sus', type: 'questionnaire', title: 'System Usability Scale', instrument: 'SUS', productName: 'the Fern & Co website', onScreen: true },
    { id: 'nps', type: 'questionnaire', title: 'Likelihood to recommend', instrument: 'NPS', productName: 'Fern & Co', onScreen: true },
    {
      id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Overall impressions and biggest frustration.',
      questions: ['Overall, how would you describe buying a plant on this site?', 'What, if anything, was the most frustrating part?'], maxFollowUps: 1,
    },
  ];
  return {
    schemaVersion: 1,
    title: variant === 'A' ? 'Checkout study — current 3-step checkout' : 'Checkout study — one-page checkout',
    researchGoals: [
      'Compare task success and time on task between the current 3-step checkout (A) and a one-page checkout (B)',
      'Find where participants struggle to find pet-safe products and promo codes',
      'Benchmark perceived usability (SUS) of both designs',
    ],
    productContext: 'Fern & Co is an online houseplant shop. Variant A has a 3-step checkout (shipping → payment → review) with the promo code hidden behind a "Have a code?" link on the review step. Variant B puts everything on one page with a visible promo field.',
    intro: DEFAULT_INTRO,
    closing: DEFAULT_CLOSING,
    moderation: { ...DEFAULT_MODERATION },
    consent: { ...DEFAULT_CONSENT },
    steps,
    randomizeTasks: false,
    estimatedMinutes: 15,
  };
}

// ── Session simulation ──────────────────────────────────────────────────────
interface Ev { kind: string; t: number; stepId: string | null; data: Record<string, unknown> }

class Sim {
  t = 0;
  path = '/';
  events: Ev[] = [];
  mouse: [number, number, number][] = [];
  gaze: [number, number, number][] = [];
  rr: Record<string, unknown>[] = [];
  idMap = new Map<string, number>();
  mx = 640;
  my = 400;
  step: string | null = null;
  constructor(public startedAt: number, public scale: number, public vw: number, public vh: number, public withGaze: boolean, public withReplay: boolean) {}
  ev(kind: string, data: Record<string, unknown> = {}) {
    this.events.push({ kind, t: Math.round(this.t), stepId: this.step, data });
  }
  wait(ms: number) {
    this.drift(ms);
  }
  say(text: string, gapAfter = 1500) {
    const dur = 1200 + text.split(/\s+/).length * 330;
    this.ev('transcript.participant', { text, startT: Math.round(this.t), endT: Math.round(this.t + dur) });
    this.drift(dur + gapAfter);
  }
  mod(text: string, kind?: 'moderator.probe' | 'moderator.nudge') {
    if (kind) this.ev(kind, { text });
    const dur = 900 + text.split(/\s+/).length * 300;
    this.ev('transcript.moderator', { text, startT: Math.round(this.t), endT: Math.round(this.t + dur) });
    this.drift(dur + 700);
  }
  nav(p: string, kind: 'load' | 'push' | 'pop' = 'push') {
    const from = this.path;
    this.path = p;
    this.ev('app.navigate', { path: p, from, title: PAGES[p].title, kind });
    if (this.withReplay) {
      const ts = this.startedAt + Math.round(this.t);
      this.idMap = new Map();
      const snap = pageSnapshot(p, this.idMap);
      this.rr.push({ type: 4, data: { href: `https://fern-and-co.demo${p}`, width: VW, height: VH }, timestamp: ts });
      this.rr.push({ type: 2, data: { node: snap.node, initialOffset: { left: 0, top: 0 } }, timestamp: ts + 1 });
    }
    this.drift(600 + rnd() * 600);
  }
  /** Mouse movement + gaze while time passes (optionally towards a target). */
  drift(ms: number, tx?: number, ty?: number) {
    const steps = Math.max(1, Math.round(ms / 100));
    const sx = this.mx;
    const sy = this.my;
    const gx = tx ?? clamp(this.mx + gauss() * 60, 10, VW - 10);
    const gy = ty ?? clamp(this.my + gauss() * 40, 10, VH - 10);
    const moves: { x: number; y: number; timeOffset: number }[] = [];
    for (let i = 1; i <= steps; i++) {
      const f = tx == null ? i / steps : 1 - Math.pow(1 - i / steps, 3);
      this.mx = sx + (gx - sx) * f + gauss() * 2;
      this.my = sy + (gy - sy) * f + gauss() * 2;
      const tt = Math.round(this.t + i * 100);
      this.mouse.push([tt, Math.round(this.mx * this.scale), Math.round(this.my * this.scale)]);
      if (this.withGaze) {
        // Gaze leads the mouse towards targets and wanders over headings/content; WebGazer-level noise (~80px).
        const lead = tx != null ? 0.6 : 0;
        const ggx = this.mx + (gx - this.mx) * lead + gauss() * 70;
        const ggy = this.my + (gy - this.my) * lead + gauss() * 70;
        this.gaze.push([tt, Math.round(clamp(ggx, 0, VW) * this.scale), Math.round(clamp(ggy, 0, VH) * this.scale)]);
      }
      if (this.withReplay && i % 2 === 0) moves.push({ x: Math.round(this.mx), y: Math.round(this.my), timeOffset: 0 });
    }
    if (this.withReplay && moves.length)
      for (let i = 0; i < moves.length; i += 5)
        this.rr.push({ type: 3, data: { source: 1, positions: moves.slice(i, i + 5).map((m, j) => ({ ...m, id: 1, timeOffset: -(moves.slice(i, i + 5).length - 1 - j) * 200 })) }, timestamp: this.startedAt + Math.round(this.t) + Math.round(((i + 5) / moves.length) * ms) });
    this.t += ms;
  }
  click(sel: string, opts: { dead?: boolean; rage?: boolean; think?: number } = {}) {
    const e = findEl(this.path, sel);
    const x = e.x + e.w * (0.3 + rnd() * 0.4);
    const y = e.y + e.h * (0.3 + rnd() * 0.4);
    this.drift(opts.think ?? 700 + rnd() * 1800, x, y);
    const data: ClickData = {
      x: Math.round(x * this.scale), y: Math.round(y * this.scale), pageX: Math.round(x * this.scale), pageY: Math.round(y * this.scale),
      vw: this.vw, vh: this.vh, path: this.path,
      el: { selector: e.sel, tag: e.tag, text: e.text, interactive: e.interactive },
    };
    const n = opts.rage ? 4 : 1;
    for (let i = 0; i < n; i++) {
      this.ev('app.click', data as unknown as Record<string, unknown>);
      if (this.withReplay) this.rr.push({ type: 3, data: { source: 2, type: 2, id: this.idMap.get(sel) ?? 1, x: Math.round(x), y: Math.round(y) }, timestamp: this.startedAt + Math.round(this.t) });
      this.t += opts.rage ? 160 : 0;
    }
    if (opts.rage) this.ev('app.rage_click', { ...data, count: n } as unknown as Record<string, unknown>);
    if (opts.dead || !e.interactive) {
      this.t += 400;
      this.ev('app.dead_click', data as unknown as Record<string, unknown>);
    }
    this.t += 300;
  }
  answer(stepId: string, questionId: string, value?: number, text?: string) {
    this.ev('answer', { stepId, questionId, ...(value != null ? { value } : {}), ...(text ? { text } : {}), source: text ? 'voice' : 'screen', at: this.startedAt + Math.round(this.t) });
    this.t += 1200 + rnd() * 1500;
  }
}

interface SimResult {
  sim: Sim;
  results: { stepId: string; outcome: TaskOutcome; startT: number; endT: number; evidence: string }[];
  answers: { stepId: string; questionId: string; value?: number; text?: string; t: number }[];
  completed: boolean;
}

function simulate(variant: 'A' | 'B', protocol: Protocol, sim: Sim, abandonAt?: 'checkout'): SimResult {
  const results: SimResult['results'] = [];
  const answers: SimResult['answers'] = [];
  const say = (pool: readonly string[]) => sim.say(pick(pool));
  const sayN = (pool: readonly string[], n: number) => {
    const copy = [...pool];
    for (let i = 0; i < n && copy.length; i++) sim.say(copy.splice(Math.floor(rnd() * copy.length), 1)[0], 1200 + rnd() * 3000);
  };
  const ans = (stepId: string, questionId: string, value?: number, text?: string) => {
    answers.push({ stepId, questionId, value, text, t: Math.round(sim.t) });
    sim.answer(stepId, questionId, value, text);
  };
  const startTask = (id: string) => {
    const st = protocol.steps.find((s) => s.id === id)!;
    sim.step = id;
    sim.ev('step.enter', { type: 'task' });
    sim.mod((st as { instruction: string }).instruction);
    sim.ev('task.start', {});
    return Math.round(sim.t);
  };
  const endTask = (id: string, start: number, outcome: TaskOutcome, evidence: string, source = 'rule') => {
    sim.ev('task.end', { outcome, source, startedAt: sim.startedAt + start, endedAt: sim.startedAt + Math.round(sim.t), durationMs: Math.round(sim.t) - start, evidence });
    results.push({ stepId: id, outcome, startT: start, endT: Math.round(sim.t), evidence });
  };
  // skill: per-participant ability; positive = faster/more successful
  const skill = gauss() * 0.7;

  sim.ev('session.start', {});
  sim.step = 'warmup';
  sim.ev('step.enter', { type: 'question' });
  sim.mod(DEFAULT_INTRO.slice(0, 160));
  sim.mod('How do you usually buy houseplants today?');
  const warm = pick(['Mostly at the garden centre near me, sometimes online if I know exactly what I want.', 'Usually online. I order from a couple of shops but delivery is hit and miss.', "Honestly I mostly buy them at the supermarket, I've never ordered a plant online."]);
  sim.say(warm);
  ans('warmup', 'warmup_q', undefined, warm);

  sim.step = 'first_impression';
  sim.ev('step.enter', { type: 'instruction' });
  sim.ev('app.ready', { path: '/' });
  sim.nav('/', 'load');
  sim.mod('Take a moment to look at the home page and tell me what you think this site is for.');
  sim.drift(3000, 900, 300);
  say(SAY.firstImpression);
  sim.drift(4000, 600, 650);

  // ── Task 1: find a pet-safe plant ──
  {
    const start = startTask('task_find');
    if (sim.path !== '/') sim.nav('/', 'push');
    const ok = chance(0.86 + skill * 0.05);
    if (chance(0.5)) {
      sim.click('a.tile-petsafe');
      sim.nav('/plants');
      sim.click('label.filter-pet', { think: 600 });
    } else {
      sim.click('nav > a:nth-child(1)');
      sim.nav('/plants');
      if (chance(0.5)) sim.say(SAY.findBad[0]);
      sim.click('label.filter-pet', { think: 2500 });
    }
    if (chance(0.6)) sim.click('label.filter-price', { think: 900 });
    if (!ok || chance(0.35)) {
      // detour to the Monstera
      sim.click('a.card-monstera');
      sim.nav('/plants/monstera-deliciosa');
      sim.click('div.gallery', { dead: true, think: 1500 });
      sim.say(SAY.findBad[1]);
      sim.nav('/plants', 'pop');
      if (!ok) {
        sim.say(SAY.findBad[2]);
        sim.click('a.card-snake', { think: 2500 });
        sim.drift(5000);
        say(SAY.findBad);
        sim.mod(pick(NUDGES), 'moderator.nudge');
        sim.say(SAY.findBad[3]);
        sim.drift(logNormal(25000, 0.4));
        sim.say("I think I'll skip this one, I can't tell which are pet-safe.");
        endTask('task_find', start, chance(0.5) ? 'abandoned' : 'failure', 'Participant gave up; no pet-safe plant in cart', 'participant');
      }
    }
    if (ok) {
      sim.click('a.card-calathea', { think: 1200 });
      sim.nav('/plants/calathea-orbifolia');
      sim.say(SAY.findGood[1]);
      if (chance(0.3)) sim.click('span.badge-pet', { dead: true });
      if (chance(0.4)) sim.click('select.size');
      sim.drift(logNormal(4000, 0.5) * Math.exp(-skill * 0.3));
      sim.click('button.add-to-cart');
      sim.ev('app.custom', { name: 'add_to_cart', sku: 'calathea-orbifolia' });
      endTask('task_find', start, 'success', 'Clicked "Add to cart" on Calathea Orbifolia');
    }
    sim.step = 'task_find';
    const r = results[results.length - 1];
    const seq = clamp(Math.round((r.outcome === 'success' ? 5.9 : 3.2) + gauss() * 0.8 + skill * 0.3), 1, 7);
    sim.mod('Overall, how difficult or easy was the task to complete?');
    ans('task_find', 'seq', seq);
    if (seq <= 4) {
      sim.mod('How did you decide which plant was pet-safe?', 'moderator.probe');
      sim.say(SAY.findBad[2]);
    }
  }

  // ── Task 2: checkout ──
  {
    const start = startTask('task_checkout');
    sim.nav('/cart');
    sim.click('button.checkout', { think: 1500 });
    const pSuccess = variant === 'A' ? 0.6 + skill * 0.15 : 0.93 + skill * 0.05;
    const ok = chance(pSuccess) && abandonAt !== 'checkout';
    if (variant === 'A') {
      sim.nav('/checkout/shipping');
      sim.say(ok ? SAY.checkoutAGood[0] : SAY.checkoutABad[0]);
      for (const f of ['input#name', 'input#address', 'input#zip', 'input#city']) {
        sim.click(f, { think: 500 });
        sim.ev('app.input', { selector: f, masked: true });
        sim.drift(1500 + rnd() * 2500);
      }
      if (chance(0.45)) sim.click('p.ship-note', { dead: true });
      sim.click('button.continue');
      sim.nav('/checkout/payment');
      if (ok) sim.say(SAY.checkoutAGood[1]);
      sim.click('label.ship-standard');
      sim.click('input#card');
      sim.ev('app.input', { selector: 'input#card', masked: true });
      sim.drift(4000 + rnd() * 4000);
      sim.click('input#exp');
      sim.click('input#cvc');
      if (!ok || chance(0.3)) {
        sim.click('button.continue', { rage: true });
        sim.ev('app.network_error', { kind: 'request', method: 'POST', url: '/api/checkout/payment-intent', status: 502, message: 'Bad Gateway', durationMs: 4100, path: '/checkout/payment' });
        sim.ev('app.error', { message: 'Payment service unavailable (502)', path: '/checkout/payment' });
        sim.say(SAY.checkoutABad[2]);
        sim.mod(pick(NUDGES), 'moderator.nudge');
        sim.say(SAY.checkoutABad[1]);
        if (chance(0.5)) {
          sim.click('button.back');
          sim.nav('/checkout/shipping', 'pop');
          sim.say(SAY.checkoutABad[3]);
          sim.click('button.continue');
          sim.nav('/checkout/payment');
        }
      }
      if (ok) {
        sim.click('button.continue');
        sim.nav('/checkout/review');
        sim.drift(logNormal(6000, 0.4));
        sim.click('button.place-order');
        sim.nav('/order/confirmed');
        sim.say(SAY.checkoutAGood[2]);
        endTask('task_checkout', start, 'success', 'Reached /order/confirmed');
      } else {
        sim.drift(logNormal(30000, 0.4));
        sim.say(SAY.checkoutABad[4]);
        endTask('task_checkout', start, abandonAt === 'checkout' ? 'abandoned' : chance(0.5) ? 'timeout' : 'failure', 'Did not reach the confirmation page', chance(0.5) ? 'ai' : 'rule');
      }
    } else {
      sim.nav('/checkout');
      sim.say(SAY.checkoutBGood[0]);
      for (const f of ['input#name', 'input#address', 'input#zip', 'input#city']) {
        sim.click(f, { think: 400 });
        sim.ev('app.input', { selector: f, masked: true });
        sim.drift(1400 + rnd() * 2200);
      }
      sim.click('label.ship-standard');
      if (chance(0.25)) sim.say(SAY.checkoutBBad[1]);
      sim.click('input#card');
      sim.drift(3500 + rnd() * 3000);
      sim.click('input#exp');
      sim.click('input#cvc');
      sim.say(pick([SAY.checkoutBGood[1], SAY.checkoutBGood[2]]));
      if (ok) {
        sim.click('button.place-order');
        sim.nav('/order/confirmed');
        sim.say(SAY.checkoutBGood[3]);
        endTask('task_checkout', start, 'success', 'Reached /order/confirmed');
      } else {
        sim.say(SAY.checkoutBBad[0]);
        sim.click('div.summary', { dead: true });
        sim.drift(logNormal(20000, 0.4));
        endTask('task_checkout', start, 'partial', 'Order placed with express shipping instead of standard', 'ai');
      }
    }
    const r = results[results.length - 1];
    const base = r.outcome === 'success' ? (variant === 'B' ? 6.2 : 5.0) : 2.6;
    const seq = clamp(Math.round(base + gauss() * 0.8 + skill * 0.3), 1, 7);
    sim.mod('Overall, how difficult or easy was the task to complete?');
    ans('task_checkout', 'seq', seq);
    if (seq <= 4) {
      sim.mod('What did you expect to happen when you clicked continue?', 'moderator.probe');
      sim.say(SAY.checkoutABad[5]);
    }
  }
  if (abandonAt === 'checkout') {
    sim.ev('session.end', { status: 'abandoned' });
    return { sim, results, answers, completed: false };
  }

  // ── Task 3: promo code ──
  {
    const start = startTask('task_promo');
    if (variant === 'A') {
      sim.nav('/checkout/review');
      const ok = chance(0.5 + skill * 0.2);
      sim.drift(2000);
      if (chance(0.6)) {
        sim.say(SAY.promoABad[0]);
        sim.click('div.summary', { dead: true, think: 2500 });
        if (chance(0.5)) {
          // detour: look for the promo field in the cart, then come back
          sim.nav('/cart');
          sim.click('div.summary', { dead: true, think: 1800 });
          sim.click('button.checkout');
          sim.nav('/checkout/shipping');
          sim.nav('/checkout/review', 'pop');
        }
        sim.say(SAY.promoABad[1]);
        sim.click('div.summary', { rage: chance(0.4), dead: true });
      }
      if (ok) {
        sim.drift(logNormal(9000, 0.5));
        sim.say(pick([SAY.promoAGood[1], SAY.promoABad[3]]));
        sim.click('a.have-code', { think: 1500 });
        sim.click('input#promo');
        sim.ev('app.input', { selector: 'input#promo', masked: false, value: 'FERN10' });
        sim.click('button.apply');
        sim.ev('app.custom', { name: 'promo_applied', code: 'FERN10' });
        sim.say(SAY.promoAGood[2]);
        endTask('task_promo', start, 'success', 'Clicked Apply with FERN10');
      } else {
        sim.mod(pick(NUDGES), 'moderator.nudge');
        sim.say(SAY.promoABad[2]);
        sim.drift(logNormal(25000, 0.4));
        endTask('task_promo', start, chance(0.6) ? 'failure' : 'abandoned', 'Promo field not found', 'participant');
      }
    } else {
      sim.nav('/checkout');
      const ok = chance(0.88 + skill * 0.05);
      sim.drift(1500);
      if (ok) {
        sim.say(SAY.promoBGood[0]);
        sim.click('input#promo', { think: 1200 });
        sim.ev('app.input', { selector: 'input#promo', masked: false, value: 'FERN10' });
        sim.click('button.apply');
        sim.ev('app.custom', { name: 'promo_applied', code: 'FERN10' });
        sim.say(SAY.promoBGood[1]);
        endTask('task_promo', start, 'success', 'Clicked Apply with FERN10');
      } else {
        sim.click('input#promo');
        sim.say(SAY.promoBBad[0]);
        sim.drift(8000);
        endTask('task_promo', start, 'partial', 'Code typed but not applied', 'ai');
      }
    }
    const r = results[results.length - 1];
    const seq = clamp(Math.round((r.outcome === 'success' ? (variant === 'B' ? 6.4 : 4.6) : 2.4) + gauss() * 0.8), 1, 7);
    sim.mod('Overall, how difficult or easy was the task to complete?');
    ans('task_promo', 'seq', seq);
  }

  // ── SUS ──
  sim.step = 'sus';
  sim.ev('step.enter', { type: 'questionnaire' });
  const succ = results.filter((r) => r.outcome === 'success').length;
  const target = clamp((variant === 'B' ? 0.72 : 0.5) + succ * 0.05 + skill * 0.08 + gauss() * 0.08, 0.05, 0.98);
  for (let i = 1; i <= 10; i++) {
    const pos = clamp(Math.round(1 + 4 * target + gauss() * 0.7), 1, 5);
    ans('sus', `sus_${i}`, i % 2 === 1 ? pos : 6 - pos);
  }
  // ── NPS ──
  sim.step = 'nps';
  sim.ev('step.enter', { type: 'questionnaire' });
  const npsV = clamp(Math.round(target * 10 + gauss() * 1.4), 0, 10);
  sim.mod('How likely are you to recommend Fern & Co to a friend or colleague?');
  ans('nps', 'nps', npsV);
  // ── Wrap-up ──
  sim.step = 'wrapup';
  sim.ev('step.enter', { type: 'interview' });
  sim.mod('Overall, how would you describe buying a plant on this site?');
  say(variant === 'A' ? SAY.wrapA : SAY.wrapB);
  sim.mod('What, if anything, was the most frustrating part?');
  sim.say(variant === 'A' ? pick([SAY.checkoutABad[5], SAY.promoABad[3], SAY.wrapA[1]]) : pick([SAY.findBad[0], SAY.wrapB[2], SAY.checkoutBBad[0]]));
  sim.mod(DEFAULT_CLOSING.slice(0, 100));
  sim.step = null;
  sim.ev('session.end', { status: 'completed' });
  return { sim, results, answers, completed: true };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const now = Date.now();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(EMAIL) as { id: string } | undefined;
  if (!user) {
    const id = newId('usr');
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, EMAIL, 'Demo Researcher', hashPassword(PASSWORD), now);
    user = { id };
  }
  const old = db.prepare('SELECT id FROM studies WHERE owner_id = ? AND name = ?').all(user.id, STUDY_NAME) as { id: string }[];
  for (const o of old) {
    for (const s of db.prepare('SELECT id FROM sessions WHERE study_id = ?').all(o.id) as { id: string }[]) fs.rmSync(paths.session(s.id), { recursive: true, force: true });
    db.prepare('DELETE FROM studies WHERE id = ?').run(o.id);
  }

  const studyId = newId('std');
  const created = now - 12 * 864e5;
  const pA = makeProtocol('A');
  const pB = makeProtocol('B');
  const protoA = newId('prt');
  const protoB = newId('prt');
  const vA = newId('var');
  const vB = newId('var');
  const linkId = newId('lnk');
  tx(() => {
    db.prepare('INSERT INTO studies (id, owner_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      studyId, user!.id, STUDY_NAME, 'Does a one-page checkout (B) beat the current 3-step checkout (A)? Think-aloud study with AI moderation.', 'live', created, now,
    );
    db.prepare('INSERT INTO protocols (id, study_id, name, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(protoA, studyId, 'Protocol A — 3-step checkout', json.str(pA), created, created);
    db.prepare('INSERT INTO protocols (id, study_id, name, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(protoB, studyId, 'Protocol B — one-page checkout', json.str(pB), created + 1, created + 1);
    db.prepare('INSERT INTO variants (id, study_id, name, protocol_id, app_id, weight, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, 1, ?)').run(vA, studyId, 'A — 3-step checkout', protoA, created);
    db.prepare('INSERT INTO variants (id, study_id, name, protocol_id, app_id, weight, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, 1, ?)').run(vB, studyId, 'B — one-page checkout', protoB, created + 1);
    db.prepare('INSERT INTO links (id, study_id, token, name, variant_id, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)').run(linkId, studyId, newId().slice(0, 12), 'Main link', created);
  });

  const insEvent = db.prepare('INSERT INTO events (session_id, seq, kind, t, at, step_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insResult = db.prepare('INSERT INTO task_results (session_id, step_id, outcome, source, started_at, ended_at, duration_ms, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insAnswer = db.prepare('INSERT INTO answers (session_id, step_id, question_id, text, value, choices, source, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
  const insNote = db.prepare('INSERT INTO notes (id, session_id, author_id, t, text, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const plan: { variant: 'A' | 'B'; abandon?: boolean; preview?: boolean; stale?: boolean }[] = [];
  for (let i = 0; i < 12; i++) plan.push({ variant: 'A' }, { variant: 'B' });
  plan.push({ variant: 'A', abandon: true }, { variant: 'B', abandon: true }, { variant: 'B', preview: true }, { variant: 'A', stale: true });

  let n = 0;
  let replayCount = 0;
  for (const p of plan) {
    const sid = newId('ses');
    const startedAt = Math.round(p.stale ? now - 50 * 60_000 : created + 864e5 + (n / plan.length) * 10 * 864e5 + rnd() * 3 * 3600e3);
    const wide = chance(0.25);
    const vw = wide ? 1440 : VW;
    const vh = wide ? 900 : VH;
    const withGaze = chance(0.6);
    const withReplay = n % 4 < 2; // half of the demo sessions (both variants) carry a synthetic replay
    const sim = new Sim(startedAt, vw / VW, vw, vh, withGaze, withReplay);
    const protocol = p.variant === 'A' ? pA : pB;
    const r = simulate(p.variant, protocol, sim, p.abandon || p.stale ? 'checkout' : undefined);
    if (p.stale) {
      // stale in-progress session: last activity ~45 min ago
      sim.events = sim.events.filter((e) => e.t < 240_000 && e.kind !== 'session.end');
      r.results.splice(0);
    }
    const endedAt = p.stale ? null : startedAt + Math.round(sim.t);
    const status = p.stale ? 'in_progress' : r.completed ? 'completed' : 'abandoned';
    const device = { userAgent: pick(['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/17.6', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0']), viewportW: vw, viewportH: vh, screenW: vw, screenH: vh + 100, dpr: wide ? 2 : 1, timezone: 'Europe/Berlin', language: 'en-US' };
    const consent = { version: '1', acceptedAt: startedAt - 30_000, audio: true, screen: true, eyeTracking: withGaze, ageConfirmed: true };
    const pc = code();
    tx(() => {
      db.prepare(
        `INSERT INTO sessions (id, study_id, variant_id, link_id, secret, participant_code, status, consent, device, url_params, step_order, steps, protocol_snapshot, preview, gaze_error_px, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sid, studyId, p.variant === 'A' ? vA : vB, linkId, newId('sec'), pc, status, json.str(consent), json.str(device),
        json.str(chance(0.5) ? { PROLIFIC_PID: newId().toUpperCase() } : {}), json.str(protocol.steps.map((s) => s.id)), json.str(protocol.steps), json.str(protocol),
        p.preview ? 1 : 0, withGaze ? Math.round(90 + rnd() * 90) : null, startedAt, endedAt, startedAt - 60_000,
      );
      let seq = 1;
      for (const e of sim.events) insEvent.run(sid, seq++, e.kind, e.t, startedAt + e.t, e.stepId, json.str(e.data));
      const batch = (kind: 'mouse' | 'gaze', pts: [number, number, number][]) => {
        const evs = sim.events;
        for (let i = 0; i < pts.length; i += 20) {
          const chunk = pts.slice(i, i + 20).filter((q) => !p.stale || q[0] < 240_000);
          if (!chunk.length) continue;
          const t0 = chunk[0][0];
          // path + step at that time
          let pathAt = '/';
          let stepAt: string | null = null;
          for (const e of evs) {
            if (e.t > t0) break;
            if (e.kind === 'app.navigate') pathAt = String(e.data.path);
            stepAt = e.stepId;
          }
          insEvent.run(sid, seq++, kind, t0, startedAt + t0, stepAt, json.str({ points: chunk, vw, vh, path: pathAt, scrollX: 0, scrollY: 0 }));
        }
      };
      batch('mouse', sim.mouse);
      if (withGaze) {
        insEvent.run(sid, seq++, 'eyetracking.calibrated', 1000, startedAt + 1000, 'warmup', json.str({ errorPx: 120 }));
        batch('gaze', sim.gaze);
      }
      for (const tr of r.results) insResult.run(sid, tr.stepId, tr.outcome, tr.outcome === 'success' ? 'rule' : 'ai', startedAt + tr.startT, startedAt + tr.endT, tr.endT - tr.startT, tr.evidence);
      for (const a of r.answers) {
        if (p.stale && a.t > 240_000) continue;
        insAnswer.run(sid, a.stepId, a.questionId, a.text ?? null, a.value ?? null, a.text ? 'voice' : 'screen', startedAt + a.t);
      }
      if (n === 0 || n === 3) {
        const ev = sim.events.find((e) => e.kind === 'app.rage_click' || e.kind === 'app.dead_click');
        if (ev) insNote.run(newId('note'), sid, user!.id, ev.t, n === 0 ? 'Repeated clicks on a non-interactive element — expected it to be a control.' : 'Hesitation before continuing; looked for shipping options.', json.str(n === 0 ? ['misclick', 'affordance'] : ['checkout']), now);
      }
    });
    if (withReplay && !p.stale) {
      const dir = paths.session(sid);
      fs.mkdirSync(dir, { recursive: true });
      const evs = sim.rr.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      const per = Math.ceil(evs.length / 4);
      for (let i = 0; i * per < evs.length; i++) fs.writeFileSync(path.join(dir, `rrweb-${String(i + 1).padStart(6, '0')}.json`), JSON.stringify({ events: evs.slice(i * per, (i + 1) * per) }));
      replayCount++;
    }
    n++;
  }

  // ── Demo synthesis: hand-written insights that go through the same verifier as AI output ──
  const built = corpusForStudy(studyId);
  const cite = (needle: string, max = 4, variantId?: string) => {
    const out: ProposedInsight['evidence'] = [];
    for (const c of built.corpus) {
      if (variantId && c.variantId !== variantId) continue;
      const l = c.lines.find((x) => x.speaker === 'participant' && x.text.includes(needle));
      if (l) out.push({ session: c.participantCode, tSec: l.t / 1000, quote: l.text, eventKind: null });
      if (out.length >= max) break;
    }
    return out;
  };
  const behaviour = (kind: string, max: number, variantId?: string) => {
    const out: ProposedInsight['evidence'] = [];
    for (const c of built.corpus) {
      if (variantId && c.variantId !== variantId) continue;
      const e = c.events.find((x) => x.kind === kind);
      if (e) out.push({ session: c.sessionId, tSec: e.t / 1000, quote: null, eventKind: kind });
      if (out.length >= max) break;
    }
    return out;
  };
  const countWith = (needle: string, variantId?: string) => built.corpus.filter((c) => (!variantId || c.variantId === variantId) && c.lines.some((l) => l.text.includes(needle))).length;
  const nA = built.corpus.filter((c) => c.variantId === vA).length;
  const nB = built.corpus.filter((c) => c.variantId === vB).length;
  const proposed: ProposedInsight[] = [
    {
      title: 'Payment step failures block checkout in variant A',
      body: `In variant A, ${countWith('something went wrong', vA)} of ${nA} participants hit a payment error and repeatedly clicked **Review order**; several were unsure whether they had been charged. Rage clicks cluster on the payment button.`,
      severity: 'critical', tags: ['checkout', 'errors', 'trust'], stepId: 'task_checkout', variantId: vA,
      recommendation: 'Show a clear inline error with retry guidance and confirm that no payment was taken.',
      evidence: [...cite('Did my payment go through or not?', 3, vA), ...behaviour('app.rage_click', 2, vA)],
    },
    {
      title: 'Shipping speed is asked too late in the 3-step flow',
      body: `Participants in A expected to choose delivery speed with the address and looked for it on the shipping step (${countWith('where do I pick the shipping speed', vA)} of ${nA}).`,
      severity: 'major', tags: ['checkout', 'information architecture'], stepId: 'task_checkout', variantId: vA,
      recommendation: 'Move shipping options next to the address, as in variant B.',
      evidence: cite('where do I pick the shipping speed', 3, vA),
    },
    {
      title: 'The promo code entry point is nearly invisible in A',
      body: `Most A participants first looked for the promo field in the cart or clicked the order summary. The small "Have a code?" link was described as easy to miss.`,
      severity: 'major', tags: ['promo', 'discoverability'], stepId: 'task_promo', variantId: vA,
      recommendation: 'Show an always-visible promo field in the order summary.',
      evidence: [...cite("that's tiny", 3, vA), ...cite("I'd expect the promo code to be in the cart", 2, vA)],
    },
    {
      title: 'Pet-safety is not visible on product cards',
      body: `Across both variants, participants could not tell from the listing which plants are pet-safe and opened product pages to check (${countWith('nothing says it on the cards')} of ${nA + nB} mentioned it).`,
      severity: 'minor', tags: ['product listing', 'filters'], stepId: 'task_find', variantId: null,
      recommendation: 'Add a pet-safe badge to product cards.',
      evidence: [...cite('nothing says it on the cards', 3), ...cite('paw icon', 2)],
    },
    {
      title: 'One-page checkout feels fast and transparent',
      body: `Variant B participants praised seeing the whole form and the running total at once (${countWith('one page', vB)} of ${nB} said so spontaneously).`,
      severity: 'positive', tags: ['checkout'], stepId: 'task_checkout', variantId: vB,
      evidence: [...cite("everything's on one page", 3, vB), ...cite('see the total the whole time', 2, vB)],
    },
    {
      title: 'Fabricated example (should be removed by verification)',
      body: 'This insight cites a quote nobody said and must be dropped by the anti-hallucination check.',
      severity: 'critical', tags: ['test'], stepId: null, variantId: null,
      evidence: [{ session: built.corpus[0]?.participantCode ?? 'x', tSec: 30, quote: 'I would pay double for express shipping', eventKind: null }],
    },
  ];
  const { insights, verification } = verifyInsights(proposed, built.corpus, { stepIds: built.stepIds, variantIds: built.variantIds });
  const summary = `**One-page checkout (B) clearly outperforms the current 3-step checkout (A).** Participants completed checkout more often and faster in B, rated it easier (SEQ) and gave it higher SUS scores.

Key findings:
- **Payment errors in A** are the biggest blocker: participants did not know whether they had been charged and rage-clicked the payment button.
- **Shipping speed is asked too late** in A; people looked for it with the address.
- **The promo code is hard to find** in A (hidden behind "Have a code?"); in B the visible field worked well.
- **Pet-safety isn't visible on product cards** in either variant.

**Recommended next steps**
1. Ship the one-page checkout, or at least move shipping options and the promo field into view.
2. Add inline payment error handling with a clear "you were not charged" message.
3. Add pet-safe badges to the product listing.`;
  saveSynthesis(studyId, { model: 'demo (hand-written, verified)', summary, insights, verification, sessionCount: built.sessionCount, generatedBy: 'seed' });

  console.log(`Seeded "${STUDY_NAME}" (${studyId}) with ${plan.length} sessions (${replayCount} with synthetic replay).`);
  console.log(`Synthesis: ${verification.insightsKept}/${verification.insightsProposed} insights kept, ${verification.evidenceVerified} evidence verified, ${verification.evidenceDropped} dropped.`);
  console.log(`Login: ${EMAIL} / ${PASSWORD}`);
}

main();

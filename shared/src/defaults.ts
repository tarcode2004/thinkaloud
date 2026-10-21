import type { ConsentSettings, ModerationSettings, Protocol } from './types.ts';

export const REALTIME_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;

export function newId(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return prefix ? `${prefix}_${s}` : s;
}

export const DEFAULT_MODERATION: ModerationSettings = {
  style: 'think_aloud_concurrent',
  probingLevel: 'moderate',
  allowClosedQuestions: true,
  silencePromptSeconds: 15,
  maxProbesPerStep: 2,
  probeOnBehavior: true,
  language: 'en',
  voice: 'marin',
  tone: 'warm, calm, curious and strictly neutral',
  customRules: [],
  allowTextFallback: true,
};

export const DEFAULT_CONSENT: ConsentSettings = {
  text: `## Before we start

Thanks for helping us improve this product. In this session an **AI moderator** will guide you through a few short activities while you use a website. **We are testing the product, not you** — there are no wrong answers.

**What we collect**
- Your voice and a transcript of what you say
- How you interact with the website (clicks, scrolling, pages visited). Text you type into the website is masked.
- Your answers to a few questions
- Optional: estimated eye-gaze position from your webcam, computed on your device. No video is stored.

**Your rights**
- Participation is voluntary. You can stop at any time using the **Stop & withdraw** button, and your data will be deleted.
- Data is used only for product research and is stored securely. Voice audio is processed by our AI provider (OpenAI) to run the conversation.

By continuing you confirm you have read this and agree to take part.`,
  storeAudio: true,
  recordScreen: true,
  offerEyeTracking: true,
  ageGate: true,
  version: '1',
};

export const DEFAULT_INTRO =
  "Hi, and thanks for joining! I'm an AI moderator, and I'll guide you through this session. " +
  "Just so you know, we're testing the product, not you, so there are no wrong answers. " +
  'As you use it, please think out loud: tell me what you are looking at, what you are trying to do, and what you expect to happen. ' +
  "Honest reactions, good or bad, are the most helpful. I won't be able to help you with the tasks, but you can say if you'd like to skip one. Ready to begin?";

export const DEFAULT_CLOSING =
  "That's everything. Thank you so much for your time and your honest feedback, it genuinely helps us make the product better. You can close this window now.";

export function emptyProtocol(title = 'Untitled protocol'): Protocol {
  return {
    schemaVersion: 1,
    title,
    researchGoals: [],
    productContext: '',
    intro: DEFAULT_INTRO,
    closing: DEFAULT_CLOSING,
    moderation: { ...DEFAULT_MODERATION },
    consent: { ...DEFAULT_CONSENT },
    steps: [],
    randomizeTasks: false,
    estimatedMinutes: 15,
  };
}

/** A complete, sensible starting protocol: warm-up, 2 tasks with SEQ, SUS, wrap-up interview. */
export function starterProtocol(productName = 'the website'): Protocol {
  return {
    ...emptyProtocol('Think-aloud usability test'),
    researchGoals: [
      'Identify the main usability problems in the core flow',
      'Understand what participants expect at each step and where expectations break',
      'Benchmark perceived usability (SUS)',
    ],
    productContext: `${productName}. Fill in what the product does and who it is for.`,
    steps: [
      {
        id: 'warmup',
        type: 'question',
        title: 'Warm-up',
        question: {
          id: 'warmup_q',
          prompt: 'To start, could you tell me a little about how you usually do this kind of thing online today?',
          kind: 'open',
          required: false,
          allowFollowUp: true,
          intent: 'Context on current habits and tools.',
        },
      },
      {
        id: 'first_impression',
        type: 'instruction',
        title: 'First impressions',
        script:
          "I'm going to show you the website now. Take a moment to look around without clicking anything, and tell me what you think it is for and what stands out to you.",
        showApp: true,
        exploreSeconds: 45,
      },
      {
        id: 'task_1',
        type: 'task',
        title: 'Task 1',
        instruction: 'Imagine you want to … Please use the website to do that, and remember to think out loud.',
        startPath: '/',
        successCriteria: 'Describe what success looks like (hidden from the participant).',
        successRules: [],
        timeLimitSec: 300,
        probes: ['What did you expect to happen when you did that?', 'How did you decide where to go first?'],
        askSEQ: true,
      },
      {
        id: 'task_2',
        type: 'task',
        title: 'Task 2',
        instruction: 'Now imagine you want to … Go ahead whenever you are ready.',
        successCriteria: 'Describe what success looks like.',
        successRules: [],
        timeLimitSec: 300,
        probes: [],
        askSEQ: true,
      },
      {
        id: 'sus',
        type: 'questionnaire',
        title: 'System Usability Scale',
        instrument: 'SUS',
        productName,
        onScreen: true,
      },
      {
        id: 'wrapup',
        type: 'interview',
        title: 'Wrap-up',
        goal: 'Overall impressions, biggest frustration, most valued aspect.',
        questions: [
          'Overall, how would you describe your experience with the website?',
          'What, if anything, was the most frustrating part?',
          'If you could change one thing, what would it be?',
        ],
        maxFollowUps: 1,
      },
    ],
  };
}

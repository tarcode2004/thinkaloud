// Generates realistic participant speech WAVs with OpenAI TTS (gpt-4o-mini-tts, 16-bit PCM WAV)
// into tests/fixtures/. Run directly: `npx tsx --env-file=.env tests/e2e/participant.fixtures.ts`.
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures');

export const CLIPS = {
  // Played by Chromium's fake audio device (looped): a short mic check, then a long silence.
  mic_check: 'Hi, can you hear me? Testing, one, two, three.',
  ready: "Yes, I'm ready. Let's start.",
  think: 'Okay, so I need to find a desk lamp. I can see Furniture, Lighting and Decor at the top. Lighting seems like the right place, so I will click that.',
  seq: 'I would say a six. It was pretty easy.',
  interview: 'Honestly, nothing was really confusing. The categories made sense and the add to cart button was easy to find.',
  // Fern & Co demo shop (tests/e2e/fullloop.spec.ts).
  explore: 'It looks like a plant shop. There are categories at the top, like indoor plants and pet-friendly, and some bestsellers further down.',
  think_shop: "Okay, let me have a look. I'll try the pet-friendly section at the top, that seems like the right place, and then open one of the plants.",
  went_ok: 'I think it went fine. It took me a moment, but I found what I was looking for.',
  probe_answer: "I mostly looked at the menu at the top first, because that's where I'd expect the categories to be.",
} as const;

export type ClipName = keyof typeof CLIPS;

export const clipPath = (n: ClipName) => path.join(FIXTURES_DIR, `${n}.wav`);
/** Fake capture file: ~5 minutes of a very low noise floor (speech is mixed in on demand). */
export const FAKE_MIC = path.join(FIXTURES_DIR, 'fake-mic.wav');

interface Wav {
  sampleRate: number;
  channels: number;
  bits: number;
  data: Buffer;
}

export function parseWav(buf: Buffer): Wav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav');
  let off = 12;
  let fmt: Omit<Wav, 'data'> | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      // Streamed TTS wavs may carry 0xFFFFFFFF as size.
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      if (!fmt) throw new Error('wav without fmt');
      return { ...fmt, data: buf.subarray(body, body + size) };
    }
    off = body + size + (size % 2);
  }
  throw new Error('wav without data');
}

export function writeWav(file: string, w: Wav) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + w.data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(w.channels, 22);
  h.writeUInt32LE(w.sampleRate, 24);
  h.writeUInt32LE((w.sampleRate * w.channels * w.bits) / 8, 28);
  h.writeUInt16LE((w.channels * w.bits) / 8, 32);
  h.writeUInt16LE(w.bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(w.data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, w.data]));
}

export async function tts(text: string): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing (needed to generate speech fixtures)');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: text,
      instructions: 'Speak like an ordinary usability-test participant: casual, natural pace, thinking out loud.',
      response_format: 'wav',
    }),
  });
  if (!res.ok) throw new Error(`TTS failed ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureFixtures(): Promise<void> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, text] of Object.entries(CLIPS) as [ClipName, string][]) {
    const file = clipPath(name);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) continue;
    const raw = await tts(text);
    const w = parseWav(raw);
    if (w.bits !== 16) throw new Error(`expected 16-bit PCM, got ${w.bits}`);
    writeWav(file, w); // normalise header (fixed sizes) for Chromium
    console.log(`[fixtures] ${name}.wav ${(w.data.length / (w.sampleRate * 2)).toFixed(1)}s @ ${w.sampleRate}Hz`);
  }
  if (!fs.existsSync(FAKE_MIC)) {
    const w = parseWav(fs.readFileSync(clipPath('mic_check')));
    const silenceSec = 300;
    const silence = Buffer.alloc(w.sampleRate * w.channels * 2 * silenceSec);
    // Very low noise floor so it isn't digital silence (more realistic, never triggers VAD).
    for (let i = 0; i < silence.length; i += 2) silence.writeInt16LE(Math.round((Math.random() - 0.5) * 6), i);
    // No speech here: Chromium may restart the file when the capture is reopened, which would
    // make the "participant" talk over the moderator at unpredictable moments.
    writeWav(FAKE_MIC, { ...w, data: silence });
    console.log('[fixtures] fake-mic.wav written');
  }
}

/** Extra clips for other specs: `tests/fixtures/<name>.wav`, generated once with TTS. */
export async function ensureClip(name: string, text: string): Promise<string> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = path.join(FIXTURES_DIR, `${name}.wav`);
  const meta = `${file}.txt`;
  if (fs.existsSync(file) && fs.statSync(file).size > 1000 && fs.existsSync(meta) && fs.readFileSync(meta, 'utf8') === text) return file;
  const w = parseWav(await tts(text));
  if (w.bits !== 16) throw new Error(`expected 16-bit PCM, got ${w.bits}`);
  writeWav(file, w);
  fs.writeFileSync(meta, text);
  console.log(`[fixtures] ${name}.wav ${(w.data.length / (w.sampleRate * 2)).toFixed(1)}s`);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixtures().then(
    () => console.log('fixtures ready'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

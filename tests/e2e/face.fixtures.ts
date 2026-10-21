// Fake webcam for eye-tracking tests: a realistic frontal face generated once with the OpenAI
// image API (gpt-image-1), turned into a looping y4m video (raw YUV 4:2:0 frames) with slight
// head motion, for Chromium's `--use-file-for-fake-video-capture`.
//   npx tsx --env-file=.env tests/e2e/face.fixtures.ts
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { FIXTURES_DIR } from './participant.fixtures.ts';

export const FACE_PNG = path.join(FIXTURES_DIR, 'face.png');
export const FACE_Y4M = path.join(FIXTURES_DIR, 'face.y4m');

const W = 640;
const H = 480;
const FPS = 15;
const FRAMES = 60; // 4 s loop

async function generateFace(): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing (needed to generate the face fixture)');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt:
        'A realistic webcam photo of an adult person sitting at a desk looking straight into the camera, frontal face, neutral expression, eyes open and clearly visible, no glasses, even soft indoor lighting, plain light wall behind, head and shoulders, face centered and filling about a third of the frame.',
      size: '1536x1024',
      quality: 'medium',
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`image generation failed ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { data: { b64_json: string }[] };
  return Buffer.from(j.data[0].b64_json, 'base64');
}

/** Bilinear sample of an RGBA PNG. */
function sampler(png: PNG) {
  const { width, height, data } = png;
  return (x: number, y: number): [number, number, number] => {
    x = Math.min(width - 1.001, Math.max(0, x));
    y = Math.min(height - 1.001, Math.max(0, y));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const px = (xx: number, yy: number, c: number) => data[(yy * width + xx) * 4 + c];
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx;
      const b = px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx;
      out[c] = a * (1 - fy) + b * fy;
    }
    return out;
  };
}

export function writeY4m(png: PNG, file: string) {
  const sample = sampler(png);
  // Crop a 4:3 window from the source (it is 3:2), then animate a small sway + zoom.
  const cropH = png.height;
  const cropW = (cropH * W) / H;
  const cx0 = (png.width - cropW) / 2;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const Y = Buffer.alloc(W * H);
  const U = Buffer.alloc((W / 2) * (H / 2));
  const V = Buffer.alloc((W / 2) * (H / 2));
  for (let f = 0; f < FRAMES; f++) {
    const ph = (f / FRAMES) * Math.PI * 2;
    const dx = Math.sin(ph) * 10; // px in source space
    const dy = Math.sin(ph * 2) * 4;
    const zoom = 1 + Math.sin(ph) * 0.015;
    const sw = cropW / zoom;
    const sh = cropH / zoom;
    const ox = cx0 + (cropW - sw) / 2 + dx;
    const oy = (cropH - sh) / 2 + dy;
    const rgbAt = (x: number, y: number) => sample(ox + (x / W) * sw, oy + (y / H) * sh);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, b] = rgbAt(x, y);
        Y[y * W + x] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
      }
    for (let y = 0; y < H / 2; y++)
      for (let x = 0; x < W / 2; x++) {
        const [r, g, b] = rgbAt(x * 2 + 0.5, y * 2 + 0.5);
        U[y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(-0.168736 * r - 0.331264 * g + 0.5 * b + 128)));
        V[y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.418688 * g - 0.081312 * b + 128)));
      }
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, Y);
    fs.writeSync(fd, U);
    fs.writeSync(fd, V);
  }
  fs.closeSync(fd);
}

export async function ensureFaceVideo(): Promise<string> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  if (!fs.existsSync(FACE_PNG)) {
    fs.writeFileSync(FACE_PNG, await generateFace());
    console.log('[fixtures] face.png generated');
  }
  if (!fs.existsSync(FACE_Y4M) || fs.statSync(FACE_Y4M).mtimeMs < fs.statSync(FACE_PNG).mtimeMs) {
    const png = PNG.sync.read(fs.readFileSync(FACE_PNG));
    writeY4m(png, FACE_Y4M);
    console.log(`[fixtures] face.y4m ${(fs.statSync(FACE_Y4M).size / 1e6).toFixed(1)}MB`);
  }
  return FACE_Y4M;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFaceVideo().then(
    (f) => console.log('ready', f),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

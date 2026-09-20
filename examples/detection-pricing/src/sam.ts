import { execFileSync } from 'node:child_process';
import type { Detection } from './detect';
import { load, type Photo } from './photo';

/**
 * The proposer: Meta's SAM 3, through fal.
 *
 * SAM 3 takes a noun phrase — "car" — and returns every instance of it, each with a mask, a box
 * and **its own score**. That last part is why this example does not stop here: a count billed on
 * the detector's own confidence is the seller marking their own homework, and SAM 3 is confident.
 *
 *   FAL_KEY=… pnpm --filter @tollstile-examples/detection-pricing photo -- photo.jpg 'a car'
 */

export type Segmentation = { readonly photo: Photo; readonly detections: readonly Detection[]; readonly proposedBy: string; readonly tookMs: number };

const ENDPOINT = 'https://fal.run/fal-ai/sam-3/image';
const TIMEOUT_MS = 60_000;
const MAX_MASKS = 12;
/** Wide enough for SAM to work with, small enough to post as a data URI. */
const SEND_WIDTH = 1024;

export async function segment(
  path: string,
  concept: string,
  options: { readonly apiKey: string; readonly endpoint?: string; readonly maxMasks?: number; readonly fetch?: typeof globalThis.fetch },
): Promise<Segmentation> {
  const photo = load(path);
  const call = options.fetch ?? globalThis.fetch;
  const jpeg = execFileSync(process.env['FFMPEG'] ?? 'ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${String(SEND_WIDTH)}:-2`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-'], {
    maxBuffer: 64 * 1_024 * 1_024,
    encoding: 'buffer',
  });

  const started = Date.now();
  const response = await call(options.endpoint ?? ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Key ${options.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      prompt: concept,
      include_scores: true,
      include_boxes: true,
      return_multiple_masks: true,
      max_masks: options.maxMasks ?? MAX_MASKS,
      apply_mask: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SAM answered HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);

  const body = (await response.json()) as { boxes?: unknown; scores?: unknown };
  return { photo, detections: detections(body, photo), proposedBy: 'fal-ai/sam-3', tookMs: Date.now() - started };
}

/** fal returns boxes as `[centre x, centre y, width, height]`, all as fractions of the image. */
function detections(body: { boxes?: unknown; scores?: unknown }, photo: Photo): readonly Detection[] {
  const boxes: unknown[] = Array.isArray(body.boxes) ? body.boxes : [];
  const scores: unknown[] = Array.isArray(body.scores) ? body.scores : [];

  return boxes
    .map((entry, index) => {
      const box: number[] = Array.isArray(entry) ? (entry as unknown[]).map((value) => Number(value)) : [];
      const [cx = 0, cy = 0, w = 0, h = 0] = box;
      const width = Math.round(w * photo.width);
      const height = Math.round(h * photo.height);
      const score: unknown = scores[index];
      return {
        box: {
          x: Math.max(0, Math.round(cx * photo.width - width / 2)),
          y: Math.max(0, Math.round(cy * photo.height - height / 2)),
          width,
          height,
        },
        // SAM's own score. Reported to the buyer, and used for nothing else.
        confidence: typeof score === 'number' ? score : 0,
        pixels: width * height,
      };
    })
    .filter((detection) => detection.box.width > 8 && detection.box.height > 8);
}

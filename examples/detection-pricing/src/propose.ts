import type { Detection } from './detect';
import { load, wholePng, type Photo } from './photo';

/**
 * A detector for real photographs: a vision model, asked for boxes.
 *
 * It is here to make the example's point with something other than a toy. The model proposes
 * regions and rates its own work, exactly as a segmentation model does — and the price still
 * depends on none of that, because a second model looks at each crop afterwards.
 *
 * Any OpenAI-shaped endpoint serves: Meta's own API (`https://api.llama.com/compat/v1`), a
 * gateway that carries Llama, or anything else that reads images.
 */

export type ProposeOptions = {
  readonly apiKey: string | undefined;
  readonly endpoint?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** The most boxes to accept from one answer. A detector that returns two hundred is broken. */
  readonly limit?: number;
};

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODEL = 'meta/llama-4-maverick';
const TIMEOUT_MS = 30_000;
const LIMIT = 16;

export type Proposal = { readonly photo: Photo; readonly detections: readonly Detection[]; readonly proposedBy: string; readonly tookMs: number };

export async function propose(path: string, target: string, options: ProposeOptions): Promise<Proposal> {
  const photo = load(path);
  const started = Date.now();
  if (options.apiKey === undefined || options.apiKey === '') {
    throw new Error('A photograph needs a model to propose regions. Set AI_GATEWAY_API_KEY (or LLAMA_API_KEY), or run without --image to use the drawn scene.');
  }

  const call = options.fetch ?? globalThis.fetch;
  const model = options.model ?? MODEL;
  const response = await call(options.endpoint ?? ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `Find every ${target} in the image. Answer with JSON only: {"found":[{"x":0.0,"y":0.0,"w":0.0,"h":0.0,"confidence":0.0}]}. ` +
            'x and y are the top-left corner as fractions of the image width and height; w and h are the size as fractions. ' +
            `Include a box only for ${target}. If there are none, answer {"found":[]}.`,
        },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${wholePng(photo).toString('base64')}` } }] },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`the detector answered HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  const detections = boxes(typeof content === 'string' ? content : '', photo, options.limit ?? LIMIT);

  return { photo, detections, proposedBy: typeof body.model === 'string' ? body.model : model, tookMs: Date.now() - started };
}

/** Models fence their JSON, apologise around it, and occasionally return a bare array. Take what parses. */
function boxes(text: string, photo: Photo, limit: number): readonly Detection[] {
  const start = text.search(/[[{]/);
  if (start === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, text.lastIndexOf(text.trimEnd().endsWith(']') ? ']' : '}') + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { found?: unknown }).found) ? (parsed as { found: unknown[] }).found : [];

  return list
    .map((entry) => entry as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; confidence?: unknown })
    .filter((entry) => [entry.x, entry.y, entry.w, entry.h].every((value) => typeof value === 'number'))
    .map((entry) => {
      const x = Math.max(0, Math.min(1, Number(entry.x)));
      const y = Math.max(0, Math.min(1, Number(entry.y)));
      const width = Math.max(0, Math.min(1 - x, Number(entry.w)));
      const height = Math.max(0, Math.min(1 - y, Number(entry.h)));
      return {
        box: {
          x: Math.round(x * photo.width),
          y: Math.round(y * photo.height),
          width: Math.round(width * photo.width),
          height: Math.round(height * photo.height),
        },
        // The detector's own opinion of its own work, reported and then ignored when billing.
        confidence: typeof entry.confidence === 'number' ? Math.max(0, Math.min(1, entry.confidence)) : 0.8,
        pixels: Math.round(width * photo.width * height * photo.height),
      };
    })
    .filter((detection) => detection.box.width > 8 && detection.box.height > 8)
    .slice(0, limit);
}

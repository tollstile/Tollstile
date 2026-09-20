import { deflateSync } from 'node:zlib';

/**
 * A stand-in for an aerial photograph, drawn rather than downloaded so the example needs no
 * dataset, no licence, and no network — and so every run detects exactly the same things.
 *
 * The scene contains what a detector should find (solar panels) and what it should not: skylights,
 * which are the same shape and nearly the same colour, and a swimming pool, which is neither. A
 * detector that finds only panels would make this example a lie; the interesting part of paying
 * per detection is what happens to the ones that should not count.
 */

export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Thing = { readonly kind: 'panel' | 'skylight' | 'pool'; readonly box: Box };

export const WIDTH = 480;
export const HEIGHT = 320;

const GROUND = [122, 132, 113] as const;
const ROOF = [150, 138, 126] as const;
const PANEL = [36, 46, 74] as const;
const SKYLIGHT = [58, 72, 96] as const;
const POOL = [62, 128, 150] as const;

/** Where everything is. Fixed, so a test can name a detection and a price. */
export const SCENE: readonly Thing[] = [
  { kind: 'panel', box: { x: 40, y: 48, width: 56, height: 34 } },
  { kind: 'panel', box: { x: 108, y: 48, width: 56, height: 34 } },
  { kind: 'panel', box: { x: 40, y: 92, width: 56, height: 34 } },
  { kind: 'panel', box: { x: 300, y: 196, width: 64, height: 38 } },
  { kind: 'skylight', box: { x: 210, y: 60, width: 34, height: 28 } },
  { kind: 'skylight', box: { x: 262, y: 60, width: 34, height: 28 } },
  { kind: 'pool', box: { x: 92, y: 210, width: 92, height: 52 } },
];

const ROOFS: readonly Box[] = [
  { x: 24, y: 32, width: 156, height: 110 },
  { x: 196, y: 44, width: 116, height: 62 },
  { x: 286, y: 182, width: 96, height: 66 },
];

/** RGB bytes, row-major. The detector reads this; the verifier sees crops of it. */
export function render(): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  fill(pixels, { x: 0, y: 0, width: WIDTH, height: HEIGHT }, GROUND);
  for (const roof of ROOFS) fill(pixels, roof, ROOF);
  for (const thing of SCENE) {
    fill(pixels, thing.box, thing.kind === 'panel' ? PANEL : thing.kind === 'skylight' ? SKYLIGHT : POOL);
  }
  return pixels;
}

function fill(pixels: Uint8Array, box: Box, colour: readonly [number, number, number]): void {
  for (let y = box.y; y < box.y + box.height && y < HEIGHT; y += 1) {
    for (let x = box.x; x < box.x + box.width && x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 3;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
    }
  }
}

export function crop(pixels: Uint8Array, box: Box, pad = 6): { pixels: Uint8Array; width: number; height: number } {
  const x0 = Math.max(0, box.x - pad);
  const y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(WIDTH, box.x + box.width + pad);
  const y1 = Math.min(HEIGHT, box.y + box.height + pad);
  const width = x1 - x0;
  const height = y1 - y0;
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((y0 + y) * WIDTH + (x0 + x)) * 3;
      const to = (y * width + x) * 3;
      out[to] = pixels[from] ?? 0;
      out[to + 1] = pixels[from + 1] ?? 0;
      out[to + 2] = pixels[from + 2] ?? 0;
    }
  }
  return { pixels: out, width, height };
}

/** A PNG, so a crop can be shown to a model or opened by a person. Written here to keep the example dependency-free. */
export function png(pixels: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(pixels.subarray(y * width * 3, (y + 1) * width * 3)).copy(raw, y * (width * 3 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

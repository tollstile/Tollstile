import { HEIGHT, WIDTH, type Box } from './scene';

/**
 * The detector: connected regions of dark blue, which is what a solar panel looks like from above.
 *
 * It is deliberately the kind of detector you actually get. It finds the panels, and it also finds
 * the skylights, because they are dark blue too — and it reports a confidence for each one that is
 * its own opinion of its own work. That last part is the reason this example exists: a detection
 * count scored by the detector is the seller marking their own homework.
 */

export type Detection = {
  readonly box: Box;
  /** The detector's own confidence, 0–1. Nothing is charged on the strength of this number. */
  readonly confidence: number;
  readonly pixels: number;
};

const DARKNESS = 110;
const BLUENESS = 12;
const MIN_PIXELS = 400;

export function detect(image: Uint8Array): readonly Detection[] {
  const seen = new Uint8Array(WIDTH * HEIGHT);
  const found: Detection[] = [];

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = y * WIDTH + x;
      if (seen[at] === 1 || !panelish(image, at)) continue;
      const region = flood(image, seen, x, y);
      if (region.pixels < MIN_PIXELS) continue;
      found.push({
        box: { x: region.x0, y: region.y0, width: region.x1 - region.x0 + 1, height: region.y1 - region.y0 + 1 },
        // Darker and larger reads as more certain. It is a plausible number, and it is still the
        // detector's own: the point of the guide is that nobody should be billed on it.
        confidence: Math.min(0.99, 0.55 + region.darkness * 0.3 + Math.min(region.pixels / 4_000, 0.2)),
        pixels: region.pixels,
      });
    }
  }
  return found.sort((one, two) => one.box.y - two.box.y || one.box.x - two.box.x);
}

function panelish(image: Uint8Array, at: number): boolean {
  const red = image[at * 3] ?? 255;
  const green = image[at * 3 + 1] ?? 255;
  const blue = image[at * 3 + 2] ?? 0;
  return red + green + blue < DARKNESS * 3 && blue > red + BLUENESS;
}

function flood(image: Uint8Array, seen: Uint8Array, startX: number, startY: number) {
  const stack = [startY * WIDTH + startX];
  let x0 = startX;
  let x1 = startX;
  let y0 = startY;
  let y1 = startY;
  let pixels = 0;
  let darkness = 0;

  while (stack.length > 0) {
    const at = stack.pop() ?? 0;
    if (seen[at] === 1 || !panelish(image, at)) continue;
    seen[at] = 1;
    pixels += 1;
    darkness += 1 - ((image[at * 3] ?? 0) + (image[at * 3 + 1] ?? 0) + (image[at * 3 + 2] ?? 0)) / (255 * 3);
    const x = at % WIDTH;
    const y = Math.floor(at / WIDTH);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    if (x > 0) stack.push(at - 1);
    if (x < WIDTH - 1) stack.push(at + 1);
    if (y > 0) stack.push(at - WIDTH);
    if (y < HEIGHT - 1) stack.push(at + WIDTH);
  }
  return { x0, x1, y0, y1, pixels, darkness: darkness / Math.max(pixels, 1) };
}

import { execFileSync } from 'node:child_process';
import type { Box } from './scene';

/**
 * A real photograph, read and cropped with ffmpeg.
 *
 * Decoding JPEG in TypeScript would be a library this example does not need: every machine that
 * can run a detector has ffmpeg, and shelling out keeps the interesting part — who decides what
 * was found, and what it costs — in view.
 */

export type Photo = { readonly pixels: Uint8Array; readonly width: number; readonly height: number; readonly path: string };

const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE'] ?? 'ffprobe';
/** Wide enough for a model to see, small enough to stay cheap. */
const MAX_WIDTH = 1024;

export function load(path: string): Photo {
  const probe = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path], { encoding: 'utf8' }).trim();
  const [rawWidth = '0', rawHeight = '0'] = probe.split('x');
  const scale = Math.min(1, MAX_WIDTH / Number(rawWidth));
  // Even dimensions keep every downstream filter happy.
  const width = Math.max(2, Math.round((Number(rawWidth) * scale) / 2) * 2);
  const height = Math.max(2, Math.round((Number(rawHeight) * scale) / 2) * 2);

  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', path, '-vf', `scale=${String(width)}:${String(height)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: width * height * 3 + 1_024,
    encoding: 'buffer',
  });
  return { pixels: new Uint8Array(raw), width, height, path };
}

/** A crop as a PNG, for a verifier to look at. Padded, because a box that clips its subject reads as a miss. */
export function cropPng(photo: Photo, box: Box, pad = 12): Buffer {
  // A box from a model can be anywhere, including outside the image. Clamp it to something a
  // filter can actually cut, rather than letting ffmpeg fail on a negative height.
  const x = Math.min(Math.max(0, Math.round(box.x - pad)), Math.max(0, photo.width - 8));
  const y = Math.min(Math.max(0, Math.round(box.y - pad)), Math.max(0, photo.height - 8));
  const width = Math.max(8, Math.min(photo.width - x, Math.round(box.width + pad * 2)));
  const height = Math.max(8, Math.min(photo.height - y, Math.round(box.height + pad * 2)));
  return execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', photo.path, '-vf', `scale=${String(photo.width)}:${String(photo.height)},crop=${String(width)}:${String(height)}:${String(x)}:${String(y)}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { maxBuffer: 16 * 1_024 * 1_024, encoding: 'buffer' },
  );
}

/** The whole photograph as a PNG, for a detector that works from the image rather than pixels. */
export function wholePng(photo: Photo): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', photo.path, '-vf', `scale=${String(photo.width)}:${String(photo.height)}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], {
    maxBuffer: 16 * 1_024 * 1_024,
    encoding: 'buffer',
  });
}

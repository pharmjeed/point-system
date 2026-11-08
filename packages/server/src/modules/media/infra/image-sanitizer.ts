import type { MediaContentType } from '@point/shared';
import type { Metadata, Sharp, SharpConstructor } from 'sharp';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import { SANITIZED_CONTENT_TYPE } from '../domain/media-policy.js';

/**
 * EXIF/GPS stripping (DEC-36, 09 §6.4, TC-071) with sharp/libvips: the image is decoded and re-encoded, the
 * EXIF orientation is baked into the pixels (`autoOrient`, the 0.35 alias of `rotate()` without an angle) and
 * no `withMetadata`/`keep*` call is made, so EXIF (GPS included), XMP, IPTC and ICC data are all dropped and
 * the pixels are converted to sRGB. The result is verified to carry no metadata before it is returned.
 */

export type ImageRejection =
  /** not a decodable image, or not the format the client declared (and signed in the upload URL) */
  | 'unsupported_type'
  /** more pixels than the decompression-bomb guard allows, or too slow to process */
  | 'too_large';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejection,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ImageRejectedError';
  }
}

export interface SanitizedImage {
  data: Buffer;
  contentType: MediaContentType;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export interface SanitizeImageOptions {
  declaredContentType: MediaContentType;
  /** decompression-bomb guard (default {@link DEFAULT_MAX_INPUT_PIXELS}) */
  maxInputPixels?: number;
  /** processing time limit (default 15 s) */
  timeoutSeconds?: number;
  /** JPEG/WebP quality (default 85) */
  quality?: number;
}

/** 50 MP: far above the 1600 px images the web app uploads (05 §5), far below libvips' 268 MP default. */
export const DEFAULT_MAX_INPUT_PIXELS = 50_000_000;

let sharpPromise: Promise<SharpConstructor> | null = null;

/** sharp (native libvips) is loaded on first use, so processes that never sanitize do not load it. */
function loadSharp(): Promise<SharpConstructor> {
  sharpPromise ??= import('sharp').then((m) => m.default);
  return sharpPromise;
}

/** Decoder check per declared type: the bytes must be that format (an extension or header is not enough). */
const MATCHES_DECLARED: Readonly<Record<MediaContentType, (m: Metadata) => boolean>> = {
  'image/jpeg': (m) => m.format === 'jpeg',
  'image/png': (m) => m.format === 'png',
  'image/webp': (m) => m.format === 'webp',
  // HEIC = HEIF with HEVC compression (AVIF is HEIF/AV1 and is not an accepted type)
  'image/heic': (m) => m.format === 'heif' && m.compression === 'hevc',
};

export async function sanitizeImage(input: Buffer, opts: SanitizeImageOptions): Promise<SanitizedImage> {
  const sharp = await loadSharp();
  const maxPixels = opts.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
  const quality = opts.quality ?? 85;
  const inputOptions = { failOn: 'warning' as const, limitInputPixels: maxPixels };

  let meta: Metadata;
  try {
    // header parsing only; the pixel limit is checked explicitly below so it reports as too_large
    meta = await sharp(input, { failOn: 'warning', limitInputPixels: false }).metadata();
  } catch (e) {
    throw new ImageRejectedError('unsupported_type', 'the uploaded bytes are not a decodable image', {
      cause: e,
    });
  }
  if (!MATCHES_DECLARED[opts.declaredContentType](meta)) {
    throw new ImageRejectedError(
      'unsupported_type',
      `declared ${opts.declaredContentType} but the content is ${meta.format}`,
    );
  }
  if (meta.width * meta.height > maxPixels) {
    throw new ImageRejectedError('too_large', `image exceeds ${maxPixels} pixels`);
  }

  const outputType = SANITIZED_CONTENT_TYPE[opts.declaredContentType];
  let pipeline: Sharp = sharp(input, inputOptions)
    .autoOrient()
    .timeout({ seconds: opts.timeoutSeconds ?? 15 });
  pipeline =
    outputType === 'image/png'
      ? pipeline.png()
      : outputType === 'image/webp'
        ? pipeline.webp({ quality })
        : pipeline.jpeg({ quality });

  let data: Buffer;
  let width: number;
  let height: number;
  try {
    const out = await pipeline.toBuffer({ resolveWithObject: true });
    data = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/timeout|pixel limit/i.test(message)) {
      throw new ImageRejectedError('too_large', 'the image is too large to process', { cause: e });
    }
    throw new ImageRejectedError('unsupported_type', 'the image could not be decoded', { cause: e });
  }

  await assertSanitized(data);
  return { data, contentType: outputType, width, height, byteSize: data.length, sha256: sha256Hex(data) };
}

/** True when the encoded image carries no EXIF (hence no GPS), XMP, IPTC, ICC profile or orientation tag. */
export async function isSanitized(data: Buffer): Promise<boolean> {
  const sharp = await loadSharp();
  const m = await sharp(data).metadata();
  return !m.exif && !m.xmp && !m.iptc && !m.icc && (m.orientation ?? 1) === 1;
}

/** A libvips/sharp change must never let metadata through silently: an unsanitized output is a 500. */
export async function assertSanitized(data: Buffer): Promise<void> {
  if (!(await isSanitized(data))) throw new Error('image sanitizer left metadata in the output');
}

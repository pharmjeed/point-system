import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/crypto/crypto.js';
import { ImageRejectedError, isSanitized, sanitizeImage } from '../src/modules/media/index.js';

// PNT-027 / DEC-36 / TC-071: photos are stored without EXIF (no GPS) — proven on real encoded images.

const GPS = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '24/1 42/1 3600/100',
  GPSLongitudeRef: 'E',
  GPSLongitude: '46/1 40/1 1200/100',
};

const canvas = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width, height, channels, background: { r: 200, g: 30, b: 60, alpha: 1 } } });

/** 64×32 JPEG, EXIF Orientation 6 (rotate 90° to display), camera make/model, GPS position, ICC profile. */
async function jpegWithGps(): Promise<Buffer> {
  return canvas(64, 32)
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'TestCam', Model: 'GPS-1' }, IFD3: GPS })
    .toBuffer();
}

// ----- a minimal EXIF (TIFF) reader, enough to prove the GPS IFD is really there --------------------------

type ExifValue = string | number[] | [number, number][];

function readExif(raw: Buffer): { ifd0: Map<number, ExifValue>; gps: Map<number, ExifValue> | null } {
  const tiff = raw.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? raw.subarray(6) : raw;
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const readIfd = (start: number) => {
    const tags = new Map<number, ExifValue>();
    for (let i = 0, n = u16(start); i < n; i++) {
      const e = start + 2 + i * 12;
      const [tag, type, count] = [u16(e), u16(e + 2), u32(e + 4)];
      const size = (SIZE[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (type === 2) tags.set(tag, tiff.toString('latin1', at, at + count).replace(/\0+$/, ''));
      else if (type === 5)
        tags.set(
          tag,
          Array.from({ length: count }, (_, k) => [u32(at + 8 * k), u32(at + 8 * k + 4)] as [number, number]),
        );
      else if (type === 3)
        tags.set(
          tag,
          Array.from({ length: count }, (_, k) => u16(at + 2 * k)),
        );
      else if (type === 4)
        tags.set(
          tag,
          Array.from({ length: count }, (_, k) => u32(at + 4 * k)),
        );
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const gpsPointer = ifd0.get(0x8825) as number[] | undefined;
  return { ifd0, gps: gpsPointer ? readIfd(gpsPointer[0]!) : null };
}

/** APPn markers of a JPEG stream up to the first scan (APP1 = EXIF/XMP, APP2 = ICC, APP13 = IPTC). */
function jpegAppMarkers(jpeg: Buffer): number[] {
  const out: number[] = [];
  for (let i = 2; i + 4 <= jpeg.length && jpeg[i] === 0xff;) {
    const marker = jpeg[i + 1]!;
    if (marker === 0xda) break;
    if (marker >= 0xe0 && marker <= 0xef) out.push(marker);
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return out;
}

function pngChunks(png: Buffer): string[] {
  const out: string[] = [];
  for (let i = 8; i + 8 <= png.length;) {
    const len = png.readUInt32BE(i);
    out.push(png.toString('latin1', i + 4, i + 8));
    i += 12 + len;
  }
  return out;
}

function webpChunks(webp: Buffer): string[] {
  const out: string[] = [];
  for (let i = 12; i + 8 <= webp.length;) {
    const len = webp.readUInt32LE(i + 4);
    out.push(webp.toString('latin1', i, i + 4));
    i += 8 + len + (len % 2);
  }
  return out;
}

describe('sanitizeImage — EXIF/GPS stripping (DEC-36)', () => {
  it('the source fixture really carries GPS, camera data, an orientation and an ICC profile', async () => {
    const src = await jpegWithGps();
    const meta = await sharp(src).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.hasProfile).toBe(true);
    const exif = readExif(meta.exif!);
    expect(exif.ifd0.get(0x010f)).toBe('TestCam'); // Make
    expect(exif.gps).not.toBeNull();
    expect(exif.gps!.get(0x0001)).toBe('N'); // GPSLatitudeRef
    expect(exif.gps!.get(0x0002)).toEqual([
      [24, 1],
      [42, 1],
      [3600, 100],
    ]); // GPSLatitude 24°42'36"
    expect(exif.gps!.get(0x0003)).toBe('E');
    expect(jpegAppMarkers(src)).toContain(0xe1);
  });

  it('re-encodes a JPEG with no EXIF/GPS, XMP, IPTC or ICC left and the orientation baked in', async () => {
    const src = await jpegWithGps();
    const out = await sanitizeImage(src, { declaredContentType: 'image/jpeg' });
    const meta = await sharp(out.data).metadata();

    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // no APP1 (EXIF/XMP), APP2 (ICC) or APP13 (IPTC) segment at all
    expect(jpegAppMarkers(out.data).filter((m) => m === 0xe1 || m === 0xe2 || m === 0xed)).toEqual([]);
    expect(out.data.includes(Buffer.from('TestCam'))).toBe(false);
    expect(out.data.includes(Buffer.from('GPS-1'))).toBe(false);
    // orientation 6 = rotate 90°: the 64×32 pixels become 32×64 and the tag is gone
    expect([out.width, out.height]).toEqual([32, 64]);
    expect([meta.width, meta.height]).toEqual([32, 64]);
    // the reported size and hash describe the stored bytes (DEC-36: new size + sha256)
    expect(out.contentType).toBe('image/jpeg');
    expect(out.byteSize).toBe(out.data.length);
    expect(out.sha256).toBe(sha256Hex(out.data));
    expect(out.sha256).not.toBe(sha256Hex(src));
    expect(await isSanitized(out.data)).toBe(true);
    expect(await isSanitized(src)).toBe(false);
  });

  it('strips EXIF/GPS from PNG (eXIf chunk) and WebP (EXIF chunk) too, keeping the format', async () => {
    const png = await canvas(20, 10, 4).png().withExif({ IFD3: GPS }).toBuffer();
    expect(pngChunks(png)).toContain('eXIf');
    const cleanPng = await sanitizeImage(png, { declaredContentType: 'image/png' });
    expect(cleanPng.contentType).toBe('image/png');
    expect(pngChunks(cleanPng.data)).not.toContain('eXIf');
    expect(pngChunks(cleanPng.data).filter((c) => /^(tEXt|iTXt|zTXt|iCCP)$/.test(c))).toEqual([]);
    expect((await sharp(cleanPng.data).metadata()).exif).toBeUndefined();

    const webp = await canvas(20, 10).webp().withExif({ IFD3: GPS }).toBuffer();
    expect(webpChunks(webp)).toContain('EXIF');
    const cleanWebp = await sanitizeImage(webp, { declaredContentType: 'image/webp' });
    expect(cleanWebp.contentType).toBe('image/webp');
    expect(webpChunks(cleanWebp.data).filter((c) => c === 'EXIF' || c === 'XMP ' || c === 'ICCP')).toEqual(
      [],
    );
    expect((await sharp(cleanWebp.data).metadata()).exif).toBeUndefined();
  });

  it('drops a GPS position carried in XMP as well', async () => {
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="24,42.6N"/></rdf:RDF></x:xmpmeta>';
    const src = await canvas(16, 16).jpeg().withXmp(xmp).toBuffer();
    expect((await sharp(src).metadata()).xmp).toBeDefined();
    const out = await sanitizeImage(src, { declaredContentType: 'image/jpeg' });
    expect((await sharp(out.data).metadata()).xmp).toBeUndefined();
    expect(out.data.includes(Buffer.from('GPSLatitude'))).toBe(false);
  });

  it('is deterministic: the same upload always gives the same sanitized bytes', async () => {
    const src = await jpegWithGps();
    const a = await sanitizeImage(src, { declaredContentType: 'image/jpeg' });
    const b = await sanitizeImage(src, { declaredContentType: 'image/jpeg' });
    expect(a.sha256).toBe(b.sha256);
  });

  it('rejects bytes that are not an image of the declared type (TC-071 fake type)', async () => {
    const reason = async (
      input: Buffer,
      declared: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic',
    ) => {
      try {
        await sanitizeImage(input, { declaredContentType: declared });
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(ImageRejectedError);
        return (e as ImageRejectedError).reason;
      }
    };
    const jpeg = await jpegWithGps();
    expect(await reason(Buffer.from('this is not an image, it only says .jpg'), 'image/jpeg')).toBe(
      'unsupported_type',
    );
    expect(await reason(await canvas(8, 8).png().toBuffer(), 'image/jpeg')).toBe('unsupported_type');
    expect(await reason(jpeg, 'image/png')).toBe('unsupported_type');
    expect(await reason(await canvas(8, 8).gif().toBuffer(), 'image/jpeg')).toBe('unsupported_type');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    );
    expect(await reason(svg, 'image/png')).toBe('unsupported_type');
    // AVIF is HEIF/AV1, not HEIC (HEIF/HEVC)
    expect(await reason(await canvas(8, 8).avif().toBuffer(), 'image/heic')).toBe('unsupported_type');
    expect(await reason(jpeg.subarray(0, 300), 'image/jpeg')).toBe('unsupported_type'); // truncated
  });

  it('rejects images above the pixel limit (decompression-bomb guard) as too large', async () => {
    const src = await jpegWithGps(); // 2048 px
    await expect(
      sanitizeImage(src, { declaredContentType: 'image/jpeg', maxInputPixels: 1000 }),
    ).rejects.toMatchObject({
      name: 'ImageRejectedError',
      reason: 'too_large',
    });
  });
});

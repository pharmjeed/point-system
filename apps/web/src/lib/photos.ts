/**
 * Inspection photos on the device (02 D-06 step 2, 05 §5): the longest edge to 1600 px, JPEG at quality
 * 0.8, re-encoded through a canvas — which drops every EXIF block, GPS position included. The server strips
 * metadata again after the upload (DEC-36). `MEDIA_TOO_LARGE` retries once at 1280 px / 0.7 (02 D-06).
 */
export const PHOTO_PROFILE = { maxEdge: 1600, quality: 0.8 } as const;
export const PHOTO_PROFILE_SMALL = { maxEdge: 1280, quality: 0.7 } as const;
export const PHOTO_TYPE = 'image/jpeg' as const;

/** Scaled size so that the longest edge is at most `maxEdge` (never enlarged). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decode(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  };
}

export async function compressPhoto(
  file: Blob,
  profile: { maxEdge: number; quality: number } = PHOTO_PROFILE,
): Promise<Blob> {
  const image = await decode(file);
  try {
    const { width, height } = fitWithin(image.width, image.height, profile.maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(image.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, PHOTO_TYPE, profile.quality),
    );
    if (!blob) throw new Error('encode failed');
    return blob;
  } finally {
    image.close();
  }
}

/** Hex SHA-256 of the bytes sent (07 `sha256`, optional): only where WebCrypto exists (secure contexts). */
export async function sha256Hex(blob: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

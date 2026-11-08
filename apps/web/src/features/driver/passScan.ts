/**
 * O-01 (V2-013, DEC-500): the camera side of «مسح بطاقة العميل» in D-05. The QR decoder (`@zxing/browser`, pure
 * JavaScript, so the service worker precaches it like any chunk) is loaded only when the driver opens the scanner.
 * The server verifies the pass (`POST /v1/tickets/intake-pass`); this only reads the text and rejects what is plainly
 * not an entry pass (a W-07 link QR, a URL) before sending anything.
 */

/** The entry pass prefix and the longest token (packages/shared `PASS_TOKEN_PREFIX` / `PASS_TOKEN_MAX_LENGTH`). */
const PASS_PREFIX = 'P1.';
const PASS_MAX = 128;
/** One decode attempt every … ms (a QR changes every 30 s: no need to read faster). */
const SCAN_EVERY_MS = 150;

/** The token to send for a scanned text, or null when it is not an entry pass. */
export function passTokenOf(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t.startsWith(PASS_PREFIX) || t.length > PASS_MAX || t.split('.').length !== 5) return null;
  return t;
}

/** Why the camera did not start: the permission was refused, or there is no usable camera / API. */
export type CameraProblem = 'denied' | 'unavailable';

export function cameraProblemOf(error: unknown): CameraProblem {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
}

/**
 * Starts the rear camera on `video` and calls `onText` with every QR text decoded (the caller stops after the first
 * entry pass). Resolves with the function that stops the camera. The frames are read here, each at the video's own
 * size once it is known (the decoder's own loop sizes its canvas once, at start, and can stay blind when the stream
 * reports its dimensions late).
 */
export async function startPassScanner(
  video: HTMLVideoElement,
  onText: (text: string) => void,
): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw Object.assign(new Error('camera unavailable'), { name: 'NotFoundError' });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' } },
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    const { BrowserQRCodeReader } = await import('@zxing/browser');
    const reader = new BrowserQRCodeReader();
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      let text: string | null = null;
      if (ctx && w && h) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(video, 0, 0, w, h);
        try {
          text = reader.decodeFromCanvas(canvas).getText();
        } catch {
          // no readable code in this frame
        }
      }
      if (text !== null) onText(text);
      if (!stopped) timer = setTimeout(tick, SCAN_EVERY_MS);
    };
    tick();
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}

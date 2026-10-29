import { statSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * A recording AudioContext for the in-page sound specs (PNT-066): headless Chromium has no audible output, so
 * the page gets a stand-in that records every construction, resume, decoded file (by byte size → sound name)
 * and every start / stop of a source, plus `navigator.vibrate` patterns. Nothing in the app changes: it uses
 * `window.AudioContext` as in production.
 */
const SOUNDS = ['offer', 'broadcast', 'reminder', 'next-due', 'escalation', 'test'] as const;

export function soundSizes(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const name of SOUNDS) {
    const size = statSync(new URL(`../../public/sounds/point-${name}.mp3`, import.meta.url)).size;
    out[size] = name.replace('-', '_');
  }
  return out;
}

export interface AudioLog {
  contexts: number;
  resumes: number;
  started: string[];
  stopped: string[];
  vibrate: unknown[];
  state: string | null;
}

export async function installFakeAudio(page: Page, options: { resumes?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ sizes, resumes }) => {
      const log = {
        contexts: 0,
        resumes: 0,
        started: [] as string[],
        stopped: [] as string[],
        vibrate: [] as unknown[],
        state: null as string | null,
      };
      (window as unknown as { __audio: typeof log }).__audio = log;
      class FakeAudioContext {
        state = 'suspended';
        currentTime = 0;
        destination = {};
        onstatechange: null | (() => void) = null;
        constructor() {
          log.contexts += 1;
          log.state = this.state;
          const all = ((window as unknown as { __contexts?: FakeAudioContext[] }).__contexts ??= []);
          all.push(this);
        }
        resume() {
          log.resumes += 1;
          if (!resumes) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
          this.state = 'running';
          log.state = 'running';
          this.onstatechange?.();
          return Promise.resolve();
        }
        suspend() {
          this.state = 'suspended';
          log.state = 'suspended';
          this.onstatechange?.();
          return Promise.resolve();
        }
        decodeAudioData(data: ArrayBuffer) {
          return Promise.resolve({ duration: 1, name: sizes[data.byteLength] ?? `bytes:${data.byteLength}` });
        }
        createBufferSource() {
          const node = {
            buffer: null as null | { name: string },
            onended: null as null | (() => void),
            connect() {},
            start() {
              log.started.push(node.buffer?.name ?? '?');
            },
            stop() {
              log.stopped.push(node.buffer?.name ?? '?');
            },
          };
          return node;
        }
        createOscillator() {
          return {
            frequency: { value: 0 },
            connect() {},
            start() {
              log.started.push('beep');
            },
            stop() {},
          };
        }
        createGain() {
          return { gain: { value: 1 }, connect() {} };
        }
      }
      Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true });
      Object.defineProperty(navigator, 'vibrate', {
        value: (pattern: unknown) => {
          log.vibrate.push(pattern);
          return true;
        },
        configurable: true,
      });
      // tests flip the context to «suspended» (iOS interruption) through this hook
      (window as unknown as { __suspendAudio: () => void }).__suspendAudio = () => {
        for (const c of (window as unknown as { __contexts?: FakeAudioContext[] }).__contexts ?? [])
          void c.suspend();
      };
    },
    { sizes: soundSizes(), resumes: options.resumes ?? true },
  );
}

export function audioLog(page: Page): Promise<AudioLog> {
  return page.evaluate(() => (window as unknown as { __audio: AudioLog }).__audio);
}

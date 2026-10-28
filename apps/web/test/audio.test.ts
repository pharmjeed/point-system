import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioRunning,
  playSound,
  runAudioTest,
  setAudioContextFactory,
  unlockAudio,
  type AudioContextLike,
} from '@/lib/audio';

/** 02 §1.10 / PNT-066 acceptance 1: no sound before the tap; a context that cannot run is «محجوب». */
function fakeContext(opts: { resumes?: boolean } = {}) {
  const started: string[] = [];
  const ctx = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    destination: {} as AudioNode,
    resume: vi.fn(async () => {
      if (opts.resumes === false) throw new Error('NotAllowedError');
      ctx.state = 'running';
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 1 }) as AudioBuffer),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(() => started.push('buffer')),
    })),
    createOscillator: vi.fn(() => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(() => started.push('beep')),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
  };
  return { ctx: ctx as unknown as AudioContextLike & { state: AudioContextState }, started };
}

afterEach(() => {
  setAudioContextFactory(null);
  vi.unstubAllGlobals();
});

describe('in-page sound', () => {
  it('plays nothing before the unlock tap', async () => {
    const { ctx, started } = fakeContext();
    setAudioContextFactory(() => ctx);
    expect(await playSound('offer')).toBe(false);
    expect(started).toEqual([]);
    expect(audioRunning()).toBe(false);
  });

  it('the test tap unlocks the context and plays the decoded test sound', async () => {
    const { ctx, started } = fakeContext();
    setAudioContextFactory(() => ctx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    await expect(runAudioTest()).resolves.toBe('played');
    expect(audioRunning()).toBe(true);
    expect(started).toEqual(['buffer']);
    expect(fetch).toHaveBeenCalledWith('/sounds/point-test.mp3');
  });

  it('a context that refuses to resume is reported as blocked', async () => {
    const { ctx, started } = fakeContext({ resumes: false });
    setAudioContextFactory(() => ctx);
    await expect(runAudioTest()).resolves.toBe('blocked');
    expect(started).toEqual([]);
  });

  it('no AudioContext at all is blocked too', async () => {
    setAudioContextFactory(() => null);
    await expect(unlockAudio()).resolves.toBe(false);
  });

  it('the test falls back to a short tone when the file cannot be loaded (offline)', async () => {
    const { ctx, started } = fakeContext();
    setAudioContextFactory(() => ctx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    await expect(runAudioTest()).resolves.toBe('played');
    expect(started).toEqual(['beep']);
    // other sounds never beep in place of their file
    expect(await playSound('offer')).toBe(false);
  });
});

import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api/queryClient';
import { homeRegistry, resetHomeRegistry } from '@/features/driver/useDriverHome';
import {
  audioRunning,
  audioStatus,
  playingSound,
  playSound,
  runAudioTest,
  setAudioContextFactory,
  stopSound,
  unlockAudio,
  type AudioContextLike,
} from '@/lib/audio';
import { applyOffer } from '@/realtime/driverHome';
import { driverEvents } from '@/realtime/driverRuntime';
import { useAudioStore } from '@/stores/audio';
import { home, IDS, offerCard } from './realtime/fixtures';

/** 02 §1.10, 14 §7, PNT-066: no sound before the tap; a context that cannot run is «محجوب». */
function fakeContext(opts: { resumes?: boolean } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  let n = 0;
  const ctx = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    destination: {} as AudioNode,
    onstatechange: null as null | (() => void),
    resume: vi.fn(async () => {
      if (opts.resumes === false) throw new Error('NotAllowedError');
      ctx.state = 'running';
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({ duration: 1, data }) as unknown as AudioBuffer),
    createBufferSource: vi.fn(() => {
      n += 1;
      const id = `buffer${n}`;
      return {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        start: vi.fn(() => started.push(id)),
        stop: vi.fn(() => stopped.push(id)),
      };
    }),
    createOscillator: vi.fn(() => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(() => started.push('beep')),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
  };
  return {
    ctx: ctx as unknown as AudioContextLike & { state: AudioContextState },
    raw: ctx,
    started,
    stopped,
  };
}

const okFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );

afterEach(() => {
  setAudioContextFactory(null);
  vi.unstubAllGlobals();
  resetHomeRegistry();
});

describe('in-page sound', () => {
  it('plays nothing — and touches no AudioContext — before the unlock tap; the state is visible', async () => {
    const { ctx, raw, started } = fakeContext();
    const factory = vi.fn(() => ctx);
    setAudioContextFactory(factory);
    expect(await playSound('offer')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(raw.createBufferSource).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(audioRunning()).toBe(false);
    expect(useAudioStore.getState().status).toBe('locked'); // the D-15 د banner shows
  });

  it('the test tap unlocks the context, preloads every sound and plays the decoded test sound', async () => {
    const { ctx, started } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await expect(runAudioTest()).resolves.toBe('played');
    expect(audioRunning()).toBe(true);
    expect(useAudioStore.getState().status).toBe('running');
    expect(started).toEqual(['buffer1']);
    for (const file of ['test', 'offer', 'broadcast', 'reminder', 'next-due', 'escalation'])
      expect(fetch).toHaveBeenCalledWith(`/sounds/point-${file}.mp3`);
  });

  it('a context that refuses to resume is reported as blocked', async () => {
    const { ctx, started } = fakeContext({ resumes: false });
    setAudioContextFactory(() => ctx);
    await expect(runAudioTest()).resolves.toBe('blocked');
    expect(started).toEqual([]);
    expect(audioStatus()).toBe('blocked');
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
    stopSound();
    expect(await playSound('offer')).toBe(false);
  });

  it('a context suspended after the unlock: the sound is not played and the state turns blocked', async () => {
    const { ctx, raw } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await unlockAudio();
    raw.state = 'suspended';
    raw.onstatechange?.();
    expect(useAudioStore.getState().status).toBe('blocked');
    expect(await playSound('offer')).toBe(false);
  });

  it('one sound at a time: a higher priority replaces, a lower one waits its turn (14 §7 rule 4)', async () => {
    const { ctx, started, stopped } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await unlockAudio();
    expect(await playSound('reminder', { key: 'offer:a' })).toBe(true);
    expect(await playSound('broadcast', { key: 'offer:b' })).toBe(true);
    expect(stopped).toEqual(['buffer1']);
    expect(await playSound('offer', { key: 'offer:c' })).toBe(false); // broadcast > offer
    expect(started).toEqual(['buffer1', 'buffer2']);
    expect(playingSound()).toEqual({ name: 'broadcast', key: 'offer:b' });
  });

  it('the test tone never holds back an alert: any alert replaces it; the tap plays it over a reminder', async () => {
    const { ctx, started, stopped } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await expect(runAudioTest()).resolves.toBe('played'); // buffer1 = test
    expect(await playSound('reminder', { key: 'offer:a' })).toBe(true); // buffer2 replaces the test
    expect(stopped).toEqual(['buffer1']);
    await expect(runAudioTest()).resolves.toBe('played'); // the tap: buffer3 over the reminder
    expect(stopped).toEqual(['buffer1', 'buffer2']);
    expect(await playSound('broadcast', { key: 'offer:b' })).toBe(true);
    expect(started).toEqual(['buffer1', 'buffer2', 'buffer3', 'buffer4']);
    expect(playingSound()).toEqual({ name: 'broadcast', key: 'offer:b' });
  });

  it('vibrates with offer, broadcast and next_due only (02 §1.10)', async () => {
    const { ctx } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    await unlockAudio();
    await playSound('offer');
    expect(vibrate).toHaveBeenLastCalledWith([200, 100, 200]);
    stopSound();
    await playSound('reminder');
    expect(vibrate).toHaveBeenCalledTimes(2); // the stop cancels the pattern (0); reminder adds none
    expect(vibrate).toHaveBeenLastCalledWith(0);
  });
});

describe('stopping a card sound (PNT-066 acceptance 2)', () => {
  it('a reservation (the press) stops the sound of its card at once', async () => {
    const { ctx, stopped } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await unlockAudio();
    await playSound('broadcast', { key: `offer:${IDS.offerA}` });
    stopSound(`offer:${IDS.offerB}`); // another card: nothing stops
    expect(stopped).toEqual([]);
    stopSound(`offer:${IDS.offerA}`); // LiveOfferCard.onAccept, before the request leaves
    expect(stopped).toEqual(['buffer1']);
    expect(playingSound()).toBeNull();
  });

  it('task.claimed by another driver stops the sound of the card on screen, without a new one', async () => {
    const { ctx, started, stopped } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await unlockAudio();
    const qc = new QueryClient();
    const card = offerCard(IDS.offerA, IDS.taskA, '2026-10-29T17:58:00.000Z', { mode: 'broadcast' });
    qc.setQueryData(queryKeys.home, applyOffer(home(), card, homeRegistry, Date.now()));
    await playSound('broadcast', { key: `offer:${IDS.offerA}` });
    const onEvent = driverEvents({ area: 'driver', userId: IDS.me, qc, hasDuty: () => true });
    onEvent({
      id: globalThis.crypto.randomUUID(),
      type: 'task.claimed',
      occurred_at: '2026-10-29T18:00:01.000Z',
      venue_id: IDS.venue,
      dispatch_pool_id: null,
      event_id: null,
      aggregate: { type: 'task', id: IDS.taskA, version: 3 },
      payload: {
        cause: 'task.claimed',
        task_id: IDS.taskA,
        offer_ids: [IDS.offerA],
        result: 'accepted',
        claimed_by: { id: IDS.other, full_name: 'سائق آخر' },
      },
    });
    expect(stopped).toEqual(['buffer1']);
    expect(started).toEqual(['buffer1']); // task.claimed plays nothing (02 §1.10)
    expect(qc.getQueryData<{ offer: unknown }>(queryKeys.home)?.offer).toBeNull();
  });

  it('a decode still in flight when the card closes never starts', async () => {
    const { ctx, started } = fakeContext();
    setAudioContextFactory(() => ctx);
    okFetch();
    await unlockAudio();
    const pending = playSound('offer', { key: `offer:${IDS.offerC}` });
    stopSound(`offer:${IDS.offerC}`);
    expect(await pending).toBe(false);
    expect(started).toEqual([]);
  });
});

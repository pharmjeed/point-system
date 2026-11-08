import { useAudioStore, type AudioStatus } from '@/stores/audio';

/**
 * In-page sound (02 §1.10, 14 §7, canon §13; PNT-066):
 * - one AudioContext, created and resumed inside a user tap («تفعيل واختبار الصوت» in D-03/D-14, the D-15 د
 *   banner) — nothing is ever played, or even attempted, before that tap;
 * - after the unlock every brand sound (`/sounds`, copied from brand/sounds) is fetched and decoded once into
 *   an AudioBuffer, so an offer plays at once;
 * - one sound at a time with the 14 §7 priority escalation > broadcast > offer > next_due > reminder; a sound
 *   is tied to a key (the offer it announces) so `task.claimed`, `offer.closed` or the driver's own press stops
 *   it immediately (`stopSound`);
 * - a context that is not running when a sound is due is «blocked»: no silent retry, the banner asks for a tap
 *   (14 §7 rule 2) and the app records `blocked` on the device;
 * - Android vibration with offer / broadcast / next_due only (02 §1.10 patterns); iPhone has none.
 */
export type SoundName = 'offer' | 'broadcast' | 'reminder' | 'next_due' | 'escalation' | 'test';

export const SOUND_NAMES: readonly SoundName[] = [
  'offer',
  'broadcast',
  'reminder',
  'next_due',
  'escalation',
  'test',
];

/** canon §13 file names (packages/shared SOUNDS), served from apps/web/public/sounds. */
export const SOUND_FILES: Record<SoundName, string> = {
  offer: '/sounds/point-offer.mp3',
  broadcast: '/sounds/point-broadcast.mp3',
  reminder: '/sounds/point-reminder.mp3',
  next_due: '/sounds/point-next-due.mp3',
  escalation: '/sounds/point-escalation.mp3',
  test: '/sounds/point-test.mp3',
};

/** 14 §7 rule 4: escalation > broadcast > offer > next_due > reminder (the test tone: see `waitsFor`). */
export const SOUND_PRIORITY: Record<SoundName, number> = {
  escalation: 5,
  broadcast: 4,
  offer: 3,
  next_due: 2,
  reminder: 1,
  test: 0,
};

/**
 * Whether `next` must give way to the sound playing now (14 §7 rule 4: one sound at a time). The test tone is
 * outside the ranking: it comes from the driver's own tap, so it always plays, and any alert replaces it — a
 * request is never lost behind the test.
 */
export function waitsFor(next: SoundName, current: SoundName): boolean {
  if (next === 'test' || current === 'test') return false;
  return SOUND_PRIORITY[current] > SOUND_PRIORITY[next];
}

/** 02 §1.10 vibration patterns; none for reminder, escalation and the test. */
export const VIBRATION: Partial<Record<SoundName, number[]>> = {
  offer: [200, 100, 200],
  broadcast: [300, 100, 300, 100, 300],
  next_due: [100, 60, 100, 60, 200],
};

/** The part of AudioContext used here (a fake one in unit tests). */
export interface AudioContextLike {
  readonly state: AudioContextState | 'interrupted';
  readonly currentTime: number;
  readonly destination: AudioNode;
  onstatechange?: ((this: unknown, ev: Event) => unknown) | null;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  createBufferSource(): AudioBufferSourceNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

type Factory = () => AudioContextLike | null;

const defaultFactory: Factory = () => {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? (new Ctor() as unknown as AudioContextLike) : null;
};

let factory: Factory = defaultFactory;
let context: AudioContextLike | null = null;
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>();

interface Playing {
  name: SoundName;
  key: string | null;
  source: AudioBufferSourceNode | OscillatorNode;
}
let playing: Playing | null = null;
/** Bumped by every play request and every stop: a decode that finishes late never starts a stale sound. */
let ticket = 0;
let pendingKey: { ticket: number; key: string | null; name: SoundName } | null = null;

const setStatus = (status: AudioStatus) => useAudioStore.getState().setStatus(status);

/** Unit tests replace the AudioContext; also forgets the current one. */
export function setAudioContextFactory(next: Factory | null): void {
  factory = next ?? defaultFactory;
  context = null;
  buffers.clear();
  playing = null;
  pendingKey = null;
  setStatus('locked');
}

export function audioSupported(): boolean {
  if (factory !== defaultFactory) return true;
  return (
    typeof window !== 'undefined' &&
    !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)
  );
}

export const audioRunning = (): boolean => context?.state === 'running';

/** `locked` until the first unlock tap of this page; then the context's state. */
export function audioStatus(): AudioStatus {
  if (!context) return 'locked';
  return context.state === 'running' ? 'running' : 'blocked';
}

function watch(ctx: AudioContextLike): void {
  try {
    ctx.onstatechange = () => {
      if (context === ctx) setStatus(audioStatus());
    };
  } catch {
    // a context without the event: the status is checked when a sound is due
  }
}

/**
 * Creates or resumes the context. Call it synchronously from the tap handler: the context is created
 * before the first `await`, which is what the browsers' autoplay rules require. On success every sound is
 * preloaded (fetched and decoded once).
 */
export function unlockAudio(): Promise<boolean> {
  try {
    if (!context) {
      context = factory();
      if (context) watch(context);
    }
  } catch {
    context = null;
  }
  const ctx = context;
  if (!ctx) {
    setStatus('blocked');
    return Promise.resolve(false);
  }
  const done = (running: boolean) => {
    setStatus(running ? 'running' : 'blocked');
    if (running) preloadSounds();
    return running;
  };
  if (ctx.state === 'running') return Promise.resolve(done(true));
  return ctx.resume().then(
    () => done(ctx.state === 'running'),
    () => done(false),
  );
}

function loadBuffer(ctx: AudioContextLike, name: SoundName): Promise<AudioBuffer | null> {
  let pending = buffers.get(name);
  if (!pending) {
    pending = fetch(SOUND_FILES[name])
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => ctx.decodeAudioData(data))
      .catch(() => {
        buffers.delete(name); // try again next time (e.g. the file was not cached offline)
        return null;
      });
    buffers.set(name, pending);
  }
  return pending;
}

/** Fetches and decodes every brand sound once (after the unlock): offers then play without a delay. */
export function preloadSounds(): void {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return;
  for (const name of SOUND_NAMES) void loadBuffer(ctx, name);
}

/** A short tone when the file cannot be loaded, so the test still tells the driver whether sound works. */
function beep(ctx: AudioContextLike): OscillatorNode {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.2;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
  return osc;
}

function vibrate(pattern: number[] | 0): void {
  try {
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    if (nav && typeof nav.vibrate === 'function') nav.vibrate(pattern);
  } catch {
    // not supported (iPhone): nothing to do
  }
}

function halt(p: Playing | null): void {
  if (!p) return;
  try {
    p.source.stop();
  } catch {
    // already ended
  }
}

export interface PlayOptions {
  /** What the sound announces (e.g. `offer:<offerId>`): `stopSound(key)` stops exactly this one. */
  key?: string | null;
}

/**
 * Plays a sound when the context runs. Returns false — without touching the context — before the unlock tap,
 * when the context is not running (the status turns `blocked`: the banner asks for a tap), when a sound of a
 * higher priority is playing, or when the file cannot be decoded.
 */
export async function playSound(name: SoundName, options: PlayOptions = {}): Promise<boolean> {
  const ctx = context;
  if (!ctx) return false; // PNT-066 acceptance 1: no play attempt before the unlock
  if (ctx.state !== 'running') {
    setStatus('blocked');
    return false;
  }
  if (playing && waitsFor(name, playing.name)) return false;
  // a higher sound still decoding is not replaced by a lower one asked in the same moment (14 §7 rule 4)
  if (pendingKey && waitsFor(name, pendingKey.name)) return false;
  ticket += 1;
  const mine = ticket;
  const key = options.key ?? null;
  pendingKey = { ticket: mine, key, name };
  const buffer = await loadBuffer(ctx, name);
  if (mine !== ticket) return false; // stopped or replaced while decoding
  pendingKey = null;
  if (ctx.state !== 'running') {
    setStatus('blocked');
    return false;
  }
  if (playing && waitsFor(name, playing.name)) return false;
  halt(playing);
  playing = null;
  let source: AudioBufferSourceNode | OscillatorNode;
  if (!buffer) {
    if (name !== 'test') return false;
    source = beep(ctx);
  } else {
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.start();
    source = node;
  }
  const current: Playing = { name, key, source };
  playing = current;
  try {
    source.onended = () => {
      if (playing === current) playing = null;
    };
  } catch {
    // fake nodes in tests
  }
  const pattern = VIBRATION[name];
  if (pattern) vibrate(pattern);
  return true;
}

/**
 * Stops the sound now (02 §1.7: `task.claimed` / `offer.closed`; a reservation or acceptance of the card):
 * the playing sound and a sound still being decoded, when their key matches (or any sound without a key).
 */
export function stopSound(key?: string | null): void {
  const matches = (k: string | null) => key === undefined || key === null || k === key;
  if (pendingKey && matches(pendingKey.key)) {
    ticket += 1; // the decode in flight will not start
    pendingKey = null;
  }
  if (playing && matches(playing.key)) {
    const stopped = playing;
    playing = null;
    halt(stopped);
    if (VIBRATION[stopped.name]) vibrate(0);
  }
}

/** The key of the sound playing now (tests and the offer card). */
export function playingSound(): { name: SoundName; key: string | null } | null {
  return playing ? { name: playing.name, key: playing.key } : null;
}

/** D-03 «تفعيل واختبار الصوت»: unlock inside the tap, then play `test`; `blocked` when it cannot run. */
export async function runAudioTest(): Promise<'played' | 'blocked'> {
  const unlocked = await unlockAudio();
  if (!unlocked) return 'blocked';
  return (await playSound('test')) ? 'played' : 'blocked';
}

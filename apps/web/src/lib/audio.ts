/**
 * In-page sound (02 §1.10, canon §13): one AudioContext opened by a user tap («تفعيل واختبار الصوت» in
 * D-03/D-14), sounds decoded once into AudioBuffers from `/sounds` (copied from brand/sounds). Nothing is
 * played before that tap (PNT-066 acceptance 1). PNT-035 uses the `test` sound only; the offer, broadcast,
 * reminder and next-task sounds and the blocked-audio banner are PNT-066/067.
 */
export type SoundName = 'offer' | 'broadcast' | 'reminder' | 'next_due' | 'escalation' | 'test';

export const SOUND_FILES: Record<SoundName, string> = {
  offer: '/sounds/point-offer.mp3',
  broadcast: '/sounds/point-broadcast.mp3',
  reminder: '/sounds/point-reminder.mp3',
  next_due: '/sounds/point-next-due.mp3',
  escalation: '/sounds/point-escalation.mp3',
  test: '/sounds/point-test.mp3',
};

/** The part of AudioContext used here (a fake one in unit tests). */
export interface AudioContextLike {
  readonly state: AudioContextState | 'interrupted';
  readonly currentTime: number;
  readonly destination: AudioNode;
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

/** Unit tests replace the AudioContext; also forgets the current one. */
export function setAudioContextFactory(next: Factory | null): void {
  factory = next ?? defaultFactory;
  context = null;
  buffers.clear();
}

export function audioSupported(): boolean {
  if (factory !== defaultFactory) return true;
  return (
    typeof window !== 'undefined' &&
    !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)
  );
}

export const audioRunning = (): boolean => context?.state === 'running';

/**
 * Creates or resumes the context. Call it synchronously from the tap handler: the context is created
 * before the first `await`, which is what the browsers' autoplay rules require.
 */
export function unlockAudio(): Promise<boolean> {
  try {
    context ??= factory();
  } catch {
    context = null;
  }
  const ctx = context;
  if (!ctx) return Promise.resolve(false);
  if (ctx.state === 'running') return Promise.resolve(true);
  return ctx.resume().then(
    () => ctx.state === 'running',
    () => false,
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

/** A short tone when the file cannot be loaded, so the test still tells the driver whether sound works. */
function beep(ctx: AudioContextLike): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.2;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
}

/** Plays a sound if the context runs; false when it never was unlocked or is suspended (blocked). */
export async function playSound(name: SoundName): Promise<boolean> {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return false;
  const buffer = await loadBuffer(ctx, name);
  if (ctx.state !== 'running') return false;
  if (!buffer) {
    if (name !== 'test') return false;
    beep(ctx);
    return true;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  return true;
}

/** D-03 «تفعيل واختبار الصوت»: unlock inside the tap, then play `test`; `blocked` when it cannot run. */
export async function runAudioTest(): Promise<'played' | 'blocked'> {
  const unlocked = await unlockAudio();
  if (!unlocked) return 'blocked';
  return (await playSound('test')) ? 'played' : 'blocked';
}

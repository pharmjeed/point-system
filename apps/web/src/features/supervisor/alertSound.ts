import type { Alert } from '@/api/types';

/**
 * Supervisor alert sounds (14 §7, §8, §10; 03 §2.8): `critical` plays `escalation` and repeats every
 * `alerts.escalation_repeat_s` (60 s) until acknowledged, at most `alerts.escalation_max_repeats` (3) times;
 * `warning` plays `reminder` once when it appears; `info` is silent. Acknowledging or resolving stops the
 * sound at once (07 §2.7 `acknowledge`: «يوقف تكرار صوت التصعيد»). One sound at a time, escalation first.
 *
 * Nothing plays before the user unlocked audio with a tap (autoplay rules, 02 §1.10, 14 §7 rule 1): the
 * controller is created disabled and `enable()` is called from the «تفعيل صوت التنبيهات» click.
 * Framework-free with injected timers and players, so the rules are unit-tested.
 */

/** Canon §12 defaults (organization settings `alerts.*`; not exposed to the web client in v1). */
export const ESCALATION_REPEAT_MS = 60_000;
export const ESCALATION_MAX_REPEATS = 3;

export interface SoundPlayer {
  /** Starts the sound from the beginning; resolves false when the browser refused to play. */
  play(): Promise<boolean>;
  stop(): void;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Escalation {
  plays: number;
  timer: unknown;
}

export interface AlertSoundOptions {
  escalation: SoundPlayer;
  reminder: SoundPlayer;
  scheduler?: Scheduler;
  repeatMs?: number;
  maxRepeats?: number;
  /** Called when the browser refused to play (audio blocked again): the page shows the unlock banner. */
  onBlocked?: () => void;
}

const browserScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

const isLiveCritical = (a: Alert) => a.severity === 'critical' && a.status === 'open';

export class AlertSoundController {
  private enabled = false;
  private readonly seen = new Set<string>();
  private readonly escalations = new Map<string, Escalation>();
  private sounding: { kind: 'escalation' | 'reminder'; alertId: string } | null = null;
  /** The last list received; null until the first refresh (the first list never plays a reminder). */
  private latest: readonly Alert[] | null = null;
  private readonly scheduler: Scheduler;
  private readonly repeatMs: number;
  private readonly maxRepeats: number;

  constructor(private readonly opts: AlertSoundOptions) {
    this.scheduler = opts.scheduler ?? browserScheduler;
    this.repeatMs = opts.repeatMs ?? ESCALATION_REPEAT_MS;
    this.maxRepeats = opts.maxRepeats ?? ESCALATION_MAX_REPEATS;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Alert id whose escalation is currently repeating (for tests and the UI). */
  get escalating(): string[] {
    return [...this.escalations.keys()];
  }

  /** After the unlock tap: open critical alerts start escalating now. */
  enable(): void {
    this.enabled = true;
    if (this.latest) this.sync(this.latest);
  }

  disable(): void {
    this.enabled = false;
    this.stopAll();
  }

  /**
   * Called with the current alert list on every refresh. The first call only records what already exists
   * (no reminder for old warnings); open critical alerts escalate as soon as audio is enabled.
   */
  sync(alerts: readonly Alert[]): void {
    const primed = this.latest !== null;
    this.latest = alerts;
    const live = new Map(alerts.filter(isLiveCritical).map((a) => [a.id, a]));

    // stop what was acknowledged, resolved or disappeared
    for (const [id, esc] of this.escalations) {
      if (live.has(id)) continue;
      this.scheduler.clearTimeout(esc.timer);
      this.escalations.delete(id);
      if (this.sounding?.kind === 'escalation' && this.sounding.alertId === id) this.silence();
    }
    if (this.sounding?.kind === 'escalation' && !live.has(this.sounding.alertId)) this.silence();

    if (this.enabled) {
      for (const a of live.values()) if (!this.escalations.has(a.id)) this.startEscalation(a.id);
      if (primed) {
        const fresh = alerts.find(
          (a) => a.severity === 'warning' && a.status === 'open' && !this.seen.has(a.id),
        );
        if (fresh && this.escalations.size === 0) void this.play('reminder', fresh.id);
      }
    }
    for (const a of alerts) this.seen.add(a.id);
  }

  stopAll(): void {
    for (const esc of this.escalations.values()) this.scheduler.clearTimeout(esc.timer);
    this.escalations.clear();
    this.silence();
  }

  private startEscalation(alertId: string): void {
    const esc: Escalation = { plays: 0, timer: null };
    this.escalations.set(alertId, esc);
    const ring = () => {
      if (!this.escalations.has(alertId) || !this.enabled) return;
      esc.plays += 1;
      void this.play('escalation', alertId);
      // the first play plus at most `maxRepeats` repeats
      if (esc.plays <= this.maxRepeats) esc.timer = this.scheduler.setTimeout(ring, this.repeatMs);
      else esc.timer = null;
    };
    ring();
  }

  private silence(): void {
    if (!this.sounding) return;
    (this.sounding.kind === 'escalation' ? this.opts.escalation : this.opts.reminder).stop();
    this.sounding = null;
  }

  private async play(kind: 'escalation' | 'reminder', alertId: string): Promise<void> {
    if (kind === 'reminder' && this.sounding?.kind === 'escalation') return; // escalation has priority
    if (this.sounding && this.sounding.kind !== kind) this.silence();
    this.sounding = { kind, alertId };
    const ok = await (kind === 'escalation' ? this.opts.escalation : this.opts.reminder).play();
    if (!ok) {
      this.sounding = null;
      this.enabled = false;
      this.stopAll();
      this.opts.onBlocked?.();
    }
  }
}

/**
 * `HTMLAudioElement` player for a file copied from brand/sounds (canon §13) into public/sounds.
 * `prime()` must run inside the unlock tap: it plays the element once, muted, so browsers that unlock audio
 * per element (iOS Safari) let it play later from a timer. A real `play()` waits for that to finish.
 */
export function htmlAudioPlayer(src: string): SoundPlayer & { prime(): Promise<void> } {
  let el: HTMLAudioElement | null = null;
  let priming: Promise<void> | null = null;
  const element = () => {
    if (!el) {
      el = new Audio(src);
      el.preload = 'auto';
    }
    return el;
  };
  return {
    prime: () => {
      if (priming) return priming;
      const a = element();
      a.muted = true;
      priming = a
        .play()
        .then(
          () => {
            a.pause();
            a.currentTime = 0;
          },
          () => undefined,
        )
        .finally(() => {
          a.muted = false;
        });
      return priming;
    },
    play: async () => {
      const a = element();
      if (priming) await priming;
      try {
        a.muted = false;
        a.currentTime = 0;
        await a.play();
        return true;
      } catch {
        return false;
      }
    },
    stop: () => {
      if (!el) return;
      el.pause();
      el.currentTime = 0;
    },
  };
}

/** Sound files (canon §13; copied byte-identical by scripts/sync-brand.mjs). */
export const SOUND_FILES = {
  escalation: '/sounds/point-escalation.mp3',
  reminder: '/sounds/point-reminder.mp3',
  test: '/sounds/point-test.mp3',
} as const;

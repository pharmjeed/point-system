import type { MediaKind, ParkingMode, PaymentMethod, PricingMode, VenueSettings } from '@/api/types';

/** Venue settings with every key present (canon §12). */
export interface FullVenueSettings {
  dispatch: {
    single_offer_reminder_s: number;
    single_offer_ttl_s: number;
    broadcast_reminder_s: number;
    unaccepted_escalation_s: number;
    next_task_wait_alert_s: number;
    idle_driver_alert: boolean;
    accept_grace_ms: number;
    offline_drivers_last: boolean;
  };
  intake: { draft_abandoned_alert_min: number };
  handover: { code_ttl_min: number; max_attempts: number; max_resends: number };
  ready: { uncollected_alert_min: number };
  inspection: { required_photos: MediaKind[]; max_extra_photos: number };
  link: { qr_ttl_min: number };
  parking: { mode: ParkingMode };
  keys: { require_slot: boolean };
  pricing: { default_mode: PricingMode; default_fee_halalas: number; allowed_methods: PaymentMethod[] };
}

/**
 * The defaults of canon §12 — the same values as `VENUE_SETTINGS_DEFAULTS` in @point/shared (checked by
 * test/venueDefaults.test.ts). The server is the judge; the UI uses them where a reply leaves a key out and
 * on driver screens that cannot read the settings (`venue.read` is not a driver permission, canon §10).
 */
export const VENUE_DEFAULTS: Readonly<FullVenueSettings> = Object.freeze<FullVenueSettings>({
  dispatch: {
    single_offer_reminder_s: 15,
    single_offer_ttl_s: 30,
    broadcast_reminder_s: 30,
    unaccepted_escalation_s: 60,
    next_task_wait_alert_s: 300,
    idle_driver_alert: true,
    accept_grace_ms: 1500,
    offline_drivers_last: false,
  },
  intake: { draft_abandoned_alert_min: 10 },
  handover: { code_ttl_min: 30, max_attempts: 5, max_resends: 3 },
  ready: { uncollected_alert_min: 10 },
  inspection: {
    required_photos: ['photo_front', 'photo_rear', 'photo_left', 'photo_right'],
    max_extra_photos: 8,
  },
  link: { qr_ttl_min: 10 },
  parking: { mode: 'mixed' },
  keys: { require_slot: true },
  pricing: { default_mode: 'included', default_fee_halalas: 0, allowed_methods: ['cash', 'pos'] },
});

/** Every group and key present: the reply's values over the defaults (a fresh copy). */
export function withDefaults(settings: VenueSettings | undefined | null): FullVenueSettings {
  const out = structuredClone(VENUE_DEFAULTS) as FullVenueSettings;
  const target = out as unknown as Record<string, Record<string, unknown>>;
  for (const [group, values] of Object.entries(settings ?? {})) {
    const into = target[group];
    if (!into || !values || typeof values !== 'object') continue;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (value !== undefined) into[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

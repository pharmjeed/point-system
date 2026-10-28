/**
 * The fake backend starts from the development seed of docs/17 §4 (packages/db/src/seed: ids, fixtures and
 * dev credentials — files without runtime dependencies), so an e2e scenario written against the fake uses
 * the same actors (DRV1 «سائق 1», SUP-R «مشرف ريماس» …), venues (RMS, LYL), PINs and passwords as a run
 * against a real API seeded with `pnpm db:seed` (PNT-036).
 */
import { SEED_CREDENTIALS } from '../../../../../packages/db/src/seed/credentials';
import {
  SEED_EVENT_DATE,
  SEED_EVENTS,
  SEED_KEY_BOARDS,
  SEED_NOW,
  SEED_SHIFTS,
  SEED_USERS,
  SEED_VENUES,
  SEED_ZONES,
} from '../../../../../packages/db/src/seed/fixtures';
import {
  SEED_IDS,
  seedKeySlotId,
  seedSpotId,
  seedSpotLabel,
  type SeedEventKey,
  type SeedUserKey,
  type SeedVenueKey,
} from '../../../../../packages/db/src/seed/ids';
import type { World } from './model';

export { SEED_CREDENTIALS, SEED_IDS };
export type { SeedEventKey, SeedUserKey, SeedVenueKey };

export interface SeedOptions {
  /** Zones, spots, key boards and slots of 17 §4 (default true); false = venues with no layout. */
  layout?: boolean;
  /** Which seeded events exist (default all three, open). */
  events?: SeedEventKey[];
  /** Whether the two seeded shifts exist and are open (default true). */
  shifts?: boolean;
}

export function seedWorld(options: SeedOptions = {}): World {
  const layout = options.layout ?? true;
  const eventKeys = options.events ?? (SEED_EVENTS.map((e) => e.key) as SeedEventKey[]);
  const world: World = {
    users: [],
    assignments: [],
    venues: [],
    pools: [],
    zones: [],
    spots: [],
    boards: [],
    slots: [],
    events: [],
    shifts: [],
    duties: [],
    tickets: [],
    cycles: [],
    tasks: [],
    offers: [],
    media: [],
    payments: [],
    custody: [],
  };
  for (const v of SEED_VENUES) {
    world.venues.push({
      id: v.id,
      code: v.code,
      name_ar: v.nameAr,
      name_en: v.nameEn,
      address: null,
      city: null,
      timezone: 'Asia/Riyadh',
      status: 'active',
      default_dispatch_pool_id: v.pool.id,
      version: 1,
      settings: {},
      settings_version: 1,
      created_at: SEED_NOW,
    });
    world.pools.push({
      id: v.pool.id,
      venue_id: v.id,
      name: v.pool.name,
      is_default: true,
      status: 'active',
      created_at: SEED_NOW,
    });
  }
  if (layout) {
    for (const z of SEED_ZONES) {
      const venueId = SEED_IDS.venues[z.venue];
      world.zones.push({
        id: z.id,
        venue_id: venueId,
        name: z.name,
        sort_order: z.sortOrder,
        status: 'active',
      });
      for (let n = 1; n <= z.spots; n += 1) {
        const label = seedSpotLabel(z.key, n);
        world.spots.push({
          id: seedSpotId(label),
          venue_id: venueId,
          zone_id: z.id,
          label,
          status: 'active',
          ticket_id: null,
        });
      }
    }
    for (const b of SEED_KEY_BOARDS) {
      const venueId = SEED_IDS.venues[b.venue];
      world.boards.push({ id: b.id, venue_id: venueId, name: b.name, status: 'active' });
      for (let n = 1; n <= b.slots; n += 1) {
        world.slots.push({
          id: seedKeySlotId(b.venue, n),
          venue_id: venueId,
          key_board_id: b.id,
          label: String(n),
          status: 'active',
          ticket_id: null,
        });
      }
    }
  }
  for (const u of SEED_USERS) {
    world.users.push({
      id: u.id,
      key: u.key,
      role: u.role,
      employee_code: u.employeeCode,
      full_name: u.fullName,
      phone_e164: u.phone,
      secret: SEED_CREDENTIALS[u.key].secret,
      can_drive: u.canDrive,
      status: 'active',
      must_change_secret: false,
      disabled_reason: null,
      disabled_at: null,
      scopes: u.scopes.map((s) => (s === 'org' ? 'org' : SEED_IDS.venues[s])),
      version: 1,
      created_at: SEED_NOW,
    });
    if (u.assignmentVenue) {
      world.assignments.push({
        id: SEED_IDS.assignments[u.key as keyof typeof SEED_IDS.assignments],
        driver_id: u.id,
        venue_id: SEED_IDS.venues[u.assignmentVenue],
        status: 'active',
        starts_at: SEED_NOW,
        ends_at: null,
        reason: null,
      });
    }
  }
  for (const e of SEED_EVENTS) {
    if (!eventKeys.includes(e.key)) continue;
    world.events.push({
      id: e.id,
      venue_id: SEED_IDS.venues[e.venue],
      dispatch_pool_id: SEED_IDS.defaultPoolByVenue[e.venue],
      name_ar: e.nameAr,
      host_name: null,
      event_date: SEED_EVENT_DATE,
      starts_at: null,
      ends_at: null,
      status: 'open',
      pricing_mode: e.pricingMode,
      fee_halalas: e.feeHalalas,
      allowed_payment_methods: [...e.allowedPaymentMethods],
      opened_at: SEED_NOW,
      canceled_at: null,
      cancel_reason: null,
      next_display_number: 1,
      version: 1,
      created_at: SEED_NOW,
    });
  }
  if (options.shifts ?? true) {
    for (const s of SEED_SHIFTS) {
      world.shifts.push({
        id: s.id,
        venue_id: SEED_IDS.venues[s.venue],
        dispatch_pool_id: SEED_IDS.defaultPoolByVenue[s.venue],
        name: s.name,
        starts_at: SEED_NOW,
        ends_at: null,
        status: 'open',
        opened_at: SEED_NOW,
        closed_at: null,
        version: 1,
      });
    }
  }
  return world;
}

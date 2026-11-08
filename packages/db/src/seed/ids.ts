// Fixed, readable identifiers of the development/test seed (PNT-010, docs/17 §4).
//
// Tests across the codebase import these constants: the names and values are stable API.
// Never renumber an existing id; add new ones with a new index instead.
//
// Format: 00000000-0000-4000-8000-KKKKAAAABBBB (valid RFC 9562 v4 layout)
//   KKKK = entity kind (table), AAAA/BBBB = readable indexes (decimal digits inside the hex field).
//   0001 organizations · 0002 venues · 0003 dispatch_pools · 0004 users · 0005 role_scopes
//   0006 driver_assignments · 0007 events · 0008 shifts · 0009 customers · 000a parking_zones
//   000b parking_spots (AAAA = zone index, BBBB = spot number) · 000c key_boards
//   000d key_slots (AAAA = board index, BBBB = slot number) · 000e whatsapp_channel
// This file has no runtime dependencies so that unit tests and the web app can import it cheaply.

const PREFIX = '00000000-0000-4000-8000-';

function seedId(kind: string, a: number, b: number): string {
  return `${PREFIX}${kind}${String(a).padStart(4, '0')}${String(b).padStart(4, '0')}`;
}

export type SeedVenueKey = 'RMS' | 'LYL';
export type SeedPoolKey = 'POOL-R' | 'POOL-L';
export type SeedZoneKey = 'A' | 'B' | 'P1';
export type SeedDriverKey = 'DRV1' | 'DRV2' | 'DRV3' | 'DRV4' | 'DRV5' | 'DRV6' | 'DRV7' | 'DRV8';
export type SeedStaffKey = 'OWN1' | 'ADM1' | 'SUP-R' | 'SUP-RL' | 'SUP-RD';
export type SeedUserKey = SeedStaffKey | SeedDriverKey;
export type SeedEventKey = 'EVT-R1' | 'EVT-R2' | 'EVT-L1';
export type SeedShiftKey = 'SHF-R' | 'SHF-L';
export type SeedCustomerKey = 'CUS1' | 'CUS2' | 'CUS3';

/** Zone layout of 17 §4: zone → venue, readable index, number of spots (labels `<zone>-01` …). */
export const SEED_ZONE_LAYOUT = {
  A: { venue: 'RMS', index: 1, spots: 30 },
  B: { venue: 'RMS', index: 2, spots: 30 },
  P1: { venue: 'LYL', index: 3, spots: 20 },
} as const satisfies Record<SeedZoneKey, { venue: SeedVenueKey; index: number; spots: number }>;

/** Key board layout of 17 §4: one board «لوحة 1» per venue with slots labelled `1` … `n`. */
export const SEED_KEY_BOARD_LAYOUT = {
  RMS: { index: 1, slots: 60 },
  LYL: { index: 2, slots: 40 },
} as const satisfies Record<SeedVenueKey, { index: number; slots: number }>;

/** Spot label as stored in `parking_spots.label`, e.g. `A-07`, `P1-20`. */
export function seedSpotLabel(zone: SeedZoneKey, n: number): string {
  return `${zone}-${String(n).padStart(2, '0')}`;
}

/** Id of a seeded parking spot by its label (`A-01` … `A-30`, `B-01` … `B-30`, `P1-01` … `P1-20`). */
export function seedSpotId(label: string): string {
  const m = /^(A|B|P1)-(\d{2})$/.exec(label);
  const zone = m?.[1] as SeedZoneKey | undefined;
  const n = Number(m?.[2]);
  if (!zone || !(n >= 1 && n <= SEED_ZONE_LAYOUT[zone].spots)) {
    throw new Error(`seedSpotId: unknown seeded spot label ${JSON.stringify(label)}`);
  }
  return seedId('000b', SEED_ZONE_LAYOUT[zone].index, n);
}

/** Id of a seeded key slot (`key_slots.label` `1` … `60` in RMS, `1` … `40` in LYL). */
export function seedKeySlotId(venue: SeedVenueKey, label: string | number): string {
  const text = String(label);
  const n = Number(text);
  const board = SEED_KEY_BOARD_LAYOUT[venue];
  if (!/^[1-9]\d*$/.test(text) || n > board.slots) {
    throw new Error(`seedKeySlotId: unknown seeded key slot ${venue}/${JSON.stringify(label)}`);
  }
  return seedId('000d', board.index, n);
}

function spotIds(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const zone of Object.keys(SEED_ZONE_LAYOUT) as SeedZoneKey[]) {
    for (let n = 1; n <= SEED_ZONE_LAYOUT[zone].spots; n++) {
      out[seedSpotLabel(zone, n)] = seedSpotId(seedSpotLabel(zone, n));
    }
  }
  return Object.freeze(out);
}

function keySlotIds(venue: SeedVenueKey): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let n = 1; n <= SEED_KEY_BOARD_LAYOUT[venue].slots; n++) out[String(n)] = seedKeySlotId(venue, n);
  return Object.freeze(out);
}

export const SEED_IDS = {
  /** ORG1 «مؤسسة الفاليت التجريبية» */
  org: '00000000-0000-4000-8000-000100000001',
  venues: {
    RMS: '00000000-0000-4000-8000-000200000001',
    LYL: '00000000-0000-4000-8000-000200000002',
  },
  /** Default dispatch pool of each venue (17 §4: POOL-R, POOL-L). */
  pools: {
    'POOL-R': '00000000-0000-4000-8000-000300000001',
    'POOL-L': '00000000-0000-4000-8000-000300000002',
  },
  /** Same pools keyed by venue code. */
  defaultPoolByVenue: {
    RMS: '00000000-0000-4000-8000-000300000001',
    LYL: '00000000-0000-4000-8000-000300000002',
  },
  users: {
    OWN1: '00000000-0000-4000-8000-000400000001',
    ADM1: '00000000-0000-4000-8000-000400000002',
    'SUP-R': '00000000-0000-4000-8000-000400000011',
    'SUP-RL': '00000000-0000-4000-8000-000400000012',
    'SUP-RD': '00000000-0000-4000-8000-000400000013',
    DRV1: '00000000-0000-4000-8000-000400000101',
    DRV2: '00000000-0000-4000-8000-000400000102',
    DRV3: '00000000-0000-4000-8000-000400000103',
    DRV4: '00000000-0000-4000-8000-000400000104',
    DRV5: '00000000-0000-4000-8000-000400000105',
    DRV6: '00000000-0000-4000-8000-000400000106',
    DRV7: '00000000-0000-4000-8000-000400000107',
    DRV8: '00000000-0000-4000-8000-000400000108',
  },
  /** Active `role_scopes` rows: org scope for OWN1/ADM1, venue scopes for supervisors. */
  roleScopes: {
    OWN1: { org: '00000000-0000-4000-8000-000500000001' },
    ADM1: { org: '00000000-0000-4000-8000-000500000002' },
    'SUP-R': { RMS: '00000000-0000-4000-8000-000500000011' },
    'SUP-RL': {
      RMS: '00000000-0000-4000-8000-000500000012',
      LYL: '00000000-0000-4000-8000-000500000013',
    },
    'SUP-RD': { RMS: '00000000-0000-4000-8000-000500000014' },
  },
  /** Active `driver_assignments` row of each driver (DRV1…DRV6 → RMS, DRV7/DRV8 → LYL). */
  assignments: {
    DRV1: '00000000-0000-4000-8000-000600000101',
    DRV2: '00000000-0000-4000-8000-000600000102',
    DRV3: '00000000-0000-4000-8000-000600000103',
    DRV4: '00000000-0000-4000-8000-000600000104',
    DRV5: '00000000-0000-4000-8000-000600000105',
    DRV6: '00000000-0000-4000-8000-000600000106',
    DRV7: '00000000-0000-4000-8000-000600000107',
    DRV8: '00000000-0000-4000-8000-000600000108',
  },
  events: {
    'EVT-R1': '00000000-0000-4000-8000-000700000001',
    'EVT-R2': '00000000-0000-4000-8000-000700000002',
    'EVT-L1': '00000000-0000-4000-8000-000700000003',
  },
  shifts: {
    'SHF-R': '00000000-0000-4000-8000-000800000001',
    'SHF-L': '00000000-0000-4000-8000-000800000002',
  },
  customers: {
    CUS1: '00000000-0000-4000-8000-000900000001',
    CUS2: '00000000-0000-4000-8000-000900000002',
    CUS3: '00000000-0000-4000-8000-000900000003',
  },
  zones: {
    RMS: {
      A: '00000000-0000-4000-8000-000a00000001',
      B: '00000000-0000-4000-8000-000a00000002',
    },
    LYL: {
      P1: '00000000-0000-4000-8000-000a00000003',
    },
  },
  /** Parking spot id by label (`A-01` …). Prefer `seedSpotId(label)`: it returns `string`, not `string | undefined`. */
  spots: spotIds(),
  keyBoards: {
    RMS: '00000000-0000-4000-8000-000c00000001',
    LYL: '00000000-0000-4000-8000-000c00000002',
  },
  /** Key slot id by venue and label (`'1'` …). Prefer `seedKeySlotId(venue, label)`. */
  keySlots: {
    RMS: keySlotIds('RMS'),
    LYL: keySlotIds('LYL'),
  },
  /** WA-CH: the single active WhatsApp channel (simulator mode). */
  whatsappChannel: '00000000-0000-4000-8000-000e00000001',
} as const;

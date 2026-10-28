// Business content of the development/test seed — docs/17_Test_Acceptance_Plan.md §4 (PNT-010).
// Values that 17 §4 states are copied literally (marked «17 §4»). Everything else (phones, employee
// codes, names, timestamps, channel identifiers) is a seed convention documented in
// docs/progress/notes/pnt-010.md. No runtime dependencies.
import {
  SEED_IDS,
  SEED_KEY_BOARD_LAYOUT,
  SEED_ZONE_LAYOUT,
  type SeedCustomerKey,
  type SeedEventKey,
  type SeedPoolKey,
  type SeedShiftKey,
  type SeedUserKey,
  type SeedVenueKey,
  type SeedZoneKey,
} from './ids.js';

/** Fixed timestamp written into every seeded time column (18:00 Asia/Riyadh). Tests should start their FakeClock after it. */
export const SEED_NOW = '2026-10-27T15:00:00.000Z';
/** Local (Asia/Riyadh) date of the seeded events. */
export const SEED_EVENT_DATE = '2026-10-27';

/** ORG1 — 17 §4. `settings` stay `{}`: absent keys take the canon §12 defaults in the application (06 ERD). */
export const SEED_ORG = {
  key: 'ORG1',
  id: SEED_IDS.org,
  nameAr: 'مؤسسة الفاليت التجريبية', // 17 §4
  nameEn: 'Valet Test Organization',
} as const;

export interface SeedVenue {
  key: SeedVenueKey;
  id: string;
  code: SeedVenueKey;
  nameAr: string;
  nameEn: string;
  pool: { key: SeedPoolKey; id: string; name: string };
}

export const SEED_VENUES: readonly SeedVenue[] = [
  {
    key: 'RMS',
    id: SEED_IDS.venues.RMS,
    code: 'RMS', // 17 §4
    nameAr: 'قاعة ريماس', // 17 §4
    nameEn: 'Rimas Hall',
    pool: { key: 'POOL-R', id: SEED_IDS.pools['POOL-R'], name: 'الافتراضية' },
  },
  {
    key: 'LYL',
    id: SEED_IDS.venues.LYL,
    code: 'LYL', // 17 §4
    nameAr: 'قاعة ليلتي', // 17 §4
    nameEn: 'Laylati Hall',
    pool: { key: 'POOL-L', id: SEED_IDS.pools['POOL-L'], name: 'الافتراضية' },
  },
];

export interface SeedZone {
  key: SeedZoneKey;
  id: string;
  venue: SeedVenueKey;
  name: string;
  sortOrder: number;
  spots: number;
}

// 17 §4: RMS zone A (A-01 … A-30) and zone B (B-01 … B-30); LYL zone P1 (P1-01 … P1-20).
export const SEED_ZONES: readonly SeedZone[] = [
  {
    key: 'A',
    id: SEED_IDS.zones.RMS.A,
    venue: 'RMS',
    name: 'A',
    sortOrder: 1,
    spots: SEED_ZONE_LAYOUT.A.spots,
  },
  {
    key: 'B',
    id: SEED_IDS.zones.RMS.B,
    venue: 'RMS',
    name: 'B',
    sortOrder: 2,
    spots: SEED_ZONE_LAYOUT.B.spots,
  },
  {
    key: 'P1',
    id: SEED_IDS.zones.LYL.P1,
    venue: 'LYL',
    name: 'P1',
    sortOrder: 1,
    spots: SEED_ZONE_LAYOUT.P1.spots,
  },
];

// 17 §4: «لوحة 1» with slots 1 … 60 (RMS) and 1 … 40 (LYL).
export const SEED_KEY_BOARDS: readonly { venue: SeedVenueKey; id: string; name: string; slots: number }[] = [
  { venue: 'RMS', id: SEED_IDS.keyBoards.RMS, name: 'لوحة 1', slots: SEED_KEY_BOARD_LAYOUT.RMS.slots },
  { venue: 'LYL', id: SEED_IDS.keyBoards.LYL, name: 'لوحة 1', slots: SEED_KEY_BOARD_LAYOUT.LYL.slots },
];

export type SeedRole = 'owner' | 'admin' | 'supervisor' | 'driver';

export interface SeedUser {
  key: SeedUserKey;
  id: string;
  role: SeedRole;
  employeeCode: string;
  fullName: string;
  phone: string;
  canDrive: boolean;
  mfaEnabled: boolean;
  /** `org` → one active org scope; venue codes → one active venue scope each (role_scopes). */
  scopes: readonly ('org' | SeedVenueKey)[];
  /** Venue of the driver's active driver_assignments row. */
  assignmentVenue?: SeedVenueKey;
}

// Roles, MFA, scopes, can_drive and assignments: 17 §4. Phones avoid the simulator fault suffixes
// 0000/1111/2222 (12 §11.3) and the customer numbers.
export const SEED_USERS: readonly SeedUser[] = [
  {
    key: 'OWN1',
    id: SEED_IDS.users.OWN1,
    role: 'owner',
    employeeCode: 'O-0001',
    fullName: 'المالك التجريبي',
    phone: '+966500000101',
    canDrive: false,
    mfaEnabled: true,
    scopes: ['org'],
  },
  {
    key: 'ADM1',
    id: SEED_IDS.users.ADM1,
    role: 'admin',
    employeeCode: 'A-0001',
    fullName: 'الإدارة التجريبية',
    phone: '+966500000102',
    canDrive: false,
    mfaEnabled: true,
    scopes: ['org'],
  },
  {
    key: 'SUP-R',
    id: SEED_IDS.users['SUP-R'],
    role: 'supervisor',
    employeeCode: 'S-0001',
    fullName: 'مشرف ريماس',
    phone: '+966500000201',
    canDrive: false,
    mfaEnabled: false,
    scopes: ['RMS'],
  },
  {
    key: 'SUP-RL',
    id: SEED_IDS.users['SUP-RL'],
    role: 'supervisor',
    employeeCode: 'S-0002',
    fullName: 'مشرف ريماس وليلتي',
    phone: '+966500000202',
    canDrive: false,
    mfaEnabled: false,
    scopes: ['RMS', 'LYL'],
  },
  {
    key: 'SUP-RD',
    id: SEED_IDS.users['SUP-RD'],
    role: 'supervisor',
    employeeCode: 'S-0003',
    fullName: 'مشرف قائد ريماس',
    phone: '+966500000203',
    canDrive: true,
    mfaEnabled: false,
    scopes: ['RMS'],
  },
  {
    key: 'DRV1',
    id: SEED_IDS.users.DRV1,
    role: 'driver',
    employeeCode: 'D-0001',
    fullName: 'سائق 1',
    phone: '+966500000301',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV2',
    id: SEED_IDS.users.DRV2,
    role: 'driver',
    employeeCode: 'D-0002',
    fullName: 'سائق 2',
    phone: '+966500000302',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV3',
    id: SEED_IDS.users.DRV3,
    role: 'driver',
    employeeCode: 'D-0003',
    fullName: 'سائق 3',
    phone: '+966500000303',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV4',
    id: SEED_IDS.users.DRV4,
    role: 'driver',
    employeeCode: 'D-0004',
    fullName: 'سائق 4',
    phone: '+966500000304',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV5',
    id: SEED_IDS.users.DRV5,
    role: 'driver',
    employeeCode: 'D-0005',
    fullName: 'سائق 5',
    phone: '+966500000305',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV6',
    id: SEED_IDS.users.DRV6,
    role: 'driver',
    employeeCode: 'D-0006',
    fullName: 'سائق 6',
    phone: '+966500000306',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'RMS',
  },
  {
    key: 'DRV7',
    id: SEED_IDS.users.DRV7,
    role: 'driver',
    employeeCode: 'D-0007',
    fullName: 'سائق 7',
    phone: '+966500000307',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'LYL',
  },
  {
    key: 'DRV8',
    id: SEED_IDS.users.DRV8,
    role: 'driver',
    employeeCode: 'D-0008',
    fullName: 'سائق 8',
    phone: '+966500000308',
    canDrive: false,
    mfaEnabled: false,
    scopes: [],
    assignmentVenue: 'LYL',
  },
];

export interface SeedEvent {
  key: SeedEventKey;
  id: string;
  venue: SeedVenueKey;
  nameAr: string;
  pricingMode: 'included' | 'per_vehicle';
  feeHalalas: number;
  allowedPaymentMethods: readonly ('cash' | 'pos')[];
}

// 17 §4: all three events are open; EVT-R2 is per_vehicle with fee_halalas = 2000 and methods cash + pos.
export const SEED_EVENTS: readonly SeedEvent[] = [
  {
    key: 'EVT-R1',
    id: SEED_IDS.events['EVT-R1'],
    venue: 'RMS',
    nameAr: 'حفل تجريبي — ريماس 1',
    pricingMode: 'included',
    feeHalalas: 0,
    allowedPaymentMethods: ['cash', 'pos'],
  },
  {
    key: 'EVT-R2',
    id: SEED_IDS.events['EVT-R2'],
    venue: 'RMS',
    nameAr: 'حفل تجريبي — ريماس 2',
    pricingMode: 'per_vehicle',
    feeHalalas: 2000,
    allowedPaymentMethods: ['cash', 'pos'],
  },
  {
    key: 'EVT-L1',
    id: SEED_IDS.events['EVT-L1'],
    venue: 'LYL',
    nameAr: 'حفل تجريبي — ليلتي 1',
    pricingMode: 'included',
    feeHalalas: 0,
    allowedPaymentMethods: ['cash', 'pos'],
  },
];

// 17 §4: one open shift per (default) pool.
export const SEED_SHIFTS: readonly { key: SeedShiftKey; id: string; venue: SeedVenueKey; name: string }[] = [
  { key: 'SHF-R', id: SEED_IDS.shifts['SHF-R'], venue: 'RMS', name: 'وردية ريماس' },
  { key: 'SHF-L', id: SEED_IDS.shifts['SHF-L'], venue: 'LYL', name: 'وردية ليلتي' },
];

// 17 §4 phones. `wa_id` = the phone without «+» (the WhatsApp ID the simulator sends for these numbers).
export const SEED_CUSTOMERS: readonly { key: SeedCustomerKey; id: string; phone: string; waId: string }[] = [
  { key: 'CUS1', id: SEED_IDS.customers.CUS1, phone: '+966551234567', waId: '966551234567' },
  { key: 'CUS2', id: SEED_IDS.customers.CUS2, phone: '+966559876543', waId: '966559876543' },
  { key: 'CUS3', id: SEED_IDS.customers.CUS3, phone: '+966500001234', waId: '966500001234' },
];

/**
 * WA-CH — 17 §4: `mode = simulator`, exactly one `phone_number_id`. Secret columns hold references
 * (05 §8 `env://…`), never values. `display_name` is left to the schema default unless
 * `BRAND_CUSTOMER_NAME_AR` is set (brand names come from configuration, canon §1).
 */
export const SEED_WHATSAPP_CHANNEL = {
  key: 'WA-CH',
  id: SEED_IDS.whatsappChannel,
  businessAccountId: 'SIM-WABA',
  phoneNumberId: 'SIM-PHONE',
  accessTokenSecretRef: 'env://WA_ACCESS_TOKEN',
  appSecretRef: 'env://WA_APP_SECRET',
  verifyTokenSecretRef: 'env://WA_VERIFY_TOKEN',
  apiVersion: 'v26.0',
  mode: 'simulator',
} as const;

/**
 * The three test vehicles of 17 §4. They are NOT seeded rows (17 §4 type «—»): builders pass them to
 * the real intake commands. Field names follow the `tickets` vehicle columns.
 */
export const SEED_VEHICLES = {
  CAMRY: {
    description: 'تويوتا كامري بيضاء 1234 ب ح د',
    vehicle_make: 'تويوتا',
    vehicle_model: 'كامري',
    vehicle_color: 'بيضاء',
    vehicle_type: 'sedan',
    plate_country: 'SA',
    plate_digits: '1234',
    plate_letters_ar: 'ب ح د',
    plate_letters_en: 'B J D',
  },
  TAHOE: {
    description: 'شفروليه تاهو سوداء 5678 ر س ص',
    vehicle_make: 'شفروليه',
    vehicle_model: 'تاهو',
    vehicle_color: 'سوداء',
    vehicle_type: 'suv',
    plate_country: 'SA',
    plate_digits: '5678',
    plate_letters_ar: 'ر س ص',
    plate_letters_en: 'R S X',
  },
  SONATA: {
    description: 'هيونداي سوناتا رمادية 910 ط ع ق',
    vehicle_make: 'هيونداي',
    vehicle_model: 'سوناتا',
    vehicle_color: 'رمادية',
    vehicle_type: 'sedan',
    plate_country: 'SA',
    plate_digits: '910',
    plate_letters_ar: 'ط ع ق',
    plate_letters_en: 'T E G',
  },
} as const;

/** Row counts the seed produces per table (also asserted by packages/db/test/seed.int.test.ts). */
export const SEED_TABLE_COUNTS = {
  organizations: 1,
  venues: 2,
  dispatch_pools: 2,
  users: 13,
  role_scopes: 6,
  driver_assignments: 8,
  events: 3,
  shifts: 2,
  customers: 3,
  parking_zones: 3,
  parking_spots: 80,
  key_boards: 2,
  key_slots: 100,
  whatsapp_channel: 1,
} as const;

export type SeedTable = keyof typeof SEED_TABLE_COUNTS;

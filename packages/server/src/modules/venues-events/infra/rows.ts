import type { EventStatus, PaymentMethod, PricingMode, SetupStatus } from '@point/shared';

/**
 * Rows of the venue-setup and event tables and their wire shapes (07_openapi components `Venue`, `DispatchPool`,
 * `ParkingZone`, `ParkingSpot`, `KeyBoard`, `KeySlot`, `VenueEvent`). Wire data is snake_case; times are ISO-8601
 * UTC; `event_date` is the local date `YYYY-MM-DD` (read as text, never as a Date).
 */

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

// ---------------------------------------------------------------------------------------------
// venues
// ---------------------------------------------------------------------------------------------

export const VENUE_COLUMNS = `v.id, v.org_id, v.code, v.name_ar, v.name_en, v.address, v.city, v.timezone, v.status,
  v.settings, v.version, v.created_at,
  (SELECT dp.id FROM dispatch_pools dp WHERE dp.venue_id = v.id AND dp.is_default) AS default_dispatch_pool_id`;

export interface VenueRow {
  id: string;
  org_id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  address: string | null;
  city: string | null;
  timezone: string;
  status: SetupStatus;
  settings: unknown;
  version: number;
  created_at: Date;
  default_dispatch_pool_id: string | null;
}

export interface VenueDto {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  address: string | null;
  city: string | null;
  timezone: string;
  status: SetupStatus;
  default_dispatch_pool_id: string | null;
  version: number;
  created_at: string | null;
}

export function toVenue(r: VenueRow): VenueDto {
  return {
    id: r.id,
    code: r.code,
    name_ar: r.name_ar,
    name_en: r.name_en,
    address: r.address,
    city: r.city,
    timezone: r.timezone,
    status: r.status,
    default_dispatch_pool_id: r.default_dispatch_pool_id,
    version: r.version,
    created_at: iso(r.created_at),
  };
}

// ---------------------------------------------------------------------------------------------
// dispatch_pools
// ---------------------------------------------------------------------------------------------

export interface DispatchPoolRow {
  id: string;
  org_id: string;
  venue_id: string;
  name: string;
  is_default: boolean;
  status: SetupStatus;
  created_at: Date;
}

export interface DispatchPoolDto {
  id: string;
  venue_id: string;
  name: string;
  is_default: boolean;
  status: SetupStatus;
  created_at: string | null;
}

export function toDispatchPool(r: DispatchPoolRow): DispatchPoolDto {
  return {
    id: r.id,
    venue_id: r.venue_id,
    name: r.name,
    is_default: r.is_default,
    status: r.status,
    created_at: iso(r.created_at),
  };
}

// ---------------------------------------------------------------------------------------------
// parking_zones · parking_spots · key_boards · key_slots
// ---------------------------------------------------------------------------------------------

export interface ParkingZoneRow {
  id: string;
  org_id: string;
  venue_id: string;
  name: string;
  sort_order: number;
  status: SetupStatus;
}

export interface ParkingZoneDto {
  id: string;
  venue_id: string;
  name: string;
  sort_order: number;
  status: SetupStatus;
}

export function toParkingZone(r: ParkingZoneRow): ParkingZoneDto {
  return { id: r.id, venue_id: r.venue_id, name: r.name, sort_order: r.sort_order, status: r.status };
}

/** Natural order of labels: prefix, then the trailing number numerically (A-2 before A-10; 9 before 10). */
export const labelPrefixSql = (col: string) => `regexp_replace(${col}, '[0-9]+$', '')`;
export const labelNumberSql = (col: string) => `COALESCE(substring(${col} from '([0-9]+)$'), '-1')`;

export const SPOT_COLUMNS = `s.id, s.org_id, s.venue_id, s.zone_id, z.name AS zone_name, s.label, s.status,
  z.status AS zone_status, z.sort_order AS zone_sort_order,
  EXISTS (SELECT 1 FROM spot_allocations a WHERE a.parking_spot_id = s.id AND a.released_at IS NULL) AS occupied,
  ${labelPrefixSql('s.label')} AS label_prefix, ${labelNumberSql('s.label')} AS label_number`;

export interface ParkingSpotRow {
  id: string;
  org_id: string;
  venue_id: string;
  zone_id: string;
  zone_name: string;
  label: string;
  status: SetupStatus;
  zone_status: SetupStatus;
  zone_sort_order: number;
  occupied: boolean;
  label_prefix: string;
  label_number: string;
}

export interface ParkingSpotDto {
  id: string;
  venue_id: string;
  zone_id: string;
  zone_name: string;
  label: string;
  status: SetupStatus;
  occupied: boolean;
}

export function toParkingSpot(r: ParkingSpotRow): ParkingSpotDto {
  return {
    id: r.id,
    venue_id: r.venue_id,
    zone_id: r.zone_id,
    zone_name: r.zone_name,
    label: r.label,
    status: r.status,
    occupied: r.occupied,
  };
}

export interface KeyBoardRow {
  id: string;
  org_id: string;
  venue_id: string;
  name: string;
  status: SetupStatus;
}

export interface KeyBoardDto {
  id: string;
  venue_id: string;
  name: string;
  status: SetupStatus;
}

export function toKeyBoard(r: KeyBoardRow): KeyBoardDto {
  return { id: r.id, venue_id: r.venue_id, name: r.name, status: r.status };
}

export const SLOT_COLUMNS = `k.id, k.org_id, k.venue_id, k.key_board_id, b.name AS board_name, k.label, k.status,
  b.status AS board_status,
  EXISTS (SELECT 1 FROM key_slot_allocations a WHERE a.key_slot_id = k.id AND a.released_at IS NULL) AS occupied`;

export interface KeySlotRow {
  id: string;
  org_id: string;
  venue_id: string;
  key_board_id: string;
  board_name: string;
  label: string;
  status: SetupStatus;
  board_status: SetupStatus;
  occupied: boolean;
}

export interface KeySlotDto {
  id: string;
  venue_id: string;
  key_board_id: string;
  board_name: string;
  label: string;
  status: SetupStatus;
  occupied: boolean;
}

export function toKeySlot(r: KeySlotRow): KeySlotDto {
  return {
    id: r.id,
    venue_id: r.venue_id,
    key_board_id: r.key_board_id,
    board_name: r.board_name,
    label: r.label,
    status: r.status,
    occupied: r.occupied,
  };
}

// ---------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------

export const EVENT_COLUMNS = `e.id, e.org_id, e.venue_id, e.dispatch_pool_id, e.name_ar, e.host_name,
  e.event_date::text AS event_date, e.starts_at, e.ends_at, e.status, e.pricing_mode, e.fee_halalas,
  e.allowed_payment_methods, e.opened_at, e.opened_by, e.closing_started_at, e.closed_at, e.canceled_at,
  e.cancel_reason, e.close_summary, e.version, e.created_at`;

export interface VenueEventRow {
  id: string;
  org_id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  host_name: string | null;
  event_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
  status: EventStatus;
  pricing_mode: PricingMode;
  fee_halalas: number;
  allowed_payment_methods: PaymentMethod[];
  opened_at: Date | null;
  opened_by: string | null;
  closing_started_at: Date | null;
  closed_at: Date | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  close_summary: Record<string, unknown> | null;
  version: number;
  created_at: Date;
}

export interface VenueEventDto {
  id: string;
  venue_id: string;
  dispatch_pool_id: string;
  name_ar: string;
  host_name: string | null;
  event_date: string;
  starts_at: string | null;
  ends_at: string | null;
  status: EventStatus;
  pricing_mode: PricingMode;
  fee_halalas: number;
  allowed_payment_methods: PaymentMethod[];
  opened_at: string | null;
  closing_started_at: string | null;
  closed_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  close_summary: Record<string, unknown> | null;
  version: number;
  created_at: string | null;
}

export function toVenueEvent(r: VenueEventRow): VenueEventDto {
  return {
    id: r.id,
    venue_id: r.venue_id,
    dispatch_pool_id: r.dispatch_pool_id,
    name_ar: r.name_ar,
    host_name: r.host_name,
    event_date: r.event_date,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    status: r.status,
    pricing_mode: r.pricing_mode,
    fee_halalas: Number(r.fee_halalas),
    allowed_payment_methods: r.allowed_payment_methods,
    opened_at: iso(r.opened_at),
    closing_started_at: iso(r.closing_started_at),
    closed_at: iso(r.closed_at),
    canceled_at: iso(r.canceled_at),
    cancel_reason: r.cancel_reason,
    close_summary: r.close_summary,
    version: r.version,
    created_at: iso(r.created_at),
  };
}

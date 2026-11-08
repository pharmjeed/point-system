import { api } from './client';
import { fetchAllPages } from './pages';
import type {
  BulkLabels,
  DispatchPool,
  EventInput,
  KeyBoard,
  KeyBoardWithSlots,
  KeySlot,
  ParkingSpot,
  ParkingZone,
  SetupStatus,
  Shift,
  ShiftInput,
  Venue,
  VenueEvent,
  VenueSettings,
  VenueSettingsResult,
} from './types';

/**
 * Venues, layout, events and shifts (07 §2.5, Canon §9.5). Reads take a React Query signal; commands take
 * the `Idempotency-Key` of the user's intent (useCommand) — every command here is `x-idempotency: required`.
 * Layout entities (pools, zones, spots, slots) carry no `version` (07 §1.5); venues, settings, events and
 * shifts send `expected_version`.
 */
const enc = encodeURIComponent;

// ---------------------------------------------------------------- venues

export const listVenues = (signal?: AbortSignal) => fetchAllPages<Venue>('/v1/venues', {}, { signal });

export async function getVenue(venueId: string, signal?: AbortSignal): Promise<Venue> {
  return (await api.get<Venue>(`/v1/venues/${enc(venueId)}`, { signal })).data;
}

export interface VenueInput {
  code: string;
  name_ar: string;
  name_en?: string;
  city?: string;
  address?: string;
}

export async function createVenue(body: VenueInput, key: string): Promise<Venue> {
  return (await api.post<Venue>('/v1/venues', { body, idempotencyKey: key })).data;
}

export interface VenuePatch {
  expected_version: number;
  name_ar?: string;
  name_en?: string | null;
  city?: string | null;
  address?: string | null;
  status?: SetupStatus;
}

export async function patchVenue(venueId: string, body: VenuePatch, key: string): Promise<Venue> {
  return (await api.patch<Venue>(`/v1/venues/${enc(venueId)}`, { body, idempotencyKey: key })).data;
}

export async function getVenueSettings(venueId: string, signal?: AbortSignal): Promise<VenueSettingsResult> {
  return (await api.get<VenueSettingsResult>(`/v1/venues/${enc(venueId)}/settings`, { signal })).data;
}

export async function putVenueSettings(
  venueId: string,
  body: { expected_version: number; settings: VenueSettings },
  key: string,
): Promise<VenueSettingsResult> {
  return (
    await api.put<VenueSettingsResult>(`/v1/venues/${enc(venueId)}/settings`, { body, idempotencyKey: key })
  ).data;
}

// ---------------------------------------------------------------- dispatch pools

export async function listPools(venueId: string, signal?: AbortSignal): Promise<DispatchPool[]> {
  return (await api.get<DispatchPool[]>(`/v1/venues/${enc(venueId)}/dispatch-pools`, { signal })).data;
}

export async function createPool(
  venueId: string,
  body: { name: string },
  key: string,
): Promise<DispatchPool> {
  return (
    await api.post<DispatchPool>(`/v1/venues/${enc(venueId)}/dispatch-pools`, { body, idempotencyKey: key })
  ).data;
}

export async function patchPool(
  poolId: string,
  body: { name?: string; status?: SetupStatus; is_default?: boolean },
  key: string,
): Promise<DispatchPool> {
  return (await api.patch<DispatchPool>(`/v1/dispatch-pools/${enc(poolId)}`, { body, idempotencyKey: key }))
    .data;
}

// ---------------------------------------------------------------- parking zones and spots

export async function listZones(venueId: string, signal?: AbortSignal): Promise<ParkingZone[]> {
  return (await api.get<ParkingZone[]>(`/v1/venues/${enc(venueId)}/parking-zones`, { signal })).data;
}

export async function createZone(
  venueId: string,
  body: { name: string; sort_order?: number },
  key: string,
): Promise<ParkingZone> {
  return (
    await api.post<ParkingZone>(`/v1/venues/${enc(venueId)}/parking-zones`, { body, idempotencyKey: key })
  ).data;
}

export async function patchZone(
  zoneId: string,
  body: { name?: string; sort_order?: number; status?: SetupStatus },
  key: string,
): Promise<ParkingZone> {
  return (await api.patch<ParkingZone>(`/v1/parking-zones/${enc(zoneId)}`, { body, idempotencyKey: key }))
    .data;
}

export const listSpots = (venueId: string, signal?: AbortSignal) =>
  fetchAllPages<ParkingSpot>(`/v1/venues/${enc(venueId)}/parking-spots`, {}, { signal });

export async function createSpots(
  venueId: string,
  body: BulkLabels & { zone_id: string },
  key: string,
): Promise<ParkingSpot[]> {
  return (
    await api.post<ParkingSpot[]>(`/v1/venues/${enc(venueId)}/parking-spots`, { body, idempotencyKey: key })
  ).data;
}

export async function patchSpot(
  spotId: string,
  body: { label?: string; status?: SetupStatus },
  key: string,
): Promise<ParkingSpot> {
  return (await api.patch<ParkingSpot>(`/v1/parking-spots/${enc(spotId)}`, { body, idempotencyKey: key }))
    .data;
}

// ---------------------------------------------------------------- key boards and slots

export async function listKeyBoards(venueId: string, signal?: AbortSignal): Promise<KeyBoardWithSlots[]> {
  return (await api.get<KeyBoardWithSlots[]>(`/v1/venues/${enc(venueId)}/key-boards`, { signal })).data;
}

export async function createKeyBoard(
  venueId: string,
  body: { name: string },
  key: string,
): Promise<KeyBoard> {
  return (await api.post<KeyBoard>(`/v1/venues/${enc(venueId)}/key-boards`, { body, idempotencyKey: key }))
    .data;
}

export async function createSlots(boardId: string, body: BulkLabels, key: string): Promise<KeySlot[]> {
  return (await api.post<KeySlot[]>(`/v1/key-boards/${enc(boardId)}/slots`, { body, idempotencyKey: key }))
    .data;
}

export async function patchSlot(
  slotId: string,
  body: { label?: string; status?: SetupStatus },
  key: string,
): Promise<KeySlot> {
  return (await api.patch<KeySlot>(`/v1/key-slots/${enc(slotId)}`, { body, idempotencyKey: key })).data;
}

// ---------------------------------------------------------------- events

export const listEvents = (venueId: string, signal?: AbortSignal) =>
  fetchAllPages<VenueEvent>(`/v1/venues/${enc(venueId)}/events`, {}, { signal });

export async function createEvent(venueId: string, body: EventInput, key: string): Promise<VenueEvent> {
  return (await api.post<VenueEvent>(`/v1/venues/${enc(venueId)}/events`, { body, idempotencyKey: key }))
    .data;
}

export async function patchEvent(
  eventId: string,
  body: Partial<EventInput> & { expected_version: number },
  key: string,
): Promise<VenueEvent> {
  return (await api.patch<VenueEvent>(`/v1/events/${enc(eventId)}`, { body, idempotencyKey: key })).data;
}

export async function openEvent(
  eventId: string,
  body: { expected_version: number },
  key: string,
): Promise<VenueEvent> {
  return (await api.post<VenueEvent>(`/v1/events/${enc(eventId)}/open`, { body, idempotencyKey: key })).data;
}

export async function cancelEvent(
  eventId: string,
  body: { reason: string; expected_version: number },
  key: string,
): Promise<VenueEvent> {
  return (await api.post<VenueEvent>(`/v1/events/${enc(eventId)}/cancel`, { body, idempotencyKey: key }))
    .data;
}

// ---------------------------------------------------------------- shifts

export const listShifts = (venueId: string, signal?: AbortSignal) =>
  fetchAllPages<Shift>(`/v1/venues/${enc(venueId)}/shifts`, {}, { signal });

export async function createShift(venueId: string, body: ShiftInput, key: string): Promise<Shift> {
  return (await api.post<Shift>(`/v1/venues/${enc(venueId)}/shifts`, { body, idempotencyKey: key })).data;
}

export async function openShift(
  shiftId: string,
  body: { expected_version: number },
  key: string,
): Promise<Shift> {
  return (await api.post<Shift>(`/v1/shifts/${enc(shiftId)}/open`, { body, idempotencyKey: key })).data;
}

export async function closeShift(
  shiftId: string,
  body: { expected_version: number },
  key: string,
): Promise<Shift> {
  return (await api.post<Shift>(`/v1/shifts/${enc(shiftId)}/close`, { body, idempotencyKey: key })).data;
}

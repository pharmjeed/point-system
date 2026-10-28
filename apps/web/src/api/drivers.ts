import { api } from './client';
import { fetchAllPages } from './pages';
import type { CreatedDriver, DriverAssignment, DriverAssignmentsResult, DriverListItem, User } from './types';

/** Driver accounts and assignments (07 §2.6, Canon §9.6). Every command is `x-idempotency: required`. */
const enc = encodeURIComponent;

export const listDrivers = (query: { venue_id?: string }, signal?: AbortSignal) =>
  fetchAllPages<DriverListItem>('/v1/drivers', query, { signal });

export async function getDriver(driverId: string, signal?: AbortSignal): Promise<DriverListItem> {
  return (await api.get<DriverListItem>(`/v1/drivers/${enc(driverId)}`, { signal })).data;
}

export interface DriverInput {
  full_name: string;
  phone: string;
  employee_code?: string;
  initial_venue_id?: string | null;
}

export async function createDriver(body: DriverInput, key: string): Promise<CreatedDriver> {
  return (await api.post<CreatedDriver>('/v1/drivers', { body, idempotencyKey: key })).data;
}

export async function patchDriver(
  driverId: string,
  body: { expected_version: number; full_name?: string; phone?: string; employee_code?: string },
  key: string,
): Promise<User> {
  return (await api.patch<User>(`/v1/drivers/${enc(driverId)}`, { body, idempotencyKey: key })).data;
}

export async function disableDriver(driverId: string, body: { reason: string }, key: string): Promise<User> {
  return (await api.post<User>(`/v1/drivers/${enc(driverId)}/disable`, { body, idempotencyKey: key })).data;
}

export async function enableDriver(driverId: string, key: string): Promise<User> {
  return (await api.post<User>(`/v1/drivers/${enc(driverId)}/enable`, { idempotencyKey: key })).data;
}

/** The temporary PIN is shown once in a dialog and never kept anywhere else (07 §2.6, 09 §9). */
export async function resetDriverSecret(
  driverId: string,
  key: string,
): Promise<{ temporary_secret: string }> {
  return (
    await api.post<{ temporary_secret: string }>(`/v1/drivers/${enc(driverId)}/reset-secret`, {
      idempotencyKey: key,
    })
  ).data;
}

export async function listDriverAssignments(
  driverId: string,
  signal?: AbortSignal,
): Promise<DriverAssignmentsResult> {
  return (await api.get<DriverAssignmentsResult>(`/v1/drivers/${enc(driverId)}/assignments`, { signal }))
    .data;
}

export async function assignDriver(
  driverId: string,
  body: { venue_id: string; reason?: string | null },
  key: string,
): Promise<DriverAssignment> {
  return (
    await api.post<DriverAssignment>(`/v1/drivers/${enc(driverId)}/assignments`, {
      body,
      idempotencyKey: key,
    })
  ).data;
}

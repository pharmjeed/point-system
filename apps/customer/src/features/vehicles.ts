/**
 * C-15 سياراتي (V2-012, docs/v2/01 R6): the list, «أضف سيارة» (the C-05 form, up to 5) and «حذف» — a vehicle in a
 * visit in progress cannot be removed («لا تُحذف سيارة في زيارة جارية»): the button is not offered and the server
 * refuses it anyway (`CUSTOMER_VEHICLE_IN_ACTIVE_VISIT`, DEC-505). Pure.
 */
import { CUSTOMER_VEHICLES_MAX, type CustomerVehicle } from '@point/shared/customer';
import { ApiError } from '../api/errors';
import { isolate, type Dictionary } from '../i18n';

export interface VehicleRowView {
  id: string;
  /** The plate as read on the car (`4821 ب ح د`), isolated inside sentences. */
  plate: string;
  /** Make · model · colour · type, the parts that are known. */
  details: string;
  inActiveVisit: boolean;
  canRemove: boolean;
}

const label = (map: Readonly<Record<string, string>>, value: string | null): string | null =>
  value === null ? null : (map[value] ?? value); // «أخرى» typed text is shown as typed

/** Make · model · colour · type as one line, the parts that are known (the list row and the car card, DEC-643). */
export function vehicleCaption(
  v: {
    vehicle_make?: string | null;
    vehicle_model?: string | null;
    vehicle_color?: string | null;
    vehicle_type?: string | null;
  },
  dict: Dictionary,
): string {
  const types: Readonly<Record<string, string>> = dict.vehicle.types;
  return [
    label(dict.vehicleMakes, v.vehicle_make ?? null),
    v.vehicle_model ?? null,
    label(dict.vehicleColors, v.vehicle_color ?? null),
    v.vehicle_type ? (types[v.vehicle_type] ?? null) : null,
  ]
    .filter((p): p is string => !!p)
    .join(' · ');
}

export function vehicleRow(v: CustomerVehicle, dict: Dictionary): VehicleRowView {
  return {
    id: v.id,
    plate: isolate(v.plate.display),
    details: vehicleCaption(v, dict),
    inActiveVisit: v.in_active_visit,
    canRemove: !v.in_active_visit,
  };
}

/** «أضف سيارة» while the account has fewer than five (the server enforces it too). */
export const canAddVehicle = (count: number): boolean => count < CUSTOMER_VEHICLES_MAX;

export type RemoveIssue = 'in_visit' | 'gone' | null;

/** The server's refusal of a removal: a visit in progress, or a vehicle that is not there any more. */
export function removeIssueFromError(e: unknown): RemoveIssue {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'CUSTOMER_VEHICLE_IN_ACTIVE_VISIT') return 'in_visit';
  if (e.code === 'RESOURCE_NOT_FOUND') return 'gone';
  return null;
}

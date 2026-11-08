import {
  CUSTOMER_VEHICLES_MAX,
  normalizeSaudiPlate,
  saudiPlateDisplay,
  type CustomerVehicle,
  CustomerVehicleCreateBodySchema,
  type CustomerVehicleType,
} from '@point/shared/customer';
import { OPEN_TICKET_STATUSES } from '@point/shared';
import type { z } from 'zod';
import type { CustomerActorContext } from '../../../core/actor-context/customer-actor.js';
import { customerAudit } from '../../../core/audit/customer-audit.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import type { ClientInfo } from '../../identity-access/application/auth-service.js';
import { lockCustomerAccount } from './account-service.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

interface VehicleRow {
  id: string;
  plate_country: string;
  plate_digits: string | null;
  plate_letters_ar: string | null;
  plate_letters_en: string | null;
  plate_raw: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_type: CustomerVehicleType | null;
  created_at: Date;
  in_active_visit: boolean;
}

/**
 * «In a visit in progress» (C-15: such a vehicle cannot be removed): an open ticket of one of the account's linked
 * `customers` rows (V2-D12) naming the vehicle (`tickets.customer_vehicle_id`, an app intake, V2-013) or, for a
 * paper or WhatsApp intake, with the same plate.
 */
const VEHICLE_SELECT = `
  SELECT v.id, v.plate_country, v.plate_digits, v.plate_letters_ar, v.plate_letters_en, v.plate_raw, v.vehicle_make,
         v.vehicle_model, v.vehicle_color, v.vehicle_type, v.created_at,
         EXISTS (SELECT 1 FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.org_id = t.org_id
                  WHERE c.customer_account_id = v.account_id AND t.status = ANY($2)
                    AND (t.customer_vehicle_id = v.id
                         OR (t.plate_country = v.plate_country AND t.plate_digits = v.plate_digits
                             AND t.plate_letters_ar = v.plate_letters_ar))) AS in_active_visit
    FROM customer_vehicles v`;

function vehicleView(v: VehicleRow): CustomerVehicle {
  return {
    id: v.id,
    plate: {
      country: v.plate_country,
      digits: v.plate_digits,
      letters_ar: v.plate_letters_ar,
      letters_en: v.plate_letters_en,
      raw: v.plate_raw,
      display: saudiPlateDisplay({ digits: v.plate_digits, letters_ar: v.plate_letters_ar }),
    },
    vehicle_make: v.vehicle_make,
    vehicle_model: v.vehicle_model,
    vehicle_color: v.vehicle_color,
    vehicle_type: v.vehicle_type,
    in_active_visit: v.in_active_visit,
    created_at: v.created_at.toISOString(),
  };
}

/** `GET /v1/customer/vehicles`: the account's vehicles, oldest first (at most 5, so no cursor). */
export async function listCustomerVehicles(q: Q, accountId: string): Promise<{ items: CustomerVehicle[] }> {
  const rows = (
    await q.query<VehicleRow>(
      `${VEHICLE_SELECT} WHERE v.account_id = $1 AND v.removed_at IS NULL ORDER BY v.created_at, v.id`,
      [accountId, [...OPEN_TICKET_STATUSES]],
    )
  ).rows;
  return { items: rows.map(vehicleView) };
}

/**
 * `POST /v1/customer/vehicles` (C-05): the plate normalised by the rule of `tickets` (`normalizeSaudiPlate`, 07
 * §1.8) or PLATE_INVALID with `field`/`reason`; then CUSTOMER_VEHICLE_LIMIT (`max`) and
 * CUSTOMER_VEHICLE_DUPLICATE, checked under the account's row lock so two concurrent adds cannot pass them both
 * (uq_customer_vehicles_plate stays the last line).
 */
export async function addCustomerVehicle(
  tx: Tx,
  actor: CustomerActorContext,
  body: z.output<typeof CustomerVehicleCreateBodySchema>,
  client: ClientInfo,
): Promise<CustomerVehicle> {
  const result = normalizeSaudiPlate(body.plate);
  if (!result.ok) throw new AppError('PLATE_INVALID', { field: result.field, reason: result.reason });
  await lockCustomerAccount(tx, actor.accountId);
  const live = await tx.rows<{ plate_digits: string | null; plate_letters_ar: string | null }>(
    `SELECT plate_digits, plate_letters_ar FROM customer_vehicles WHERE account_id = $1 AND removed_at IS NULL`,
    [actor.accountId],
  );
  if (live.length >= CUSTOMER_VEHICLES_MAX)
    throw new AppError('CUSTOMER_VEHICLE_LIMIT', { max: CUSTOMER_VEHICLES_MAX });
  const { plate } = result;
  if (live.some((v) => v.plate_digits === plate.digits && v.plate_letters_ar === plate.letters_ar))
    throw new AppError('CUSTOMER_VEHICLE_DUPLICATE');
  const row = await tx.one<{ id: string }>(
    `INSERT INTO customer_vehicles (account_id, plate_country, plate_digits, plate_letters_ar, plate_letters_en,
            vehicle_make, vehicle_model, vehicle_color, vehicle_type, created_at)
     VALUES ($1, 'SA', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      actor.accountId,
      plate.digits,
      plate.letters_ar,
      plate.letters_en,
      body.vehicle_make ?? null,
      body.vehicle_model ?? null,
      body.vehicle_color ?? null,
      body.vehicle_type ?? null,
      tx.now,
    ],
  );
  await customerAudit(tx, {
    actor: { type: 'customer', accountId: actor.accountId },
    action: 'customer.vehicle.add',
    entityType: 'customer_vehicle',
    entityId: row.id,
    requestId: client.requestId,
    ip: client.ip ?? null,
    userAgent: client.userAgent ?? null,
    metadata: { vehicle_type: body.vehicle_type ?? null },
  });
  const v = (
    await tx.query<VehicleRow>(`${VEHICLE_SELECT} WHERE v.id = $1`, [row.id, [...OPEN_TICKET_STATUSES]])
  ).rows[0]!;
  return vehicleView(v);
}

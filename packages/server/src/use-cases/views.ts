import type { DriverState } from '@point/shared';
import { currentDriverState, type SettleOutcome } from '../modules/dispatch/index.js';
import {
  plateView,
  taskView,
  type TaskReadRow,
  type TicketQueryable,
  type TicketViewer,
} from '../modules/tickets-custody/index.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * TaskCard (07; D-04 / D-10): the driver's current or next task. Parking spot and key slot only for the
 * assignee (09 §5.1); the handover code itself never appears (claim_code state arrives with PNT-047).
 */
export async function loadTaskCard(q: TicketQueryable, taskId: string, viewer: TicketViewer, now: Date) {
  const r = await q.query<
    TaskReadRow & {
      t_id: string;
      display_number: number;
      t_status: string;
      t_version: number;
      event_name_ar: string;
      plate_country: string;
      plate_digits: string | null;
      plate_letters_ar: string | null;
      plate_letters_en: string | null;
      plate_raw: string | null;
      vehicle_make: string | null;
      vehicle_model: string | null;
      vehicle_color: string | null;
      vehicle_type: string | null;
      payment_status: string;
      fee_halalas: number;
      allowed_payment_methods: string[];
      current_spot_id: string | null;
      current_spot_note: string | null;
      current_key_slot_id: string | null;
      requested_at: Date | null;
    }
  >(
    `SELECT k.*, u.full_name AS assignee_full_name, u.employee_code AS assignee_employee_code,
            t.id AS t_id, t.display_number, t.status AS t_status, t.version AS t_version, e.name_ar AS event_name_ar,
            t.plate_country, t.plate_digits, t.plate_letters_ar, t.plate_letters_en, t.plate_raw,
            t.vehicle_make, t.vehicle_model, t.vehicle_color, t.vehicle_type, t.payment_status, t.fee_halalas,
            e.allowed_payment_methods, t.current_spot_id, t.current_spot_note, t.current_key_slot_id,
            c.requested_at
       FROM tasks k
       JOIN tickets t ON t.id = k.ticket_id
       JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = k.assignee_id
       LEFT JOIN retrieval_cycles c ON c.id = k.cycle_id
      WHERE k.id = $1`,
    [taskId],
  );
  const k = r.rows[0];
  if (!k) return null;
  const isAssignee = k.assignee_id === viewer.userId;
  const staff = viewer.role !== 'driver';
  let parking: { spot_label: string | null; zone_name: string | null; spot_note: string | null } | null =
    null;
  let keySlot: { id: string; board_name: string; label: string } | null = null;
  if (isAssignee || staff) {
    if (k.current_spot_id || k.current_spot_note) {
      const s = k.current_spot_id
        ? (
            await q.query<{ label: string; zone_name: string }>(
              `SELECT s.label, z.name AS zone_name FROM parking_spots s JOIN parking_zones z ON z.id = s.zone_id WHERE s.id = $1`,
              [k.current_spot_id],
            )
          ).rows[0]
        : undefined;
      parking = {
        spot_label: s?.label ?? null,
        zone_name: s?.zone_name ?? null,
        spot_note: k.current_spot_note,
      };
    }
    if (k.current_key_slot_id) {
      const s = (
        await q.query<{ id: string; label: string; board_name: string }>(
          `SELECT ks.id, ks.label, b.name AS board_name FROM key_slots ks JOIN key_boards b ON b.id = ks.key_board_id WHERE ks.id = $1`,
          [k.current_key_slot_id],
        )
      ).rows[0];
      keySlot = s ? { id: s.id, board_name: s.board_name, label: s.label } : null;
    }
  }
  const requestedAt = k.requested_at ? new Date(k.requested_at) : null;
  return {
    task: taskView(k, { showAssignee: isAssignee || staff }),
    ticket: {
      id: k.t_id,
      display_number: k.display_number,
      event_name_ar: k.event_name_ar,
      plate: plateView(k),
      vehicle: { make: k.vehicle_make, model: k.vehicle_model, color: k.vehicle_color, type: k.vehicle_type },
      status: k.t_status,
      version: k.t_version,
    },
    parking,
    key_slot: keySlot,
    requested_at: iso(requestedAt),
    waiting_seconds: requestedAt
      ? Math.max(0, Math.floor((now.getTime() - requestedAt.getTime()) / 1000))
      : null,
    payment_due:
      k.payment_status === 'due' && (isAssignee || staff)
        ? { amount_halalas: Number(k.fee_halalas), allowed_methods: k.allowed_payment_methods }
        : null,
    claim_code: null,
  };
}

export async function loadTaskCardOrThrow(
  q: TicketQueryable,
  taskId: string,
  viewer: TicketViewer,
  now: Date,
) {
  const card = await loadTaskCard(q, taskId, viewer, now);
  if (!card) throw new Error(`task ${taskId} vanished`);
  return card;
}

/** DriverStateResult (07) after a command released the driver. */
export async function driverStateResult(
  q: TicketQueryable,
  userId: string,
  settled: SettleOutcome | null,
  viewer: TicketViewer,
  now: Date,
): Promise<{ driver_state: DriverState; promoted_next_task: Awaited<ReturnType<typeof loadTaskCard>> }> {
  return {
    driver_state: await currentDriverState(q, userId),
    promoted_next_task:
      settled?.outcome === 'promoted' ? await loadTaskCard(q, settled.task.id, viewer, now) : null,
  };
}

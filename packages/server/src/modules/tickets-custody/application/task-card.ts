import { plateView } from '../domain/plate.js';
import type { Tx } from '../../../core/db/tx.js';
import { loadClaimCodeState } from './claim-codes.js';
import { iso, taskView, type Queryable, type TaskReadRow, type Viewer } from './views.js';

/**
 * TaskCard (07; D-04 / D-10): the driver's current or next task. Parking spot and key slot only for the
 * assignee and staff (09 §5.1). `claim_code` is the ClaimCodeState of the retrieval cycle's current code for the
 * assignee and staff (the TicketDetail projection, DEC-208): state only, the handover code itself never appears
 * (DEC-38); null for park/repark tasks and paper tickets. `ready_at` is the cycle's readiness (D-04 «منذ», DEC-348).
 * Used by the HTTP reads and by the realtime `task.updated` messages to the assignee.
 */
export async function loadTaskCard(q: Queryable, taskId: string, viewer: Viewer, now: Date) {
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
      ready_at: Date | null;
    }
  >(
    `SELECT k.*, u.full_name AS assignee_full_name, u.employee_code AS assignee_employee_code,
            t.id AS t_id, t.display_number, t.status AS t_status, t.version AS t_version, e.name_ar AS event_name_ar,
            t.plate_country, t.plate_digits, t.plate_letters_ar, t.plate_letters_en, t.plate_raw,
            t.vehicle_make, t.vehicle_model, t.vehicle_color, t.vehicle_type, t.payment_status, t.fee_halalas,
            e.allowed_payment_methods, t.current_spot_id, t.current_spot_note, t.current_key_slot_id,
            c.requested_at, c.ready_at
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
    ready_at: iso(k.ready_at),
    waiting_seconds: requestedAt
      ? Math.max(0, Math.floor((now.getTime() - requestedAt.getTime()) / 1000))
      : null,
    payment_due:
      k.payment_status === 'due' && (isAssignee || staff)
        ? { amount_halalas: Number(k.fee_halalas), allowed_methods: k.allowed_payment_methods }
        : null,
    claim_code:
      k.type === 'retrieve' && (isAssignee || staff)
        ? await loadClaimCodeState(q, k.venue_id, k.cycle_id)
        : null,
  };
}

export type TaskCard = NonNullable<Awaited<ReturnType<typeof loadTaskCard>>>;

/**
 * realtime:RT-2 (07 §4.3, §4.5): the TaskCard shows ticket-derived fields (`parking`, `key_slot`, `payment_due`).
 * A command that changes one of them for the assignee of an open task without a task event (an official spot /
 * slot transfer, a fee waiver or reversal) bumps the task version here, so the TaskCard the dispatch planner
 * republishes on `custody.changed` / `payment.*` is newer than the one the driver holds (a same-version card is
 * ignored) and a command sent with the old `expected_version` is VERSION_CONFLICT. The caller holds L4 on the task.
 */
export async function bumpTaskCardVersion(tx: Tx, taskId: string): Promise<void> {
  await tx.query(`UPDATE tasks SET version = version + 1 WHERE id = $1`, [taskId]);
}

/** A custody move that changes what the TaskCard shows: the key into or out of a slot, the vehicle into or out of a spot. */
export function custodyTouchesTaskCard(
  subject: 'vehicle' | 'key',
  fromType: string | null | undefined,
  toType: string | null | undefined,
): boolean {
  const holder = subject === 'key' ? 'key_slot' : 'spot';
  return fromType === holder || toType === holder;
}

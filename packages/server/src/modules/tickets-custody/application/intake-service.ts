import { Injectable } from '@nestjs/common';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { requireDuty } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { normalizePhone } from '../../../core/phone.js';
import { normalizePlate, normalizeTag, type PlateInput } from '../domain/plate.js';
import type { TicketRow } from '../infra/rows.js';
import { checkVersion, invalidTransition } from './errors.js';
import { emitForTicket, ticketRef, userActor } from './events.js';
import { loadTicketDetail } from './views.js';

export interface IntakePatch {
  expected_version: number;
  /** `app` is never written here: it comes from the entry pass (POST /v1/tickets/intake-pass, DEC-501) */
  channel?: 'whatsapp' | 'paper';
  plate?: PlateInput;
  vehicle?: {
    make?: string | null;
    model?: string | null;
    color?: string | null;
    type?: 'sedan' | 'suv' | 'pickup' | 'van' | 'other' | null;
  };
  customer_phone?: string | null;
  consent?: { method: 'verbal_staff_confirmed'; confirmed: true } | null;
  paper_serial?: string | null;
  key_tag?: string | null;
  notes?: string | null;
  damage_marks?: { area: string; note?: string }[];
}

const OPERATION = 'PATCH /v1/tickets/{ticketId}/intake';

/** Loads a ticket the actor may address by id (scope as not-found, 08 §1.3 rule 4) without locking it. */
export async function findTicketInScope(
  tx: Pick<Tx, 'maybeOne'>,
  actor: ActorContext,
  ticketId: string,
): Promise<Pick<TicketRow, 'id' | 'venue_id' | 'dispatch_pool_id' | 'created_by' | 'status'>> {
  const t = await tx.maybeOne<
    Pick<TicketRow, 'id' | 'venue_id' | 'dispatch_pool_id' | 'created_by' | 'status'>
  >(`SELECT id, venue_id, dispatch_pool_id, created_by, status FROM tickets WHERE id = $1 AND org_id = $2`, [
    ticketId,
    actor.orgId,
  ]);
  if (!t || !actor.venueIds.has(t.venue_id)) throw new AppError('TICKET_NOT_FOUND');
  return t;
}

export function assertCreator(actor: ActorContext, t: Pick<TicketRow, 'created_by'>): void {
  if (t.created_by !== actor.userId)
    throw new AppError('PERMISSION_DENIED', { permission: 'ticket.intake', reason: 'not_ticket_creator' });
}

/** Live link codes of a ticket are revoked (the whatsapp module owns them; PNT-044 may move this there). */
export async function revokeLiveLinkCodes(
  tx: Tx,
  ticketId: string,
  reason: 'channel_paper' | 'ticket_voided',
): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `UPDATE link_codes SET status = 'revoked', revoke_reason = $2
      WHERE ticket_id = $1 AND status IN ('active','pending_confirmation') RETURNING id`,
    [ticketId, reason],
  );
  return r.rows.map((x) => x.id);
}

/**
 * `PATCH /v1/tickets/{ticketId}/intake` (PNT-026; 11 §2.4, §2.6; DEC-40). Starts at L5 and never takes a lower
 * level: draft fields while `received`; during `parking` only `{channel: paper, paper_serial}` for a ticket
 * that is not linked (wa_link_status = none, link_version + 1, live link code revoked `channel_paper`).
 */
@Injectable()
export class IntakeService {
  async update(tx: Tx, actor: ActorContext, ticketId: string, body: IntakePatch, requestId: string) {
    // 07 §1.10: scope (unknown or foreign ticket → TICKET_NOT_FOUND) before the duty conditions
    const pre = await findTicketInScope(tx, actor, ticketId);
    const duty = requireDuty(actor);
    if (pre.dispatch_pool_id !== duty.poolId) throw new AppError('DUTY_REQUIRED');
    assertCreator(actor, pre);

    const [t] = await lockTickets(tx, [ticketId]); // L5
    const ticket = t as TicketRow;
    checkVersion('ticket', ticket, body.expected_version);

    const fields = (Object.keys(body) as (keyof IntakePatch)[]).filter((k) => k !== 'expected_version');
    const conversion = ticket.status === 'parking';
    if (ticket.status === 'parking') {
      const onlyPaper =
        fields.every((f) => f === 'channel' || f === 'paper_serial') &&
        body.channel === 'paper' &&
        typeof body.paper_serial === 'string' &&
        body.paper_serial.trim() !== '';
      if (!onlyPaper)
        throw invalidTransition(
          'ticket',
          ticket,
          OPERATION,
          ['received'],
          'only_paper_conversion_in_parking',
        );
      if (ticket.channel === 'paper')
        throw invalidTransition('ticket', ticket, OPERATION, ['received'], 'already_paper');
      // V2-013 (DEC-501): an app ticket is the customer's account, nothing to convert after the intake
      if (ticket.channel === 'app')
        throw invalidTransition('ticket', ticket, OPERATION, ['received'], 'app_channel');
      if (ticket.wa_link_status === 'linked')
        throw invalidTransition('ticket', ticket, OPERATION, ['received'], 'ticket_linked');
    } else if (ticket.status !== 'received') {
      throw invalidTransition('ticket', ticket, OPERATION, ['received', 'parking']);
    } else if (body.channel === 'paper' && ticket.channel !== 'paper' && ticket.wa_link_status === 'linked') {
      // a linked customer keeps WhatsApp (11 §2.6); the same rule as DEC-40 during received
      throw invalidTransition('ticket', ticket, OPERATION, ['received'], 'ticket_linked');
    }

    const sets: Record<string, unknown> = {};
    const changed: string[] = [];

    // V2-013 (DEC-501): an app ticket (the customer's entry pass, O-01) keeps its customer unless the draft leaves the
    // app channel for WhatsApp or paper in `received`, which unlinks the account (its customers row and vehicle)
    const leavingApp = ticket.channel === 'app' && body.channel !== undefined;
    if (ticket.channel === 'app' && !leavingApp) {
      const app = (['customer_phone', 'consent', 'paper_serial'] as const).filter(
        (f) => body[f] !== undefined,
      );
      if (app.length)
        throw new AppError('VALIDATION_FAILED', {
          fields: app.map((field) => ({ field, issue: 'app_channel' })),
        });
    }
    if (leavingApp) {
      sets.customer_id = null;
      sets.customer_vehicle_id = null;
    }

    if (body.plate !== undefined) {
      const p = normalizePlate(body.plate);
      Object.assign(sets, {
        plate_country: p.country,
        plate_digits: p.digits,
        plate_letters_ar: p.letters_ar,
        plate_letters_en: p.letters_en,
        plate_raw: p.raw,
      });
      // a different plate is not the account's vehicle any more (DEC-501): the link to it goes, the account stays
      if (
        ticket.customer_vehicle_id &&
        (p.country !== ticket.plate_country ||
          p.digits !== ticket.plate_digits ||
          p.letters_ar !== ticket.plate_letters_ar ||
          p.raw !== ticket.plate_raw)
      )
        sets.customer_vehicle_id = null;
      changed.push('plate');
    }
    if (body.vehicle !== undefined) {
      const clean = (v: string | null | undefined) => (v == null ? null : v.trim() || null);
      for (const k of ['make', 'model', 'color', 'type'] as const) {
        if (body.vehicle[k] !== undefined) {
          sets[`vehicle_${k}`] = k === 'type' ? (body.vehicle.type ?? null) : clean(body.vehicle[k]);
          changed.push(`vehicle.${k}`);
        }
      }
    }
    if (body.notes !== undefined) {
      sets.notes = body.notes == null ? null : body.notes.trim() || null;
      changed.push('notes');
    }

    let customerId = leavingApp ? null : ticket.customer_id;
    if (body.customer_phone !== undefined) {
      if (body.customer_phone == null || body.customer_phone.trim() === '') {
        customerId = null;
      } else {
        const e164 = normalizePhone(body.customer_phone);
        if (!e164) throw new AppError('PHONE_INVALID', { field: 'customer_phone' });
        const c = await tx.one<{ id: string }>(
          `INSERT INTO customers (id, org_id, phone_e164, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164 RETURNING id`,
          [newId(), ticket.org_id, e164, tx.now],
        );
        customerId = c.id;
      }
      if (customerId !== ticket.customer_id) {
        // consent was given for the previous number only
        await tx.query(
          `UPDATE customer_consents SET revoked_at = $2, revoke_source = 'staff' WHERE ticket_id = $1 AND revoked_at IS NULL`,
          [ticket.id, tx.now],
        );
        sets.customer_id = customerId;
      }
      changed.push('customer_phone');
    }
    if (body.consent !== undefined) {
      if (body.consent === null) {
        await tx.query(
          `UPDATE customer_consents SET revoked_at = $2, revoke_source = 'staff' WHERE ticket_id = $1 AND revoked_at IS NULL`,
          [ticket.id, tx.now],
        );
      } else {
        if (!customerId)
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ field: 'consent', issue: 'customer_phone_required' }],
          });
        await tx.query(
          `INSERT INTO customer_consents (org_id, customer_id, ticket_id, channel, method, captured_by, captured_at)
           SELECT $1, $2, $3, 'whatsapp', 'verbal_staff_confirmed', $4, $5
            WHERE NOT EXISTS (SELECT 1 FROM customer_consents WHERE ticket_id = $3 AND customer_id = $2 AND revoked_at IS NULL)`,
          [ticket.org_id, customerId, ticket.id, actor.userId, tx.now],
        );
      }
      changed.push('consent');
    }
    if (body.paper_serial !== undefined) {
      const serial = body.paper_serial == null ? null : normalizeTag(body.paper_serial) || null;
      if (serial) {
        const dup = await tx.maybeOne<{ display_number: number }>(
          `SELECT display_number FROM tickets WHERE event_id = $1 AND paper_serial = $2 AND status <> 'voided' AND id <> $3 LIMIT 1`,
          [ticket.event_id, serial, ticket.id],
        );
        if (dup) throw new AppError('PAPER_SERIAL_IN_USE', { field: 'paper_serial' });
      }
      sets.paper_serial = serial;
      changed.push('paper_serial');
    }
    if (body.key_tag !== undefined) {
      const tag = body.key_tag == null ? null : normalizeTag(body.key_tag) || null;
      if (tag) {
        const dup = await tx.maybeOne<{ display_number: number }>(
          `SELECT display_number FROM tickets WHERE venue_id = $1 AND key_tag = $2 AND status NOT IN ('delivered','voided') AND id <> $3 LIMIT 1`,
          [ticket.venue_id, tag, ticket.id],
        );
        if (dup)
          throw new AppError('KEY_TAG_IN_USE', {
            field: 'key_tag',
            conflicting_display_number: dup.display_number,
          });
      }
      sets.key_tag = tag;
      changed.push('key_tag');
    }

    let waChange: { from: string; to: string } | null = null;
    if (body.channel !== undefined && body.channel !== ticket.channel) {
      sets.channel = body.channel;
      if (body.channel === 'paper') {
        await revokeLiveLinkCodes(tx, ticket.id, 'channel_paper');
        if (ticket.wa_link_status !== 'none') {
          sets.wa_link_status = 'none';
          waChange = { from: ticket.wa_link_status, to: 'none' };
        }
        if (conversion) {
          // DEC-40: the buttons of any earlier message stop working
          sets.link_version = ticket.link_version + 1;
          waChange = { from: ticket.wa_link_status, to: 'none' };
        }
      }
      changed.push('channel');
    }

    if (body.damage_marks !== undefined) {
      const marks = JSON.stringify(
        body.damage_marks.map((m) => ({ area: m.area, ...(m.note ? { note: m.note } : {}) })),
      );
      const upd = await tx.query(
        `UPDATE vehicle_inspections SET damage_marks = $2
          WHERE id = (SELECT id FROM vehicle_inspections WHERE ticket_id = $1 AND kind = 'intake' ORDER BY created_at DESC, id DESC LIMIT 1)`,
        [ticket.id, marks],
      );
      if ((upd.rowCount ?? 0) === 0) {
        await tx.query(
          `INSERT INTO vehicle_inspections (org_id, ticket_id, kind, captured_by, damage_marks, created_at)
           VALUES ($1, $2, 'intake', $3, $4, $5)`,
          [ticket.org_id, ticket.id, actor.userId, marks, tx.now],
        );
      }
      changed.push('damage_marks');
    }

    let updated = ticket;
    if (changed.length) {
      const cols = Object.keys(sets);
      const assignments = cols.map((c, i) => `${c} = $${i + 3}`);
      updated = await tx.one<TicketRow>(
        `UPDATE tickets SET ${[...assignments, 'version = version + 1'].join(', ')}
          WHERE id = $1 AND version = $2 RETURNING *`,
        [ticket.id, ticket.version, ...cols.map((c) => sets[c])],
      );
    }
    if (waChange) {
      await emitForTicket(tx, updated, {
        type: 'ticket.wa_link_changed',
        actor: userActor(actor.userId),
        payload: {
          ticket: ticketRef(updated),
          from: waChange.from,
          to: waChange.to,
          method: 'channel_paper',
          link_version: updated.link_version,
          notification_id: null,
        },
      });
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'ticket.intake',
      entityType: 'ticket',
      entityId: ticket.id,
      venueId: ticket.venue_id,
      requestId,
      before: { version: ticket.version, status: ticket.status },
      after: { version: updated.version },
      metadata: { operation: OPERATION, fields: changed, paper_conversion: conversion },
    });
    return loadTicketDetail(tx, ticket.id, { userId: actor.userId, role: actor.role });
  }
}

import { Injectable } from '@nestjs/common';
import { autoResolveAlerts, raiseAlert } from '../core/alerts/alerts.js';
import { requireDuty, type ActorContext } from '../core/actor-context/actor-context.js';
import { lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import {
  assertCreator,
  checkVersion,
  emitForTicket,
  findTicketInScope,
  invalidTransition,
  loadTicketDetail,
  missingIntakeFields,
  ticketRef,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { listUploadedPhotoKinds } from '../modules/media/index.js';
import { venueSettingsFor } from '../modules/venues-events/index.js';
import { customerLinking } from './hooks.js';
import { auditCommand, eventActor } from './shared.js';

const OPERATION = 'POST /v1/tickets/{ticketId}/submit-intake';

/**
 * SubmitIntake (PNT-028; 11 TT-03): L5 only. Required fields per channel → consent → opt-out → inspection
 * photos of `inspection.required_photos` (explicit acknowledgement → `incomplete` + `inspection_incomplete`
 * alert) → `parking`. The fee snapshot stays as taken at intake (DEC-43). W-01 starts in PNT-043 through
 * the CustomerLinkingHook.
 */
@Injectable()
export class SubmitIntakeUseCase {
  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: { expected_version: number; acknowledge_incomplete_inspection?: boolean },
    requestId: string,
  ) {
    const pre = await findTicketInScope(tx, actor, ticketId); // 07 §1.10: scope before duty
    requireDuty(actor);
    assertCreator(actor, pre);
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    checkVersion('ticket', t, body.expected_version);
    if (t.status !== 'received') throw invalidTransition('ticket', t, OPERATION, ['received']);

    const qr = await tx.maybeOne(
      `SELECT 1 FROM link_codes WHERE ticket_id = $1 AND status IN ('active','pending_confirmation','consumed') LIMIT 1`,
      [t.id],
    );
    const missing = missingIntakeFields(t, { hasQrLink: !!qr });
    if (missing.length) throw new AppError('INTAKE_INCOMPLETE', { missing });

    const direct = t.channel === 'whatsapp' && !!t.customer_id && t.wa_link_status !== 'linked' && !qr;
    if (direct) {
      const consent = await tx.maybeOne(
        `SELECT 1 FROM customer_consents WHERE ticket_id = $1 AND customer_id = $2 AND revoked_at IS NULL LIMIT 1`,
        [t.id, t.customer_id],
      );
      if (!consent) throw new AppError('CONSENT_REQUIRED', { field: 'consent' });
      const c = await tx.one<{ wa_opted_out_at: Date | null }>(
        `SELECT wa_opted_out_at FROM customers WHERE id = $1`,
        [t.customer_id],
      );
      if (c.wa_opted_out_at) throw new AppError('WA_CUSTOMER_OPTED_OUT');
    }

    const settings = await venueSettingsFor(tx, t.venue_id);
    const required = settings.inspection.required_photos;
    // uploaded photo kinds come from the media module (PNT-027); failed uploads of a missing kind are listed
    const uploaded = new Set<string>(await listUploadedPhotoKinds(tx, t.id));
    const missingPhotos = required.filter((k) => !uploaded.has(k));
    const failed = await tx.rows<{ id: string }>(
      `SELECT id FROM media_assets WHERE ticket_id = $1 AND upload_status = 'failed' AND kind = ANY($2::text[]) ORDER BY created_at, id`,
      [t.id, missingPhotos],
    );
    if (missingPhotos.length && !body.acknowledge_incomplete_inspection)
      throw new AppError('INSPECTION_INCOMPLETE', {
        missing: missingPhotos,
        failed_media_ids: failed.map((m) => m.id),
      });
    const inspection = missingPhotos.length ? 'incomplete' : 'complete';

    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET status = 'parking', submitted_at = $2, inspection_status = $3, version = version + 1
        WHERE id = $1 AND version = $4 RETURNING *`,
      [t.id, tx.now, inspection, t.version],
    );
    // the intake inspection record (11 TT-03): kept with the damage marks entered in the draft
    const insp = await tx.maybeOne<{ id: string }>(
      `UPDATE vehicle_inspections SET required_photos_ok = $2, notes = COALESCE(notes, $3)
        WHERE id = (SELECT id FROM vehicle_inspections WHERE ticket_id = $1 AND kind = 'intake' ORDER BY created_at DESC, id DESC LIMIT 1)
        RETURNING id`,
      [t.id, inspection === 'complete', t.notes],
    );
    const inspectionId =
      insp?.id ??
      (
        await tx.one<{ id: string }>(
          `INSERT INTO vehicle_inspections (org_id, ticket_id, kind, captured_by, notes, required_photos_ok, created_at)
           VALUES ($1, $2, 'intake', $3, $4, $5, $6) RETURNING id`,
          [t.org_id, t.id, actor.userId, t.notes, inspection === 'complete', tx.now],
        )
      ).id;
    await tx.query(
      `UPDATE media_assets SET inspection_id = $2 WHERE ticket_id = $1 AND inspection_id IS NULL`,
      [t.id, inspectionId],
    );

    // PNT-043: W-01 linking for the direct method; the submitted event carries the resulting link status
    const linked = direct
      ? await customerLinking().onIntakeSubmitted(tx, { ticket: updated, actor, requestId })
      : null;
    const submitted = linked ?? updated;
    const ea = eventActor(actor);
    await emitForTicket(tx, submitted, {
      type: 'ticket.intake_submitted',
      actor: ea,
      payload: {
        ticket: ticketRef(submitted),
        channel: submitted.channel,
        inspection_status: inspection,
        payment_status: submitted.payment_status,
        wa_link_status: submitted.wa_link_status,
      },
    });
    // the draft leaves `received`: a draft_abandoned alert raised by a refused discard is resolved (11 §6.10, 14 §8)
    await autoResolveAlerts(tx, {
      orgId: t.org_id,
      venueId: t.venue_id,
      dedupeKeys: [`draft_abandoned:${t.id}`],
      note: 'intake_submitted',
    });
    if (inspection === 'incomplete') {
      await raiseAlert(tx, {
        orgId: t.org_id,
        venueId: t.venue_id,
        type: 'inspection_incomplete',
        dedupeKey: `inspection_incomplete:${t.id}`,
        poolId: t.dispatch_pool_id,
        eventId: t.event_id,
        ticketId: t.id,
        userId: actor.userId,
        details: {
          display_number: t.display_number,
          missing: missingPhotos,
          missing_count: missingPhotos.length,
        },
      });
    }
    await auditCommand(tx, actor, {
      action: 'ticket.intake',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: { status: 'received' },
      after: { status: 'parking', inspection_status: inspection, wa_link_status: submitted.wa_link_status },
      metadata: { acknowledged_incomplete_inspection: !!body.acknowledge_incomplete_inspection },
    });
    return loadTicketDetail(tx, t.id, { userId: actor.userId, role: actor.role });
  }
}

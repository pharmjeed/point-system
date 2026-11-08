import type { WaLinkStatus } from '@point/shared';
import { audit } from '../../../core/audit/audit-writer.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { changeWaLinkStatus } from './ticket-link.js';

/**
 * «إيقاف» (12 §7.6, PNT-048), one transaction: customers.wa_opted_out_at, every live consent revoked
 * (`customer_opt_out`), every open WhatsApp ticket of the customer → `opted_out` (with
 * `ticket.wa_link_changed` + `ticket.updated` for the staff), then `wa.customer_opted_out` → W-12. Action
 * tokens stay valid: pressing «طلب السيارة» later resumes the consent (PNT-045). A repeated stop word
 * changes nothing (same opted_out_at → no second W-12).
 */
export async function optOutCustomer(
  tx: Tx,
  a: { orgId: string; customerId: string; inboundMessageId: string },
): Promise<{ changed: boolean; affectedTicketIds: string[] }> {
  const candidates = await tx.rows<{ id: string }>(
    `SELECT id FROM tickets WHERE customer_id = $1 AND channel = 'whatsapp'
        AND status NOT IN ('delivered','voided') AND wa_link_status <> 'opted_out' ORDER BY id`,
    [a.customerId],
  );
  // L5 before anything else (canon §14ب)
  const locked = (await lockTickets(
    tx,
    candidates.map((c) => c.id),
  )) as {
    id: string;
    org_id: string;
    venue_id: string;
    event_id: string;
    dispatch_pool_id: string;
    display_number: number;
    customer_id: string | null;
    channel: string;
    status: string;
    wa_link_status: WaLinkStatus;
    link_version: number;
    version: number;
  }[];
  const customer = await tx.maybeOne<{ wa_opted_out_at: Date }>(
    `UPDATE customers SET wa_opted_out_at = $2 WHERE id = $1 AND wa_opted_out_at IS NULL RETURNING wa_opted_out_at`,
    [a.customerId, tx.now],
  );
  if (!customer) return { changed: false, affectedTicketIds: [] };
  const revoked = await tx.query(
    `UPDATE customer_consents SET revoked_at = $2, revoke_source = 'customer_opt_out'
      WHERE customer_id = $1 AND revoked_at IS NULL`,
    [a.customerId, tx.now],
  );
  const affected: string[] = [];
  for (const t of locked) {
    // re-check after the lock (TOCTOU)
    if (
      t.customer_id !== a.customerId ||
      t.channel !== 'whatsapp' ||
      t.status === 'delivered' ||
      t.status === 'voided' ||
      t.wa_link_status === 'opted_out'
    )
      continue;
    await changeWaLinkStatus(tx, t, 'opted_out', {
      method: 'opt_out',
      actor: { type: 'customer', id: a.customerId },
      action: 'job.wa_process_inbound',
    });
    affected.push(t.id);
  }
  await emitEvent(tx, {
    type: 'wa.customer_opted_out',
    orgId: a.orgId,
    aggregate: { type: 'customer', id: a.customerId, version: null },
    actor: { type: 'customer', id: a.customerId },
    payload: {
      customer_id: a.customerId,
      affected_ticket_ids: affected,
      opted_out_at: customer.wa_opted_out_at.toISOString(),
      inbound_message_id: a.inboundMessageId,
    },
  });
  await audit(tx, {
    orgId: a.orgId,
    actor: { type: 'customer', id: a.customerId },
    action: 'job.wa_process_inbound',
    entityType: 'customer',
    entityId: a.customerId,
    after: { wa_opted_out_at: customer.wa_opted_out_at.toISOString() },
    metadata: {
      effect: 'wa_opt_out',
      revoked_consents: revoked.rowCount ?? 0,
      affected_ticket_ids: affected,
    },
  });
  return { changed: true, affectedTicketIds: affected };
}

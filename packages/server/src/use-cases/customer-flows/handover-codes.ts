import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../../core/actor-context/actor-context.js';
import type { Env } from '../../core/config/env.js';
import { parseEncryptionKey } from '../../core/crypto/crypto.js';
import { lockCycles, lockTickets } from '../../core/db/locks.js';
import type { Tx } from '../../core/db/tx.js';
import { AppError } from '../../core/errors/app-error.js';
import { ENV } from '../../http/tokens.js';
import {
  claimCodeState,
  findTicketInScope,
  isClosedTicket,
  issueClaimCode,
  resendClaimCode,
  verifyClaimCode,
  type ClaimCodeSecrets,
  type CycleRow,
  type TicketRow,
} from '../../modules/tickets-custody/index.js';
import { venueSettingsFor } from '../../modules/venues-events/index.js';
import { assertChannelAvailable, assertCodeMessageSendable } from '../../modules/whatsapp/index.js';
import { registerClaimCodeHook, type ClaimCodeHook } from '../hooks.js';
import { assertAssignee, auditCommand, eventActor } from '../shared.js';

/** CODE_PEPPER + DATA_ENCRYPTION_KEY of the running process (never stored, never logged). */
export function claimCodeSecrets(env: Env): ClaimCodeSecrets {
  return {
    pepper: env.CODE_PEPPER,
    key: parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID),
  };
}

/** The S2 ClaimCodeHook (use-cases/hooks.ts) filled by tickets-custody's ClaimCodeService (PNT-047). */
export function claimCodeHookFor(secrets: ClaimCodeSecrets): ClaimCodeHook {
  return {
    async issueAtReady(tx, { ticket, cycle, actor }) {
      const row = await issueClaimCode(tx, ticket, cycle, { secrets, actor: eventActor(actor) });
      return { claim_code_id: row.id, expires_at: new Date(row.expires_at).toISOString() };
    },
    async verifyAtHandover(tx, { ticket, cycle, code, actor }) {
      const task = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM tasks WHERE cycle_id = $1 AND status = 'in_progress'`,
        [cycle.id],
      );
      const row = await verifyClaimCode(tx, ticket, cycle, code, {
        pepper: secrets.pepper,
        actor: eventActor(actor),
        userId: actor.userId,
        taskId: task?.id ?? null,
      });
      return { claim_code_id: row.id };
    },
  };
}

/**
 * Registers the claim code hook with this process's secrets when the api module starts (the hook needs
 * CODE_PEPPER and DATA_ENCRYPTION_KEY; the worker never issues or verifies codes).
 */
@Injectable()
export class ClaimCodeHookRegistrar {
  constructor(@Inject(ENV) env: Env) {
    registerClaimCodeHook(claimCodeHookFor(claimCodeSecrets(env)));
  }
}

const RESEND_OP = 'POST /v1/tickets/{ticketId}/handover-code/resend';

/**
 * `POST /v1/tickets/{ticketId}/handover-code/resend` (PNT-047; 11 §5.1 rule 4; 09: the assignee or a
 * supervisor; the ticket `ready` and linked — or an app ticket, whose new code C-12 shows, V2-015 DEC-517). L5 ticket → L6 cycle → L9 codes; no pool lock (the queue is
 * untouched). The checks follow 08 §2: scope → assignee → state (HANDOVER_NOT_READY, WA_*) → code
 * (HANDOVER_CODE_LOCKED for the assignee on a locked code, RESEND_LIMIT_REACHED).
 */
@Injectable()
export class ResendHandoverCodeUseCase {
  private readonly secrets: ClaimCodeSecrets;

  constructor(@Inject(ENV) env: Env) {
    this.secrets = claimCodeSecrets(env);
  }

  async execute(tx: Tx, actor: ActorContext, ticketId: string, requestId: string) {
    await findTicketInScope(tx, actor, ticketId);
    const supervisor = actor.role === 'supervisor';
    const [locked] = await lockTickets(tx, [ticketId]); // L5
    const t = locked as TicketRow;
    if (isClosedTicket(t.status)) throw new AppError('TICKET_CLOSED', { ticket_status: t.status });
    const [cycle] = t.active_cycle_id ? ((await lockCycles(tx, [t.active_cycle_id])) as CycleRow[]) : [null]; // L6
    const task = cycle
      ? await tx.maybeOne<{ id: string; assignee_id: string | null }>(
          `SELECT id, assignee_id FROM tasks WHERE cycle_id = $1 AND status NOT IN ('completed','canceled')`,
          [cycle.id],
        )
      : null;
    if (!cycle || !task) throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });
    if (!supervisor) assertAssignee(actor, task);
    if (t.status !== 'ready') throw new AppError('HANDOVER_NOT_READY', { ticket_status: t.status });

    const customer = t.customer_id
      ? await tx.maybeOne<{ wa_opted_out_at: Date | null }>(
          `SELECT wa_opted_out_at FROM customers WHERE id = $1`,
          [t.customer_id],
        )
      : null;
    // V2-015 (DEC-517): an app ticket's new code is shown on C-12 (no WhatsApp message, no channel to check)
    if (t.channel !== 'app') {
      if (t.channel === 'whatsapp' && (t.wa_link_status === 'opted_out' || customer?.wa_opted_out_at))
        throw new AppError('WA_CUSTOMER_OPTED_OUT');
      if (t.channel !== 'whatsapp' || t.wa_link_status !== 'linked' || !t.customer_id)
        throw new AppError('WA_NOT_LINKED', { wa_link_status: t.wa_link_status });
      await assertChannelAvailable(tx, t.org_id);
      await assertCodeMessageSendable(tx, t.org_id, t.customer_id);
    }

    const { issued, replaced } = await resendClaimCode(tx, t, cycle, {
      secrets: this.secrets,
      actor: eventActor(actor),
      supervisor,
    });
    await auditCommand(tx, actor, {
      action: 'handover.resend_code',
      operation: RESEND_OP,
      entityType: 'ticket',
      entityId: t.id,
      venueId: t.venue_id,
      requestId,
      before: replaced ? { resend_no: replaced.resend_no, locked: !!replaced.locked_at } : null,
      after: { resend_no: issued.resend_no },
      metadata: {
        cycle_id: cycle.id,
        claim_code_id: issued.id,
        replaced_claim_code_id: replaced?.id ?? null,
        reissued_locked: !!replaced?.locked_at,
      },
    });
    const max = (await venueSettingsFor(tx, t.venue_id)).handover.max_resends;
    return claimCodeState(tx, issued, max);
  }
}

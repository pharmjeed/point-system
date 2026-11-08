import { Inject, Injectable } from '@nestjs/common';
import { requireDuty, type ActorContext } from '../core/actor-context/actor-context.js';
import { customerAudit } from '../core/audit/customer-audit.js';
import type { Env } from '../core/config/env.js';
import { newId } from '../core/crypto/ids.js';
import { parseEncryptionKey, type EncryptionKey } from '../core/crypto/crypto.js';
import { lockTickets } from '../core/db/locks.js';
import type { Tx } from '../core/db/tx.js';
import { AppError } from '../core/errors/app-error.js';
import { maskPhone } from '../core/logging/redact.js';
import { assertOperatorOperating } from '../core/operator-status.js';
import { ENV } from '../http/tokens.js';
import { markPassUsed, verifyIntakePass, type VerifiedPass } from '../modules/customer-accounts/index.js';
import { applySubscriptionEntitlement, subscriptionCoverage } from '../modules/subscriptions/index.js';
import {
  assertCreator,
  checkVersion,
  findTicketInScope,
  invalidTransition,
  loadTicketDetail,
  type TicketRow,
} from '../modules/tickets-custody/index.js';
import { auditCommand } from './shared.js';
import { StartIntakeUseCase } from './start-intake.js';

export interface IntakePassBody {
  pass_token: string;
  /** the driver's own draft (D-05): it becomes the app ticket */
  ticket_id?: string;
  expected_version?: number;
  /** without ticket_id only: the event, as in POST /v1/tickets */
  event_id?: string | null;
}

const OPERATION = 'POST /v1/tickets/intake-pass';

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
  vehicle_type: string | null;
}

/** The first word of the account's name: what V2-D12 lets the operator see, never stored on its side. */
export function firstName(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * IntakeByPass (O-01; V2-013/V2-014, DEC-500 … DEC-503). The driver scans the customer's entry pass in D-05:
 *
 * - with `ticket_id`: his own `received` draft (made by «استلام مركبة» in D-04, which already holds the number, the
 *   park task and the custody) becomes the app ticket — the path D-05 uses;
 * - without: the ticket is created by StartIntake first (L1 … L8, `POST /v1/tickets` unchanged), then linked.
 *
 * Order: the duty and the operator (`organizations` FOR SHARE, OPERATOR_SUSPENDED — also for a draft: a pass intake
 * is a new customer link, DEC-500), the reference the body names (scope before the pass, 07 §1.10), the pass
 * (account FOR SHARE → pass FOR NO KEY UPDATE, before L1/L5), then L5 on the draft. The ticket gets
 * `channel = app`, `wa_link_status = none`, the operator's `customers` row of the account (found by
 * `customer_account_id`, else by phone and linked, else created with the phone and language only: V2-D12) and, when
 * the chosen vehicle is in the account, `customer_vehicle_id` and the vehicle fields; otherwise the driver enters the
 * vehicle by hand (01 §4). The entitlement stays the one decided when the ticket was created (DEC-502). No W-01 and no
 * WhatsApp message ever for this ticket (DEC-503). The pass step is consumed; audit_log and customer_audit_log.
 */
@Injectable()
export class IntakePassUseCase {
  private readonly keys: EncryptionKey[];

  constructor(
    private readonly startIntake: StartIntakeUseCase,
    @Inject(ENV) env: Env,
  ) {
    this.keys = [parseEncryptionKey(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID)];
  }

  async execute(tx: Tx, actor: ActorContext, body: IntakePassBody, requestId: string) {
    const duty = requireDuty(actor);
    if (body.ticket_id !== undefined && body.expected_version === undefined)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'expected_version', issue: 'required_with_ticket_id' }],
      });
    if (body.ticket_id !== undefined && body.event_id !== undefined)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'event_id', issue: 'not_with_ticket_id' }],
      });
    await assertOperatorOperating(tx, actor.orgId);

    // the reference the body names is resolved first: a foreign or unknown one answers as not found
    if (body.ticket_id !== undefined) {
      const pre = await findTicketInScope(tx, actor, body.ticket_id);
      if (pre.dispatch_pool_id !== duty.poolId) throw new AppError('DUTY_REQUIRED');
      assertCreator(actor, pre);
    } else if (body.event_id) {
      const ev = await tx.maybeOne<{ venue_id: string }>(
        `SELECT venue_id FROM events WHERE id = $1 AND org_id = $2`,
        [body.event_id, actor.orgId],
      );
      if (!ev || ev.venue_id !== duty.venueId)
        throw new AppError('RESOURCE_NOT_FOUND', { resource: 'event' });
    }

    const pass = await verifyIntakePass(tx, this.keys, body.pass_token);

    let ticket: TicketRow;
    let started: Awaited<ReturnType<StartIntakeUseCase['execute']>> | null = null;
    if (body.ticket_id !== undefined) {
      const [locked] = await lockTickets(tx, [body.ticket_id]); // L5
      ticket = locked as TicketRow;
      checkVersion('ticket', ticket, body.expected_version!);
      if (ticket.status !== 'received') throw invalidTransition('ticket', ticket, OPERATION, ['received']);
      const liveLink = await tx.maybeOne(
        `SELECT 1 FROM link_codes WHERE ticket_id = $1 AND status IN ('active','pending_confirmation','consumed') LIMIT 1`,
        [ticket.id],
      );
      if (
        ticket.channel === 'app' ||
        ticket.customer_id ||
        ticket.paper_serial ||
        ticket.wa_link_status !== 'none' ||
        liveLink
      )
        throw invalidTransition('ticket', ticket, OPERATION, ['received'], 'customer_channel_set');
    } else {
      started = await this.startIntake.execute(tx, actor, { event_id: body.event_id ?? null }, requestId);
      // inserted by this transaction: already ours, no lock to take
      ticket = await tx.one<TicketRow>(`SELECT * FROM tickets WHERE id = $1`, [started.ticket!.id]);
    }

    const customerId = await customerRowOf(tx, ticket.org_id, pass);
    const vehicle = pass.vehicleId
      ? await tx.maybeOne<VehicleRow>(
          `SELECT id, plate_country, plate_digits, plate_letters_ar, plate_letters_en, plate_raw, vehicle_make,
                  vehicle_model, vehicle_color, vehicle_type
             FROM customer_vehicles WHERE id = $1 AND account_id = $2 AND removed_at IS NULL`,
          [pass.vehicleId, pass.accountId],
        )
      : null;

    const sets: Record<string, unknown> = {
      channel: 'app',
      customer_id: customerId,
      customer_vehicle_id: vehicle?.id ?? null,
    };
    if (vehicle)
      Object.assign(sets, {
        plate_country: vehicle.plate_country,
        plate_digits: vehicle.plate_digits,
        plate_letters_ar: vehicle.plate_letters_ar,
        plate_letters_en: vehicle.plate_letters_en,
        plate_raw: vehicle.plate_raw,
        vehicle_make: vehicle.vehicle_make,
        vehicle_model: vehicle.vehicle_model,
        vehicle_color: vehicle.vehicle_color,
        vehicle_type: vehicle.vehicle_type,
      });
    const cols = Object.keys(sets);
    const updated = await tx.one<TicketRow>(
      `UPDATE tickets SET ${[...cols.map((c, i) => `${c} = $${i + 3}`), 'version = version + 1'].join(', ')}
        WHERE id = $1 AND version = $2 RETURNING *`,
      [ticket.id, ticket.version, ...cols.map((c) => sets[c])],
    );
    await markPassUsed(tx, pass.accountId, pass.step);
    // V2-033 (docs/v2/04 §2 rule 1, DEC-535): the account's active subscription at this venue covering the scanned
    // vehicle makes the visit the subscription's (the badge «مشترك {brand}», nothing due at the handover); «إتمام التسجيل»
    // decides again with the final plate. The driver learns only covered / not covered (01 §4), never the plan.
    const coverage = await subscriptionCoverage(tx, updated);
    const entitlementChange = await applySubscriptionEntitlement(tx, updated);
    const final = entitlementChange
      ? await tx.one<TicketRow>(`SELECT * FROM tickets WHERE id = $1`, [ticket.id])
      : updated;

    await auditCommand(tx, actor, {
      action: 'ticket.intake',
      operation: OPERATION,
      entityType: 'ticket',
      entityId: ticket.id,
      venueId: ticket.venue_id,
      requestId,
      before: { version: ticket.version, channel: ticket.channel },
      after: {
        version: final.version,
        channel: 'app',
        entitlement: final.entitlement,
        subscription_id: final.subscription_id ?? null,
      },
      metadata: {
        method: started ? 'pass_new_ticket' : 'pass_draft',
        subscription: coverage.covered ? 'covered' : coverage.reason,
        vehicle_prefilled: !!vehicle,
        vehicle_chosen: pass.vehicleId !== null,
        pass_step: pass.step,
      },
    });
    await customerAudit(tx, {
      actor: { type: 'system', name: 'staff_intake' },
      accountId: pass.accountId,
      action: 'customer.pass.used',
      entityType: 'ticket',
      entityId: ticket.id,
      requestId,
      metadata: { venue_id: ticket.venue_id, org_id: ticket.org_id, vehicle_prefilled: !!vehicle },
    });

    const result = {
      ticket: await loadTicketDetail(tx, ticket.id, { userId: actor.userId, role: actor.role }),
      customer: {
        first_name: firstName(pass.displayName),
        phone_masked: maskPhone(pass.phoneE164),
        vehicle_prefilled: !!vehicle,
        // V2-033 (01 §4): «مشترك — هذه السيارة غير مشمولة» when the account subscribes here for another vehicle
        subscription: coverage.covered
          ? ('covered' as const)
          : coverage.reason === 'vehicle_not_covered' || coverage.reason === 'open_ticket'
            ? coverage.reason
            : null,
      },
    };
    return started ? { ...result, task: started.task, driver_state: started.driver_state } : result;
  }
}

/**
 * The operator's `customers` row of the account (V2-D12: one per operator and account, uq_customers_org_account): the
 * linked one, else the row of the same phone (an earlier WhatsApp customer of this operator) now linked, else a new
 * row with the phone and the language only — the operator keeps no name, no other operator's data.
 */
async function customerRowOf(tx: Tx, orgId: string, pass: VerifiedPass): Promise<string> {
  const linked = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM customers WHERE org_id = $1 AND customer_account_id = $2`,
    [orgId, pass.accountId],
  );
  if (linked) return linked.id;
  const row = await tx.one<{ id: string }>(
    `INSERT INTO customers (id, org_id, phone_e164, locale, customer_account_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (org_id, phone_e164) DO UPDATE SET customer_account_id = EXCLUDED.customer_account_id
     RETURNING id`,
    [newId(), orgId, pass.phoneE164, pass.locale, pass.accountId, tx.now],
  );
  return row.id;
}

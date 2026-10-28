import { WaChannelModeSchema } from '@point/shared';
import { z } from 'zod';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  activeChannel,
  channelView,
  SECRET_REF_PATTERN,
  type ChannelRow,
  type Queryable,
} from '../infra/channel.js';
import type { WhatsappRuntime } from '../runtime.js';

const SecretRef = z
  .string()
  .trim()
  .regex(SECRET_REF_PATTERN, 'must be a secret reference (env://NAME or sm://path), never a value');

/** Body of `PUT /v1/admin/whatsapp/channel` (07_openapi, additionalProperties: false). */
export const WhatsappChannelPutBody = z.strictObject({
  display_name: z.string().trim().min(1).max(60).optional(),
  business_account_id: z.string().trim().min(1).max(64),
  phone_number_id: z.string().trim().min(1).max(64),
  phone_display: z.string().trim().max(32).nullable().optional(),
  api_version: z.string().regex(/^v[0-9]+\.[0-9]+$/),
  mode: WaChannelModeSchema,
  access_token_secret_ref: SecretRef,
  app_secret_ref: SecretRef,
  verify_token_secret_ref: SecretRef,
});
export type WhatsappChannelPutBody = z.infer<typeof WhatsappChannelPutBody>;

/** Audit diff of a channel: no secret references (redact() masks them anyway). */
function auditView(ch: ChannelRow) {
  return {
    phone_number_id: ch.phone_number_id,
    business_account_id: ch.business_account_id,
    api_version: ch.api_version,
    mode: ch.mode,
    is_active: ch.is_active,
    display_name: ch.display_name,
  };
}

/** PNT-038 — the single active channel (uq_whatsapp_channel_active), references only, owner-managed. */
export class WhatsappChannelAdmin {
  constructor(private readonly rt: WhatsappRuntime) {}

  async get(q: Queryable, actor: ActorContext) {
    const ch = await activeChannel(q, actor.orgId);
    if (!ch) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'whatsapp_channel' });
    return channelView(ch, this.rt.secretEnv);
  }

  /**
   * Full replacement of the active row, or its creation the first time (07 §2.7). The same number is
   * updated in place; a different number deactivates the old row first, so history keeps pointing at
   * the channel that carried it. A concurrent second activation hits uq_whatsapp_channel_active →
   * INVALID_STATE_TRANSITION (reason channel_already_active, 08 §5.1).
   */
  async put(tx: Tx, actor: ActorContext, body: WhatsappChannelPutBody, requestId: string) {
    if (body.mode !== this.rt.env.WA_MODE) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ field: 'mode', issue: 'wa_mode_mismatch', message: `WA_MODE is ${this.rt.env.WA_MODE}` }],
      });
    }
    const current = await tx.maybeOne<ChannelRow>(
      `SELECT * FROM whatsapp_channel WHERE org_id = $1 AND is_active FOR NO KEY UPDATE`,
      [actor.orgId],
    );
    const displayName = body.display_name ?? current?.display_name ?? this.rt.env.BRAND_CUSTOMER_NAME_AR;
    const values = [
      displayName,
      body.business_account_id,
      body.phone_number_id,
      body.phone_display ?? null,
      body.access_token_secret_ref,
      body.app_secret_ref,
      body.verify_token_secret_ref,
      body.api_version,
      body.mode,
    ];
    let row: ChannelRow;
    if (
      current &&
      current.phone_number_id === body.phone_number_id &&
      current.business_account_id === body.business_account_id
    ) {
      row = await tx.one<ChannelRow>(
        `UPDATE whatsapp_channel SET display_name = $2, business_account_id = $3, phone_number_id = $4, phone_display = $5,
                access_token_secret_ref = $6, app_secret_ref = $7, verify_token_secret_ref = $8, api_version = $9, mode = $10
          WHERE id = $1 RETURNING *`,
        [current.id, ...values],
      );
    } else {
      if (current)
        await tx.query(`UPDATE whatsapp_channel SET is_active = false WHERE id = $1`, [current.id]);
      row = await tx.one<ChannelRow>(
        `INSERT INTO whatsapp_channel (org_id, display_name, business_account_id, phone_number_id, phone_display,
                access_token_secret_ref, app_secret_ref, verify_token_secret_ref, api_version, mode, is_active, health_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'healthy', $11, $11) RETURNING *`,
        [actor.orgId, ...values, tx.now],
      );
    }
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'wa.channel_manage',
      entityType: 'whatsapp_channel',
      entityId: row.id,
      requestId,
      before: current ? auditView(current) : null,
      after: auditView(row),
      metadata: current && current.id !== row.id ? { replaced_channel_id: current.id } : null,
    });
    this.rt.channels.invalidate();
    return channelView(row, this.rt.secretEnv);
  }
}

import type { Tx } from '../../../core/db/tx.js';

/** Who sent an inbound message (12 §6.4); any field may be missing for a username user (F-21). */
export interface WaSenderIdentity {
  /** contacts[].wa_id (falls back to messages[].from) */
  waId: string | null;
  /** BSUID: contacts[].user_id / messages[].from_user_id (DEC-35) */
  userId: string | null;
  /** '+' + from, when it is a valid E.164 number */
  phoneE164: string | null;
}

export interface CustomerRow {
  id: string;
  org_id: string;
  phone_e164: string | null;
  wa_id: string | null;
  wa_user_id: string | null;
  locale: string;
  last_inbound_at: Date | null;
  wa_opted_out_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** customers_phone_e164_check */
export function phoneFromWaId(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const d = digits.replace(/\D/g, '');
  return /^[1-9][0-9]{7,14}$/.test(d) ? `+${d}` : null;
}

/**
 * Inbound sender → customer (PNT-041, DEC-35). Matches by wa_id, then BSUID, then phone; fills the
 * identifiers that are still empty unless another customer already owns them (uq_customers_wa_id /
 * uq_customers_wa_user_id: link to the existing customer and log, 08 §5.1); `last_inbound_at` is the
 * message time and never moves backwards. The caller holds the per-sender advisory lock.
 */
export async function upsertInboundCustomer(
  tx: Tx,
  orgId: string,
  s: WaSenderIdentity,
  at: Date,
): Promise<CustomerRow> {
  const phone = s.phoneE164 ?? phoneFromWaId(s.waId);
  for (let round = 0; round < 3; round++) {
    const found = await tx.rows<CustomerRow>(
      `SELECT * FROM customers
        WHERE org_id = $1 AND (($2::text IS NOT NULL AND wa_id = $2) OR ($3::text IS NOT NULL AND wa_user_id = $3)
                               OR ($4::text IS NOT NULL AND phone_e164 = $4))
        ORDER BY created_at, id`,
      [orgId, s.waId, s.userId, phone],
    );
    const best =
      found.find((c) => s.waId && c.wa_id === s.waId) ??
      found.find((c) => s.userId && c.wa_user_id === s.userId) ??
      found.find((c) => phone && c.phone_e164 === phone);
    if (best) {
      const others = found.filter((c) => c.id !== best.id);
      const setWa = !best.wa_id && s.waId && !others.some((c) => c.wa_id === s.waId) ? s.waId : null;
      const setUser =
        !best.wa_user_id && s.userId && !others.some((c) => c.wa_user_id === s.userId) ? s.userId : null;
      const setPhone =
        !best.phone_e164 && phone && !others.some((c) => c.phone_e164 === phone) ? phone : null;
      return tx.one<CustomerRow>(
        `UPDATE customers SET wa_id = COALESCE(wa_id, $2), wa_user_id = COALESCE(wa_user_id, $3),
                phone_e164 = COALESCE(phone_e164, $4),
                last_inbound_at = GREATEST(COALESCE(last_inbound_at, $5::timestamptz), $5::timestamptz)
          WHERE id = $1 RETURNING *`,
        [best.id, setWa, setUser, setPhone, at],
      );
    }
    if (!phone && !s.userId)
      throw new Error('an inbound sender needs a phone or a BSUID (ck_customers_identifier)');
    // any unique conflict (a concurrent insert of the same person) → look up again
    const inserted = await tx.maybeOne<CustomerRow>(
      `INSERT INTO customers (org_id, phone_e164, wa_id, wa_user_id, last_inbound_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT DO NOTHING RETURNING *`,
      [orgId, phone, s.waId, s.userId, at, tx.now],
    );
    if (inserted) return inserted;
  }
  throw new Error('customer upsert did not converge');
}

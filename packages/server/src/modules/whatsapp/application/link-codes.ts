import { randomInt } from 'node:crypto';
import { renderWaText, waCatalog } from '@point/shared';
import type { Tx } from '../../../core/db/tx.js';
import { LINK_CODE_ALPHABET } from '../domain/inbound-text.js';

/** A 6-character code from the unambiguous alphabet (no 0/O/1/I), `link_codes_code_check`. */
export function newLinkCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += LINK_CODE_ALPHABET[randomInt(0, LINK_CODE_ALPHABET.length)];
  return s;
}

export interface LinkCodeRow {
  id: string;
  org_id: string;
  ticket_id: string;
  code: string;
  status: 'active' | 'pending_confirmation' | 'consumed' | 'expired' | 'revoked';
  created_by: string;
  created_at: Date;
  expires_at: Date;
  inbound_message_id: string | null;
  inbound_wa_id: string | null;
  inbound_user_id: string | null;
  inbound_phone_e164: string | null;
  revoke_reason: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
}

/** The live code with this value (uq_link_codes_live_code), locked (L9) for the caller's update. */
export async function lockLiveLinkCode(tx: Tx, orgId: string, code: string): Promise<LinkCodeRow | null> {
  return tx.maybeOne<LinkCodeRow>(
    `SELECT * FROM link_codes WHERE org_id = $1 AND code = $2 AND status IN ('active','pending_confirmation')
      FOR NO KEY UPDATE`,
    [orgId, code],
  );
}

/**
 * `https://wa.me/{digits}?text=…` (12 §7.2) — the QR on D-07; scanning it alone sends nothing. The text
 * names the configured customer brand (`BRAND_CUSTOMER_NAME_AR`, DEC-470).
 */
export function waMeLink(
  displayPhoneE164: string,
  code: string,
  customerBrandAr: string,
): { url: string; prefilled_text: string } {
  const text = renderWaText(waCatalog(customerBrandAr).linkPrefilledText, [code]);
  return {
    url: `https://wa.me/${displayPhoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`,
    prefilled_text: text,
  };
}

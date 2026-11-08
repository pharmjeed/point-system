import { SEED_IDS } from '@point/db/seed';
import { WA_TEMPLATE_DEFINITIONS, type WaTemplateStatus } from '@point/shared';
import type { Database } from '@point/server';

/**
 * The W-01 … W-08 catalog as `whatsapp_templates` rows with `status` (default `approved`) — what
 * `POST /v1/admin/whatsapp/templates/sync` leaves once Meta approved them. For tests that submit a direct
 * WhatsApp link without the simulator (PNT-043 refuses it with WA_TEMPLATE_NOT_APPROVED otherwise).
 */
export async function approveWaTemplates(
  db: Pick<Database, 'query'>,
  opts: { status?: WaTemplateStatus; names?: readonly string[] } = {},
): Promise<void> {
  for (const def of WA_TEMPLATE_DEFINITIONS) {
    if (opts.names && !opts.names.includes(def.name)) continue;
    await db.query(
      `INSERT INTO whatsapp_templates (org_id, name, language, category, status, components)
       VALUES ($1, $2, 'ar', 'UTILITY', $3, $4)
       ON CONFLICT (org_id, name, language) DO UPDATE SET status = EXCLUDED.status, version = whatsapp_templates.version + 1`,
      [SEED_IDS.org, def.name, opts.status ?? 'approved', JSON.stringify(def.components)],
    );
  }
}

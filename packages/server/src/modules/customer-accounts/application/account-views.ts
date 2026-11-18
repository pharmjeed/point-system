import {
  CUSTOMER_PROFILE_CONSENT_KINDS,
  maskPhone,
  type CustomerConsentState,
  type CustomerMe,
  type CustomerProfileConsentKind,
} from '@point/shared/customer';
import type { Env } from '../../../core/config/env.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';

type Q = Pick<Database, 'query'> | Pick<Tx, 'query'>;

export interface CustomerAccountRow {
  id: string;
  /** NULL once deleted (0011): only `phone_hash` remains */
  phone_e164: string | null;
  phone_hash: string | null;
  display_name: string | null;
  locale: 'ar' | 'en';
  status: 'active' | 'suspended' | 'deleted';
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The text versions in force and their public pages (configuration, DEC-498). */
export interface ConsentTexts {
  versions: Readonly<Record<CustomerProfileConsentKind, string>>;
  urls: Readonly<Record<CustomerProfileConsentKind, string | null>>;
}

export function consentTexts(env: Env): ConsentTexts {
  return {
    versions: {
      terms: env.CUSTOMER_TERMS_VERSION,
      privacy: env.CUSTOMER_PRIVACY_VERSION,
      marketing: env.CUSTOMER_MARKETING_VERSION,
    },
    urls: {
      terms: env.CUSTOMER_TERMS_URL || null,
      privacy: env.CUSTOMER_PRIVACY_URL || null,
      marketing: env.CUSTOMER_MARKETING_URL || null,
    },
  };
}

interface ConsentRow {
  kind: CustomerProfileConsentKind;
  version: string;
  granted: boolean;
  created_at: Date;
}

/**
 * `CustomerMe` (DEC-482) computed by the server: each consent is the latest answer of its kind (append-only rows,
 * highest id), `granted` only when that answer is for the version in force; `profile_complete` = a display name and
 * terms + privacy granted at their current version.
 */
export async function buildCustomerMe(q: Q, texts: ConsentTexts, accountId: string): Promise<CustomerMe> {
  const a = (await q.query<CustomerAccountRow>(`SELECT * FROM customer_accounts WHERE id = $1`, [accountId]))
    .rows[0];
  if (!a) throw new AppError('AUTH_UNAUTHENTICATED');
  if (a.status === 'deleted' || a.phone_e164 === null) throw new AppError('ACCOUNT_DELETED');
  const phone = a.phone_e164;
  const latest = (
    await q.query<ConsentRow>(
      `SELECT DISTINCT ON (kind) kind, version, granted, created_at FROM customer_account_consents
        WHERE account_id = $1 AND kind = ANY($2) ORDER BY kind, id DESC`,
      [accountId, [...CUSTOMER_PROFILE_CONSENT_KINDS]],
    )
  ).rows;
  const vehicles = (
    await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM customer_vehicles WHERE account_id = $1 AND removed_at IS NULL`,
      [accountId],
    )
  ).rows[0]!.n;
  const state = (kind: CustomerProfileConsentKind): CustomerConsentState => {
    const row = latest.find((r) => r.kind === kind);
    const current = texts.versions[kind];
    return {
      kind,
      current_version: current,
      granted: row && row.version === current ? row.granted : null,
      answered_version: row?.version ?? null,
      answered_at: row ? row.created_at.toISOString() : null,
      document_url: texts.urls[kind],
    };
  };
  const consents = { terms: state('terms'), privacy: state('privacy'), marketing: state('marketing') };
  return {
    id: a.id,
    phone_e164: phone,
    phone_masked: maskPhone(phone),
    display_name: a.display_name,
    locale: a.locale,
    status: a.status,
    consents,
    profile_complete:
      a.display_name !== null && consents.terms.granted === true && consents.privacy.granted === true,
    vehicles_count: vehicles,
    created_at: a.created_at.toISOString(),
  };
}

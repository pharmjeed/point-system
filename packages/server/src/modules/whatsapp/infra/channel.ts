import type pg from 'pg';
import type { WaChannelMode, WaHealthStatus } from '@point/shared';
import type { SecretResolver } from '../../../core/secrets/secret-resolver.js';
import type { GraphPhoneNumber } from './graph-client.js';

export type Queryable = {
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
};

export interface ChannelRow {
  id: string;
  org_id: string;
  display_name: string;
  business_account_id: string;
  phone_number_id: string;
  phone_display: string | null;
  access_token_secret_ref: string;
  app_secret_ref: string;
  verify_token_secret_ref: string;
  api_version: string;
  mode: WaChannelMode;
  is_active: boolean;
  health_status: WaHealthStatus;
  health_changed_at: Date | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The single active channel of an organization (uq_whatsapp_channel_active). */
export async function activeChannel(q: Queryable, orgId: string): Promise<ChannelRow | null> {
  const r = await q.query<ChannelRow>(`SELECT * FROM whatsapp_channel WHERE org_id = $1 AND is_active`, [
    orgId,
  ]);
  return r.rows[0] ?? null;
}

export interface PhoneNumberFacts {
  quality_rating: string | null;
  messaging_limit_tier: string | null;
}

const META_ENUM = /^[A-Z0-9_]{1,32}$/;
const metaEnum = (v: unknown) => (typeof v === 'string' && META_ENUM.test(v) ? v : null);

/**
 * The descriptive fields of `GET /{phone_number_id}` kept on the channel (12 §3.1): the quality rating and the
 * messaging limit, read from the current `whatsapp_business_manager_messaging_limit` (F-18) before the legacy
 * `messaging_limit_tier`. Anything that is not a Meta enum value is ignored.
 */
export function phoneNumberFacts(body: GraphPhoneNumber | null | undefined): PhoneNumberFacts {
  return {
    quality_rating: metaEnum(body?.quality_rating),
    messaging_limit_tier:
      metaEnum(body?.whatsapp_business_manager_messaging_limit) ?? metaEnum(body?.messaging_limit_tier),
  };
}

/**
 * Stores those facts on the channel row when they changed; a missing value keeps the stored one. One statement:
 * callers outside a transaction (the sender's probe) commit it at once, a command transaction keeps it with its own
 * changes (the template sync).
 */
export async function storePhoneNumberFacts(
  q: Queryable,
  channelId: string,
  facts: PhoneNumberFacts,
): Promise<boolean> {
  if (!facts.quality_rating && !facts.messaging_limit_tier) return false;
  const r = await q.query(
    `UPDATE whatsapp_channel SET quality_rating = COALESCE($2, quality_rating),
            messaging_limit_tier = COALESCE($3, messaging_limit_tier)
      WHERE id = $1 AND (quality_rating IS DISTINCT FROM COALESCE($2, quality_rating)
                         OR messaging_limit_tier IS DISTINCT FROM COALESCE($3, messaging_limit_tier))`,
    [channelId, facts.quality_rating, facts.messaging_limit_tier],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function activeChannels(q: Queryable): Promise<ChannelRow[]> {
  return (await q.query<ChannelRow>(`SELECT * FROM whatsapp_channel WHERE is_active ORDER BY created_at, id`))
    .rows;
}

/** `env://NAME` or `sm://path` (05 §7.7): references only, a raw secret is refused by validation. */
export const SECRET_REF_PATTERN = /^(env:\/\/[A-Z_][A-Z0-9_]{0,127}|sm:\/\/[A-Za-z0-9_./:-]{1,256})$/;

/**
 * Whether a reference points at something (07 `secrets_configured`): `env://` refs are checked locally;
 * `sm://` refs cannot be checked without calling the secret manager (never inside a transaction), so a
 * well-formed reference counts as configured and is verified at use.
 */
export function isSecretConfigured(
  ref: string | null | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (!ref || !SECRET_REF_PATTERN.test(ref)) return false;
  if (ref.startsWith('env://')) return !!env[ref.slice('env://'.length)];
  return true;
}

export interface ChannelView {
  id: string;
  display_name: string;
  business_account_id: string;
  phone_number_id: string;
  phone_display: string | null;
  api_version: string;
  mode: WaChannelMode;
  is_active: boolean;
  health_status: WaHealthStatus;
  health_changed_at: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  secrets_configured: { access_token: boolean; app_secret: boolean; verify_token: boolean };
}

/** WhatsAppChannel of 07: never the secret references nor their values (PNT-038 AC2). */
export function channelView(ch: ChannelRow, env: Record<string, string | undefined>): ChannelView {
  return {
    id: ch.id,
    display_name: ch.display_name,
    business_account_id: ch.business_account_id,
    phone_number_id: ch.phone_number_id,
    phone_display: ch.phone_display,
    api_version: ch.api_version,
    mode: ch.mode,
    is_active: ch.is_active,
    health_status: ch.health_status,
    health_changed_at: ch.health_changed_at ? new Date(ch.health_changed_at).toISOString() : null,
    quality_rating: ch.quality_rating,
    messaging_limit_tier: ch.messaging_limit_tier,
    secrets_configured: {
      access_token: isSecretConfigured(ch.access_token_secret_ref, env),
      app_secret: isSecretConfigured(ch.app_secret_ref, env),
      verify_token: isSecretConfigured(ch.verify_token_secret_ref, env),
    },
  };
}

/**
 * App secrets accepted for X-Hub-Signature-256 (12 §3.3): the channel's current secret and, during a
 * rotation, WA_APP_SECRET_PREVIOUS_REF (24 h).
 */
export async function webhookAppSecrets(
  secrets: SecretResolver,
  ch: Pick<ChannelRow, 'app_secret_ref'>,
  previousRef: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const ref of [ch.app_secret_ref, previousRef]) {
    if (!ref) continue;
    try {
      const v = await secrets.resolve(ref);
      if (v && !out.includes(v)) out.push(v);
    } catch {
      // an unreadable reference never verifies a signature
    }
  }
  return out;
}

/**
 * Short-lived cache of the active channels for the webhook endpoint (12 §6.2 step 5: the handler does
 * nothing but verify and store). Invalidated by PUT /v1/admin/whatsapp/channel in the same process.
 */
export class ActiveChannelCache {
  private value: { at: number; rows: ChannelRow[] } | null = null;
  constructor(private readonly ttlMs = 5000) {}

  async get(q: Queryable): Promise<ChannelRow[]> {
    const now = Date.now();
    if (this.value && now - this.value.at < this.ttlMs) return this.value.rows;
    const rows = await activeChannels(q);
    this.value = { at: now, rows };
    return rows;
  }

  invalidate(): void {
    this.value = null;
  }
}

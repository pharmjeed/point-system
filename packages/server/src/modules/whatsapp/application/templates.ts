import {
  WA_TEMPLATE_DEFINITIONS,
  WA_TEMPLATE_NAMES,
  type WaTemplateCategory,
  type WaTemplateCreation,
  type WaTemplateStatus,
} from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { classifyGraphFailure, type GraphFailure } from '../domain/graph-errors.js';
import { activeChannel, type ChannelRow, type Queryable } from '../infra/channel.js';
import type { GraphTemplate } from '../infra/graph-client.js';
import type { WhatsappRuntime } from '../runtime.js';
import { setChannelHealth } from './channel-health.js';

export interface TemplateRow {
  id: string;
  org_id: string;
  name: string;
  language: string;
  category: WaTemplateCategory;
  status: WaTemplateStatus;
  components: unknown[];
  meta_template_id: string | null;
  rejection_reason: string | null;
  version: number;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** WhatsAppTemplate of 07. */
export function templateView(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    components: t.components,
    meta_template_id: t.meta_template_id,
    rejection_reason: t.rejection_reason,
    version: t.version,
    last_synced_at: t.last_synced_at ? new Date(t.last_synced_at).toISOString() : null,
  };
}

/** Meta status → whatsapp_templates.status (06). */
export function templateStatusFromMeta(status: string | null | undefined): WaTemplateStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'PAUSED':
      return 'paused';
    case 'DISABLED':
    case 'DELETED':
    case 'PENDING_DELETION':
      return 'disabled';
    default:
      return 'pending';
  }
}

function categoryFromMeta(c: string | null | undefined): WaTemplateCategory {
  const v = (c ?? 'UTILITY').toUpperCase();
  return v === 'MARKETING' || v === 'AUTHENTICATION' ? v : 'UTILITY';
}

/** Send gate (12 §5.4, L-05): only an `approved` row of (org, name, ar) may be sent. */
export async function templateStatus(
  q: Queryable,
  orgId: string,
  name: string,
): Promise<WaTemplateStatus | null> {
  const r = await q.query<{ status: WaTemplateStatus }>(
    `SELECT status FROM whatsapp_templates WHERE org_id = $1 AND name = $2 AND language = 'ar'`,
    [orgId, name],
  );
  return r.rows[0]?.status ?? null;
}

/** Remote state of one catalog template, fetched outside any transaction. */
export interface RemoteTemplate {
  definition: WaTemplateCreation;
  remote: GraphTemplate | null;
  /** created during this sync because Meta did not have it */
  created: boolean;
}

export interface RemoteSync {
  channelId: string;
  templates: RemoteTemplate[];
}

function syncError(f: GraphFailure, ch: ChannelRow): AppError {
  if (f.kind === 'timeout') return new AppError('DEPENDENCY_TIMEOUT', { dependency: 'whatsapp' });
  const c = classifyGraphFailure(f);
  if (f.kind === 'network' || c.retryable || c.cls === 'channel')
    return new AppError(
      'WA_CHANNEL_UNAVAILABLE',
      { health_status: ch.health_status, since: ch.health_changed_at, provider_error_code: c.providerCode },
      { retryAfterS: 30 },
    );
  return new AppError('WA_SEND_FAILED', { provider_error_code: c.providerCode });
}

/** PNT-039 — template rows, sync with `/{waba_id}/message_templates`, the approval gate. */
export class WhatsappTemplates {
  constructor(private readonly rt: WhatsappRuntime) {}

  async list(q: Queryable, orgId: string) {
    const rows = (
      await q.query<TemplateRow>(
        `SELECT * FROM whatsapp_templates WHERE org_id = $1 ORDER BY name, language`,
        [orgId],
      )
    ).rows;
    const order = (n: string) => {
      const i = (WA_TEMPLATE_NAMES as readonly string[]).indexOf(n);
      return i < 0 ? WA_TEMPLATE_NAMES.length : i;
    };
    return rows
      .sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))
      .map(templateView);
  }

  /**
   * Network phase (never inside a transaction): reads the remote catalog and creates the W-01 … W-08
   * definitions Meta does not have yet (12 §8.1). Timeout → DEPENDENCY_TIMEOUT; channel down, 5xx or a
   * channel-class error → WA_CHANNEL_UNAVAILABLE; other Graph errors → WA_SEND_FAILED (08 §4.13).
   */
  async fetchRemote(q: Queryable, orgId: string): Promise<RemoteSync> {
    const ch = await activeChannel(q, orgId);
    if (!ch) throw new AppError('RESOURCE_NOT_FOUND', { resource: 'whatsapp_channel' });
    if (ch.health_status === 'down')
      throw new AppError(
        'WA_CHANNEL_UNAVAILABLE',
        {
          health_status: 'down',
          since: ch.health_changed_at ? new Date(ch.health_changed_at).toISOString() : null,
        },
        { retryAfterS: 30 },
      );
    const token = await this.rt.secrets.resolve(ch.access_token_secret_ref).catch(() => null);
    if (!token)
      throw new AppError('WA_CHANNEL_UNAVAILABLE', {
        health_status: ch.health_status,
        reason: 'access_token',
      });
    const list = await this.rt.graph.listTemplates(ch, token);
    if (!list.ok) throw syncError(list, ch);
    const remote = list.body.data ?? [];
    const templates: RemoteTemplate[] = [];
    for (const definition of WA_TEMPLATE_DEFINITIONS) {
      let found =
        remote.find((t) => t.name === definition.name && t.language === definition.language) ?? null;
      let created = false;
      if (!found) {
        const r = await this.rt.graph.createTemplate(ch, token, definition);
        if (!r.ok) throw syncError(r, ch);
        found = {
          id: r.body.id,
          name: definition.name,
          language: definition.language,
          status: r.body.status ?? 'PENDING',
          category: r.body.category ?? definition.category,
        };
        created = true;
      }
      templates.push({ definition, remote: found, created });
    }
    return { channelId: ch.id, templates };
  }

  /** DB phase, inside the command transaction: upsert rows (whatsapp_templates_org_id_name_language_key). */
  async applySync(tx: Tx, actor: ActorContext, sync: RemoteSync, requestId: string) {
    const changed: { name: string; from: string | null; to: string }[] = [];
    let degraded: string | null = null;
    for (const t of sync.templates) {
      const status = templateStatusFromMeta(t.remote?.status);
      const category = categoryFromMeta(t.remote?.category ?? t.definition.category);
      const components =
        Array.isArray(t.remote?.components) && t.remote.components.length
          ? t.remote.components
          : t.definition.components;
      const before = await tx.maybeOne<{ status: string; category: string }>(
        `SELECT status, category FROM whatsapp_templates WHERE org_id = $1 AND name = $2 AND language = $3`,
        [actor.orgId, t.definition.name, t.definition.language],
      );
      await tx.query(
        `INSERT INTO whatsapp_templates (org_id, name, language, category, status, components, meta_template_id, rejection_reason, last_synced_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
         ON CONFLICT (org_id, name, language) DO UPDATE SET
           category = EXCLUDED.category, status = EXCLUDED.status, components = EXCLUDED.components,
           meta_template_id = COALESCE(EXCLUDED.meta_template_id, whatsapp_templates.meta_template_id),
           rejection_reason = EXCLUDED.rejection_reason, last_synced_at = EXCLUDED.last_synced_at,
           version = whatsapp_templates.version
             + CASE WHEN whatsapp_templates.status IS DISTINCT FROM EXCLUDED.status
                      OR whatsapp_templates.category IS DISTINCT FROM EXCLUDED.category THEN 1 ELSE 0 END`,
        [
          actor.orgId,
          t.definition.name,
          t.definition.language,
          category,
          status,
          JSON.stringify(components),
          t.remote?.id ?? null,
          status === 'rejected' ? (t.remote?.rejected_reason ?? 'REJECTED') : null,
          tx.now,
        ],
      );
      if (!before || before.status !== status || before.category !== category)
        changed.push({ name: t.definition.name, from: before?.status ?? null, to: status });
      // a catalog template that is not approved UTILITY degrades the channel (12 §6.9)
      if (status !== 'approved' || category !== 'UTILITY')
        degraded ??= `template_${t.definition.name}_${status}`;
    }
    if (degraded) await setChannelHealth(tx, sync.channelId, 'degraded', degraded, 'wa.templates_manage');
    await audit(tx, {
      orgId: actor.orgId,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'wa.templates_manage',
      entityType: 'whatsapp_channel',
      entityId: sync.channelId,
      requestId,
      metadata: {
        command: 'templates_sync',
        changed,
        created: sync.templates.filter((t) => t.created).map((t) => t.definition.name),
      },
    });
    return this.list(tx, actor.orgId);
  }
}

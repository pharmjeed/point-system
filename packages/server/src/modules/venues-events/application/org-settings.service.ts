import { Inject, Injectable } from '@nestjs/common';
import { orgSettingsSchema, rooms, type OrgSettings, type OrgSettingsEditable } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { newId } from '../../../core/crypto/ids.js';
import type { Database } from '../../../core/db/database.js';
import type { Tx } from '../../../core/db/tx.js';
import { InvariantViolation } from '../../../core/errors/app-error.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { DATABASE } from '../../../http/tokens.js';
import { auditCommand, type CommandMeta } from './support.js';

/** Rooms per NOTIFY: `user:<uuid>` rooms stay well under the 8000-byte payload limit (DEC-48). */
const ROOMS_PER_NOTIFY = 100;

interface OrgRow {
  settings: unknown;
  updated_at: Date;
}

function parseStored(raw: unknown, orgId: string): OrgSettings {
  const r = orgSettingsSchema.safeParse(raw ?? {});
  if (!r.success)
    throw new InvariantViolation(`organizations.settings of ${orgId} does not match the canon schema`);
  return r.data;
}

/** The editable view (`OrgSettings` of 07): `security.*` without the fixed `pin_length` (DEC-66) and `heartbeat.*`. */
function editableView(s: OrgSettings, updatedAt: Date) {
  const { pin_length: _fixed, ...security } = s.security;
  return { security, heartbeat: { ...s.heartbeat }, updated_at: new Date(updatedAt).toISOString() };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `GET/PUT /v1/admin/org-settings` (PNT-091, DEC-39): owner only through `org.settings_manage`. Organization settings
 * belong to venues-events with the venue settings (04 §4.2 item 2).
 */
@Injectable()
export class OrgSettingsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async get(actor: ActorContext) {
    const [row] = await this.db.rows<OrgRow>(`SELECT settings, updated_at FROM organizations WHERE id = $1`, [
      actor.orgId,
    ]);
    if (!row)
      throw new InvariantViolation(`organization ${actor.orgId} of an authenticated actor is missing`);
    return editableView(parseStored(row.settings, actor.orgId), row.updated_at);
  }

  /**
   * Replaces `security.*` and `heartbeat.*` (all keys required; bounds and `interval_s < uncertain_after_s <
   * offline_after_s` checked by the shared schema → VALIDATION_FAILED). Other sections (`retention.*`, `ops.*`, …)
   * and `security.pin_length` are kept. Sessions store their own `expires_at`, so a new session length applies to
   * new sign-ins only; a heartbeat change is pushed to every active user's devices with `sync.required` (07 §4).
   */
  async put(tx: Tx, actor: ActorContext, meta: CommandMeta, body: OrgSettingsEditable) {
    // organizations is a setup table outside canon §14ب: locked alone in its own command (DEC-121)
    const row = await tx.maybeOne<OrgRow>(
      `SELECT settings, updated_at FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
      [actor.orgId],
    );
    if (!row)
      throw new InvariantViolation(`organization ${actor.orgId} of an authenticated actor is missing`);
    const current = parseStored(row.settings, actor.orgId);
    const next = parseStored(
      {
        ...current,
        security: { ...body.security, pin_length: current.security.pin_length },
        heartbeat: body.heartbeat,
      },
      actor.orgId,
    );
    const before = editableView(current, row.updated_at);
    const changed = !same(current.security, next.security) || !same(current.heartbeat, next.heartbeat);
    const updatedAt = changed ? tx.now : row.updated_at;
    if (changed)
      await tx.query(`UPDATE organizations SET settings = $2, updated_at = $3 WHERE id = $1`, [
        actor.orgId,
        JSON.stringify(next),
        updatedAt,
      ]);
    const after = editableView(next, updatedAt);
    await auditCommand(tx, actor, meta, {
      action: 'org.settings_manage',
      entityType: 'organization',
      entityId: actor.orgId,
      venueId: null,
      before: { security: before.security, heartbeat: before.heartbeat },
      after: { security: after.security, heartbeat: after.heartbeat },
      ...(changed ? {} : { metadata: { noop: true } }),
    });
    if (!same(current.heartbeat, next.heartbeat)) await this.pushHeartbeat(tx, actor.orgId);
    return after;
  }

  /** Devices pick the new heartbeat timings up from `GET /v1/me` after `sync.required`. */
  private async pushHeartbeat(tx: Tx, orgId: string) {
    const users = await tx.rows<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND status = 'active' ORDER BY id`,
      [orgId],
    );
    for (let i = 0; i < users.length; i += ROOMS_PER_NOTIFY)
      await publishRealtime(
        tx,
        orgId,
        users.slice(i, i + ROOMS_PER_NOTIFY).map((u) => rooms.user(u.id)),
        { event: 'sync.required', id: newId(), data: { reason: 'settings_changed', scope: 'me' } },
      );
  }
}

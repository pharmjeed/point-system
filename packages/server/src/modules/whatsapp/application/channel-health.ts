import type { WaHealthStatus } from '@point/shared';
import { autoResolveAlerts, raiseAlertForAffectedVenues } from '../../../core/alerts/alerts.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Tx } from '../../../core/db/tx.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';

const GAUGE: Record<WaHealthStatus, number> = { healthy: 0, degraded: 1, down: 2 };

export const channelDownDedupeKey = (channelId: string) => `wa_channel_down:${channelId}`;

/**
 * The only transitions of 12 §5.14: healthy → degraded, healthy/degraded → down, down/degraded → healthy.
 * A degradation never lifts a `down` channel. Each transition writes `wa.channel_health_changed` (the
 * notifications realtime planner turns it into `channel.status` for every staff room), raises
 * `wa_channel_down` for every venue with an open or closing event when it goes down (DEC-46) and
 * auto-resolves those alerts when it is healthy again. Never another number or channel (P-02).
 */
export async function setChannelHealth(
  tx: Tx,
  channelId: string,
  to: WaHealthStatus,
  reason: string,
  action: 'job.wa_send' | 'job.wa_process_inbound' | 'wa.templates_manage',
): Promise<{ changed: boolean; from: WaHealthStatus | null }> {
  const cur = await tx.maybeOne<{ id: string; org_id: string; health_status: WaHealthStatus }>(
    `SELECT id, org_id, health_status FROM whatsapp_channel WHERE id = $1 FOR NO KEY UPDATE`,
    [channelId],
  );
  if (!cur) return { changed: false, from: null };
  const from = cur.health_status;
  if (from === to || (to === 'degraded' && from === 'down')) return { changed: false, from };
  await tx.query(`UPDATE whatsapp_channel SET health_status = $2, health_changed_at = $3 WHERE id = $1`, [
    channelId,
    to,
    tx.now,
  ]);
  await emitEvent(tx, {
    type: 'wa.channel_health_changed',
    orgId: cur.org_id,
    aggregate: { type: 'whatsapp_channel', id: channelId, version: null },
    actor: { type: 'system', id: null },
    payload: { channel_id: channelId, from, to, reason },
  });
  if (to === 'down') {
    await raiseAlertForAffectedVenues(tx, {
      orgId: cur.org_id,
      type: 'wa_channel_down',
      dedupeKey: channelDownDedupeKey(channelId),
      details: { channel_id: channelId, reason },
    });
  } else if (to === 'healthy') {
    await autoResolveAlerts(tx, {
      orgId: cur.org_id,
      dedupeKeys: [channelDownDedupeKey(channelId)],
      note: 'whatsapp channel healthy',
    });
  }
  await audit(tx, {
    orgId: cur.org_id,
    actor: { type: 'system', id: null },
    action,
    entityType: 'whatsapp_channel',
    entityId: channelId,
    before: { health_status: from },
    after: { health_status: to },
    metadata: { reason },
  });
  metrics.waChannelHealth.set(GAUGE[to]);
  return { changed: true, from };
}

import { newId } from '../../../core/crypto/ids.js';
import type { JobHandler } from '../../../core/outbox/dispatcher.js';
import { publishRealtime } from '../../../core/realtime/realtime-publisher.js';
import { ROOMS_PER_PUBLISH } from '../application/realtime-planner.js';

/**
 * `job.ws_publish` (canon §7.2, DEC-48): the fallback of a publication too large for NOTIFY. Its row holds
 * ids only (rooms, the realtime event, its id and aggregate), so the message itself cannot be rebuilt;
 * the clients of those rooms get `sync.required` instead and refetch their snapshot (11 §9.4: the snapshot
 * is the source after any gap). Small chunks: the fallback never overflows again.
 */
export const wsPublishHandler: JobHandler = {
  type: 'job.ws_publish',
  mode: 'tx',
  async handle({ row, tx }) {
    const p = row.payload as {
      rooms?: unknown;
      event?: unknown;
      aggregate?: { type: string; id: string; version: number | null } | null;
    };
    const target = Array.isArray(p.rooms)
      ? [...new Set(p.rooms.filter((r): r is string => typeof r === 'string' && r.length > 0))]
      : [];
    for (let i = 0; i < target.length; i += ROOMS_PER_PUBLISH)
      await publishRealtime(tx!, row.org_id, target.slice(i, i + ROOMS_PER_PUBLISH), {
        event: 'sync.required',
        id: newId(),
        ...(p.aggregate ? { aggregate: p.aggregate } : {}),
        data: { cause: 'job.ws_publish', reason: 'publish_overflow' },
      });
  },
};

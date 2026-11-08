import { Inject, Injectable } from '@nestjs/common';
import { isTerminalTicketStatus, type MediaContentType } from '@point/shared';
import { z } from 'zod';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { appendTicketEvent, audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import { sha256Hex } from '../../../core/crypto/crypto.js';
import type { Database } from '../../../core/db/database.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError, InvariantViolation } from '../../../core/errors/app-error.js';
import { emitEvent } from '../../../core/outbox/outbox-writer.js';
import { venueSettings } from '../../../core/settings/settings-service.js';
import { DATABASE, ENV } from '../../../http/tokens.js';
import { zodToFields } from '../../../http/zod-pipe.js';
import { PHOTO_UPLOADED_TIMELINE_TYPE } from '../domain/media-events.js';
import { SANITIZED_CONTENT_TYPE, isUuid, sanitizedStorageKey } from '../domain/media-policy.js';
import { ImageRejectedError, assertSanitized, sanitizeImage } from '../infra/image-sanitizer.js';
import {
  findMedia,
  findTicketFacts,
  listUploadedPhotoKinds,
  lockMediaRow,
  markMediaUploaded,
  toMediaDto,
  type MediaDto,
  type MediaRow,
  type MediaTicketFacts,
} from '../infra/media-queries.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../infra/object-storage.js';
import {
  mediaNotFound,
  mediaTooLarge,
  mediaTypeUnsupported,
  storageFailureToAppError,
  uploadIncomplete,
} from './media-errors.js';
import type { MediaCommandContext } from './request-media-upload.js';

export const COMPLETE_UPLOAD_OPERATION = 'POST /v1/media/{mediaId}/complete';

/** Body of `POST /v1/media/{mediaId}/complete` (07_openapi `completeMediaUpload`). */
export const CompleteMediaUploadBody = z.strictObject({
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type CompleteMediaUploadBody = z.infer<typeof CompleteMediaUploadBody>;

/** Cache-Control stored on the sanitized object (and repeated on every read link, 09 §6.3). */
export const PHOTO_CACHE_CONTROL = 'private, no-store';

/**
 * Result of the storage phase, computed outside any transaction and consumed by the command transaction.
 * `error` carries the exact error the command must answer (stored with the idempotency key when it is a
 * deterministic 4xx, never when it is a 5xx such as DEPENDENCY_TIMEOUT).
 */
export type MediaCompletionPlan =
  | { kind: 'error'; error: unknown }
  | { kind: 'already_uploaded'; mediaId: string }
  | {
      kind: 'ready';
      mediaId: string;
      storageKey: string;
      byteSize: number;
      sha256: string;
      contentType: MediaContentType;
      /** what the client uploaded (before sanitizing); null when resumed from a previous attempt */
      original: { byteSize: number; sha256: string } | null;
      resumed: boolean;
    };

/**
 * `POST /v1/media/{mediaId}/complete` (PNT-027, DEC-36) in two phases:
 *
 * 1. `prepare` — no transaction: object exists → size = declared → sha256 = declared → the bytes are the
 *    declared image type → EXIF/GPS stripped (re-encode, orientation baked) → sanitized copy written to its
 *    final key (create-only) → the unsanitized original deleted (09 §6.2: it never survives `uploaded`).
 *    A completion interrupted after the original was deleted resumes from the sanitized copy.
 * 2. `finalize` — the command transaction: L0 → L5 ticket → media row → `uploaded` with the new size and
 *    hash → audit + `ticket_events` → late inspection completion (11 §6.3) when it applies.
 *
 * Calling it twice is safe: an `uploaded` row is answered as is (no second timeline entry), the same
 * Idempotency-Key replays the stored response, and two concurrent calls converge on one sanitized object.
 */
@Injectable()
export class CompleteMediaUploadUseCase {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Phase 1. Never throws: every outcome, error included, is returned as a plan. */
  async prepare(actor: ActorContext, mediaId: string, rawBody: unknown): Promise<MediaCompletionPlan> {
    try {
      return await this.plan(actor, mediaId, rawBody);
    } catch (e) {
      return { kind: 'error', error: storageFailureToAppError(e, this.env.MEDIA_MAX_BYTES) };
    }
  }

  private async plan(actor: ActorContext, mediaId: string, rawBody: unknown): Promise<MediaCompletionPlan> {
    const body = CompleteMediaUploadBody.safeParse(rawBody ?? {});
    if (!body.success) {
      return { kind: 'error', error: new AppError('VALIDATION_FAILED', { fields: zodToFields(body.error) }) };
    }
    if (!isUuid(mediaId)) return { kind: 'error', error: mediaNotFound() };
    const m = await findMedia(this.db, mediaId, actor.orgId);
    const ticket = m ? await findTicketFacts(this.db, m.ticket_id, actor.orgId) : null;
    if (!m || !ticket || !isUploaderInScope(actor, m, ticket))
      return { kind: 'error', error: mediaNotFound() };
    if (m.upload_status === 'uploaded') return { kind: 'already_uploaded', mediaId };
    if (m.upload_status !== 'pending')
      return { kind: 'error', error: uploadIncomplete(m.id, m.upload_status) };

    const max = this.env.MEDIA_MAX_BYTES;
    const finalKey = sanitizedStorageKey(m.org_id, m.ticket_id, m.id, m.content_type);
    const reject = async (error: AppError): Promise<MediaCompletionPlan> => {
      // the unsanitized bytes are useless and may carry a location: never keep them
      await this.storage.delete(m.storage_key);
      return { kind: 'error', error };
    };

    const head = await this.storage.head(m.storage_key);
    if (!head)
      return (await this.resume(m, finalKey)) ?? { kind: 'error', error: uploadIncomplete(m.id, 'pending') };
    if (head.size > max) return reject(mediaTooLarge(max));
    if (m.byte_size !== null && head.size !== m.byte_size) return reject(uploadIncomplete(m.id, 'pending'));

    const original = await this.storage.get(m.storage_key, { maxBytes: max });
    if (!original)
      return (await this.resume(m, finalKey)) ?? { kind: 'error', error: uploadIncomplete(m.id, 'pending') };
    if (m.byte_size !== null && original.length !== m.byte_size)
      return reject(uploadIncomplete(m.id, 'pending'));
    const originalSha = sha256Hex(original);
    const declared = [m.sha256, body.data.sha256].filter((h): h is string => !!h);
    if (declared.some((h) => h !== originalSha)) return reject(uploadIncomplete(m.id, 'pending'));

    let clean;
    try {
      clean = await sanitizeImage(original, { declaredContentType: m.content_type });
    } catch (e) {
      if (e instanceof ImageRejectedError) {
        return reject(e.reason === 'too_large' ? mediaTooLarge(max) : mediaTypeUnsupported());
      }
      throw e;
    }
    if (clean.byteSize > max) return reject(mediaTooLarge(max));

    let stored = { byteSize: clean.byteSize, sha256: clean.sha256 };
    const put = await this.storage.put(finalKey, clean.data, {
      contentType: clean.contentType,
      cacheControl: PHOTO_CACHE_CONTROL,
      ifNoneMatch: true,
    });
    if (put === 'exists') {
      // a concurrent or interrupted completion stored it first: the row must describe the bytes in the bucket
      const existing = await this.storage.get(finalKey);
      if (!existing)
        throw new AppError('DEPENDENCY_TIMEOUT', { dependency: 'object_storage' }, { retryAfterS: 1 });
      stored = { byteSize: existing.length, sha256: sha256Hex(existing) };
    }
    await this.storage.delete(m.storage_key);
    return {
      kind: 'ready',
      mediaId: m.id,
      storageKey: finalKey,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      contentType: clean.contentType,
      original: { byteSize: original.length, sha256: originalSha },
      resumed: false,
    };
  }

  /** The original is gone: a previous attempt may have stored the sanitized copy before its transaction failed. */
  private async resume(m: MediaRow, finalKey: string): Promise<MediaCompletionPlan | null> {
    const existing = await this.storage.get(finalKey);
    if (!existing) return null;
    await assertSanitized(existing);
    return {
      kind: 'ready',
      mediaId: m.id,
      storageKey: finalKey,
      byteSize: existing.length,
      sha256: sha256Hex(existing),
      contentType: SANITIZED_CONTENT_TYPE[m.content_type],
      original: null,
      resumed: true,
    };
  }

  /** Phase 2, inside the command transaction (no storage I/O here). */
  async finalize(
    tx: Tx,
    actor: ActorContext,
    mediaId: string,
    plan: MediaCompletionPlan | undefined,
    ctx: MediaCommandContext,
  ): Promise<MediaDto> {
    // no plan: the storage phase was skipped for a key that was known then and is not anymore — retry it
    if (!plan) throw new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 1 });
    if (plan.kind === 'error') throw plan.error;

    const seen = await findMedia(tx, mediaId, actor.orgId);
    if (!seen) throw mediaNotFound();
    const [locked] = await lockTickets(tx, [seen.ticket_id]); // L5
    const ticket = locked as MediaTicketFacts | undefined;
    const m = await lockMediaRow(tx, mediaId);
    if (!m || !ticket || !isUploaderInScope(actor, m, ticket)) throw mediaNotFound(); // TOCTOU (09 §8.4)

    const entry = {
      orgId: m.org_id,
      actor: { type: 'user' as const, id: actor.userId, role: actor.role },
      action: 'ticket.intake',
      entityType: 'media_asset',
      entityId: m.id,
      venueId: ticket.venue_id,
      requestId: ctx.requestId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    };
    if (m.upload_status === 'uploaded') {
      await audit(tx, {
        ...entry,
        metadata: { command: COMPLETE_UPLOAD_OPERATION, ticket_id: m.ticket_id, result: 'already_uploaded' },
      });
      return toMediaDto(m);
    }
    if (m.upload_status !== 'pending') throw uploadIncomplete(m.id, m.upload_status);
    // the row changed between the phases (cannot normally happen): plan again
    if (plan.kind !== 'ready') throw new AppError('SERVICE_UNAVAILABLE', {}, { retryAfterS: 1 });
    if (
      plan.mediaId !== m.id ||
      plan.storageKey !== sanitizedStorageKey(m.org_id, m.ticket_id, m.id, m.content_type)
    ) {
      throw new InvariantViolation('media completion plan does not match the media row');
    }

    const updated = await markMediaUploaded(tx, {
      id: m.id,
      storageKey: plan.storageKey,
      byteSize: plan.byteSize,
      sha256: plan.sha256,
      contentType: plan.contentType,
      at: tx.now,
    });
    await audit(tx, {
      ...entry,
      before: {
        upload_status: 'pending',
        byte_size: m.byte_size,
        sha256: m.sha256,
        content_type: m.content_type,
      },
      after: {
        upload_status: 'uploaded',
        byte_size: updated.byte_size,
        sha256: updated.sha256,
        content_type: updated.content_type,
      },
      metadata: {
        command: COMPLETE_UPLOAD_OPERATION,
        ticket_id: m.ticket_id,
        kind: m.kind,
        metadata_stripped: true,
        original_byte_size: plan.original?.byteSize ?? null,
        original_sha256: plan.original?.sha256 ?? null,
        resumed: plan.resumed,
      },
    });
    await appendTicketEvent(tx, {
      orgId: m.org_id,
      venueId: ticket.venue_id,
      ticketId: ticket.id,
      type: PHOTO_UPLOADED_TIMELINE_TYPE,
      actor: { type: 'user', id: actor.userId },
      ticketVersion: ticket.version,
      data: {
        media_id: m.id,
        kind: m.kind,
        content_type: updated.content_type,
        byte_size: updated.byte_size,
      },
    });
    await completeLateInspection(tx, actor, ticket, updated);
    return toMediaDto(updated);
  }
}

/** `complete` is the uploader's own action (09 §4.2), on a ticket still in his scope. */
function isUploaderInScope(
  actor: ActorContext,
  m: MediaRow,
  t: Pick<MediaTicketFacts, 'org_id' | 'venue_id'>,
): boolean {
  return m.uploaded_by === actor.userId && t.org_id === actor.orgId && actor.venueIds.has(t.venue_id);
}

/**
 * 11 §2.4 / §6.3: `incomplete` → `complete` when the late photos complete the intake inspection — every kind
 * of `inspection.required_photos` uploaded and taken by the intake submission (`captured_at <= submitted_at`).
 * Emits `ticket.inspection_completed` (11 §8.2: supervisors and the creator get `ticket.updated`; the
 * `inspection_incomplete` alert is resolved by its consumer). No customer message.
 */
async function completeLateInspection(
  tx: Tx,
  actor: ActorContext,
  ticket: MediaTicketFacts,
  media: MediaRow,
): Promise<void> {
  if (
    ticket.inspection_status !== 'incomplete' ||
    !ticket.submitted_at ||
    isTerminalTicketStatus(ticket.status)
  )
    return;
  const { inspection } = await venueSettings(tx, ticket.venue_id);
  const uploaded = new Set(
    await listUploadedPhotoKinds(tx, ticket.id, { capturedAtOrBefore: ticket.submitted_at }),
  );
  if (!inspection.required_photos.every((k) => uploaded.has(k))) return;

  const r = await tx.one<{ version: number }>(
    `UPDATE tickets SET inspection_status = 'complete', version = version + 1
      WHERE id = $1 AND version = $2 AND inspection_status = 'incomplete' RETURNING version`,
    [ticket.id, ticket.version],
  );
  await tx.query(
    `UPDATE vehicle_inspections SET required_photos_ok = true WHERE ticket_id = $1 AND kind = 'intake'`,
    [ticket.id],
  );
  await appendTicketEvent(tx, {
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    ticketId: ticket.id,
    type: 'ticket.inspection_completed',
    actor: { type: 'user', id: actor.userId },
    ticketVersion: r.version,
    data: { media_id: media.id },
  });
  await emitEvent(tx, {
    type: 'ticket.inspection_completed',
    orgId: ticket.org_id,
    venueId: ticket.venue_id,
    dispatchPoolId: ticket.dispatch_pool_id,
    eventId: ticket.event_id,
    aggregate: { type: 'ticket', id: ticket.id, version: r.version },
    actor: { type: 'user', id: actor.userId },
    payload: {
      ticket: { ticket_id: ticket.id, display_number: ticket.display_number, ticket_version: r.version },
      media_id: media.id,
    },
  });
}

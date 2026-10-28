import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MediaContentType, MediaKind } from '@point/shared';
import type { ActorContext } from '../../../core/actor-context/actor-context.js';
import { audit } from '../../../core/audit/audit-writer.js';
import type { Env } from '../../../core/config/env.js';
import { newId } from '../../../core/crypto/ids.js';
import { lockTickets } from '../../../core/db/locks.js';
import type { Tx } from '../../../core/db/tx.js';
import { AppError } from '../../../core/errors/app-error.js';
import { venueSettings } from '../../../core/settings/settings-service.js';
import { ENV } from '../../../http/tokens.js';
import {
  UPLOAD_TICKET_STATUSES,
  isExtraKind,
  isUploadAllowedStatus,
  isUuid,
  uploadStorageKey,
  uploadUrlTtlSeconds,
} from '../domain/media-policy.js';
import {
  countExtraPhotoSlots,
  findTicketFacts,
  insertPendingMedia,
  toMediaDto,
  type MediaDto,
  type MediaTicketFacts,
} from '../infra/media-queries.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../infra/object-storage.js';
import { assertTicketVisible } from './media-errors.js';

export const REQUEST_UPLOAD_OPERATION = 'POST /v1/tickets/{ticketId}/media';

/** Validated body of `POST /v1/tickets/{ticketId}/media` (07_openapi `requestMediaUpload`). */
export interface MediaUploadRequest {
  kind: MediaKind;
  content_type: MediaContentType;
  byte_size: number;
  sha256?: string;
  captured_at?: string;
}

/** 07_openapi `UploadInstruction` */
export interface UploadInstructionDto {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface MediaCommandContext {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * `POST /v1/tickets/{ticketId}/media` (PNT-027): a `pending` media row and a presigned PUT to the private
 * bucket. Runs inside the command transaction: L0 (idempotency) → L5 ticket → media insert → audit (L10).
 * Presigning is local math; nothing here talks to the storage.
 */
@Injectable()
export class RequestMediaUploadUseCase {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(
    tx: Tx,
    actor: ActorContext,
    ticketId: string,
    body: MediaUploadRequest,
    ctx: MediaCommandContext,
  ): Promise<{ media: MediaDto; upload: UploadInstructionDto }> {
    if (!isUuid(ticketId)) throw new AppError('TICKET_NOT_FOUND');
    // read without a lock first: scope and creator (08 §2 steps 7–8)
    const seen = await findTicketFacts(tx, ticketId, actor.orgId);
    assertTicketVisible(actor, seen);
    assertCreator(actor, seen);

    // L5: the photo commands never touch the dispatch queue (canon §14ب, 07 §1.11)
    const [locked] = await lockTickets(tx, [ticketId]);
    const ticket = locked as MediaTicketFacts | undefined;
    assertTicketVisible(actor, ticket); // TOCTOU re-check after the lock (09 §8.4)
    assertCreator(actor, ticket);
    if (!isUploadAllowedStatus(ticket.status)) {
      throw new AppError('INVALID_STATE_TRANSITION', {
        entity_type: 'ticket',
        entity_id: ticket.id,
        current_status: ticket.status,
        current_version: ticket.version,
        command: REQUEST_UPLOAD_OPERATION,
        allowed_from: [...UPLOAD_TICKET_STATUSES],
      });
    }

    const ttl = uploadUrlTtlSeconds(this.env.MEDIA_UPLOAD_URL_TTL_S);
    const { inspection } = await venueSettings(tx, ticket.venue_id);
    if (isExtraKind(body.kind, inspection.required_photos)) {
      const windowStart = new Date(tx.now.getTime() - ttl * 1000);
      const used = await countExtraPhotoSlots(tx, ticket.id, inspection.required_photos, windowStart);
      if (used >= inspection.max_extra_photos) {
        throw new AppError('INVALID_STATE_TRANSITION', {
          entity_type: 'ticket',
          entity_id: ticket.id,
          current_status: ticket.status,
          command: REQUEST_UPLOAD_OPERATION,
          reason: 'max_extra_photos',
          max_extra_photos: inspection.max_extra_photos,
        });
      }
    }

    const mediaId = newId();
    const row = await insertPendingMedia(tx, {
      id: mediaId,
      orgId: ticket.org_id,
      ticketId: ticket.id,
      kind: body.kind,
      storageKey: uploadStorageKey(ticket.org_id, ticket.id, mediaId, randomBytes(16).toString('hex')),
      contentType: body.content_type,
      byteSize: body.byte_size,
      sha256: body.sha256 ?? null,
      uploadedBy: actor.userId,
      capturedAt: body.captured_at ? new Date(body.captured_at) : null,
      createdAt: tx.now,
    });
    const upload = await this.storage.presignUpload(row.storage_key, {
      contentType: body.content_type,
      contentLength: body.byte_size,
      expiresInS: ttl,
      now: tx.now,
    });

    await audit(tx, {
      orgId: ticket.org_id,
      actor: { type: 'user', id: actor.userId, role: actor.role },
      action: 'ticket.intake',
      entityType: 'media_asset',
      entityId: mediaId,
      venueId: ticket.venue_id,
      requestId: ctx.requestId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      after: {
        upload_status: 'pending',
        kind: body.kind,
        content_type: body.content_type,
        byte_size: body.byte_size,
      },
      metadata: { command: REQUEST_UPLOAD_OPERATION, ticket_id: ticket.id, ticket_status: ticket.status },
    });

    return {
      media: toMediaDto(row),
      upload: {
        method: 'PUT',
        url: upload.url,
        headers: upload.headers,
        expires_at: upload.expiresAt.toISOString(),
      },
    };
  }
}

/** Only the ticket's creator uploads its photos (09 §3 `ticket.intake`, §4.2: PERMISSION_DENIED). */
function assertCreator(actor: ActorContext, t: MediaTicketFacts): void {
  if (t.created_by !== actor.userId) throw new AppError('PERMISSION_DENIED', { permission: 'ticket.intake' });
}

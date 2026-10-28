import { describe, expect, it } from 'vitest';
import {
  canReadTicketPhotos,
  isExtraKind,
  isSupportedContentType,
  isUploadAllowedStatus,
  isUuid,
  normalizeContentType,
  presignedExpiry,
  readUrlTtlSeconds,
  sanitizedStorageKey,
  uploadStorageKey,
  uploadUrlTtlSeconds,
} from '../src/modules/media/domain/media-policy.js';

const ORG = '00000000-0000-4000-8000-000100000001';
const TICKET = '0193b6f2-5c1e-7a40-9d2f-6b8e1c0a4f11';
const MEDIA = '0193b6f2-5c1e-7a40-9d2f-6b8e1c0a4f12';

describe('media rules', () => {
  it('uploads are requested while received or parking only (09 §3 ticket.intake)', () => {
    expect(isUploadAllowedStatus('received')).toBe(true);
    expect(isUploadAllowedStatus('parking')).toBe(true);
    for (const s of ['parked', 'requested', 'ready', 'reparking', 'delivered', 'voided'] as const) {
      expect(isUploadAllowedStatus(s)).toBe(false);
    }
  });

  it('content types are the canon list, compared case-insensitively, without parameters', () => {
    expect(isSupportedContentType(normalizeContentType(' Image/JPEG '))).toBe(true);
    expect(isSupportedContentType('image/heic')).toBe(true);
    expect(isSupportedContentType('image/gif')).toBe(false);
    expect(isSupportedContentType(normalizeContentType('image/jpeg; q=1'))).toBe(false);
  });

  it('extra photos are the kinds the venue does not require', () => {
    const required = ['photo_front', 'photo_rear', 'photo_left', 'photo_right'] as const;
    expect(isExtraKind('photo_extra', required)).toBe(true);
    expect(isExtraKind('photo_damage', required)).toBe(true);
    expect(isExtraKind('photo_front', required)).toBe(false);
    expect(isExtraKind('photo_left', ['photo_front', 'photo_rear'])).toBe(true);
  });

  it('storage keys: the sanitized object follows 09 §6.1, the upload lands under incoming/ with a nonce', () => {
    expect(sanitizedStorageKey(ORG, TICKET, MEDIA, 'image/jpeg')).toBe(
      `org/${ORG}/tickets/${TICKET}/${MEDIA}.jpg`,
    );
    expect(sanitizedStorageKey(ORG, TICKET, MEDIA, 'image/webp')).toBe(
      `org/${ORG}/tickets/${TICKET}/${MEDIA}.webp`,
    );
    expect(sanitizedStorageKey(ORG, TICKET, MEDIA, 'image/png')).toBe(
      `org/${ORG}/tickets/${TICKET}/${MEDIA}.png`,
    );
    // HEIC is re-encoded as JPEG
    expect(sanitizedStorageKey(ORG, TICKET, MEDIA, 'image/heic')).toBe(
      `org/${ORG}/tickets/${TICKET}/${MEDIA}.jpg`,
    );
    const nonce = 'a'.repeat(32);
    expect(uploadStorageKey(ORG, TICKET, MEDIA, nonce)).toBe(`incoming/${ORG}/${TICKET}/${MEDIA}-${nonce}`);
    expect(() => uploadStorageKey(ORG, TICKET, MEDIA, '../x')).toThrow();
  });

  it('read access = ticket.read_full: staff in scope; a driver as open-task assignee or creator during intake', () => {
    const driver = { role: 'driver' as const, userId: 'd1' };
    const ticket = (
      status: 'received' | 'parking' | 'parked' | 'delivered',
      createdBy = 'd1',
      task = false,
    ) => ({
      status,
      createdBy,
      readerHasOpenTask: task,
    });
    for (const role of ['owner', 'admin', 'supervisor'] as const) {
      expect(canReadTicketPhotos({ role, userId: 'x' }, ticket('delivered', 'd9'))).toBe(true);
    }
    expect(canReadTicketPhotos(driver, ticket('received'))).toBe(true);
    expect(canReadTicketPhotos(driver, ticket('parking'))).toBe(true);
    expect(canReadTicketPhotos(driver, ticket('parked'))).toBe(false); // creator after intake
    expect(canReadTicketPhotos(driver, ticket('parked', 'd9', true))).toBe(true); // assignee
    expect(canReadTicketPhotos(driver, ticket('received', 'd9'))).toBe(false); // neither
  });

  it('link lifetimes: reads at most 300 s (09 §6.3), uploads at least 1 s and within the SigV4 limit', () => {
    expect(readUrlTtlSeconds(300)).toBe(300);
    expect(readUrlTtlSeconds(3600)).toBe(300);
    expect(readUrlTtlSeconds(60)).toBe(60);
    expect(readUrlTtlSeconds(0)).toBe(1);
    expect(uploadUrlTtlSeconds(300)).toBe(300);
    expect(uploadUrlTtlSeconds(0)).toBe(1);
    expect(uploadUrlTtlSeconds(10 ** 9)).toBe(604800);
    expect(presignedExpiry(new Date('2026-10-28T10:00:00.999Z'), 300).toISOString()).toBe(
      '2026-10-28T10:05:00.000Z',
    );
  });

  it('only UUIDs address a resource', () => {
    expect(isUuid(MEDIA)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(`${MEDIA}x`)).toBe(false);
  });
});

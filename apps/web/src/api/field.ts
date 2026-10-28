import { api } from './client';
import { NetworkError } from './errors';
import type {
  AcceptOfferResult,
  AudioTestResult,
  ClaimCodeState,
  CompleteParkingResult,
  ConsentInput,
  CreateTicketResult,
  Device,
  DisplayMode,
  DriverHome,
  DriverStateResult,
  DutySession,
  HandoverResult,
  Media,
  MediaContentType,
  MediaKind,
  MediaUploadResult,
  NotificationPermissionState,
  PaymentMethod,
  PlateBody,
  SignedUrl,
  StartDutyResult,
  TaskCard,
  TicketChannel,
  TicketDetail,
  UploadInstruction,
  VehicleInfo,
} from './types';

/**
 * The driver's field commands (07 §2.1–§2.3): duty, device checks, intake, photos, parking, offers,
 * retrieval steps and handover. Every command here is `x-idempotency: required` (the device checks are
 * optional) and takes the key of the user's intent from useCommand. Task commands send the task's
 * `expected_version`, ticket commands the ticket's (07 §1.5; the offer id is enough for accept).
 */
const enc = encodeURIComponent;

// ---------------------------------------------------------------- home & duty (07 §2.1)

/** `GET /v1/me/home` — the driver's full sync source (02 §1.7). */
export async function getHome(signal?: AbortSignal): Promise<DriverHome> {
  return (await api.get<DriverHome>('/v1/me/home', { signal })).data;
}

export async function startDuty(
  body: { venue_id?: string | null; device_id?: string | null },
  key: string,
): Promise<StartDutyResult> {
  return (await api.post<StartDutyResult>('/v1/me/duty/start', { body, idempotencyKey: key })).data;
}

/** `active: false` ends the break (D-04 banner); starting one is D-14 (PNT-070). */
export async function setBreak(active: boolean, key: string): Promise<DutySession> {
  return (await api.post<DutySession>('/v1/me/duty/break', { body: { active }, idempotencyKey: key })).data;
}

export async function endDuty(key: string): Promise<DutySession> {
  return (await api.post<DutySession>('/v1/me/duty/end', { idempotencyKey: key })).data;
}

// ---------------------------------------------------------------- device checks (D-03)

export async function recordAudioTest(
  body: { device_id: string; result: AudioTestResult },
  key: string,
): Promise<Device> {
  return (await api.post<Device>('/v1/me/audio-test', { body, idempotencyKey: key })).data;
}

/** Permission and display mode only; the Web Push subscription is PNT-072. */
export async function updateDevice(
  deviceId: string,
  body: { display_mode?: DisplayMode; notification_permission?: NotificationPermissionState },
  key: string,
): Promise<Device> {
  return (await api.put<Device>(`/v1/me/devices/${enc(deviceId)}`, { body, idempotencyKey: key })).data;
}

// ---------------------------------------------------------------- intake (07 §2.2)

/** «استلام مركبة»: `event_id` is required when the venue has more than one open event (DEC-37). */
export async function createTicket(
  body: { event_id?: string | null },
  key: string,
): Promise<CreateTicketResult> {
  return (await api.post<CreateTicketResult>('/v1/tickets', { body, idempotencyKey: key })).data;
}

export async function getTicket(ticketId: string, signal?: AbortSignal): Promise<TicketDetail> {
  return (await api.get<TicketDetail>(`/v1/tickets/${enc(ticketId)}`, { signal })).data;
}

export interface IntakePatch {
  expected_version: number;
  channel?: TicketChannel;
  plate?: PlateBody;
  vehicle?: VehicleInfo;
  customer_phone?: string | null;
  consent?: ConsentInput | null;
  paper_serial?: string | null;
  key_tag?: string | null;
  notes?: string | null;
}

export async function patchIntake(ticketId: string, body: IntakePatch, key: string): Promise<TicketDetail> {
  return (await api.patch<TicketDetail>(`/v1/tickets/${enc(ticketId)}/intake`, { body, idempotencyKey: key }))
    .data;
}

export interface MediaRequest {
  kind: MediaKind;
  content_type: MediaContentType;
  byte_size: number;
  sha256?: string;
  captured_at?: string;
}

export async function requestUpload(
  ticketId: string,
  body: MediaRequest,
  key: string,
): Promise<MediaUploadResult> {
  return (
    await api.post<MediaUploadResult>(`/v1/tickets/${enc(ticketId)}/media`, { body, idempotencyKey: key })
  ).data;
}

export async function completeMedia(mediaId: string, body: { sha256?: string }, key: string): Promise<Media> {
  return (await api.post<Media>(`/v1/media/${enc(mediaId)}/complete`, { body, idempotencyKey: key })).data;
}

export async function getMediaUrl(mediaId: string, signal?: AbortSignal): Promise<SignedUrl> {
  return (await api.get<SignedUrl>(`/v1/media/${enc(mediaId)}/url`, { signal })).data;
}

export async function submitIntake(
  ticketId: string,
  body: { expected_version: number; acknowledge_incomplete_inspection?: boolean },
  key: string,
): Promise<TicketDetail> {
  return (
    await api.post<TicketDetail>(`/v1/tickets/${enc(ticketId)}/submit-intake`, { body, idempotencyKey: key })
  ).data;
}

export async function discardDraft(
  ticketId: string,
  body: { expected_version: number },
  key: string,
): Promise<DriverStateResult> {
  return (
    await api.post<DriverStateResult>(`/v1/tickets/${enc(ticketId)}/discard-draft`, {
      body,
      idempotencyKey: key,
    })
  ).data;
}

// ---------------------------------------------------------------- parking, offers, retrieval (07 §2.3)

export interface ParkingInput {
  parking_spot_id?: string | null;
  spot_note?: string | null;
  key_slot_id?: string | null;
  expected_version?: number;
}

export async function completeParking(
  taskId: string,
  body: ParkingInput,
  key: string,
): Promise<CompleteParkingResult> {
  return (
    await api.post<CompleteParkingResult>(`/v1/tasks/${enc(taskId)}/complete-parking`, {
      body,
      idempotencyKey: key,
    })
  ).data;
}

export async function acceptOffer(offerId: string, key: string): Promise<AcceptOfferResult> {
  return (
    await api.post<AcceptOfferResult>(`/v1/task-offers/${enc(offerId)}/accept`, { idempotencyKey: key })
  ).data;
}

export async function keyPickup(
  taskId: string,
  body: { key_slot_id: string; expected_version?: number },
  key: string,
): Promise<TaskCard> {
  return (await api.post<TaskCard>(`/v1/tasks/${enc(taskId)}/key-pickup`, { body, idempotencyKey: key }))
    .data;
}

export async function startRetrieval(
  taskId: string,
  body: { expected_version?: number },
  key: string,
): Promise<TaskCard> {
  return (await api.post<TaskCard>(`/v1/tasks/${enc(taskId)}/start-retrieval`, { body, idempotencyKey: key }))
    .data;
}

export async function markReady(
  taskId: string,
  body: { expected_version?: number },
  key: string,
): Promise<TaskCard> {
  return (await api.post<TaskCard>(`/v1/tasks/${enc(taskId)}/ready`, { body, idempotencyKey: key })).data;
}

export interface HandoverInput {
  verification: { method: 'code'; code: string } | { method: 'paper_stub'; paper_serial: string };
  payment?: { method: PaymentMethod; amount_halalas: number; pos_reference?: string | null } | null;
  expected_version?: number;
}

export async function handover(ticketId: string, body: HandoverInput, key: string): Promise<HandoverResult> {
  return (
    await api.post<HandoverResult>(`/v1/tickets/${enc(ticketId)}/handover`, { body, idempotencyKey: key })
  ).data;
}

export async function resendHandoverCode(ticketId: string, key: string): Promise<ClaimCodeState> {
  return (
    await api.post<ClaimCodeState>(`/v1/tickets/${enc(ticketId)}/handover-code/resend`, {
      idempotencyKey: key,
    })
  ).data;
}

// ---------------------------------------------------------------- object storage

/** The storage refused the PUT (expired URL, size or type rejected): the photo must be requested again. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(readonly status: number) {
    super(`storage PUT ${status}`);
  }
}

/**
 * PUT the compressed photo straight to the presigned URL with the headers the API returned (07 §3.1). The
 * body is the Blob itself, so the request carries exactly the declared `byte_size`. XHR for the progress
 * events of the tile (02 D-06 «◐ 60%»); no cookies and no app headers go to the storage.
 */
export function putToStorage(
  upload: UploadInstruction,
  body: Blob,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers ?? {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else reject(new StorageError(xhr.status));
    };
    xhr.onerror = () => reject(new NetworkError('network'));
    xhr.ontimeout = () => reject(new NetworkError('timeout'));
    xhr.timeout = 60_000;
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

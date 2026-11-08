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
  Incident,
  IncidentType,
  Media,
  MediaContentType,
  MediaKind,
  MediaUploadResult,
  NotificationPermissionState,
  PaymentMethod,
  PlateBody,
  RetrievalCycle,
  SignedUrl,
  StartDutyResult,
  Task,
  TaskCard,
  TicketChannel,
  TicketDetail,
  TicketSummary,
  UploadInstruction,
  VehicleInfo,
  WaLinkResult,
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

/** A Web Push subscription as `PUT /v1/me/devices/{deviceId}` stores it (07 §2.1, 14 §6.4). */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Permission, display mode and (PNT-072) the Web Push subscription; `null` removes it. */
export async function updateDevice(
  deviceId: string,
  body: {
    display_mode?: DisplayMode;
    notification_permission?: NotificationPermissionState;
    push_subscription?: PushSubscriptionBody | null;
  },
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

// ---------------------------------------------------------------- vehicles (D-12 / D-13)

/** One page of `GET /v1/tickets` (the D-12 infinite list; `ticket.updated` patches it in place). */
export interface VehiclePage {
  items: TicketSummary[];
  nextCursor: string | null;
}

/**
 * `GET /v1/tickets` for D-12: the open tickets of the driver's venue, minimal projection, newest first.
 * `q` = digits only (plate digits or the ticket number), `status` = comma list (07 `listTickets`).
 */
export async function listVehicles(
  filter: { q?: string; status?: readonly string[]; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<VehiclePage> {
  const result = await api.get<TicketSummary[]>('/v1/tickets', {
    query: {
      q: filter.q || undefined,
      status: filter.status?.length ? filter.status.join(',') : undefined,
      limit: filter.limit ?? 50,
      cursor: filter.cursor ?? undefined,
    },
    signal,
  });
  return { items: result.data ?? [], nextCursor: result.meta.next_cursor ?? null };
}

export interface RetrievalRequestResult {
  ticket: TicketSummary;
  cycle: RetrievalCycle;
  task: Task;
}

/** D-13 «طلب الإحضار نيابة عن العميل» (07 `POST /v1/tickets/{ticketId}/retrievals`, reason required). */
export async function requestOnBehalf(
  ticketId: string,
  body: { reason: string },
  key: string,
): Promise<RetrievalRequestResult> {
  return (
    await api.post<RetrievalRequestResult>(`/v1/tickets/${enc(ticketId)}/retrievals`, {
      body,
      idempotencyKey: key,
    })
  ).data;
}

/** D-13 «إلغاء طلب الإحضار» — the driver only before the assignment (07 `POST /retrieval-cycles/{id}/cancel`). */
export async function cancelRetrieval(
  cycleId: string,
  body: { reason: string },
  key: string,
): Promise<{ ticket: TicketSummary; cycle: RetrievalCycle }> {
  return (
    await api.post<{ ticket: TicketSummary; cycle: RetrievalCycle }>(
      `/v1/retrieval-cycles/${enc(cycleId)}/cancel`,
      { body, idempotencyKey: key },
    )
  ).data;
}

/** D-13 «إبلاغ عن واقعة» / D-10 «إبلاغ عن مشكلة» (07 `POST /v1/incidents`, the ticket attached). */
export async function reportIncident(
  body: {
    venue_id: string;
    event_id?: string | null;
    ticket_id?: string | null;
    type: IncidentType;
    description: string;
  },
  key: string,
): Promise<Incident> {
  return (await api.post<Incident>('/v1/incidents', { body, idempotencyKey: key })).data;
}

/** D-13 «تغيير رقم الجوال» (07 `PATCH /v1/tickets/{ticketId}/customer-phone`, with `expected_version`). */
export async function changeCustomerPhone(
  ticketId: string,
  body: { expected_version: number; customer_phone: string; consent: ConsentInput; reason: string },
  key: string,
): Promise<TicketDetail> {
  return (
    await api.patch<TicketDetail>(`/v1/tickets/${enc(ticketId)}/customer-phone`, {
      body,
      idempotencyKey: key,
    })
  ).data;
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

/**
 * D-06 (QR mode, right before the submit) and D-07: `direct` sends W-01 again to the ticket's number (the retry
 * of D-07, DEC-193), `qr` issues a link code for the customer-brand QR panel (07 `linkWhatsApp`, `wa.link`).
 */
export async function linkWhatsApp(
  ticketId: string,
  body: { method: 'direct' | 'qr' },
  key: string,
): Promise<WaLinkResult> {
  return (
    await api.post<WaLinkResult>(`/v1/tickets/${enc(ticketId)}/whatsapp-link`, { body, idempotencyKey: key })
  ).data;
}

/** D-07 «هل هو جوال العميل الذي أمامك؟» (07 `confirmWhatsAppLink`): `matches` links or rejects the sender. */
export async function confirmWhatsAppLink(
  ticketId: string,
  body: { link_code_id: string; matches: boolean },
  key: string,
): Promise<TicketDetail> {
  return (
    await api.post<TicketDetail>(`/v1/tickets/${enc(ticketId)}/whatsapp-link/confirm`, {
      body,
      idempotencyKey: key,
    })
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

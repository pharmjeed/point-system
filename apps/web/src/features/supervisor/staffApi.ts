import { api, apiFetch, type ApiResult } from '@/api/client';
import { ApiError } from '@/api/errors';
import type {
  Alert,
  AlertSeverity,
  AlertStatus,
  AlertType,
  AuditEntry,
  CashHandover,
  ClaimCodeState,
  CustodyEvent,
  CustodyHolderType,
  CustodySubject,
  DriverAssignment,
  DriverListItem,
  DriverReportRow,
  DriverState,
  DriverTransfer,
  EventStatus,
  EventSummaryReport,
  Export,
  ExportKind,
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  KeyBoard,
  KeySlot,
  MessagesReport,
  OperationsBoard,
  OrgSettings,
  OutboxEvent,
  OutboxStatus,
  ParkingSpot,
  Payment,
  PaymentMethod,
  PaymentsReport,
  Reconciliation,
  RetentionPolicy,
  RetrievalCycle,
  RoleScope,
  Settlement,
  SignedUrl,
  Task,
  TicketDetail,
  TicketSummary,
  TicketTimeline,
  User,
  Venue,
  VenueEvent,
  VenueSettings,
  WhatsAppChannel,
  WhatsAppTemplate,
} from '@/api/types';
import type {
  CreatedStaff,
  ForcedDutySession,
  ManualReconcileBody,
  StaffMember,
  WaLinkResult,
} from '@/api/types.staff';

/**
 * Data layer of the supervisor/admin/owner screens (07 §2.2–§2.7). Reads are React Query queries keyed by
 * `staffKeys` so the realtime client (PNT-064/065, another stream) can invalidate them by key when
 * `ticket.updated` / `alert.*` / `driver.state_changed` / `incident.updated` / `sync.required` arrive; until then
 * the screens poll (`refetchInterval`, 15 s like the board's fallback refetch in 15 §11.1).
 * Commands go through `useCommand` (Idempotency-Key per intent) — the senders below take that key.
 */

/** Board fallback refetch (15 §11.1: «جلب احتياطي كل 15 ثانية»). */
export const LIVE_REFETCH_MS = 15_000;

export const staffKeys = {
  all: ['staff'] as const,
  venues: () => ['staff', 'venues'] as const,
  venueEvents: (venueId: string, statuses: readonly string[]) =>
    ['staff', 'venue-events', venueId, statuses.join(',')] as const,
  venueSettings: (venueId: string) => ['staff', 'venue-settings', venueId] as const,
  keyBoards: (venueId: string) => ['staff', 'key-boards', venueId] as const,
  parkingSpots: (venueId: string) => ['staff', 'parking-spots', venueId] as const,
  /** `GET /v1/events/{eventId}/operations` — invalidate on ticket.updated, driver.state_changed, alert.*, sync.required. */
  board: (eventId: string) => ['staff', 'board', eventId] as const,
  boards: () => ['staff', 'board'] as const,
  ticketSearch: (scope: string, q: string) => ['staff', 'ticket-search', scope, q] as const,
  /** `GET /v1/tickets/{id}` — invalidate on ticket.updated (aggregate id). */
  ticket: (ticketId: string) => ['staff', 'ticket', ticketId] as const,
  /** `GET /v1/tickets/{id}/timeline`. */
  timeline: (ticketId: string) => ['staff', 'ticket', ticketId, 'timeline'] as const,
  mediaUrl: (mediaId: string) => ['staff', 'media-url', mediaId] as const,
  /** `GET /v1/alerts` — invalidate on alert.raised / alert.updated. */
  alerts: (filters?: AlertFilters) =>
    filters ? (['staff', 'alerts', filters] as const) : (['staff', 'alerts'] as const),
  /** `GET /v1/incidents` — invalidate on incident.updated. */
  incidents: (filters?: IncidentFilters) =>
    filters ? (['staff', 'incidents', filters] as const) : (['staff', 'incidents'] as const),
  incident: (incidentId: string) => ['staff', 'incident', incidentId] as const,
  driver: (driverId: string) => ['staff', 'driver', driverId] as const,
  driverAssignments: (driverId: string) => ['staff', 'driver', driverId, 'assignments'] as const,
  availableDrivers: (venueId: string) => ['staff', 'drivers', venueId, 'available'] as const,
  venueDrivers: (venueId: string) => ['staff', 'drivers', venueId] as const,
  event: (eventId: string) => ['staff', 'event', eventId] as const,
  reconciliation: (eventId: string) => ['staff', 'event', eventId, 'reconciliation'] as const,
  settlement: (eventId: string) => ['staff', 'event', eventId, 'settlement'] as const,
  report: (kind: string, params: Record<string, string | undefined>) =>
    ['staff', 'report', kind, params] as const,
  exportJob: (exportId: string) => ['staff', 'export', exportId] as const,
  auditLog: (filters: Record<string, string | undefined>, cursor: string | null) =>
    ['staff', 'admin', 'audit-log', filters, cursor] as const,
  outbox: (filters: Record<string, string | undefined>, cursor: string | null) =>
    ['staff', 'admin', 'outbox', filters, cursor] as const,
  waChannel: () => ['staff', 'admin', 'wa-channel'] as const,
  waTemplates: () => ['staff', 'admin', 'wa-templates'] as const,
  retention: () => ['staff', 'admin', 'retention'] as const,
  orgSettings: () => ['staff', 'admin', 'org-settings'] as const,
  /** `GET /v1/staff` (S-13 «الموظفون») — every page, filtered in the UI. */
  staffMembers: () => ['staff', 'admin', 'staff-members'] as const,
};

// ---------------------------------------------------------------- query strings

type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string>;

/**
 * Query string with OpenAPI's default for arrays (`style: form, explode: true` → `?status=a&status=b`), or a
 * comma list where 07 says so (`GET /v1/tickets` `status`: «قيم متعددة مفصولة بفاصلة»).
 */
export function withQuery(
  path: string,
  query: Record<string, QueryValue>,
  options: { commaArrays?: readonly string[] } = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      if (options.commaArrays?.includes(key)) params.append(key, value.join(','));
      else for (const v of value) params.append(key, v);
    } else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const get = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
  (await api.get<T>(path, { signal })).data;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const getPage = async <T>(path: string, signal?: AbortSignal): Promise<Page<T>> => {
  const r: ApiResult<T[]> = await apiFetch<T[]>('GET', path, { signal });
  return { items: r.data ?? [], nextCursor: r.meta.next_cursor ?? null };
};

// ---------------------------------------------------------------- reads

export const fetchVenues = (signal?: AbortSignal) =>
  getPage<Venue>(withQuery('/v1/venues', { status: 'active', limit: 200 }), signal);

export const fetchVenueEvents = (venueId: string, statuses: readonly EventStatus[], signal?: AbortSignal) =>
  getPage<VenueEvent>(
    withQuery(`/v1/venues/${encodeURIComponent(venueId)}/events`, { status: statuses, limit: 200 }),
    signal,
  );

export const fetchVenueSettings = (venueId: string, signal?: AbortSignal) =>
  get<{ settings: VenueSettings; version: number }>(
    `/v1/venues/${encodeURIComponent(venueId)}/settings`,
    signal,
  );

export const fetchKeyBoards = (venueId: string, signal?: AbortSignal) =>
  get<Array<{ board: KeyBoard; slots: KeySlot[] }>>(
    withQuery(`/v1/venues/${encodeURIComponent(venueId)}/key-boards`, { active_only: true }),
    signal,
  );

export const fetchParkingSpots = (venueId: string, signal?: AbortSignal) =>
  getPage<ParkingSpot>(
    withQuery(`/v1/venues/${encodeURIComponent(venueId)}/parking-spots`, {
      available_only: true,
      limit: 200,
    }),
    signal,
  );

export const fetchBoard = (eventId: string, signal?: AbortSignal) =>
  get<OperationsBoard>(`/v1/events/${encodeURIComponent(eventId)}/operations`, signal);

export const searchTickets = (
  scope: { eventId?: string; venueId?: string },
  q: string,
  signal?: AbortSignal,
) =>
  getPage<TicketSummary>(
    withQuery('/v1/tickets', {
      q,
      event_id: scope.eventId,
      venue_id: scope.eventId ? undefined : scope.venueId,
      open_only: false,
      limit: 20,
    }),
    signal,
  );

export const fetchTicket = (ticketId: string, signal?: AbortSignal) =>
  get<TicketDetail>(`/v1/tickets/${encodeURIComponent(ticketId)}`, signal);

export const fetchTimeline = (ticketId: string, signal?: AbortSignal) =>
  get<TicketTimeline>(`/v1/tickets/${encodeURIComponent(ticketId)}/timeline`, signal);

export const fetchMediaUrl = (mediaId: string, signal?: AbortSignal) =>
  get<SignedUrl>(`/v1/media/${encodeURIComponent(mediaId)}/url`, signal);

export interface AlertFilters {
  venue_id?: string;
  status?: AlertStatus[];
  type?: AlertType;
  severity?: AlertSeverity;
}

export const fetchAlerts = (filters: AlertFilters, signal?: AbortSignal) =>
  getPage<Alert>(withQuery('/v1/alerts', { ...filters, limit: 200 }), signal);

export interface IncidentFilters {
  venue_id?: string;
  event_id?: string;
  ticket_id?: string;
  status?: IncidentStatus[];
  type?: IncidentType;
}

export const fetchIncidents = (filters: IncidentFilters, signal?: AbortSignal) =>
  getPage<Incident>(withQuery('/v1/incidents', { ...filters, limit: 200 }), signal);

export const fetchIncident = (incidentId: string, signal?: AbortSignal) =>
  get<Incident>(`/v1/incidents/${encodeURIComponent(incidentId)}`, signal);

export const fetchDriver = (driverId: string, signal?: AbortSignal) =>
  get<DriverListItem>(`/v1/drivers/${encodeURIComponent(driverId)}`, signal);

export const fetchDriverAssignments = (driverId: string, signal?: AbortSignal) =>
  get<{ assignments: DriverAssignment[]; transfers: DriverTransfer[] }>(
    `/v1/drivers/${encodeURIComponent(driverId)}/assignments`,
    signal,
  );

export const fetchDrivers = (
  filters: { venue_id?: string; driver_state?: DriverState },
  signal?: AbortSignal,
) => getPage<DriverListItem>(withQuery('/v1/drivers', { ...filters, status: 'active', limit: 200 }), signal);

export const fetchEvent = (eventId: string, signal?: AbortSignal) =>
  get<VenueEvent>(`/v1/events/${encodeURIComponent(eventId)}`, signal);

export const fetchReconciliation = (eventId: string, signal?: AbortSignal) =>
  get<Reconciliation>(`/v1/events/${encodeURIComponent(eventId)}/reconciliation`, signal);

export const fetchSettlement = (eventId: string, signal?: AbortSignal) =>
  get<Settlement>(`/v1/events/${encodeURIComponent(eventId)}/settlement`, signal);

export const fetchEventSummary = (eventId: string, signal?: AbortSignal) =>
  get<EventSummaryReport>(`/v1/reports/events/${encodeURIComponent(eventId)}/summary`, signal);

export interface PeriodFilters {
  venue_id?: string;
  event_id?: string;
  from?: string;
  to?: string;
}

export const fetchDriversReport = (f: PeriodFilters, signal?: AbortSignal) =>
  getPage<DriverReportRow>(
    withQuery('/v1/reports/drivers', { venue_id: f.venue_id, from: f.from, to: f.to, limit: 200 }),
    signal,
  );

export const fetchPaymentsReport = (f: PeriodFilters, signal?: AbortSignal) =>
  get<PaymentsReport>(
    withQuery('/v1/reports/payments', { venue_id: f.venue_id, event_id: f.event_id, from: f.from, to: f.to }),
    signal,
  );

export const fetchMessagesReport = (f: PeriodFilters, signal?: AbortSignal) =>
  get<MessagesReport>(
    withQuery('/v1/reports/messages', { venue_id: f.venue_id, from: f.from, to: f.to }),
    signal,
  );

export const fetchExport = (exportId: string, signal?: AbortSignal) =>
  get<Export>(`/v1/exports/${encodeURIComponent(exportId)}`, signal);

export const fetchAuditLog = (
  filters: Record<string, string | undefined>,
  cursor: string | null,
  signal?: AbortSignal,
) => getPage<AuditEntry>(withQuery('/v1/admin/audit-log', { ...filters, cursor, limit: 50 }), signal);

export const fetchOutbox = (
  filters: { status?: OutboxStatus[]; type?: string; older_than_s?: string },
  cursor: string | null,
  signal?: AbortSignal,
) => getPage<OutboxEvent>(withQuery('/v1/admin/outbox', { ...filters, cursor, limit: 50 }), signal);

/**
 * The one WhatsApp channel, or null before the owner sets it up: the server answers RESOURCE_NOT_FOUND while no
 * row exists (07 §2.7, DEC-142), which S-13 shows as «لم تُضبط القناة بعد.» with the owner's create form (PUT).
 */
export const fetchWaChannel = async (signal?: AbortSignal): Promise<WhatsAppChannel | null> => {
  try {
    return await get<WhatsAppChannel>('/v1/admin/whatsapp/channel', signal);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'RESOURCE_NOT_FOUND') return null;
    throw e;
  }
};

export const fetchWaTemplates = (signal?: AbortSignal) =>
  get<WhatsAppTemplate[]>('/v1/admin/whatsapp/templates', signal);

export const fetchRetention = (signal?: AbortSignal) =>
  get<RetentionPolicy>('/v1/admin/retention-policy', signal);

export const fetchOrgSettings = (signal?: AbortSignal) => get<OrgSettings>('/v1/admin/org-settings', signal);

/**
 * `GET /v1/staff` read to the end (an organization has tens of staff accounts; 07 §1.7 cursor pages). The server
 * already narrows it: the owner sees admins and supervisors, an admin sees supervisors only (09 §4.6).
 */
export async function fetchStaffMembers(signal?: AbortSignal): Promise<StaffMember[]> {
  const out: StaffMember[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const r: Page<StaffMember> = await getPage<StaffMember>(
      withQuery('/v1/staff', { limit: 200, cursor }),
      signal,
    );
    out.push(...r.items);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// ---------------------------------------------------------------- commands (Idempotency-Key from useCommand)

const post = async <T>(path: string, body: unknown, key: string): Promise<T> =>
  (await api.post<T>(path, { body, idempotencyKey: key })).data;

const put = async <T>(path: string, body: unknown, key: string): Promise<T> =>
  (await api.put<T>(path, { body, idempotencyKey: key })).data;

const patch = async <T>(path: string, body: unknown, key: string): Promise<T> =>
  (await api.patch<T>(path, { body, idempotencyKey: key })).data;

const t = (ticketId: string) => `/v1/tickets/${encodeURIComponent(ticketId)}`;

export const commands = {
  acknowledgeAlert: (alertId: string, body: { note: string | null }, key: string) =>
    post<Alert>(`/v1/alerts/${encodeURIComponent(alertId)}/acknowledge`, body, key),
  resolveAlert: (alertId: string, body: { note: string | null }, key: string) =>
    post<Alert>(`/v1/alerts/${encodeURIComponent(alertId)}/resolve`, body, key),

  revealPhone: (ticketId: string, body: { reason: string }, key: string) =>
    post<{ phone_e164: string; revealed_at: string }>(`${t(ticketId)}/reveal-phone`, body, key),
  voidTicket: (
    ticketId: string,
    body: { reason: string; custody_returned_to_customer: true; expected_version?: number },
    key: string,
  ) => post<TicketDetail>(`${t(ticketId)}/void`, body, key),
  inspectionException: (ticketId: string, body: { reason: string }, key: string) =>
    post<TicketDetail>(`${t(ticketId)}/inspection-exception`, body, key),
  requestOnBehalf: (ticketId: string, body: { reason: string }, key: string) =>
    post<{ ticket: TicketSummary; cycle: RetrievalCycle; task: Task }>(
      `${t(ticketId)}/retrievals`,
      body,
      key,
    ),
  cancelRetrieval: (cycleId: string, body: { reason: string }, key: string) =>
    post<{ ticket: TicketSummary; cycle: RetrievalCycle; repark_task?: Task | null }>(
      `/v1/retrieval-cycles/${encodeURIComponent(cycleId)}/cancel`,
      body,
      key,
    ),
  reassignTask: (
    taskId: string,
    body: {
      reason: string;
      target_driver_id: string | null;
      override_priority?: boolean;
      expected_version?: number;
    },
    key: string,
  ) =>
    post<{ task: Task; ticket: TicketSummary }>(
      `/v1/tasks/${encodeURIComponent(taskId)}/reassign`,
      body,
      key,
    ),
  releaseCustody: (taskId: string, body: { key_slot_id: string; reason: string }, key: string) =>
    post<Task>(`/v1/tasks/${encodeURIComponent(taskId)}/release-custody`, body, key),
  repark: (ticketId: string, body: { reason: string; expected_version?: number }, key: string) =>
    post<{ ticket: TicketDetail; task: Task }>(`${t(ticketId)}/repark`, body, key),
  handoverException: (
    ticketId: string,
    body: {
      reason: string;
      identity_checks: {
        phone_last4?: string;
        plate_confirmed?: boolean;
        vehicle_description_confirmed?: boolean;
        document_note?: string;
      };
      payment?: {
        method: PaymentMethod;
        amount_halalas: number;
        pos_reference?: string | null;
        collected_by: string;
      } | null;
      expected_version?: number;
    },
    key: string,
  ) =>
    post<{ ticket: TicketDetail; cycle: RetrievalCycle; payment?: Payment | null }>(
      `${t(ticketId)}/handover-exception`,
      body,
      key,
    ),
  resendCode: (ticketId: string, key: string) =>
    post<ClaimCodeState>(`${t(ticketId)}/handover-code/resend`, undefined, key),
  custodyTransfer: (
    ticketId: string,
    body: {
      subject: CustodySubject;
      to_holder_type: CustodyHolderType;
      to_holder_id: string | null;
      reason: string;
    },
    key: string,
  ) => post<CustodyEvent>(`${t(ticketId)}/custody-transfers`, body, key),
  recordPayment: (
    ticketId: string,
    body: { method: PaymentMethod; amount_halalas: number; pos_reference?: string | null },
    key: string,
  ) => post<{ payment: Payment; ticket: TicketSummary }>(`${t(ticketId)}/payments`, body, key),
  reversePayment: (
    paymentId: string,
    body: {
      reason: string;
      replacement?: { method: PaymentMethod; amount_halalas: number; pos_reference?: string | null } | null;
    },
    key: string,
  ) =>
    post<{ reversed: Payment; replacement?: Payment | null }>(
      `/v1/payments/${encodeURIComponent(paymentId)}/reverse`,
      body,
      key,
    ),
  waivePayment: (ticketId: string, body: { reason: string }, key: string) =>
    post<TicketDetail>(`${t(ticketId)}/payment-waiver`, body, key),

  // S-03 (GAP-2): manual reconcile after an outage, customer phone change, WhatsApp re-link (07 §2.2, §2.3)
  manualReconcile: (ticketId: string, body: ManualReconcileBody, key: string) =>
    post<TicketDetail>(`${t(ticketId)}/manual-reconcile`, body, key),
  changeCustomerPhone: (
    ticketId: string,
    body: {
      expected_version: number;
      customer_phone: string;
      consent: { method: 'verbal_staff_confirmed'; confirmed: true };
      reason: string;
    },
    key: string,
  ) => patch<TicketDetail>(`${t(ticketId)}/customer-phone`, body, key),
  linkWhatsApp: (ticketId: string, body: { method: 'direct' | 'qr' }, key: string) =>
    post<WaLinkResult>(`${t(ticketId)}/whatsapp-link`, body, key),
  confirmWhatsAppLink: (ticketId: string, body: { link_code_id: string; matches: boolean }, key: string) =>
    post<TicketDetail>(`${t(ticketId)}/whatsapp-link/confirm`, body, key),

  createIncident: (
    body: {
      venue_id: string;
      event_id?: string | null;
      ticket_id?: string | null;
      type: IncidentType;
      severity?: IncidentSeverity;
      description: string;
    },
    key: string,
  ) => post<Incident>('/v1/incidents', body, key),
  updateIncident: (
    incidentId: string,
    body: {
      expected_version: number;
      status?: IncidentStatus;
      severity?: IncidentSeverity;
      owner_id?: string | null;
      resolution?: string | null;
      description?: string;
    },
    key: string,
  ) => patch<Incident>(`/v1/incidents/${encodeURIComponent(incidentId)}`, body, key),

  transferDriver: (
    driverId: string,
    body: { to_venue_id: string; scheduled_at?: string | null; reason: string },
    key: string,
  ) => post<DriverTransfer>(`/v1/drivers/${encodeURIComponent(driverId)}/transfers`, body, key),
  cancelTransfer: (transferId: string, body: { reason: string }, key: string) =>
    post<DriverTransfer>(`/v1/transfers/${encodeURIComponent(transferId)}/cancel`, body, key),
  /** S-06 «إنهاء المناوبة قسرًا» (GAP-6): `duty.force_end` is the supervisor's alone (canon §10). */
  forceEndDuty: (sessionId: string, body: { reason: string }, key: string) =>
    post<ForcedDutySession>(`/v1/duty-sessions/${encodeURIComponent(sessionId)}/force-end`, body, key),

  startClosing: (eventId: string, body: { expected_version?: number }, key: string) =>
    post<VenueEvent>(`/v1/events/${encodeURIComponent(eventId)}/start-closing`, body, key),
  closeEvent: (eventId: string, body: { expected_version?: number; note?: string | null }, key: string) =>
    post<VenueEvent>(`/v1/events/${encodeURIComponent(eventId)}/close`, body, key),
  cashHandover: (
    body: { event_id: string; driver_id: string; amount_halalas: number; note?: string | null },
    key: string,
  ) => post<CashHandover>('/v1/cash-handovers', body, key),

  createExport: (
    body: {
      kind: ExportKind;
      filters: { venue_id?: string; event_id?: string; from?: string; to?: string };
    },
    key: string,
  ) => post<Export>('/v1/exports', body, key),

  retryOutbox: (outboxId: string, key: string) =>
    post<OutboxEvent>(`/v1/admin/outbox/${encodeURIComponent(outboxId)}/retry`, undefined, key),
  syncTemplates: (key: string) =>
    post<WhatsAppTemplate[]>('/v1/admin/whatsapp/templates/sync', undefined, key),
  putWaChannel: (
    body: {
      display_name?: string;
      business_account_id: string;
      phone_number_id: string;
      phone_display?: string | null;
      api_version: string;
      mode: 'live' | 'simulator';
      access_token_secret_ref: string;
      app_secret_ref: string;
      verify_token_secret_ref: string;
    },
    key: string,
  ) => put<WhatsAppChannel>('/v1/admin/whatsapp/channel', body, key),
  putRetention: (body: Omit<RetentionPolicy, 'approved_by_owner' | 'updated_at'>, key: string) =>
    put<RetentionPolicy>('/v1/admin/retention-policy', body, key),
  putOrgSettings: (body: OrgSettings, key: string) => put<OrgSettings>('/v1/admin/org-settings', body, key),

  // S-13 «الموظفون» (GAP-3; 07 §2.6, canon §10 `staff.manage`)
  createStaff: (
    body: {
      full_name: string;
      phone: string;
      role: 'admin' | 'supervisor';
      can_drive?: boolean;
      venue_ids?: string[];
    },
    key: string,
  ) => post<CreatedStaff>('/v1/staff', body, key),
  patchStaff: (
    userId: string,
    body: {
      expected_version: number;
      full_name?: string;
      phone?: string;
      can_drive?: boolean;
      status?: 'active' | 'disabled';
      reason?: string;
    },
    key: string,
  ) => patch<User>(`/v1/staff/${encodeURIComponent(userId)}`, body, key),
  updateStaffScopes: (
    userId: string,
    body: { grant_venue_ids?: string[]; revoke_venue_ids?: string[]; org_scope?: boolean },
    key: string,
  ) => post<RoleScope[]>(`/v1/staff/${encodeURIComponent(userId)}/scopes`, body, key),
  resetStaffMfa: (userId: string, body: { reason: string }, key: string) =>
    post<User>(`/v1/staff/${encodeURIComponent(userId)}/reset-mfa`, body, key),
};

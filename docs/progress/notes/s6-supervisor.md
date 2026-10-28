# S6 supervisor backend — التنبيهات والوقائع ولوحة التشغيل وإجراءات المشرف (PNT-074 … PNT-085, notes)

Backend only (no web screen). Built on the S2 slice (tickets-custody, dispatch v1, use-cases) and the core alert
writer of DEC-79.

## Structure

- `packages/server/src/modules/incidents/` — 04 §4.2 item 7; imports venues-events and core only.
  - `application/alerts.service.ts` — `GET /v1/alerts`, acknowledge, resolve (through the core `publishStatus`).
  - `application/alert-auto-resolver.ts` — the `alert_auto_resolver` EventProjector (11 §6.10 table, below).
  - `application/incidents.service.ts` — `GET/POST /v1/incidents`, `GET/PATCH /v1/incidents/{incidentId}`, and
    `openIncident()` for the flows that open incidents themselves (TT-19, TT-20, a reversal after delivery).
  - `application/scope.ts` — `scopeStillGranted()` (TOCTOU re-check, 09 §8.4) and `staffEligibleForVenue()`.
  - `http/` — `AlertsController`, `IncidentsController`, zod schemas, `IncidentsHttpModule`.
  - `jobs/index.ts` — `incidentsJobs()` (none), `incidentsProjectors()` (the resolver).
- `packages/server/src/use-cases/` (they compose tickets-custody, dispatch, incidents, media, whatsapp; 04 §4.3):
  - `operations-board.ts` (PNT-074), `ticket-timeline.ts` (PNT-076), `reveal-phone.ts` (PNT-077),
    `inspection-exception.ts` and `custody-transfer.ts` (PNT-079), `manual-reconcile.ts` (PNT-085),
    `supervisor-views.ts` (WhatsAppMessage / CustodyEvent / Payment views, customer-text masking).
  - `http/*.controller.ts` (one per ticket), `http/supervisor-schemas.ts`, `http/supervisor.module.ts`
    (`SupervisorHttpModule`, imports `MediaHttpModule` for the photo URLs).
- `packages/server/src/modules/tickets-custody/jobs/ready-uncollected.ts` — `job.ready_uncollected_check`.
- `packages/server/src/modules/audit-monitoring/jobs/system-monitor.ts` — `draft_abandoned` evaluation added.

## Routes

| Route | Permission | Notes |
|---|---|---|
| `GET /v1/alerts` | `alert.read` | venue scope (`venue_id` outside → `SCOPE_VENUE_DENIED`), `status` (default `open,acknowledged`; repeated or comma list), `type`, `severity`, signed keyset cursor, newest first |
| `POST /v1/alerts/{alertId}/acknowledge` | `alert.manage` | `open` → `acknowledged`; `alert.acknowledged` + WS `alert.updated` (stops the escalation sound) |
| `POST /v1/alerts/{alertId}/resolve` | `alert.manage` | `open`/`acknowledged` → `resolved`, `resolution_note` = note |
| `GET /v1/incidents`, `GET /v1/incidents/{incidentId}` | `incident.read` | filters `venue_id`, `event_id`, `ticket_id`, `status[]`, `type`; newest first |
| `POST /v1/incidents` | `incident.create` | 201; `incident.opened` |
| `PATCH /v1/incidents/{incidentId}` | `incident.manage` | 11 §6.11 transitions; `incident.updated` / `incident.resolved` |
| `GET /v1/events/{eventId}/operations` | `alert.read` | the S-02 snapshot (REPEATABLE READ, one `now`) |
| `GET /v1/tickets/{ticketId}/timeline` | `ticket.read_full` | S-03 |
| `POST /v1/tickets/{ticketId}/reveal-phone` | `ticket.reveal_phone` | `Cache-Control: private, no-store` |
| `POST /v1/tickets/{ticketId}/inspection-exception` | `ticket.inspection_exception` | |
| `POST /v1/tickets/{ticketId}/custody-transfers` | `ticket.custody_transfer` | 201 CustodyEvent |
| `POST /v1/tickets/{ticketId}/manual-reconcile` | `ticket.manual_reconcile` | TicketDetail |

## Alert producers and automatic resolution

- `ready_not_collected:{cycle_id}` — `POST /v1/tasks/{taskId}/ready` schedules `job.ready_uncollected_check` at
  `ready_at + ready.uncollected_alert_min` (payload `{ticket_id, cycle_id, ready_at}`, dedupe
  `ready_uncollected:{cycle_id}`, aggregate the cycle). The handler (tickets-custody `ticketsCustodyJobs()`) locks
  L5 → L6, requires the ticket still `ready` on that cycle with that readiness mark, reschedules when it fires early
  (or the threshold was raised), raises the alert with the task and the driver, and writes a system audit row.
- `draft_abandoned:{ticket_id}` — the SystemMonitor (every tick, one process) raises it for drafts `received` for at
  least `intake.draft_abandoned_alert_min` of their venue since creation, unless a live one exists (the alert of a
  refused discard keeps its details), and resolves the live ones whose ticket left `received`.
- `inspection_incomplete` — raised at submit by S2; resolved by the exception command (inline) and by the resolver on
  `ticket.inspection_completed` (late photo completion, the media module leaves it to "its consumer").
- `driver_connection_lost_with_custody` — raised by `job.heartbeat_sweep` (PNT-062, dispatch); not derivable here.
  The resolver clears it when a `custody.changed` leaves the driver with nothing (no vehicle or key of an open ticket,
  no active movement); the reconnect resolution belongs to the heartbeat sweep.
- AlertAutoResolver (worker projector, idempotent, only alerts raised no later than the event):

| Event | Clears |
|---|---|
| `task.claimed` | `request_unaccepted:{task}` |
| `task.started`, `task.promoted`, `task.reassigned`, `task.withdrawn` | `next_task_waiting_long:{task}`, `idle_driver_while_next_waiting:{task}` |
| `task.canceled` | the three above |
| `ticket.delivered`, `ticket.retrieval_canceled`, `ticket.reparking` (`closed_cycle_id`) | `ready_not_collected:{cycle}`, `handover_code_locked:{cycle}` |
| `handover.code_issued`, `handover.exception_approved` | `handover_code_locked:{cycle}` |
| `ticket.inspection_completed`, `ticket.inspection_exception_approved` | `inspection_incomplete:{ticket}` |
| `ticket.intake_submitted` | `draft_abandoned:{ticket}` |
| `ticket.voided` | `draft_abandoned`, `inspection_incomplete` of the ticket |
| `ticket.delivered`, `ticket.voided`, `ticket.manually_reconciled` (to delivered/voided) | `wa_send_failed:{ticket}:*` |
| `custody.changed` (from a driver who now holds nothing) | `driver_connection_lost_with_custody:{his sessions}` |

## Changes outside my modules (all additive)

- `modules/venues-events/index.ts`: exports `ListCursorCodec`, `pageOf`, `CursorValue`, `EVENT_COLUMNS`,
  `toVenueEvent`, `VenueEventRow`, `VenueEventDto`.
- `modules/media/index.ts`: exports `MediaReadUrlQuery`, `SignedUrlDto`.
- `modules/tickets-custody`: `jobs/index.ts` returns the new handler; `index.ts` exports `READY_UNCOLLECTED_JOB`,
  `readyUncollectedHandler`, `scheduleReadyUncollectedCheck`.
- `use-cases/movement.ts`: `markReady` schedules the check (replaces the S2 extension-point comment, one line).
- `modules/audit-monitoring/jobs/system-monitor.ts`: `evaluateAbandonedDrafts`, `abandonedDrafts()`,
  `MonitorReport.drafts`.
- Registration lines: `packages/server/src/index.ts` (incidents export uncommented), `apps/api/src/features.ts`
  (`IncidentsHttpModule` uncommented, `SupervisorHttpModule` appended), `apps/worker/src/handlers.ts` (incidents jobs
  and projectors uncommented); `use-cases/index.ts` appended exports.

## Tests (apps/api/test, real routes, PostgreSQL 16)

- `alerts-incidents.int.test.ts` (15): list/filters/scope/cursor, dedupe, acknowledge (WS frame, audit, replay,
  409), resolve (note kept, admins room for multi-venue types), not found/TOCTOU, the resolver table event by event,
  real flows (claim, delivery, custody gone); incidents create/scope/driver rules/list/get/PATCH transitions.
- `alert-producers.int.test.ts` (5): the ready timer (due, stale, early), draft_abandoned (threshold, once, resolved
  on leaving `received`, refused discard kept, void inline).
- `operations-board.int.test.ts` (5): **AC1 — 200 seeded random operations** (intake, park, request, broadcast,
  accept, key pickup, start, ready, handover, breaks, clock + worker drains) with the board compared to reference SQL
  every 25 steps for two events, plus the invariants; queue/badges/offer recipient/KPIs; active tasks
  «لم تُستلم»; alerts, failed messages, channel health; custody issues; scope.
- `ticket-timeline.int.test.ts` (4): full staff view with the custody chain and signed photo URLs; the code, its
  ciphertext and hash, phones and link codes never appear; driver view; supervisor commands refused to drivers.
- `reveal-phone.int.test.ts` (4): number once with `no-store`, audit without the number, masked replay; reason,
  permission, scope, no phone; `RATE_LIMITED` with `Retry-After`, not stored, window rolls.
- `supervisor-actions.int.test.ts` (8): inspection exception (event, alert, audit, `self_approved`, refusals);
  custody transfers (201 view, previous holder's later command `CUSTODY_HOLDER_MISMATCH`, task follows the item with
  settlement, `MOVEMENT_IN_PROGRESS`, holder eligibility, spot/slot allocations and occupancy, unknown key reaching the
  assignee, validation/permissions/closed).
- `manual-reconcile.int.test.ts` (6): in-flight retrieval → delivered with no customer message (pending W-02 skipped,
  nothing planned), custody `manual_reconcile`, driver released, audit; ready → parked with code revoked and purged;
  a reserved next task reconciled away; parking/draft → parked/voided without replaying the early request; payment
  rules (13 §8.5); refusals.
- Every `x-error-codes` entry of these routes is reached through the real route, except `SCOPE_VENUE_DENIED` of
  `GET /v1/tickets/{ticketId}/timeline` (unreachable by design, DEC-PROPOSED-13).

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | The acknowledgement note has no column (`alerts` has `resolution_note` only): it is kept in the audit row (`metadata.note`); the resolve note is `resolution_note`. | 06 alerts, 07 acknowledgeAlert | 07 |
| DEC-PROPOSED-2 | Alert and incident lists: newest first (`raised_at` / `created_at`, then `id`); array query parameters accepted repeated or comma separated; without `venue_id` every venue of the caller's scope. | 07 §1.7 | 07 listAlerts, listIncidents |
| DEC-PROPOSED-3 | Automatic resolution runs in the worker as the AlertAutoResolver projector with the table above, only for alerts raised no later than the event; producers that resolve inline keep doing so (idempotent). Ticket closure resolves the ticket's `wa_send_failed:*`; `driver_connection_lost_with_custody` clears when custody is gone (reconnect: heartbeat sweep). | 11 §6.10, 14 §8 | 04 §4.2 item 7 |
| DEC-PROPOSED-4 | `POST /v1/incidents` by a driver needs `ticket_id` (`VALIDATION_FAILED required_for_driver`) of an open ticket of his venue (closed → `TICKET_NOT_FOUND`); a ticket or event of another venue than `venue_id` → `VALIDATION_FAILED venue_mismatch` / `ticket_event_mismatch`; an event outside the scope → `RESOURCE_NOT_FOUND {resource: event}`; `event_id` defaults to the ticket's event. | canon §10 `incident.create`, 08 §1.3 | 07 createIncident |
| DEC-PROPOSED-5 | 07 lists `x-ws-events: alert.raised` for `POST /v1/incidents`: read as `incident.updated` (11 §8.8). The incidents module publishes no realtime; the realtime planner maps `incident.*` to WS `incident.updated` (and `ticket.updated` when linked). | 11 §8.8, 07 | 07 createIncident |
| DEC-PROPOSED-6 | Incident PATCH: one event per change (`incident.resolved` when it becomes resolved, otherwise `incident.updated` with `changed`); resolution required to resolve (`VALIDATION_FAILED resolution required`, also for clearing it on a resolved incident); reopening (`resolved → in_review`) clears `resolution`, `resolved_by`, `resolved_at` (the audit keeps them); `closed` is final (`INVALID_STATE_TRANSITION reason incident_closed`); `owner_id` must be active staff with the venue in scope (unknown → `RESOURCE_NOT_FOUND {resource: user}`, else `VALIDATION_FAILED not_eligible`); a no-op PATCH bumps nothing, emits nothing, is audited `noop`. | 11 §6.11, 09 §11 | 11 §6.11, 07 updateIncident |
| DEC-PROPOSED-7 | `openIncident()` is the seam for system-opened incidents (TT-19, TT-20, reversal after delivery): `opened_by` is the commanding user (06 NOT NULL), a `resolution` creates it resolved with `incident.opened` then `incident.resolved`. | 11 §6.11 | 04 module map |
| DEC-PROPOSED-8 | Operations board queue = the requests nobody is moving yet: the unaccepted demand of `v_pool_queue` and the reserved next tasks (`assigned_waiting`, S-02 «محجوز تالٍ»), oldest first; `oldest_wait_seconds` from `v_pool_queue` only (15 §11.1); accepted/in-progress tasks are `active_tasks`. `QueueItem` adds `badges` (`late`, `long_wait`) and `offer.recipient` (single round, «معروض على {سائق}»); `TaskCard` on the board adds `badges` (`not_collected`, `long_wait`). | 02 S-02, 15 §11.1 | 07 QueueItem, TaskCard |
| DEC-PROPOSED-9 | Board KPIs: `drivers_on_duty` = every open duty session of the event's pool, breaks included; `drivers_busy` = intake_parking + retrieving + busy_with_next; `avg_accept_seconds_30m` = KPI-01 (`claimed_at − queued_at`) of retrieve tasks claimed in the last 30 minutes, 0.1 s, `null` when none. | 15 KPI-01, 02 S-02 | 07 OperationsBoard |
| DEC-PROPOSED-10 | Board `alerts` = live alerts of the venue whose `event_id` is null or this event, critical → warning → info then newest (≤ 200); `failed_messages` = outbound `failed` of the event in the last 30 minutes (`failed_at`, else `created_at`; ≤ 100); `channel_health` = the active channel's health, `down` when none. | 15 §11.1 | 07 OperationsBoard |
| DEC-PROPOSED-11 | `custody_issues` (S-02 «العهدة»): a vehicle or key of an open ticket of the event held by `unknown` or `supervisor`, by a driver who is off duty or not `online`, by a driver without an open task on the ticket, or by the creator of a draft beyond `intake.draft_abandoned_alert_min`; `since` = the last custody event of that subject. | 02 S-02, 15 §11.1 | 07 OperationsBoard |
| DEC-PROPOSED-12 | The timeline adds `media` (the Media items with `read_url` signed by the media module exactly as `GET /v1/media/{mediaId}/url`, ≤ 300 s, logged there); sections are oldest first; custody events of one instant follow their timeline rows (`custody_events.id` is random). | 16 PNT-076, 02 S-03, 09 §6.3 | 07 TicketTimeline |
| DEC-PROPOSED-13 | Timeline visibility: staff in scope see all; a driver only as the open task's assignee or the creator during intake (else `TICKET_NOT_FOUND`) and then only his own steps (events he performed or of his tasks/cycles/custody, no `wa.*`), custody involving him, his cycles and tasks, W-01/W-05 outbound status without text, his own collections, no incidents. `SCOPE_VENUE_DENIED` cannot occur on this route (addressed by ticket id, 08 §1.3 rule 4, as DEC-112): drop it from its `x-error-codes`. | 09 §5.1 | 07 getTicketTimeline |
| DEC-PROPOSED-14 | Inbound WhatsApp text is stored as received (12 §6.5), so the supervisor views mask runs of 6+ digits (phones, handover codes; Western, Arabic-Indic and Persian digits, spaces/dashes inside) and link-code-like tokens (6 characters of the link alphabet mixing letters and digits) with `••••••`; outbound text is stored masked already. | 09 §5.1, 12 §5.10 | 12 §6.5 |
| DEC-PROPOSED-15 | Reveal-phone: the hourly limit counts the user's `ticket.reveal_phone` audit rows in a rolling hour, serialized by a per-user advisory transaction lock; `RATE_LIMITED {retry_after_s}` + `Retry-After` = time until the oldest counted reveal leaves the window (429 is not stored with the key). Allowed in any ticket status (11 §2.4). A ticket without a phone (paper, a customer known only by BSUID) → `RESOURCE_NOT_FOUND {resource: customer}`. The idempotent replay stored with the key carries the masked number (rewritten before COMMIT), so no new copy of the full number stays in the database; a replay returns the masked number. | 09 §5.1 rule 2, §11, 07 §1.4 | 07 revealCustomerPhone |
| DEC-PROPOSED-16 | Inspection exception on a closed ticket → `INVALID_STATE_TRANSITION reason ticket_closed`; not `incomplete` → `INVALID_STATE_TRANSITION reason inspection_not_incomplete` (`allowed_from` = the open statuses); the `inspection_incomplete` alert is resolved automatically (`resolved_by` NULL); payload adds `missing_photos_count`; audit `missing_photos`, `self_approved` (approver = creator). | 11 §2.4, 09 §10–§11, 15 | 11 §8.2 |
| DEC-PROPOSED-17 | Custody transfer targets: never `customer` (delivery is TT-18/TT-19: `VALIDATION_FAILED use_handover`); vehicle → driver/spot/supervisor/unknown, key → driver/key_slot/supervisor/unknown (`not_allowed_for_subject`); a `parked` vehicle only to a spot or unknown (`parked_vehicle_spot_or_unknown`; the route lists no INVALID_STATE_TRANSITION); a driver holder must be an active driver (or can-drive supervisor) `on_duty` in the ticket's pool (`driver_not_on_duty`, `not_a_driver`); a supervisor holder active staff with the venue in scope. The reason is the custody event's `note`; the pool lock is always taken. | 11 §2.4, §2.7, DEC-32, 06 checks | 07 transferCustody, 11 §2.4 |
| DEC-PROPOSED-18 | The task follows an item that goes to another driver while it is `accepted`/`in_progress` (either subject); the new assignee leaves `available` (his live single offers revoked `recipient_unavailable`), the previous is settled (promotion or available) then a pass. The key reaching the assignee of an accepted retrieval counts as picked up (`key_picked_up_at`, `task.key_picked_up` with `key_slot_id: null` — the S2 DEC-PROPOSED-20 path); a key leaving him before the start resets it. `task.reassigned` carries 11 §8.3 plus `from_status` and `target: driver` (analytics). A draft's park task follows too: the intake stays the creator's (PATCH/submit are creator-only), the new assignee completes the parking. | 11 §2.4, 10 §2.5 | 11 §8.3 |
| DEC-PROPOSED-19 | Manual reconcile to `delivered` of a `due` ticket needs the documented collection (`payment` with `collected_by`) or a prior waiver, else `PAYMENT_PENDING` (13 §8.5 over 11 TT-22's "open an incident"); `payment` only for `delivered` and a `due` ticket (`not_applicable`), `PAYMENT_ALREADY_RECORDED`, 13 §5.2/§5.6 rules; a recorded payment forbids `voided` (13 §8.6: `INVALID_STATE_TRANSITION reason payment_recorded`); `payment.recorded` with `source: reconcile` and a second audit row `payment.record`. Add PAYMENT_PENDING, PAYMENT_METHOD_NOT_ALLOWED, PAYMENT_AMOUNT_MISMATCH, PAYMENT_ALREADY_RECORDED to its `x-error-codes`. | 13 §8.5–§8.6, 11 TT-22 | 11 TT-22, 07 manualReconcile |
| DEC-PROPOSED-20 | Manual reconcile details: any open status, `parked → parked` included (corrections; same spot/slot keep their allocation); a closed ticket → `INVALID_STATE_TRANSITION reason ticket_closed`; spot/note/slot only for `parked` (spot or note → holder `spot`, neither → `unknown`; slot → `key_slot`, else `unknown`); `delivered_by` = the retrieve task's assignee, else the cycle's `retrieved_by`/`accepted_by`, else the actor; the driver of a canceled movement is settled (promotion or available), a canceled reserved next task leaves its driver on his current movement (`driver.availability_changed` only); `parked_by` = the open park/repark task's assignee; the early request kept while parking is dropped (not replayed); live claim codes revoked `canceled` with the ciphertext purged; link codes and action tokens revoked for `voided` only; the ticket's pending WhatsApp notifications (no attempt in flight) are skipped `superseded` with their queued messages; live alerts of the former state resolved (`inspection_incomplete` kept for `parked`); a paper ticket without serial only to `voided`; `incident_id` of the ticket's venue and not of another ticket; `ticket.manually_reconciled` carries `manual: true` (its timeline row = `data.manual`); custody notes = `paper_log_ref`. | 11 TT-22, 04 outage, 07 | 11 TT-22 |
| DEC-PROPOSED-21 | The `intake.draft_abandoned_alert_min` timer has no canon job (S2 DEC-PROPOSED-6): the SystemMonitor evaluates it every tick from `tickets.created_at`, per venue, raising once (a live alert is never overwritten) and resolving the live ones whose draft left `received`. | 14 §8, canon §12 | canon §7.2, 14 §8 |
| DEC-PROPOSED-22 | `job.ready_uncollected_check` payload `{ticket_id, cycle_id, ready_at}`, aggregate `retrieval_cycle`, dedupe `ready_uncollected:{cycle_id}`; a timer firing before `ready_at + ready.uncollected_alert_min` (clock skew, raised threshold) reschedules itself; audited as a system action. | 10 §12, 11 §9 | 11 §9 |

## For the other agents

- **Dispatch (PNT-062 heartbeat):** raise `driver_connection_lost_with_custody:{duty_session_id}` with `user_id`;
  the resolver already clears it when custody is gone; resolve it yourselves on reconnect.
- **WhatsApp (PNT-078 handover-exception):** use `openIncident()` from the incidents module (with `resolution` for the
  documented `manual_verification` / `lost_ticket` incident). The resolver clears `handover_code_locked:{cycle}` on
  `handover.exception_approved` and `handover.code_issued`.
- **Payments (PNT-080/081):** manual reconcile records its documented collection itself (13 §5.5 SQL, `source:
  reconcile`, `normalizePosReference()` exported from the use-cases); fold it into the payments service when it exists.
- **Realtime planners (PNT-064):** `incident.*` → WS `incident.updated` (+ `ticket.updated` when linked);
  `ticket.manually_reconciled` → `ticket.updated`; nothing else is published by these commands except the alerts'
  own `alert.raised` / `alert.updated` (core).

## Not done / gaps

- No web screen (S-02, S-03, S-04, S-12 are another agent's): PNT-074 stays `in_progress` (backend done).
- Push for alerts (escalation sound repeat, `alerts.escalation_repeat_s`) is client/Push work; acknowledge publishes
  the `alert.updated` that stops it.

# payments-reports — التحصيل والتسوية وإغلاق الحفل والتقارير (PNT-080 … PNT-082, PNT-087 … PNT-089, notes)

Collection at the handover (separately or inline), waiver and reversal, cash handovers with their discrepancy
incident, the event settlement, start-closing / reconciliation / close with `close_summary`, the four reports and
the audited CSV exports built by `job.export_generate`. Spec: 13 (money), 11 §6.4 (event), 15 §10 (KPIs), 07 §2.4,
§2.5, §2.7, 09 §3 / §10 / §11.

## Structure

| Place | Content |
|---|---|
| `packages/server/src/modules/payments-reports/` | Imports tickets-custody, venues-events, media and core only, through their `index.ts` (04 §4.3; enforced by `packages/server/test/payments-reports-domain.test.ts`). Never dispatch, whatsapp, notifications or the use-cases. |
| `…/domain/payment-rules.ts` | Pure 13 §5 rules: `normalizePosReference` (Arabic-Indic digits → Latin, spaces/dashes/zero-width removed, upper case, empty → none), `posReferenceIssues` (`not_applicable`, `looks_like_card_number`, `invalid_format`), `assertPaymentMatches` (method then exact fee), `paymentStatusBlocker`, `formatSar` (`20.00`), `formatRiyadh` (`YYYY-MM-DD HH:mm`), incident texts. |
| `…/application/payments.ts` | `PaymentsService.record / waive / reverse`; the shared pieces the use-cases reuse: `assertCollectable` (no effect), `recordCollection` (insert + ticket `collected` + `payment.recorded` + audit), `alreadyRecorded`, `assertEventAcceptsMoney`, `moneyStateError`. |
| `…/application/cash-handovers.ts` | `CashHandoversService.confirm` (13 §10.1). |
| `…/application/incidents.ts` | `openPaymentDiscrepancyIncident` — the auto-created `payment_discrepancy` incident and `incident.opened` (until PNT-083 offers a helper). |
| `…/application/settlement.ts` | `computeSettlement` (13 §11 / 07 `Settlement`), `integrityViolations` (13 §11.3), `financeSummary`. |
| `…/application/reconciliation.ts` | `computeReconciliation` (07 `Reconciliation`: blockers = `details.blockers` of EVENT_CLOSE_BLOCKED; warnings), `closeSummary`. |
| `…/application/reports.ts` | `ReportsService` + `eventSummaryReport`, `driverReportRows`, `paymentsReportRows`, `messagesReport` (15 §10 SQL). |
| `…/application/exports.ts`, `export-data.ts` | `ExportsService.request / get`; the CSV builders per kind (`payments` = 13 §13 columns). |
| `…/infra/` | `csv.ts` (RFC 4180, BOM, CRLF, formula-injection guard on text cells), `cursor.ts` (HMAC keyset cursors bound to the list and its filters), `exports-storage.ts` (`EXPORTS_STORAGE`: a second instance of the media module's ObjectStorage for `S3_BUCKET_EXPORTS`; in memory without S3). |
| `…/jobs/` | `job.export_generate` (`mode: external`), `paymentsReportsJobs()`, `paymentsReportsWorkerService()` (the worker's exports client, registered as the `exports` object deleter of `job.retention_purge`). |
| `…/http/` | `PaymentsController` (§9.4), `ReportsController`, `ExportsController`, zod bodies/queries (strict), `PaymentsReportsHttpModule` (registers the exports storage and the `exports` deleter in the api). |
| `packages/server/src/use-cases/inline-payment.ts` | `handoverPaymentHook` = the S2 `InlinePaymentHook` (registered when the use-cases load). |
| `packages/server/src/use-cases/close-event.ts`, `http/event-close.controller.ts` | `CloseEventUseCase`, `EventCloseQueries` (reconciliation), `EventCloseController`, `EventCloseHttpModule`. |

Registration: `packages/server/src/index.ts` (payments-reports line uncommented), `apps/api/src/features.ts`
(`PaymentsReportsHttpModule` uncommented + `EventCloseHttpModule`), `apps/worker/src/handlers.ts`
(`paymentsReportsJobs()` + `paymentsReportsWorkerService`). No new env var (`S3_BUCKET_EXPORTS`, `EXPORT_URL_TTL_S`
existed), no new dependency.

## Routes

| Route | Permission | Ticket | Notes |
|---|---|---|---|
| `POST /v1/tickets/{ticketId}/payments` | `payment.record` ✓ 201 | PNT-080 | `PaymentInput` only (no `expected_version`); `{payment, ticket}`. L2 event FOR SHARE → L4 retrieve task → L5 ticket (no pool lock, 13 §5.5). |
| `POST /v1/tickets/{ticketId}/handover` (S2 route) | `handover.verify` ✓ | PNT-080 | Inline `payment` through `InlinePaymentHook.check` (money checks before the stub/code) and `collect` (after the verification, `source = handover`). |
| `POST /v1/tickets/{ticketId}/payment-waiver` | `payment.waive` ✓ | PNT-081 | `{reason}` (≥ 3, REASON_REQUIRED); answers `TicketDetail`. L2 FOR SHARE → L5. |
| `POST /v1/payments/{paymentId}/reverse` | `payment.reverse` ✓ | PNT-081 | `{reason, replacement?}`; answers `{reversed, replacement}`. L2 FOR SHARE → L5 → L9 payment. |
| `POST /v1/cash-handovers` | `cash.handover_confirm` ✓ 201 | PNT-082 | `{event_id, driver_id, amount_halalas, note?}`; answers `CashHandover` + `payment_ids`, `incident_id`. L2 FOR SHARE → L9 the driver's unlinked cash payments `ORDER BY id FOR NO KEY UPDATE`. |
| `GET /v1/events/{eventId}/settlement` | `report.read` | PNT-082 | One REPEATABLE READ, READ ONLY snapshot. |
| `POST /v1/events/{eventId}/start-closing` | `event.manage` ✓ | PNT-087 | venues-events (`EventsService.startClosing`): open → closing, `event.closing_started`. |
| `GET /v1/events/{eventId}/reconciliation` | `event.manage` | PNT-087 | One REPEATABLE READ, READ ONLY snapshot. |
| `POST /v1/events/{eventId}/close` | `event.manage` ✓ | PNT-087 | `{expected_version?, note?}`; L2 FOR NO KEY UPDATE; blockers re-read inside; `close_summary`; `event.closed`. |
| `GET /v1/reports/events/{eventId}/summary` | `report.read` | PNT-088 | 07 `EventSummaryReport`. |
| `GET /v1/reports/drivers` | `report.read` | PNT-088 | `from`, `to`, `venue_id?`, `limit` (1–200, 50), `cursor`; page envelope (`meta.next_cursor`). |
| `GET /v1/reports/payments` | `report.read` | PNT-088 | `from`, `to`, `venue_id?`, `event_id?`; 07 `PaymentsReport`. |
| `GET /v1/reports/messages` | `report.read` | PNT-088 | `from`, `to`, `venue_id?`, `status?`; 07 `MessagesReport`. |
| `POST /v1/exports` | `export.create` ✓ 202 | PNT-089 | `{kind, filters: {venue_id?, event_id?, from?, to?}}` (strict). |
| `GET /v1/exports/{exportId}` | `export.create` | PNT-089 | The requester's own export; `download_url` when `ready` and not expired. |

Scope everywhere: a resource addressed by id (ticket, payment, event, driver, export) outside the caller's venues is
its 404; a `venue_id` the caller names (report query, export filters) is SCOPE_VENUE_DENIED. Every money command
re-reads the staff scope after its locks (TOCTOU, 09 §8.4); for `POST …/payments` the assignee check on the locked
retrieve task is that re-check (only the assignee may collect), as in the S2 handover.

## Behaviour

**Collection (PNT-080).** Separate: ticket head (TICKET_NOT_FOUND) → L2 → L4 → L5 → NOT_TASK_ASSIGNEE (a live
accepted/in_progress retrieve task of someone else) → `ready` with a live task else INVALID_STATE_TRANSITION
(`allowed_from: [ready]`) → `assertCollectable`: closed/canceled event EVENT_ALREADY_CLOSED; `collected`
PAYMENT_ALREADY_RECORDED `{payment_id, method, collected_by}`; `not_required`/`waived` INVALID_STATE_TRANSITION
(`current_status` = the payment status, `allowed_from: [due]`, `reason: payment_not_required | payment_waived`) →
reference rules → PAYMENT_METHOD_NOT_ALLOWED `{allowed_methods}` → PAYMENT_AMOUNT_MISMATCH `{expected_halalas,
received_halalas}`. The reference rules run in the body pipe first (input shape, 08 §2 step 6). Inline: the hook's
`check` runs at the S2 payment gate (after the custody checks, before the stub/code: no attempt consumed): `due`
without payment PAYMENT_PENDING; `due` with payment the same checks with the `payment.` prefix; `collected` with
payment PAYMENT_ALREADY_RECORDED; `not_required`/`waived` with payment VALIDATION_FAILED `payment` `not_applicable`.
`collect` writes the payment once the verification passed, in the handover transaction. The handover takes L2 FOR
SHARE between L1 and L4 when the ticket is due or a payment is sent (13 §5.5).

**Waiver and reversal (PNT-081).** Waiver: EVENT_ALREADY_CLOSED → voided TICKET_CLOSED → collected
PAYMENT_ALREADY_RECORDED → not_required/waived INVALID_STATE_TRANSITION → `waived` with the three waiver columns,
`payment.waived`, audit `payment.waive` (reason). Reversal: 404 → EVENT_ALREADY_CLOSED → PAYMENT_ALREADY_REVERSED
`{payment_id, reversed_at}` → ticket not `collected` INVALID_STATE_TRANSITION `payment_integrity` → replacement rules
(`replacement.` prefix, `no_change`) → original `reversed`; ticket `due` (no replacement) or stays `collected`;
`payment.reversed` (with `replacement_payment_id`) then the replacement's `payment.recorded` (`source:
replacement`, `collected_by`/`cycle_id`/`collected_at` copied, 13 §7.2); without replacement on a delivered ticket a
`payment_discrepancy` incident linked to the ticket (13 §7.1). Self-approval (a driving supervisor waiving a ticket
he hands over, or reversing his own collection) is allowed and flagged `metadata.self_approved` (09 §10 rule 2).

**Cash and settlement (PNT-082).** Expected = the driver's `recorded` cash of the event with no `cash_handover_id`,
locked under the event FOR SHARE; two handovers at once never link a payment twice (EvalPlanQual skips the linked
rows: the later one expects 0); a collection committed after the read stays outstanding (PAY-TC-17). The difference
is the generated column; ≠ 0 opens a `payment_discrepancy` incident (event-level, `ticket_id` null, medium) whose id
is in the response, the event and the audit metadata. Settlement = 13 §11.4 reference queries, the adjusted
difference of §10.4, the integrity checks of §11.3 and the financial blockers of §12.

**Event close (PNT-087).** start-closing in venues-events (version guard, INVALID_STATE_TRANSITION from anything but
`open`, EVENT_ALREADY_CLOSED when final). Close: scope 404 → L2 FOR NO KEY UPDATE (waits for and then excludes every
money command, which hold FOR SHARE) → scope re-check → VERSION_CONFLICT → `closing` only → reconciliation inside the
transaction → EVENT_CLOSE_BLOCKED `{blockers}` exactly as `GET …/reconciliation` lists them → `closed`, `closed_at`,
`closed_by`, `close_summary`, `version + 1`, `event.closed`, audit `event.manage` (reason = note). Warnings (open
incidents, failed messages, cash differences) never block and are frozen in the summary.

**Reports (PNT-088) and exports (PNT-089).** See DEC-PROPOSED-14 and -15 below.

## Locks (canon §14ب)

| Command | Order |
|---|---|
| separate collection | L0 → L2 event FOR SHARE → L4 retrieve task → L5 ticket → (L9 payment insert) |
| handover with money | L0 → L1 pool → L2 event FOR SHARE → L4 → L5 → L6 cycle → … (S2 order) |
| waiver | L0 → L2 FOR SHARE → L5 |
| reversal | L0 → L2 FOR SHARE → L5 → L9 payment FOR NO KEY UPDATE (+ incident / replacement inserts) |
| cash handover | L0 → L2 FOR SHARE → L9 payments FOR NO KEY UPDATE ORDER BY id |
| start-closing / close | L0 → L2 FOR NO KEY UPDATE |

## Changes outside the module

- `modules/venues-events`: `assertStartClosing` / `assertClosable` (domain), `EventsService.startClosing`, the
  start-closing route, and index exports (`assertClosable`, `FINAL_EVENT_STATUSES`, `EVENT_COLUMNS`, `toVenueEvent`,
  `VenueEventRow`, `VenueEventDto`).
- `use-cases/hooks.ts`: `InlinePaymentHook.check?` and `collect(..., requestId)`; `use-cases/handover.ts`: the
  conditional L2 lock and the call to `check` (the S2 gate stays the fallback without a hook);
  `use-cases/index.ts`: exports + the side-effect import of `inline-payment.ts`.
- New: `use-cases/inline-payment.ts`, `use-cases/close-event.ts`, `use-cases/http/event-close.controller.ts`.
- Registration lines in the three shared files; `apps/worker/test/handlers.test.ts` (one handler per canon job).

## Tests

- Unit: `packages/server/test/payments-reports-domain.test.ts` (reference rules, collection checks, formats,
  phone masking, CSV, cursors, module boundaries), `apps/worker/test/handlers.test.ts`.
- Integration (PostgreSQL 16, real routes, tickets driven to `ready` through the S2 routes, fixtures in
  `apps/api/test/payments-fixtures.ts`): `payments-collection` (PAY-TC-01, 03 … 11), `payments-waiver-reverse`
  (PAY-TC-12 … 15, self-approval), `payments-cash-settlement` (PAY-TC-16, 17, 23, 25; reference SQL of 13 §11.4),
  `event-close` (start-closing, every blocker, PAY-TC-18 … 20, close vs handover race, the full-event scenario: no
  open custody, amounts = collections, event closed), `reports` (scripted durations vs the 15 SQL, Riyadh dates,
  keyset pages, scope), `exports` (202 → job → signed link → CSV content, no phone/code/key, link and file expiry,
  retention purge, scope at request and at generation, storage retry). The permission matrix and the routes contract
  cover the new routes automatically.

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

- DEC-PROPOSED-1: Self cash handover code — 13 §10.2 and PAY-TC-25 say `VALIDATION_FAILED` (field `driver_id`), while
  08 §4 (PERMISSION_DENIED row and the constraint map `ck_cash_handover_distinct_people`), 09 §10 rule 3 and
  `core/errors/pg-constraint-map.ts` say `PERMISSION_DENIED` — `403 PERMISSION_DENIED {permission:
  cash.handover_confirm, reason: self_handover}`, checked before any lock (08 is the code file; the schema check stays
  the backstop) — 13 §10.2, 13 §19 PAY-TC-25.
- DEC-PROPOSED-2: Event-addressed money/report routes outside the scope — 07 lists `SCOPE_VENUE_DENIED` for
  `POST /v1/cash-handovers`, `GET /v1/events/{eventId}/settlement` and `GET /v1/reports/events/{eventId}/summary`;
  13 §16 and DEC-112 say 404 — an event (path or body `event_id`) or a driver (`driver_id`, organization-wide) outside
  the scope is `404 RESOURCE_NOT_FOUND {resource: event | driver}`; SCOPE_VENUE_DENIED only for a named `venue_id`
  (report queries, export filters) — `07_openapi.yaml` x-error-codes of those three operations.
- DEC-PROPOSED-3: Money checks of the handover through the S2 seam — 13 §5.3 puts the money checks before the code or
  stub (no attempt consumed) and 13 §5.5 takes the event FOR SHARE; the S2 `InlinePaymentHook` only had `collect` —
  optional `check(tx, {ticket, payment, actor})` without effect at the payment gate, `collect` gets `requestId`; the
  handover locks L2 FOR SHARE after L1 only when the ticket is `due` or a payment is sent (no contention with intake
  otherwise) — `use-cases/hooks.ts`, `use-cases/handover.ts`, 04 §4.4 handover locks.
- DEC-PROPOSED-4: Handover with a payment on a `collected` ticket — S2 answered `VALIDATION_FAILED not_applicable`;
  13 §5.3 says PAYMENT_ALREADY_RECORDED — PAYMENT_ALREADY_RECORDED `{payment_id, method, collected_by}`; `not_required`
  / `waived` keep `VALIDATION_FAILED payment not_applicable` — `07_openapi.yaml` handover x-error-codes (add
  PAYMENT_ALREADY_RECORDED, VALIDATION_FAILED is implicit).
- DEC-PROPOSED-5: FieldError key — the 13 §5.6/§16 examples write `{field, reason}` — the envelope's `{field, issue}`
  (08 §2, `zodToFields`), e.g. `{field: pos_reference, issue: looks_like_card_number}` — 13 §5.6, §16 examples.
- DEC-PROPOSED-6: `pos_reference` normalization — 13 §5.6 removes spaces and dashes and upper-cases — also Arabic-Indic
  digits → Latin (DEC-17), Unicode dashes/minus, NBSP and zero-width/bidi marks removed; empty after normalization = no
  reference; not `^[A-Z0-9]{1,24}$` → `invalid_format`; with `cash` → `not_applicable`; checked in the body pipe of the
  separate route (input shape) and in the hook's `check` for the handover (`payment.` prefix) — 13 §5.6.
- DEC-PROPOSED-7: Replacement rules — 13 §7.2 allows correcting the method or the reference — a replacement with the
  same method and the same normalized reference → `VALIDATION_FAILED {field: replacement, issue: no_change}`; field
  paths of the replacement carry the `replacement.` prefix; the replacement keeps `collected_by`, `cycle_id`,
  `collected_at` and is inserted after the original is reversed (the partial unique index is not deferrable) — 13 §7.2.
- DEC-PROPOSED-8: Money-state refusals — 08 §4.10 note gives only `reason` — INVALID_STATE_TRANSITION on a money state
  carries `current_status` = the ticket's `payment_status` and `allowed_from` = the money states accepted (`[due]` for
  collection/waiver, `[collected]` for a reversal); a reversal whose ticket is not `collected` (impossible by the rules,
  13 §11.3 b) is `reason: payment_integrity` — 08 §4.10.
- DEC-PROPOSED-9: Cash handover on a non-open event — 13 §10 only names `closed` — `draft` →
  INVALID_STATE_TRANSITION (`allowed_from: [open, closing]`), `closed`/`canceled` → EVENT_ALREADY_CLOSED; expected 0 and
  amount 0 → `VALIDATION_FAILED amount_halalas nothing_to_hand_over`; a driver of the organization in any venue may hand
  over the cash he collected in this event (PAY-TC-21: transfers keep the cash in the original event) — 13 §10.2,
  07 x-error-codes (`INVALID_STATE_TRANSITION`, `RESOURCE_NOT_FOUND`, `VALIDATION_FAILED`).
- DEC-PROPOSED-10: Auto-created incidents and their link — `cash_handovers` has no incident column — payments-reports
  writes the `payment_discrepancy` incident (`status open`, `severity medium`, `opened_by` = the actor) and
  `incident.opened {incident_id, type, status, severity, ticket_id, auto_created: true}`; the handover's incident is
  found through its audit row (`metadata.incident_id`) and returned as `incident_id`; to be replaced by the incidents
  module helper when PNT-083 lands — 06 ERD (optional `cash_handovers.incident_id`), 13 §10.
- DEC-PROPOSED-11: Event payloads — 11 §8.7 and 13 §14 differ — `payment.recorded {ticket_id, payment_id, cycle_id,
  method, amount_halalas, collected_by, source, replaces_payment_id?}`, `payment.waived {ticket_id, amount_halalas,
  waived_by, reason}`, `payment.reversed {payment_id, ticket_id, method, amount_halalas, reversed_by, reason,
  with_replacement, replacement_payment_id, after_cash_handover, ticket_delivered, incident_id}`,
  `cash.handover_recorded {cash_handover_id, event_id, driver_id, received_by, amount_halalas, expected_halalas,
  difference_halalas, linked_payments_count, incident_id}`, `event.closing_started` / `event.closed {event_id, status,
  by}`; the audit `after` of `payment.record` uses `ticket_payment_status` as in 13 §5.5 — 11 §8.7, 13 §14.
- DEC-PROPOSED-12: Reconciliation lists — 07 gives names only — `open_tickets` = not delivered/voided;
  `keys_not_in_slots` = open tickets whose key holder is not a key slot (driver, supervisor, unknown, or a draft's key
  still with the customer); `open_requests` = retrieve tasks `queued`/`offered`/`broadcast` as `QueueItem` with the live
  round; `open_tasks` = every other open task (park, accepted/in_progress retrieve, reserved next task, repark);
  `warnings.failed_messages` = the event's failed outbound messages (latest 200), redacted; the reconciliation is read
  in one REPEATABLE READ snapshot — 07 `Reconciliation`, 02 S-10.
- DEC-PROPOSED-13: `close_summary` shape — 13 §12 names only `finance` — `{closed_at, closed_by, note, tickets
  (Settlement.tickets), finance {currency, amounts, drivers, discrepancies}, warnings {open_incidents: [ids],
  failed_messages: count, cash_discrepancies: [...]}}`; the note (≤ 500, trimmed) is also the audit reason; closing an
  `open` event is INVALID_STATE_TRANSITION (`allowed_from: [closing]`) — 06 ERD `events.close_summary`, 07 `VenueEvent`.
- DEC-PROPOSED-14: Report semantics — 13 §13 describes `GET /v1/reports/payments` as a cursor list of payments
  (`method`, `status`, `collected_by` filters) while 07 defines per-event totals — 07 wins on the wire: one row per
  event held in the period (its Riyadh `event_date` between the Riyadh dates of `from` and `to`), totals, reversals and
  waivers counted apart; drivers: one row per (driver, venue) (FR-RPT-06), counts by completion time in `[from, to)`,
  duty hours clipped to the period, keyset cursor `(employee_code, user_id, venue_id)` HMAC-signed with the filters
  (PAGINATION_CURSOR_INVALID otherwise); messages: totals by current status of the messages created in `[from, to)`,
  `status` narrows totals and list (default list = failed), messages without a venue only for organization-scope callers
  without `venue_id`, never a recipient/sender id or a full phone; event summary: `tickets_total` includes voided
  (also counted in `voided`), timings = KPI-01 (`claimed_at − queued_at`), KPI-02 (`started_at − accepted_at`), KPI-03
  (delivered + reparked cycles), KPI-04 (delivered), canceled cycles only in `canceled_requests`; `from > to` →
  `VALIDATION_FAILED from after_to`; times are UTC ISO on the wire, Riyadh dates only where a date is the filter — 13 §13,
  15 §10, 07 §2.7.
- DEC-PROPOSED-15: Export rules — 07/09 give the contract, not the job — `POST` answers 202 with the `pending` export;
  `job.export_generate` (`mode: external`) recomputes the requester's scope (inactive → `failed requester_inactive`,
  revoked venue or event → `failed scope_revoked`), reads in one REPEATABLE READ READ ONLY transaction (statement timeout
  30 s), uploads outside any transaction to `exports/{org_id}/{export_id}.csv`, keeps the file 24 h (`expires_at`,
  06 ERD §8.1), fails `too_many_rows` above 50 000 rows, retries storage outages (last attempt → `failed
  storage_unavailable`, misconfigured bucket → `failed storage_error`); filters are ANDed (`drivers` with `event_id` =
  that event's venue over the period; no `to` = up to the generation time); `GET` is the requester's only (another user
  → 404, 09 §4.7) and presigns for `min(EXPORT_URL_TTL_S, time left)` with `private, no-store`; every issued link is
  audited (`export.create`, `metadata.download_link_issued`), the job outcome too (`job.export_generate`, system actor);
  the `audit` kind also needs `audit.read` (`PERMISSION_DENIED {permission: audit.read, reason: audit_read_required}`);
  no export carries a code, a key position, a stub, a photo or a full phone (tickets: `customer_phone_masked`, plate
  display only) — 07 §2.7, 09 §3, §11, 13 §13.
- DEC-PROPOSED-16: Where the close lives — 04 §4.4 lists CloseEvent as a use-case — start-closing (a single-module
  transition) stays in venues-events; reconciliation and close are `use-cases/close-event.ts` (they compose
  venues-events, tickets-custody and payments-reports) — 04 §4.4.
- DEC-PROPOSED-17: Settlement discrepancies — 13 §11.1 item 6 names three kinds — `type ∈ {cash_difference (a non-zero
  handover difference + its incident), delivered_due (a delivered ticket that is `due` now), reversed_without_replacement
  (a reversed payment on a delivered ticket without a recorded one; kept as history after a waiver)}` with `driver_id`,
  `ticket_id`, `cash_handover_id`, `difference_halalas`, `incident_id` — 07 `Settlement.discrepancies`.
- DEC-PROPOSED-18: No dedicated export rate limit — 09 §3 mentions a row/rate limit; no limiter exists beyond the
  `command` class — the 50 000-row cap only; a per-user export limit is a follow-up — 09 §3.

## Codes not reachable (and why)

- `SCOPE_VENUE_DENIED` on `POST /v1/cash-handovers`, the settlement and the event summary: no venue is named (DEC-PROPOSED-2).
- `EVENT_ALREADY_CLOSED` on `POST /v1/tickets/{ticketId}/payments`: a closed event has no ticket in `ready` (open tickets
  block the close), so INVALID_STATE_TRANSITION answers first; the check stays (defence in depth).
- `uq_payments_ticket_recorded` → PAYMENT_ALREADY_RECORDED from the constraint map: the L5 lock serializes two
  collections, so the second sees `collected` and answers with the details before the insert.
- Not covered by a test: `too_many_rows` (needs 50 000 rows), `storage_error` / `storage_unavailable` on the last
  attempt (the retry path and success after a retry are tested).

## Follow-ups

- PNT-083: replace `openPaymentDiscrepancyIncident` with the incidents module helper; consider a
  `cash_handovers.incident_id` column instead of the audit lookup.
- PNT-047 / PNT-078 / PNT-085: the claim-code verification, the supervisor exception (`source: exception`) and the
  manual reconcile (`source: reconcile`) reuse `assertCollectable` + `recordCollection` (exported from the module).
- PNT-093 (G4, lead): the full-event scenario of `apps/api/test/event-close.int.test.ts` is the building block.

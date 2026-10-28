# S2 backend — الاستلام والصف والتوزيع v1 (PNT-024 … PNT-034, notes)

The paper vertical slice through the API (gate G1): duty, intake, parking, retrieval on behalf, dispatch v1 (single
offers to the longest-idle driver, atomic accept, expiry), movement and the paper handover, plus the reads the driver
and supervisor screens need. Media (PNT-027) is used through its exports; the web screens (PNT-035/036) come later.

## Structure

| Place | Content |
|---|---|
| `packages/server/src/modules/tickets-custody/` | Never imports dispatch or the use-cases (04 §4.3 rule 2; enforced by `packages/server/test/dispatch-ordering.test.ts`). May import media. |
| `…/domain/plate.ts` | `normalizePlate` (07 §1.8: Arabic letter → Latin map, keyboard variants أإآٱ→ا · يئی→ى · ةھۀ→ه · ک→ك · ؤ→و, Arabic-Indic and Persian digits, tatweel/diacritics ignored, letters stored space-separated, other countries keep `raw`), `plateView`, `latinDigits`, `normalizeTag` (key tags and paper serials: trim, Latin digits, collapse spaces, upper case). |
| `…/domain/intake.ts` | `missingIntakeFields` (INTAKE_INCOMPLETE), `draftFieldsPresent` (DRAFT_HAS_DATA). |
| `…/application/intake-service.ts` | `IntakeService.update` (PATCH intake), `findTicketInScope`, `assertCreator`, `revokeLiveLinkCodes`. |
| `…/application/{events,custody,errors,views}.ts` | `emitForTicket` (outbox + `ticket_events`), `moveCustody`/`moveBoth` (`custody_events` + `custody.changed`), `invalidTransition` (11 §1.5 / DEC-106 details), `checkVersion`, `TicketSummary`/`TicketDetail`/`Task` views with the 09 §5.1 field allow-list. |
| `packages/server/src/modules/dispatch/` | Duty, tasks, offers, the pass, timers, the release hook. Imports tickets-custody and venues-events (04 §4.3 rule 1), never the use-cases. |
| `…/application/duty-service.ts` | `DutyService.start/setBreak/end`, `dutyItems`. |
| `…/application/{pass,offers,tasks}.ts` | `runDispatchPass`, `createSingleRound`, `revokeRound`, `revokeDriverSingleOffers`, `expireSingleRound`, `ensureDispatchSweep`, `requestDispatchPass`, `insertParkTask`/`insertRetrieveTask`, `settleDriverAfterTask`, `withdrawTask`. |
| `…/application/driver-release.ts` | `releaseDriverWork` = the `DriverReleaseHook` (DEC-32), registered when the module is imported (`dispatch/index.ts`). |
| `…/jobs/index.ts` | `job.offer_expire`, `job.dispatch_pass`, `job.dispatch_sweep` (`dispatchJobs()`, registered in `apps/worker/src/handlers.ts`). |
| `packages/server/src/use-cases/` | Cross-module commands that own the transaction (04 §4.4): `start-intake`, `submit-intake`, `discard-void`, `complete-parking`, `request-retrieval` (+ `openRetrievalCycle`), `accept-offer`, `movement`, `handover`, `queries`; `hooks.ts` (extension points); `http/` (controllers, zod bodies, pipes, `TicketsCustodyHttpModule`, `DispatchHttpModule` — the Nest modules live here because their controllers call use-cases). |

Registration lines uncommented: `packages/server/src/index.ts` (tickets-custody, dispatch, use-cases),
`apps/api/src/features.ts` (`TicketsCustodyHttpModule`, `DispatchHttpModule`), `apps/worker/src/handlers.ts`
(`ticketsCustodyJobs()` — empty in S2 — and `dispatchJobs()`).

Venues, events and shifts are read through the venues-events exports: `venueSettingsFor` (dispatch settings, parking
mode, key slots, required photos, handover attempts), `findDefaultDispatchPool` + `findOpenShiftForPool` (duty start,
`GET /v1/me/home`), `listVenueEventsByStatus` (the DEC-37 event choice, `open_events`). The binding contracts of
`docs/progress/notes/pnt-018-020.md` are met: intake locks L1 → L2 and re-checks `open`; duty start reads the open
shift only under L1; complete-parking reads the spot with its zone and the slot with its board `FOR SHARE` after its
canon locks; shift close uses the release hook as described below.

## Routes

| Route | Permission | Ticket | Notes |
|---|---|---|---|
| `GET /v1/me/home` | `duty.self` | PNT-024/065 | DriverHome: venue, open events, assignment, `shift_open`, duty, `driver_state`, head offer card (10 §2.6, `waiting_seconds`, `can_accept`, `can_reserve_next`), current/next task cards, `draft_ticket_id`, checks, `server_time`. |
| `POST /v1/me/duty/start` | `duty.self` ✓ 201 | PNT-024 | Driver: active assignment; supervisor: `can_drive` + venue in scope (`venue_id` required when the scope has several venues). |
| `POST /v1/me/duty/break` | `duty.self` ✓ | PNT-024 | `{active}` (start / end the break). |
| `POST /v1/me/duty/end` | `duty.self` ✓ | PNT-024 | |
| `POST /v1/tickets` | `ticket.intake` ✓ 201 | PNT-025 | StartIntake. |
| `GET /v1/tickets` | `ticket.read_minimal` | reads | `event_id`, `venue_id`, `status` (comma list), `q` (plate digits or display number), `open_only`, `limit`, `cursor`; newest first; a driver sees open tickets of his venue only. |
| `GET /v1/tickets/{ticketId}` | `ticket.read_minimal` | reads | `projection: full` for staff in scope, the assignee of an open task, the creator while `received`/`parking`; otherwise `minimal`. A driver never reads a closed ticket. |
| `PATCH /v1/tickets/{ticketId}/intake` | `ticket.intake` ✓ | PNT-026 | |
| `POST /v1/tickets/{ticketId}/submit-intake` | `ticket.intake` ✓ | PNT-028 | |
| `POST /v1/tickets/{ticketId}/discard-draft` | `ticket.discard_empty_draft` ✓ | PNT-029 | |
| `POST /v1/tickets/{ticketId}/void` | `ticket.void` ✓ | PNT-029 | `{reason, custody_returned_to_customer}`. |
| `POST /v1/tasks/{taskId}/complete-parking` | `task.execute` ✓ | PNT-030 | `{parking_spot_id?, spot_note?, key_slot_id?}`. |
| `POST /v1/tickets/{ticketId}/retrievals` | `retrieval.request_on_behalf` ✓ 201 | PNT-031 | `{reason}` (≥ 3 chars). |
| `POST /v1/task-offers/{offerId}/accept` | `offer.accept` ✓ | PNT-032 | Empty body. |
| `POST /v1/tasks/{taskId}/key-pickup` | `task.execute` ✓ | PNT-033 | `{key_slot_id}`. |
| `POST /v1/tasks/{taskId}/start-retrieval` | `task.execute` ✓ | PNT-033 | |
| `POST /v1/tasks/{taskId}/ready` | `task.execute` ✓ | PNT-033 | |
| `POST /v1/tickets/{ticketId}/handover` | `handover.verify` ✓ | PNT-034 | `{verification: {method: paper_stub, paper_serial} \| {method: code, code}, payment?}`. |

Every command runs through the core command protocol (L0 idempotency, one transaction, `audit_log`, outbox) and
writes `ticket_events` for every ticket/task/custody change. Check order everywhere: CSRF → session → permission →
L0 → body → **scope** (`TICKET_NOT_FOUND` / `RESOURCE_NOT_FOUND` / `OFFER_NOT_FOUND`) → **duty** → locks in canon
§14ب order → resource guards (creator/assignee/recipient, version, state).

## Behaviour

**Duty (PNT-024).** `start`: L1 pool → L3 assignment/user re-read (TOCTOU, 09 §8.4: `ASSIGNMENT_REQUIRED`,
`DRIVER_DISABLED`, `PERMISSION_DENIED` `can_drive_revoked`) → the pool's open shift, read only under L1 (shift close
holds it while it ends the sessions) → `duty_sessions` `on_duty` with `available_since =
last_heartbeat_at = now` → `driver.duty_started` + `driver.availability_changed` → pass (resolves
`no_drivers_on_duty`).
`DUTY_ALREADY_STARTED {duty_session_id}`; `SHIFT_NOT_OPEN {venue_id}` without an open shift on the default pool.
`break`: refused with an active or next task (`DRIVER_NOT_AVAILABLE`) or custody without a task (`CUSTODY_OPEN`
items); `available_since = NULL` while on break and `now` when it ends; live single offers revoked
(`recipient_unavailable`) and re-offered by the pass. `end`: `DUTY_END_BLOCKED_CUSTODY {items}` (vehicle, key, task,
next task, draft), else `ended` (`end_reason = self`), `driver.duty_ended` and `off_duty`.

**StartIntake (PNT-025).** Event: explicit `event_id` (another venue → `RESOURCE_NOT_FOUND {resource: event}`; not
open → `EVENT_NOT_OPEN`) or the single open event; several open → `VALIDATION_FAILED event_id
required_multiple_open_events` (DEC-37). Locks L1 pool → L2 event (re-checked) → duty/assignment re-read under the
pool lock → `DRIVER_ON_BREAK` / `MOVEMENT_IN_PROGRESS {active_task_id}` → his live single offer revoked (L4 → L7) →
number by `UPDATE events SET next_display_number = next_display_number + 1 … RETURNING` (no event version bump) →
ticket `received` with the fee snapshot (DEC-43: `per_vehicle` → `due` + `fee_halalas`, otherwise `not_required`, 0)
→ park task `in_progress` → L8 `available_since = NULL` → custody customer → driver (`intake`) for vehicle and key →
`ticket.created`, `task.created`, `custody.changed` ×2, availability → pass. Intake and accept by the same driver
serialize on the pool lock: exactly one wins.

**PATCH intake (PNT-026).** L5 only. `received`: plate (PLATE_INVALID with `field`/`reason`), vehicle, notes,
`customer_phone` (E.164, `PHONE_INVALID`; upserts `customers` by `(org_id, phone_e164)`; a changed number revokes the
ticket's consent), `consent` (`verbal_staff_confirmed` row in `customer_consents`; `null` revokes), `paper_serial`
(unique per event: `PAPER_SERIAL_IN_USE`), `key_tag` (unique among open tickets of the venue: `KEY_TAG_IN_USE
{conflicting_display_number}`), `channel`, `damage_marks` (in the intake `vehicle_inspections` row). `parking`: only
`{channel: paper, paper_serial}` for a ticket that is not linked (DEC-40): `wa_link_status = none`, `link_version + 1`,
live link codes revoked (`channel_paper`), `ticket.wa_link_changed {method: channel_paper}`; anything else →
`INVALID_STATE_TRANSITION` with `reason` `only_paper_conversion_in_parking` / `already_paper` / `ticket_linked`.

**SubmitIntake (PNT-028).** L5. `INTAKE_INCOMPLETE {missing}` → direct WhatsApp link (customer, no QR code, not
linked): `CONSENT_REQUIRED {field: consent}`, `WA_CUSTOMER_OPTED_OUT` → photos: `inspection.required_photos` minus
media's `listUploadedPhotoKinds` → `INSPECTION_INCOMPLETE {missing, failed_media_ids}` unless
`acknowledge_incomplete_inspection` → `parking`, `submitted_at`, `inspection_status` (`complete`/`incomplete`), intake
`vehicle_inspections` row (created or updated, `required_photos_ok`) and every media row of the ticket linked to it
(`inspection_id`) → `CustomerLinkingHook.onIntakeSubmitted` for a direct link (W-01, PNT-043) →
`ticket.intake_submitted` with the resulting `wa_link_status` → `draft_abandoned` resolved → `inspection_incomplete`
alert (core writer, dedupe `inspection_incomplete:<ticket>`). The late `incomplete → complete` stays with media
(DEC-104).

**Discard / void (PNT-029).** Discard: creator, `received`, no data (`DRAFT_HAS_DATA {fields_present}` — the
`draft_abandoned` alert is raised and kept although the command fails). Void: supervisor, `received`/`parking`
(DEC-45), `REASON_REQUIRED`, `custody_returned_to_customer: true` required (else `CUSTODY_OPEN {items}`). Shared
effects: park task `canceled`, ticket `voided` (`void_reason`, pending request cleared), custody → customer
(`correction`), link codes and action tokens revoked, `draft_abandoned`/`inspection_incomplete` resolved, the driver
settled (promotion or available), pass.

**CompleteParking (PNT-030).** L1 → L4 task → L5 ticket. Inputs per `parking.mode` (`assigned_spots`: spot;
`free_text`: note, no spot; `mixed`: one of them) and `keys.require_slot` (`VALIDATION_FAILED` fields); spot with its
zone and slot with its board read `FOR SHARE` (of the venue, else `RESOURCE_NOT_FOUND`; all `active`, else
`VALIDATION_FAILED` `inactive` / `zone_inactive` / `board_inactive`), so a deactivation, which takes those rows
`FOR NO KEY UPDATE`, serializes with the allocation; actor holds vehicle and key (`CUSTODY_HOLDER_MISMATCH`); L9 allocations
(`PARKING_SPOT_OCCUPIED`, `KEY_SLOT_OCCUPIED`, backed by the partial unique indexes); task `completed`, ticket `parked`
(`parked_by/at`), custody driver → spot (`parked`/`repark`) and driver → key slot (`key_deposited`; no slot → holder
`unknown`); then TT-08 order: settle the driver (promote his reserved next task in the same transaction, else
`available_since = now`) → an early request (DEC-13, `pending_retrieval_at`) becomes a cycle with the original
request time → pass.

**Retrieval on behalf (PNT-031).** Scope → driver on duty in the pool (`DUTY_REQUIRED`, `DRIVER_ON_BREAK` from the
core duty guard) → L1 → L5 → `TICKET_CLOSED` / `TICKET_NOT_PARKED` / `RETRIEVAL_ALREADY_ACTIVE` → cycle (`source =
staff`, `requested_by`, `request_reason`) + retrieve task `queued` with `priority_at = requested_at` → ticket
`requested` → `ticket.retrieval_requested` → immediate pass (DEC-08).

**Movement (PNT-033).** L4 → L5 → L6, no pool lock. `key-pickup`: key slot → driver (`key_pickup`), allocation
released, `task.key_picked_up`; `TASK_NOT_STARTABLE` for a reserved next task, `CUSTODY_HOLDER_MISMATCH` for another
slot. `start-retrieval`: `KEY_NOT_PICKED_UP` first; spot → driver (`retrieval_start`), spot released, ticket
`retrieving`, `task.started` + `ticket.retrieving`. `ready`: ticket `ready`, `cycle.ready_at`; expected method `code`
(linked WhatsApp, PNT-047 hook) / `paper_stub` / `supervisor_exception`; the driver stays busy until the handover.

**Handover (PNT-034).** L1 → L4 → L5 → L6. `TICKET_CLOSED` (a second handover with a new key) → `HANDOVER_NOT_READY`
→ `NOT_TASK_ASSIGNEE` → `VERSION_CONFLICT` → custody → payment gate (`PAYMENT_PENDING {amount_halalas,
allowed_methods}`; a payment for a ticket that is not due → `VALIDATION_FAILED payment not_applicable`) → paper stub
compared with `normalizeTag`: a wrong stub is kept (`handover.code_attempt_failed` in `ticket_events`) and answered
`PAPER_STUB_MISMATCH {attempts_left}`; at `handover.max_attempts` → `handover.code_locked`, alert
`handover_code_locked:<cycle>`, `HANDOVER_CODE_LOCKED {locked_at, alert_id}` → deliver: task `completed`, cycle
`delivered`, ticket `delivered`, custody → customer (`handover`), `ready_not_collected`/`handover_code_locked`
resolved, driver settled, pass.

## Dispatch v1 (PNT-032)

- **Pass** (`runDispatchPass`, 10 §4.1) runs inside every transaction that changes a pool, holding the pool lock
  (DEC-08; an already held lock is reused). A: defensive expiry of single rounds past `expires_at + grace`. B: open
  demand locked in queue order `(priority_at, seq)`, drivers from `v_driver_state` whose shift is `open` (a closing
  shift's sessions are skipped while the close releases them one by one). C: demand without anybody on duty →
  `no_drivers_on_duty` (critical, `none_on_duty`/`all_on_break`), never another venue; resolved once someone is on
  duty. D: for each task the longest-idle candidate (`available_since`, then `user_id`; `dispatch.offline_drivers_last`)
  that is not blocked by a live single offer and not in the task's tried set (single recipients of this episode ∪
  acceptors) gets a single round; a live broadcast is converted (`converted_to_single`). E: `PassAdvisor` (S4). Counters
  `last_pass_at`/`pass_count` without a version bump.
- **Single round**: `round_no + 1`, `reminder_at`/`expires_at` from `dispatch.single_offer_reminder_s` /
  `dispatch.single_offer_ttl_s`, `task.offered`, `job.offer_expire` at `expires_at + dispatch.accept_grace_ms`
  (DEC-47, dedupe `offer_expire:<offer>`, aggregate version = the round's version).
- **Accept** follows 10 §5.2 exactly (locks L1 → L4 → L5 → L6 → L7 → L8, then duty/assignment, recipient, already
  claimed — 200 for the winner's other devices, `TASK_ALREADY_CLAIMED` + `rejected_late` after the rollback for the
  others — revoked, expired (time compared even before the timer ran), capacity, priority guard `OLDER_REQUEST_PENDING`
  {older_task_id, older_offer_id}), then 10 §5.3: round `accepted`, task `accepted`/`assigned_waiting`, cycle, ticket,
  `available_since = NULL`, his other live single offer revoked and requeued, `task.claimed`, `ticket.assigned` /
  `ticket.assigned_waiting`, `request_unaccepted` resolved, pass.
- **Expiry** (`job.offer_expire` and pass step A): round `expired`, task `queued` (same episode), the silent driver
  rotated to the back (`available_since = now`, DEC-26), `offer.expired`, pass. A stale timer is a no-op; an early one
  reschedules itself.
- **Sweep** (`job.dispatch_sweep`, 10 §8.2): every 5 s, one pass per pool with open demand, a live round or a reserved
  next task, each pool in its own transaction; it always schedules its successor. Seeded on demand by
  `ensureDispatchSweep` (a plain read first, so no command waits on a running sweep).
- **`job.dispatch_pass`**: a pass for a pool a transaction could not lock (dedupe `dispatch_pass:<pool>`), via
  `requestDispatchPass`.
- **Release hook** (DEC-32): `releaseDriverWork(tx, {orgId, driverId, poolId, reason, actorId})` revokes his live
  single offers (`transfer` for a transfer, else `recipient_unavailable`), withdraws his reserved next task and an
  accepted retrieval whose key is not picked up yet (`task.withdrawn`, back to `queued` with their original priority,
  ticket `requested`, cycle assignment cleared), never touches a picked-up key or a vehicle in his hands, and runs the
  pass without him. It never ends or changes the duty session: shift close (`reason: shift_closed`) ends it right
  after the call. Identity-access disable and shift close go through it (both tested end to end).

## Extension points

| Point | Where | S2 default | Filled by |
|---|---|---|---|
| `CustomerLinkingHook.onIntakeSubmitted` (W-01) | `use-cases/hooks.ts` — runs before `ticket.intake_submitted` and returns the changed ticket, so the event carries `pending_send` and the NotificationPlanner plans W-01 from it | nothing (`null`; `wa_link_status` stays `none`) | PNT-043 |
| `ClaimCodeHook.issueAtReady` / `verifyAtHandover` | `use-cases/hooks.ts` | no code; `method: code` → `VALIDATION_FAILED verification.method not_applicable` | PNT-047 |
| `InlinePaymentHook.collect` | `use-cases/hooks.ts` | none: a due ticket is `PAYMENT_PENDING` | PNT-080 |
| `BroadcastPolicy.onNoSingleCandidate` | `dispatch/application/pass.ts` | keep `queued` | PNT-052/053 (S4) |
| `PassAdvisor` (`idle_driver_while_next_waiting`) | `dispatch/application/pass.ts` | none | S4 |
| `job.offer_remind`, `job.broadcast_remind`, `job.escalate_unaccepted`, `job.next_task_wait_check`, `job.ready_uncollected_check`, `job.claim_code_expire` | comments at the scheduling sites | not scheduled | S4 / PNT-047 / PNT-058 |
| Early request (DEC-13) | `complete-parking.ts` + `openRetrievalCycle` | implemented: converts `pending_retrieval_at` at parked | the «طلب السيارة» button (PNT-045, whatsapp `registerButtonPressHandler`) sets it |

## Changes outside the three modules

- **Core (one, additive):** `appendCustodyEvent` in `packages/server/src/core/audit/audit-writer.ts` now returns the
  new row's id (`RETURNING id`), needed for `custody.changed.custody_event_id` (11 §8.6). Existing callers ignore it.
- No change to `pg-constraint-map.ts` was needed: the S2 uniqueness conflicts are checked explicitly before the write
  under the locks, and the existing map covers the indexes as the backstop.

## Tests

- `apps/api/test/` — integration through the real routes (`createS2App()` = `createTestApp()` with a 20 s lock
  timeout for the 50-way race): `duty-commands` (12), `duty-shift-close` (2), `tickets-intake` (17),
  `tickets-submit-void` (10), `tickets-parking` (12), `tickets-movement` (8), `tickets-reads` (6), `dispatch-offers`
  (18), `dispatch-release` (4), `g1-vertical-slice` (1): 90 tests. Unit: `tickets-plate.test.ts` (6),
  `packages/server/test/dispatch-ordering.test.ts` (6: idle ordering, candidate choice, module boundaries).
- `duty-shift-close`: `POST /v1/shifts/{shiftId}/close` with the real hook — the live single round of the first
  released driver is revoked and nothing is offered to his colleagues of the closing shift (without the shift filter
  the same transaction writes three rounds), every session ends `shift_closed`, `no_drivers_on_duty` is raised, and the
  next shift's first driver gets round 2; a duty start queued behind the close on L1 gets `SHIFT_NOT_OPEN`.
- `tickets-parking`: inactive spot/zone/slot/board refused, and a spot deactivation holding the row (as PATCH
  parking-spots does) makes the waiting allocation see the committed `inactive` and fail without an allocation.
- `dispatch-fixtures.ts`: HTTP steps of the slice, SQL setups for states S2 cannot reach through the API (broadcast
  rounds, reserved next tasks), and `expectConsistent` = the invariants of 10 §14.1 (I-A … I-F) and 11 §1.7, run after
  the steps of every scenario. `dispatch-locks.ts`: a row lock held from a separate connection (with a statement
  inside that transaction) + waiting for lock waiters (`pg_stat_activity`), for the race tests.
- Races on separate connections: 50 parallel intakes → 50 unique consecutive numbers; intake vs accept by the same
  driver → exactly one succeeds; 20 parallel accepts of one offer from the same driver → one assignment, all 200;
  parallel accepts of one broadcast by different drivers → one winner, the others `TASK_ALREADY_CLAIMED`; two drivers
  accepting their own single offers in parallel → both win.
- Error codes: every code in the OpenAPI `x-error-codes` of the 18 routes above is exercised through the real route,
  except the ones that S2 cannot produce (see gaps).
- G1 scenario: duty → intake → PATCH → submit → complete-parking → request on behalf → accept → key-pickup → start →
  ready → handover, with the custody chain, timeline, outbox and audit of every step, and the invariants after each.

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | Guard order for ticket/task/offer commands: scope (`TICKET_NOT_FOUND`/`RESOURCE_NOT_FOUND`/`OFFER_NOT_FOUND`) before the duty conditions (`DUTY_REQUIRED`/`DRIVER_ON_BREAK`), then locks and resource guards. An off-duty driver of another venue learns nothing about a ticket. | 07 §1.10 steps 4–6, 08 §1.3 | 08 §1.3 |
| DEC-PROPOSED-2 | The draft's customer and consent are written at `PATCH /intake` (customers upserted by normalized phone, `customer_consents` `verbal_staff_confirmed` per ticket), not at submit as TT-03 reads: `tickets` has only `customer_id`, no draft phone column. Submit checks consent and opt-out. A changed or cleared phone revokes the ticket's consent (`revoke_source = staff`). | 11 TT-03, 06 | 11 TT-03 |
| DEC-PROPOSED-3 | `consent` without a phone → `422 VALIDATION_FAILED {field: consent, issue: customer_phone_required}`; `CONSENT_REQUIRED` stays for the submit of a direct link without consent. | 08 §4.x | 08 |
| DEC-PROPOSED-4 | `INTAKE_INCOMPLETE.missing` names: `plate`, `vehicle.make`, `vehicle.color`, `key_tag`, plus `paper_serial` (paper) or `customer_phone` (WhatsApp without customer, live/consumed QR code or link). | 08, 02 D-05 | 08, 07 |
| DEC-PROPOSED-5 | `DRAFT_HAS_DATA.fields_present` ∈ `plate`, `vehicle`, `customer_phone`, `key_tag`, `paper_serial`, `notes`, `damage_marks`, `photos` (any entered data, not only plate/phone/tag/photo of 11 TT-04). | DEC-20, 11 TT-04 | 11 TT-04 |
| DEC-PROPOSED-6 | `draft_abandoned` is resolved when the draft leaves `received` — by submit too, not only by void (11 §6.10, 14 §8 "submit or cancel"). The timer of `intake.draft_abandoned_alert_min` has no job in canon §7.2 and is not implemented. | 11 §6.10, 14 §8, canon §12 | canon §7.2 |
| DEC-PROPOSED-7 | `void` with `custody_returned_to_customer` other than `true` → `409 CUSTODY_OPEN {items}` (the custody items still away from the customer); void of a terminal ticket → `INVALID_STATE_TRANSITION` (`allowed_from: [received, parking]`, DEC-45), not `TICKET_CLOSED`. | DEC-45, 08 | 07 void, 08 |
| DEC-PROPOSED-8 | Paper-stub attempts are counted from `ticket_events` `handover.code_attempt_failed` with `data.cycle_id` (no `claim_codes` row for paper tickets) against `handover.max_attempts`; the lock raises `handover_code_locked:<cycle>` like a code lock. | 11 TT-18, 13 | 06 (no attempts column for paper), 11 |
| DEC-PROPOSED-9 | Handover check order: closed → not ready → assignee → version → custody → **payment gate** → verification. The gate refuses before a wrong attempt is counted, so a kept attempt never coexists with a payment effect. Until PNT-080, a due ticket answers `PAYMENT_PENDING` even when the body carries a payment. | 11 TT-18, 13 | 07 handover |
| DEC-PROPOSED-10 | `ticket.ready` omits `code_expires_at` (11 §8.2): the outbox guard rejects payload keys containing `code` except the SAFE_KEYS list. Propose adding `code_expires_at` to SAFE_KEYS when PNT-047 issues codes. | DEC-38, 11 §8.2 | core outbox guard, 11 §8.2 |
| DEC-PROPOSED-11 | S2 has no broadcast: a request whose untried candidates are exhausted stays `queued` until a new idle driver appears (a new duty, a finished task, the end of a break). The tried set resets only with a new episode. | 10 §4.4 | 10 (S2 note) |
| DEC-PROPOSED-12 | `job.dispatch_sweep` is one global, self-perpetuating chain (dedupe `dispatch_sweep`), seeded on demand by any command that creates demand or a round; each pool is passed in its own transaction so one failing pool does not stop the others. | 10 §8.2 | 10 §8.2, canon §7.2 |
| DEC-PROPOSED-13 | The release hook keeps broadcast recipient rows (the driver can no longer accept them: duty/assignment checks) and excludes the driver from the pass it runs; `withdrawTask` clears `retrieval_cycles.accepted_by`, `assigned_at` and `assigned_waiting_at` (the cycle is waiting again). Duty end keeps broadcast recipient rows too. | DEC-32, 10 §9 | 10 §9 |
| DEC-PROPOSED-14 | An accepted round whose task was requeued afterwards (withdrawn) answers a late accept with `OFFER_REVOKED {close_reason: accepted}`: the card is history. | 10 §5.2 step 11 | 08 OFFER_REVOKED |
| DEC-PROPOSED-15 | Supervisor duty start with several venues in scope requires `venue_id` (`VALIDATION_FAILED venue_id required_multiple_venues`; none in scope → `no_venue_scope`); a venue outside the scope → `SCOPE_VENUE_DENIED`. | 09 §3 `duty.self` | 07 duty/start |
| DEC-PROPOSED-16 | Event choice at intake: an `event_id` of another venue → `404 RESOURCE_NOT_FOUND {resource: event}`; no open event → `EVENT_NOT_OPEN {event_id: null}`. | DEC-37 | 08 EVENT_NOT_OPEN |
| DEC-PROPOSED-17 | Ticket numbers are allocated inside StartIntake on the locked event row (`UPDATE … RETURNING`, no event version bump); a venues-events allocator can replace it with the same SQL. | 10 §7.1, 06 | 04 module map |
| DEC-PROPOSED-18 | Field visibility: the creator during intake does not see `fee_halalas` (09 §5.1 lists it for staff and the retrieval assignee); the retrieval assignee never sees `paper_serial`; holders only for staff or the actor's own custody. | 09 §5.1 | 09 §5.1 |
| DEC-PROPOSED-19 | `task.*` and `custody.changed` are written to `ticket_events` (timeline); `offer.*` are outbox-only. Promotion emits `task.promoted` + `ticket.assigned` (via `promotion`) and no `driver.availability_changed` (the driver never becomes available in between). | 11 §1.6, §8 | 11 §8 |
| DEC-PROPOSED-20 | A park with no key slot (`keys.require_slot = false`) leaves the key holder `unknown`; `key-pickup` then answers `CUSTODY_HOLDER_MISMATCH` and the key reaches the driver through a custody transfer (`POST /v1/tickets/{ticketId}/custody-transfers`, a later ticket). | 11 TT-05, TT-16 | 11 TT-16 |
| DEC-PROPOSED-21 | Live link codes are revoked by tickets-custody (`UPDATE link_codes … revoke_reason = channel_paper / ticket_voided`); PNT-044 may move this into the whatsapp module behind a hook. | DEC-40 | 04 module map |
| DEC-PROPOSED-22 | The dispatch pass considers only duty sessions whose shift is `open`. Shift close marks the shift `closed` before it releases and ends the sessions one by one, so the pass run by each release offers nothing to a colleague of the closing shift; with demand left and nobody on an open shift, `no_drivers_on_duty` is raised. | venues-events contract (pnt-018-020 notes), DEC-32, 10 §4.2 | 10 §4.2 query 3 |
| DEC-PROPOSED-23 | complete-parking refuses an inactive zone or board as well as an inactive spot or slot: `VALIDATION_FAILED` with `issue` `inactive`, `zone_inactive` or `board_inactive` on `parking_spot_id` / `key_slot_id`; the rows are read `FOR SHARE` after the canon locks. | venues-events contract, 06 | 08 VALIDATION_FAILED, 07 complete-parking |

## With the WhatsApp adapter and the NotificationPlanner (merged after S2 started)

- The S2 events carry the canonical fields the planner reads (11 §8.2): `ticket.intake_submitted` (`channel`,
  `wa_link_status`), `ticket.retrieval_requested` (`cycle_id`, `requested_early`), `ticket.assigned_waiting`
  (`cycle_id`, `task_id`), `ticket.retrieving` and `ticket.delivered` (`cycle_id`), `ticket.wa_link_changed`
  (`from`, `to`, `method`, `link_version`). In S2 no ticket is ever linked, so nothing is planned; once PNT-043 sets
  `pending_send`, W-01 … W-06 follow without changes here. Paper tickets never reach a message.
- Void revokes the ticket's action tokens through the whatsapp export `revokeActionTokens` (11 §5.3); live link codes
  are still revoked by tickets-custody (DEC-PROPOSED-21).
- Realtime: the S2 commands publish no WS message (the S2 screens poll, PNT-035); `x-ws-events` of these routes belong
  to the realtime planners of PNT-064 (DEC-48). The whatsapp module's `registerTicketUpdatePublisher` seam can take
  the tickets-custody `ticketSummary` builder then, so one TicketSummary projection serves every `ticket.updated`.

## Spec gaps and follow-ups

- Codes in `x-error-codes` that S2 cannot produce: `WA_TEMPLATE_NOT_APPROVED` (submit-intake, PNT-043),
  `HANDOVER_CODE_INVALID` / `HANDOVER_CODE_EXPIRED` / `HANDOVER_CODE_CONSUMED` (handover with a code, PNT-047),
  `PAYMENT_AMOUNT_MISMATCH` / `PAYMENT_METHOD_NOT_ALLOWED` (inline payment, PNT-080). Their tests belong to those
  tickets.
- Timers not scheduled in S2 (no handlers yet): `job.offer_remind`, `job.broadcast_remind`, `job.escalate_unaccepted`,
  `job.next_task_wait_check`, `job.ready_uncollected_check`, `job.claim_code_expire`, and a draft-abandoned timer
  (DEC-PROPOSED-6).
- `GET /v1/tickets?q=` searches plate digits and the display number only; Arabic letters alone return an empty page.
- `assigned_waiting` is reachable only through broadcast rounds (S4); S2 tests create those rounds with SQL.
- Test teardown: `pg-pool` resolves `end()` before its idle clients have disconnected, so the `DROP DATABASE` of
  `TestApp.close()` can terminate them (57P01); seen as an intermittent "unhandled error" after the 50-way race until
  core `48ca52a` gave `Database` a pool `error` listener.

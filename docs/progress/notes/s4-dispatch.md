# S4 — محرك التوزيع الكامل والمؤقتات (PNT-052 … PNT-063, PNT-084, PNT-086, notes)

docs/10 end to end on top of the S2 dispatch v1: single-offer timers, the broadcast mode, the next-task reservation and
its promotion, the priority guard, escalation and the waiting alerts, the supervisor operations (withdraw, reassign,
release custody, field cancel, repark), the early request, the heartbeat sweep, force-end, driver transfers, the
realtime messages of every dispatch event, and the race suite. Not pushed; `docs/DECISIONS.md` untouched — the
proposals below are numbered `DEC-PROPOSED-n` for the lead.

## Structure

| Place | Content |
|---|---|
| `packages/server/src/modules/dispatch/application/pass.ts` | `runDispatchPass` (10 §4.1 A–E), `BroadcastPolicy` + `BROADCAST_MODE` (PNT-053), `PassAdvisor` + `IDLE_DRIVER_ADVISOR` (10 §4.7), test seam `PassGate`. |
| `…/application/offers.ts` | `createSingleRound` (now schedules `job.offer_remind` too), `openBroadcast`, `extendBroadcast`, `eligibilityOf`, `remindRound`, `scheduleEscalation`, `scheduleNextTaskWaitCheck`, plus the S2 functions. |
| `…/application/tasks.ts` | `insertReparkTask` (TT-20/TT-20b), `cancelTask` (`task.canceled`), `withdrawTask` (now `key_was_picked_up`, a new escalation episode, its alerts resolved). |
| `…/application/priority-guard.ts` | `findOlderActionable` (the 10 §5.4 query), shared by accept and reassign. |
| `…/application/cards.ts` | `cardEligibility`, `loadOfferCards` / `loadHeadOfferCard` (OfferCard of 07, `waiting_seconds`, `safety_note_ar`), `loadDriverLives` (DriverLive + `duty_session_id`). |
| `…/application/realtime.ts` | `dispatchRealtimePlanner` (TxPlanner `dispatch-realtime`, DEC-41/DEC-48), `registerDispatchRealtime()`. |
| `…/application/heartbeat.ts` | `connectionStateAt`, `ensureHeartbeatSweep`, `sweepHeartbeats` (PNT-062). |
| `…/application/duty-service.ts` | `forceEnd` (PNT-084), the heartbeat chain seeded at duty start. |
| `…/jobs/index.ts` | `job.offer_expire`, `job.offer_remind`, `job.broadcast_remind`, `job.escalate_unaccepted`, `job.next_task_wait_check`, `job.dispatch_pass`, `job.dispatch_sweep`, `job.heartbeat_sweep`. |
| `packages/server/src/modules/tickets-custody/` | `application/task-card.ts` (`loadTaskCard`, moved from `use-cases/views.ts` so the dispatch planner can build the TaskCard — dispatch never imports the use-cases), `application/claim-codes.ts` (`revokeLiveClaimCode`), `jobs/index.ts` (`job.ready_uncollected_check` + `scheduleReadyUncollectedCheck`). |
| `packages/server/src/use-cases/dispatch-ops.ts` | `ReassignTaskUseCase`, `ReleaseCustodyUseCase`, `CancelCycleUseCase`, `ReparkUseCase`. |
| `…/use-cases/transfers.ts` | `DriverTransfersUseCase` (create, cancel), `completeTransfer`, `transferActivateHandler`, `transferWatchPlanner`. |
| `…/use-cases/request-retrieval.ts` | `openRetrievalCycle` schedules the escalation; `requestRetrievalForCustomer` (the entry point of the «طلب السيارة» button, PNT-045). |
| `…/use-cases/jobs.ts` | `useCasesJobs()` = `[job.transfer_activate]`; registers the realtime planner and the transfer watch for the worker. |
| `…/use-cases/http/dispatch-ops.controller.ts` | The six new routes (below); `DispatchHttpModule.onModuleInit` registers the realtime planner and the transfer watch in the api. |

## Routes

| Route | Permission | Ticket | Notes |
|---|---|---|---|
| `POST /v1/tasks/{taskId}/reassign` | `task.reassign` ✓ | PNT-058 | `{reason, target_driver_id?: uuid \| null, override_priority?, expected_version?}` → `{task, ticket}`. |
| `POST /v1/tasks/{taskId}/release-custody` | `task.release_custody` ✓ | PNT-058 | `{key_slot_id, reason}` → Task. Assignee or supervisor. |
| `POST /v1/retrieval-cycles/{cycleId}/cancel` | `retrieval.cancel` ✓ | PNT-059 | `{reason}` → `{ticket, cycle, repark_task}`. |
| `POST /v1/tickets/{ticketId}/repark` | `ticket.repark` ✓ | PNT-061 | `{reason, expected_version?}` → `{ticket: TicketDetail, task}`. |
| `POST /v1/duty-sessions/{sessionId}/force-end` | `duty.force_end` ✓ | PNT-084 | `{reason}` → DutySession. |
| `POST /v1/drivers/{driverId}/transfers` | `driver.transfer` ✓ 201 | PNT-086 | `{to_venue_id, scheduled_at?, reason}` → DriverTransfer. |
| `POST /v1/transfers/{transferId}/cancel` | `driver.transfer` ✓ | PNT-086 | `{reason}` → DriverTransfer. |
| `GET /v1/drivers` (identity) | `driver.read` | PNT-084 | `live` now carries `duty_session_id` (the path id of force-end, S-05/S-06). |

All commands use the core protocol (L0 idempotency, one transaction, audit with the reason, outbox) and the S2 check
order: scope (`RESOURCE_NOT_FOUND` / `TICKET_NOT_FOUND`) → duty → canon locks → resource guards.

## Behaviour

**Single-offer timers (PNT-052).** A single round schedules `job.offer_remind` at `reminder_at`
(`dispatch.single_offer_reminder_s`, dedupe `offer_remind:<offer>`) and `job.offer_expire` at `expires_at +
dispatch.accept_grace_ms` (dedupe `offer_expire:<offer>`), both with the round's version as aggregate version and
`{offer_id, task_id, pool_id}`. The reminder applies while the round is active, still a single, not yet reminded and
of the same version; it reaches the recipient only while he is still `available`; `reminded_at` is descriptive (no
version bump). An early timer reschedules itself at the real deadline. Accept at 31 s wins; the expiry fires at
31.5 s, rotates the silent driver (`available_since = now`) and the next pass offers round 2.

**Broadcast (PNT-053).** In step D a queued task with no untried idle candidate goes to `BROADCAST_MODE`: one
`broadcast` round (`round_no + 1`, `reminder_at` from `dispatch.broadcast_reminder_s`, no `expires_at`) whose
recipients are every on-duty driver of the pool (break, other pools and closing shifts excluded) with
`eligible_as` from the live state (`available` → `accept`, `intake_parking`/`retrieving` → `reserve_next`,
`busy_with_next` → `view_only`), `task.broadcast_opened` and one `job.broadcast_remind` (dedupe
`broadcast_remind:<offer>`: one reminder, to the recipients still on duty whose live state is not view-only).
R-3: a newer request stays `queued` (and invisible) while every driver who could act is held by an older live round.
A live broadcast is extended with drivers who came on duty or back from a break (`task.broadcast_extended` with only
the added rows; nobody is ever removed); an idle untried driver converts the oldest broadcast to a single round
(`converted_to_single`). A broadcast whose recipients all left stays a broadcast and the pass raises
`no_drivers_on_duty` (no `broadcast → queued`). `registerBroadcastPolicy(p | null)` replaces/restores the policy.

**Next task (PNT-054/055).** Accepting with one movement → task and ticket `assigned_waiting`, `ticket.assigned_waiting`
(W-03 by the WhatsApp planner), `job.next_task_wait_check` at `assigned_waiting_at + dispatch.next_task_wait_alert_s`
(dedupe `next_task_wait:<task>:<ms>`). A second reservation → `NEXT_TASK_ALREADY_RESERVED {next_task_id}`;
`uq_tasks_next_per_driver` is the backstop and maps to the same code. A reserved task cannot start
(`TASK_NOT_STARTABLE`). Promotion happens inside the transaction that ends the current task (handover,
complete-parking, supervisor cancel/withdrawal of the current task) through `settleDriverAfterTask`: `accepted`,
ticket `assigned`, `task.promoted`, `available_since` stays NULL — a concurrent pass blocked on L1 never sees him
available. W-04 is planned from `ticket.retrieving` only (the real start).

**Priority guard (PNT-056).** `findOlderActionable` (10 §5.4): an older task of the same pool with a live round the
driver can act on now (single to him within the grace, or broadcast with him as `accept`/`reserve_next`) refuses
the newer one with `OLDER_REQUEST_PENDING {older_task_id, older_offer_id}` — in accept and in reassign to a driver;
a supervisor passes it with `override_priority: true` (extra audit `dispatch.priority_override`). An older request
offered exclusively to someone else (R-4) or back in the queue without a round (EC-41) does not block.

**Escalation and waiting alerts (PNT-057).** `openRetrievalCycle` and every requeue (`withdrawTask`) schedule
`job.escalate_unaccepted` at `queued_at + dispatch.unaccepted_escalation_s` (dedupe
`escalate_unaccepted:<task>:<queued_at ms>`, payload `{task_id, cycle_id, queued_at}`). It applies while the task is
still `queued`/`offered`/`broadcast` with the same `queued_at` and not escalated: `tasks.escalated_at` (descriptive),
`task.escalated {…, waited_s, on_duty_count, available_count, mode_at_escalation}` and the critical alert
`request_unaccepted:<task>` (core `raiseAlert`; a repeat refreshes `details`). The request never leaves the queue.
`next_task_waiting_long:<task>` (warning) from `job.next_task_wait_check`; `idle_driver_while_next_waiting:<oldest
reserved task>` from the pass advisor when `dispatch.idle_driver_alert` and somebody is idle (stale ones resolved
`no_idle_driver`). Auto-resolution: claim/reassign → `request_unaccepted`; promotion/withdrawal → the next-task
alerts; a driver on duty → `no_drivers_on_duty`. Everything runs from server timers (no client needed).

**Withdraw / reassign / release custody (PNT-058).** Reassign before the movement only (`REASSIGN_BLOCKED_MOVEMENT
{task_id, started_at}` for `in_progress`; a picked-up key → `CUSTODY_RELEASE_REQUIRED {task_id, key_holder_id}`).
To the queue (`target_driver_id: null`, task `accepted`/`assigned_waiting`): `task.withdrawn` (trigger
`supervisor`), original `priority_at`, a new episode (`queued_at = now`) and its escalation, the previous driver
settled (promotion or available) and excluded from the pass of that transaction. To a driver: on duty in the same
pool (`DUTY_REQUIRED {target_driver_id}`), not `busy_with_next` (`NEXT_TASK_ALREADY_RESERVED`), `available` /
`intake_parking` / `retrieving` (else `DRIVER_NOT_AVAILABLE`), the priority guard for him → claimed in his name
(`accepted` or `assigned_waiting`), the live round revoked (`reassigned`), his own live single offer requeued,
`task.reassigned {from_assignee_id, to_assignee_id, result_status, reason, priority_override, trigger: reassign}` +
`ticket.assigned(_waiting)` (`via: supervisor`). Release custody: the assignee (or a supervisor) of an `accepted`
retrieval whose key was picked up: key driver → slot (`withdrawal_release`, slot and board active, `FOR SHARE`,
`KEY_SLOT_OCCUPIED`), new allocation, `key_picked_up_at = NULL`; the task stays his and he is not released.

**Field cancel (PNT-059).** Driver on duty in the pool while `requested`; supervisor while `requested`/`assigned`/
`assigned_waiting` (picked-up key → `CUSTODY_RELEASE_REQUIRED`): round revoked (`task_canceled`), task `canceled`
(`customer_field_cancel` / `supervisor_cancel`), cycle `canceled`, ticket `parked`, `ticket.retrieval_canceled`
(W-07 when the customer was told), driver settled, pass. After the start (`retrieving`/`ready`, supervisor only,
TT-20b/DEC-30): the live handover code revoked (`canceled`, ciphertext purged), retrieve task `canceled`
(`supervisor_cancel`), `repark` task `in_progress` for the same driver, ticket `reparking` (`ticket.reparking`
`cause: supervisor_cancel` → no W-08), no custody event, `available_since` stays NULL. A driver after assignment →
`INVALID_STATE_TRANSITION reason driver_cancel_after_assignment`.

**Early request (PNT-060).** `requestRetrievalForCustomer(tx, {ticketId, customerId, requestedAt?})` (L1 → L5) for
the button handler of PNT-045: `parked` → `created` (cycle `whatsapp`, immediate pass); `received`/`parking`/
`reparking` → `pending_early` (sets `pending_retrieval_at` once, `ticket.retrieval_requested_early` with
`parking_task_assignee_id` and `status_at_request`) or `already_pending` (the original time kept); open cycle →
`already_active`; closed → `closed`. No movement is created while the vehicle is being parked; complete-parking
converts it with the original time (`requested_early = true`, no second W-02). The function writes no audit row: the
inbound-message transaction of the caller does.

**Repark for customer absence (PNT-061).** `ready` schedules `job.ready_uncollected_check` at `ready_at +
ready.uncollected_alert_min` (dedupe `ready_uncollected:<cycle>`) → `ready_not_collected:<cycle>` (warning) while
the ticket is still `ready` with the same cycle and `ready_at`. Repark (supervisor, `ready` + task `in_progress`):
code revoked (`reparked`), cycle `reparked` with its times kept, retrieve task `canceled`
(`repark_customer_absent`), `repark` task `in_progress` for the driver, ticket `reparking` (`cause: customer_absent`
→ W-08), a `customer_absent` incident (through `IncidentRecorder`), the alert resolved; complete-parking → `parked`
without a message; the next request is `cycle_no + 1`. Cancel-after-start and repark require the vehicle and the key
with the task's driver, else `CUSTODY_HOLDER_MISMATCH {subject, current_holder_type}` and nothing changes.

**Safety sweep and heartbeat (PNT-062).** The S2 `job.dispatch_sweep` (5 s) is the safety net: with the
in-transaction pass switched off (`registerPassGate`) a request is still offered within 5 s. `job.heartbeat_sweep`
(one global chain, dedupe `heartbeat_sweep`, seeded at duty start, every `heartbeat.interval_s`): for each open duty
session whose stored `connection_state` differs from `connectionStateAt(last_heartbeat_at ?? started_at)`
(`uncertain` after `heartbeat.uncertain_after_s` = 45, `offline` after `heartbeat.offline_after_s` = 120) — each in
its own transaction, L8 only, no version bump — `driver.connection_changed`; going `offline` with a vehicle, a key or
an active task raises `driver_connection_lost_with_custody:<duty_session>` (warning), resolved when he is back online,
his custody is cleared or the duty ends. Availability and tasks are never touched: an offline driver keeps his
running task.

**Force-end (PNT-084).** Supervisor of the venue: L1 pool → L3 user; blockers (vehicle, key, task in progress, an
active park/repark — identity's `blockingCustody`) → `DUTY_END_BLOCKED_CUSTODY {items: [{type, ticket_id,
display_number, task_id?}]}` without override; otherwise `releaseDriverWork` (reason `forced`: live singles revoked,
next task and accepted-before-pickup back to the queue with their priority), duty `ended` (`end_reason = forced`,
`ended_by`), `driver.duty_ended`, audit `duty.force_end` with the reason; the driver's devices get `sync.required`.

**Transfers (PNT-086, AC-10/AC-16).** The supervisor needs both venues (`TRANSFER_SCOPE_DENIED {missing_venue_id}`);
same venue → `VALIDATION_FAILED to_venue_id same_as_current`; `DRIVER_DISABLED`; one open transfer per driver
(`TRANSFER_ALREADY_PENDING {transfer_id}`). Immediate (`scheduled_at` absent or due): L1 every pool of both venues
(ascending) → L3 transfer → assignment → user; a vehicle, key, task in progress or active park/repark →
`TRANSFER_BLOCKED_CUSTODY {items}` with no row and no alert; else `completeTransfer`: live singles revoked
(`transfer`), next task / accepted-before-pickup back to the old queue with their priority, duty ended
(`transfer`), old assignment ended, new active assignment (`transfer_id`), every session revoked (ws
`session.revoked`), transfer `completed`, `driver.transferred`; history keeps the original venue. Scheduled →
`pending` + `job.transfer_activate` at `scheduled_at` (dedupe `transfer_activate:<id>`): blocked at activation →
`blocked` + `blocked_details`, `driver.transfer_blocked`, `transfer_blocked:<id>` (info) for the supervisors of both
venues through `raiseAlertForAffectedVenues`; the transfer-watch planner re-schedules the activation whenever a
transaction ends the driver's task or moves custody away from him; a disabled driver's transfer is canceled at
activation. Cancel: `pending`/`blocked` only, resolves the alert.

## Timers (10 §8.2)

| Job | Scheduled at | Dedupe | Still applies when |
|---|---|---|---|
| `job.offer_remind` | `reminder_at` | `offer_remind:<offer>` | round active, single, same version, not reminded |
| `job.offer_expire` | `expires_at + accept_grace_ms` | `offer_expire:<offer>` | round active, same version |
| `job.broadcast_remind` | `reminder_at` | `broadcast_remind:<offer>` | round active, broadcast, not reminded |
| `job.escalate_unaccepted` | `queued_at + unaccepted_escalation_s` | `escalate_unaccepted:<task>:<queued_at ms>` | queued/offered/broadcast, same `queued_at`, not escalated |
| `job.next_task_wait_check` | `assigned_waiting_at + next_task_wait_alert_s` | `next_task_wait:<task>:<ms>` | `assigned_waiting`, same `assigned_waiting_at` |
| `job.ready_uncollected_check` | `ready_at + ready.uncollected_alert_min` | `ready_uncollected:<cycle>` | ticket `ready`, same cycle and `ready_at` |
| `job.heartbeat_sweep` | every `heartbeat.interval_s` | `heartbeat_sweep` | always (chain) |
| `job.transfer_activate` | `scheduled_at` / now (watch) | `transfer_activate:<transfer>` | transfer `pending`/`blocked`, due |

All run in mode `tx` (row marked done first), lock in canon order, and are no-ops when stale. `point_timer_lag_seconds`
is observed by the worker for every `job.*` row; the handlers add `dispatchOffers`, `dispatchEscalations`,
`dispatchAcceptRejections{code}`, `dispatchTimeToClaim`, `dispatchPassDuration{reason}`.

## Realtime (07 §4.3, 11 §9.2; DEC-41/DEC-48)

`dispatchRealtimePlanner` turns the transaction's events into `publishRealtime` calls before COMMIT (nothing reaches a
socket unless the change commits; a refused command publishes nothing — tested). Payloads are fresh reads at the end
of the transaction; one message per `(task, recipient)` and one `driver.state_changed` per driver per transaction.

| Domain event | WS message | Rooms | Data |
|---|---|---|---|
| `task.offered` | `task.offered` | `user:<recipient>` | OfferCard (`eligible_as`, `can_accept`, `can_reserve_next`, `expires_at`, `server_time`, `waiting_seconds`, `safety_note_ar`); aggregate `task_offer` + round version; skipped if the round closed in the same transaction |
| `task.broadcast_opened` / `_extended` | `task.broadcast` | each (added) recipient's user room | OfferCard per recipient |
| `task.claimed` | `task.updated` (winner's TaskCard) then `task.claimed` | winner; then `pool:<pool>:drivers` + `venue:<venue>:supervisors` | `{task_id, offer_ids, result, claimed_by: {id, full_name}}` |
| `task.created`, `.offered`, `.broadcast_*`, `.promoted`, `.key_picked_up`, `.started`, `.completed`, `.canceled`, `.withdrawn`, `.reassigned` | `task.updated` (Task, no parking/key slot) | venue supervisors | `cause` = the domain event |
| `task.promoted`, `.key_picked_up`, `.started`, `.completed`, `.canceled`, `.reassigned` (new assignee), `custody.changed` (`withdrawal_release`), `ticket.reparking` (repark task) | `task.updated` (TaskCard) | the assignee's user room | parking and key slot for him only |
| `task.withdrawn`, `.reassigned` (previous) | `task.updated` (Task, `assignee: null`) | the previous driver | |
| `offer.reminded` | `offer.reminder` | the recipients who can act | `{offer_id, task_id}`, no aggregate (descriptive) |
| `offer.expired` / `offer.revoked` | `offer.closed` | the recipient(s) | `{offer_id, task_id, close_reason}` |
| `driver.duty_started`, `.break_*`, `.availability_changed`, `.duty_ended` | `driver.state_changed` (DriverLive) | the driver + venue supervisors | aggregate `{type: user, id, version: null}` |
| `driver.connection_changed`, `.enabled`, `.disabled` | `driver.state_changed` | venue supervisors | |
| `driver.transfer_requested` / `_blocked` / `driver.transferred` | `driver.state_changed` | supervisors of both venues | |
| `driver.duty_ended` (`forced`/`self`) | `sync.required {reason: duty_force_ended \| duty_ended, scope: home}` | the driver | his other devices refetch |

Users whose sessions the transaction revokes (transfer, disable) get no user-room message (`session.revoked` does
the job). Lock-screen pushes are not planned here (DEC-23, notifications module).

## Extension points

| Point | Where | Default | For |
|---|---|---|---|
| `BroadcastPolicy` | `dispatch/application/pass.ts` | `BROADCAST_MODE` | tests / later policies |
| `PassAdvisor` | same | `IDLE_DRIVER_ADVISOR` | tests |
| `PassGate` (test only) | same | none | PNT-062 AC1 |
| `IncidentRecorder` | `use-cases/hooks.ts` | writes a `resolved` incident + `incident.opened`/`incident.resolved` | the incidents module (PNT-077) |
| `requestRetrievalForCustomer` | `use-cases/request-retrieval.ts` (exported from `@point/server`) | — | the WhatsApp button handler (PNT-045) |
| `revokeLiveClaimCode` | `tickets-custody` | revokes + purges the ciphertext | claim codes (PNT-047) may own it |
| `scheduleReadyUncollectedCheck` | `tickets-custody` | called by `ready` | — |
| Transfer watch | `use-cases/transfers.ts` (TxPlanner) | re-activates blocked transfers on `custody.changed` / `task.completed` / `task.canceled` / `task.reassigned` | custody transfer and manual reconcile (PNT-083/079) need nothing extra |

## Changes outside the dispatch module and the use-cases

- `packages/server/src/modules/identity-access/application/admin-service.ts`: `GET /v1/drivers` live adds
  `duty_session_id` (both SELECTs + the view).
- `packages/server/src/modules/tickets-custody/`: `task-card.ts` (moved, unchanged logic), `claim-codes.ts`,
  `jobs/index.ts` (`job.ready_uncollected_check`), index exports.
- `apps/worker/src/handlers.ts`: appended `handlers.push(...useCasesJobs())`.
- Root `package.json`: `test:race`; `scripts/race-loop.mjs`.
- `packages/server/src/use-cases/{hooks,index}.ts`: appended `IncidentRecorder` and the S4 exports.
- Tests updated: `tickets-movement`/`tickets-parking` now expect a broadcast where S2 kept the request queued.

## Tests

- New integration files (real PostgreSQL 16, `FakeClock`, `OutboxDispatcher.drain`, a NOTIFY listener capturing every
  realtime message): `dispatch-s4-offers` (8), `dispatch-s4-next-task` (11), `dispatch-s4-supervisor-ops` (12),
  `dispatch-s4-early-request` (3), `dispatch-s4-duty-transfer` (8), `dispatch-s4-heartbeat` (4),
  `dispatch-s4-realtime` (5), `dispatch-race` (6) — 57 tests; `dispatch-s4-fixtures.ts` holds the shared steps.
- Race suite (`apps/api/test/dispatch-race.int.test.ts`, 17 §race designs) on separate connections: 12 parallel
  accepts of one broadcast (10 accept + 2 reserve_next) → one 200 and eleven `TASK_ALREADY_CLAIMED`; intake vs
  accept by the same driver; accept vs `job.offer_expire` around the deadline; double handover; reassign vs accept;
  AC-17: 100 rounds of 20 parallel accepts on the newer request while the older is actionable → none succeeds.
  `RACE_ITERATIONS` (default 3) repeats each scenario inside one run; `PRIORITY_ITERATIONS` defaults to 100.
- `pnpm test:race` runs the suite `RACE_LOOPS` (default 50) times in a row, stopping at the first failure, then
  `pnpm db:invariants` unless `RACE_INVARIANTS=0`. The "nightly" part of PNT-063 is this command; no scheduled CI
  workflow was added (CI runs on PRs and `main` only, CLAUDE.md §8).
- Results (2026-10-28, PostgreSQL 16, loaded machine): `pnpm test:race` with `RACE_LOOPS=50` — 50 consecutive runs
  green in 2304 s, then `ALL INVARIANT TESTS PASSED`; `pnpm test` 38 files / 955 tests green; `pnpm test:int`
  44 files / 414 tests green (the opt-in MinIO file skipped without `TEST_S3_ENDPOINT`); `pnpm lint` and
  `pnpm typecheck` clean.

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | When every on-duty driver of the pool is `busy_with_next`, the request still opens a broadcast whose recipients are all `view_only` (the third example of 10 §4.8), so the supervisors and drivers see it waiting; it is converted to a single round as soon as somebody becomes idle. When the drivers who could act are all held by an older live round (R-3), the request stays `queued`. | 10 §4.1 step D vs §4.8 | 10 §4.1 |
| DEC-PROPOSED-2 | `reassign` to a driver is also allowed for a task in the queue (`queued`/`offered`/`broadcast`): it is claimed in his name and the live round is revoked (`reassigned`). `target_driver_id: null` on a task already in the queue → `INVALID_STATE_TRANSITION reason already_in_queue`; the same assignee → `reason same_assignee`. | 10 §9.1 | 07 reassign, 08 |
| DEC-PROPOSED-3 | A reassignment to a driver emits `task.reassigned` (`trigger: reassign`, `target: driver`, `from_status`, `result_status`) and `ticket.assigned`/`ticket.assigned_waiting` with `via: supervisor`; no `task.claimed` (nobody accepted). | 11 §8.3 | 11 §8.3 |
| DEC-PROPOSED-4 | The pass in the withdrawal transaction excludes the previous assignee: a supervisor-assigned driver is not in the tried set (10 §4.4 counts recipients and acceptors), so without the exclusion the task would be offered straight back to the driver it was taken from. Later passes may offer it to him again. | 10 §4.4, §9.1 | 10 §9.1 |
| DEC-PROPOSED-5 | DriverLive carries `duty_session_id` (D-12 / S-05 need it for `POST /v1/duty-sessions/{sessionId}/force-end`), in `GET /v1/drivers` and in `driver.state_changed`. | 07 DriverLive | 07 DriverLive |
| DEC-PROPOSED-6 | `connection_state` is descriptive (10 §2.7; 06 duty_sessions: «النبضة لا تزيد `version`»): the heartbeat sweep changes it without a version bump. Identity's heartbeat (`POST /v1/me/heartbeat` and `client.heartbeat`) still bumps `duty_sessions.version` when it sets `online` again — proposal: drop that bump (identity-access owns the change). | 10 §2.7, 06 | identity `me-service.ts` |
| DEC-PROPOSED-7 | `driver_connection_lost_with_custody:<duty_session_id>` is raised on the transition to `offline` while the driver holds a vehicle, a key or an active task (refreshed while it stays so), and resolved automatically when he is online again, his custody/task is cleared or the duty ends. | 14 §8, 10 §8.4 | 14 §8 |
| DEC-PROPOSED-8 | Realtime envelopes: `driver.state_changed` has aggregate `{type: user, id, version: null}` (DriverLive mixes descriptive fields); `offer.reminder` has none; the winner's `task.updated` precedes `task.claimed` (same task version, the winner's client ignores the claim); `task.claimed` carries `offer_ids` (the accepted round) and `claimed_by {id, full_name}`; the supervisors' Task never carries the spot or key slot; a connection change (`driver.connection_changed`) goes to the supervisors only — the device shows its own connection state (11 §9.4 step 7) and a disconnected device cannot receive it. | 07 §4.3, §4.5, 11 §9.4 | 07 §4.3 |
| DEC-PROPOSED-9 | `sync.required {reason: duty_force_ended \| duty_ended, scope: home}` goes to the driver's user room when his duty is force-ended or ended (his other devices); transfer and disable rely on `session.revoked` and send nothing else to his user room. | 11 §9.2 | 07 §4.3 |
| DEC-PROPOSED-10 | TT-20 records the `customer_absent` incident already `resolved` (the repark is the resolution), severity `low`, with `incident.opened` + `incident.resolved` (`auto_created: true`), through the `IncidentRecorder` hook that the incidents module may replace. | 11 §2.3, TT-20 | 11 TT-20 |
| DEC-PROPOSED-11 | Transfers live in the use-cases (they cross identity, dispatch and venues), and blocked transfers are re-evaluated by a TxPlanner that schedules `job.transfer_activate` now when a transaction ends the driver's task or moves custody from him — so custody transfers and manual reconcile need no transfer code. | 10 §9.7, 11 §8.11, 04 §4.4 | 04 module map |
| DEC-PROPOSED-12 | Transfer rules: the actor needs both venues (`TRANSFER_SCOPE_DENIED {missing_venue_id}`, also for cancel); target = current venue → `VALIDATION_FAILED to_venue_id same_as_current`; an immediate transfer that is blocked → 409 with no transfer row and no alert; a scheduled one is checked at activation; a driver disabled before activation → the transfer is `canceled`; cancel is allowed in `pending`/`blocked`. A concurrent assignment change → `ASSIGNMENT_CONFLICT {reason: assignment_changed}`. | 09 §8.2, 10 §9.7 | 07 transfers, 08 |
| DEC-PROPOSED-13 | An immediate transfer and its activation lock L1 for every dispatch pool of both venues (ascending id) before L3 transfer → assignment → user. | canon §14ب, 10 §9.7 | canon §14ب note |
| DEC-PROPOSED-14 | Cancel after the start and repark require the vehicle and the key with the running task's driver (a formal custody transfer moves the task with them, 10 §6.3); otherwise `CUSTODY_HOLDER_MISMATCH {subject, current_holder_type}`. Both resolve `ready_not_collected:<cycle>` and `handover_code_locked:<cycle>`. | TT-20, TT-20b | 07 cancel/repark |
| DEC-PROPOSED-15 | `requestRetrievalForCustomer` results: `created`, `pending_early`, `already_pending` (a repeated press during parking keeps the first time and emits nothing), `already_active`, `closed`; `ticket.retrieval_requested_early` adds `status_at_request` and `parking_task_assignee_id`. | DEC-13, 10 §7.3 | 11 §8.2 |
| DEC-PROPOSED-16 | Timer payloads carry `offer_id` (`job.offer_remind`, `job.offer_expire`, `job.broadcast_remind`) and the episode mark (`queued_at`, `assigned_waiting_at`, `ready_at`); a stale mark is a no-op. | 11 §8.11 | 11 §8.11 |
| DEC-PROPOSED-17 | Force-end `DUTY_END_BLOCKED_CUSTODY.items` = identity's `blockingCustody` rows `{type: vehicle\|key\|task\|parking, ticket_id, display_number, task_id?}`, the same list as transfer blocking. | 08 DUTY_END_BLOCKED_CUSTODY | 08 |
| DEC-PROPOSED-18 | `release-custody` allocates the requested slot (`KEY_SLOT_OCCUPIED` if it is taken, slot/board must be active), keeps the task `accepted` with its assignee and never settles him; a second call → `INVALID_STATE_TRANSITION reason key_not_picked_up`. | 10 §9.2 | 07 release-custody |
| DEC-PROPOSED-19 | `idle_driver_while_next_waiting` is one alert per pool, for the oldest reserved task (`idle_driver_ids`, `reserved_by`, `waiting_since`); the others of the pool are resolved `no_idle_driver`. | 10 §4.7 | 14 §8 |
| DEC-PROPOSED-20 | The heartbeat sweep is one global chain (dedupe `heartbeat_sweep`) seeded at duty start, like the dispatch sweep (S2 DEC-PROPOSED-12); each session is swept in its own transaction. | 10 §8.2 | canon §7.2 |
| DEC-PROPOSED-21 | The TaskCard projection lives in tickets-custody (`loadTaskCard`), shared by the reads, the command responses and the realtime `task.updated`; `revokeLiveClaimCode` lives there until PNT-047 owns claim codes. | 04 §4.3 | 04 module map |

## Gaps and follow-ups

- Codes in the new routes' `x-error-codes` that cannot be produced yet: none — every listed code is exercised through
  the real route (`PERMISSION_DENIED` by the permission guard). `CUSTODY_HOLDER_MISMATCH` needs a split custody that
  only the custody-transfer endpoint (PNT-083) can create; the test sets it with SQL.
- `POST /v1/me/heartbeat` sent with an `Idempotency-Key` answers 500 in the test environment: the runner asserts an
  audit row for keyed commands and the heartbeat writes none. Clients send it without a key (canon §9.1); core may
  exempt it.
- A blocked scheduled transfer is re-evaluated only through the watch planner; a blocker that disappears without an
  event (data fix) waits for the next command touching the driver.
- `revokeLiveClaimCode` and the WhatsApp planner's W-07/W-08 rules are integrated only through events; the code issue
  and verify paths stay with PNT-047.
- The simulator test `tools/wa-simulator/test/webhooks.test.ts` ("reset" with a 200 ms real timer) failed once under
  the full unit run and passed alone — a timing flake outside S4.

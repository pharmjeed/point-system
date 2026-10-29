# g4-rehearsal — G4 full event, analytics end to end, one incident writer, automated rehearsal (PNT-093, PNT-090 AC2, PNT-102)

Stream branch `wave4/g4-rehearsal`. `docs/DECISIONS.md`, `STATUS.md`, `state.json` and `tickets.json` are untouched; the
proposals below are numbered `DEC-PROPOSED-n` for the lead.

## 1. PNT-093 — gate G4 (`apps/api/test/g4-full-event.int.test.ts`)

One full event of RMS through the real routes, the worker and the WhatsApp simulator — 14 sequential steps sharing
one app (the customer harness: api on a port, simulator in process, the worker's dispatcher on the FakeClock) with
**every** handler and projector of the real worker registered (`apps/worker/src/handlers.ts`: dispatch,
tickets-custody, whatsapp, notifications, incidents + the AlertAutoResolver, payments-reports, audit-monitoring +
the AnalyticsProjector, use-cases). Every advance of the clock goes through `tick()`: the on-duty phones send
`POST /v1/me/heartbeat` every 15 s (as the PWA does) and the worker runs, so the timers fire on time and nobody
flaps to `uncertain` unless the scenario silences his phone.

| Step | What happens (all through the real routes) |
|---|---|
| opening | yesterday's shift closed (`shift.closed`), a shift created and opened, the event created (per vehicle 20.00 SAR, cash + POS) and opened, five drivers on duty |
| arrivals | 16 intakes, photos uploaded through `POST /v1/tickets/{id}/media` → presigned PUT → `complete`; K4 submitted with 3 photos then the 4th (taken before the submission, `captured_at`) uploaded late → `ticket.inspection_completed`, the alert resolved by the worker; K5 inspection exception; K6 wrong phone corrected (`PATCH customer-phone`, W-01 to the new number); K7 draft voided with custody returned; K8 early request (pressed while parking, converted at complete-parking with the press time) delivered |
| K1 | «إيقاف» (W-12, `opted_out`) then the button resumes the consent: W-02 … W-06 |
| K3 | offer reminded (15 s), expired (31.5 s), next driver, `task.escalated` + critical `request_unaccepted` at 60 s, acknowledged by the supervisor, claimed → alert resolved |
| K4 | field cancel at the gate (W-07), asked again (cycle 2), POS reference corrected by a reversal with replacement |
| K6 | ready, no-show: `ready_not_collected` after 10 min, repark (W-08, `customer_absent` incident), parked, asked again, delivered |
| peak | breaks; two drivers with reserved next tasks (W-03), two view-only broadcasts, a late driver: the older becomes his single offer, the newer broadcast is extended to him (`task.broadcast_extended`); the provider goes down (`wa_channel_down`, messages wait) and comes back (only the current state is sent: W-05, no late W-04); a separate collection; promotions at handover (`task.promoted`); K14's code locked after five wrong codes, the exceptional handover with the driver's cash |
| transfer | DRV3 takes a late guest's car in; `TRANSFER_SCOPE_DENIED` (SUP-R), `TRANSFER_BLOCKED_CUSTODY` without row or alert, a scheduled transfer blocked at activation (alerts on both venues), completed when the car is parked; his sessions revoked, a stale RMS offer is `OFFER_NOT_FOUND`, his RMS history intact; he works in LYL (intake, retrieval, handover) and ends his duty |
| K9 / K13 | reassignment to the driving supervisor (he collects the cash); withdrawal back to the queue, offered to another driver |
| K2 | the basement: no heartbeat for 130 s with a car → `uncertain`, `offline`, `driver_connection_lost_with_custody`; back online → resolved; later the POS payment is reversed without replacement → due + `payment_discrepancy` incident (PATCH `in_review`), the host covers it (waiver), the incident resolved |
| K15 | ten minutes without the API (no request at all, the worker runs): delivered on the paper log, then `manual-reconcile` to `delivered` with the cash `collected_by` the driver (TC-038); DRV6 disabled (lost phone) and enabled again, signs in, back on duty |
| closing | start-closing (`EVENT_NOT_OPEN` for a new intake), reconciliation lists the last car and the cash, `EVENT_CLOSE_BLOCKED` with the same blockers, the last car delivered, cash handed over by every driver (DRV2 five riyals short → difference −500 and its incident), reconciliation clear, close, `EVENT_ALREADY_CLOSED`, the shift closed (every duty ended) |

Acceptance asserted at the end: no open custody (every ticket delivered or voided with both holders `customer`, no
spot/slot allocation, no open task, round, cycle or live code, no code copy); the amounts — checked against a ledger of
what each collector took, kept from the scenario's own commands (the handovers with a payment, the separate
collection, the exceptional handover, the reconciliation, both reversals) and never read back from the server: before
the cash handovers every settlement driver's cash collected / count / outstanding and POS amount / count equal it, each
driver hands over his ledger amount (DRV2 five riyals short: `difference_halalas` −500, 0 for the others, the linked
payments = his cash collections), and at the end the recorded cash and POS, `by_method` and the handovers' sums equal
it (10 cash collections, 4 POS slips); settlement collected = recorded payments, nothing due or outstanding,
integrity ok, `close_summary.finance` = the settlement; the event closed; the transfer completed with the LYL
assignment; every action with its actor (TC-036 «كل فعل بفاعله»): each ticket's `created_by` / `parked_by` /
`delivered_by` is who the scenario had do it (the assignee for the exception and the reconciliation), and every
successful command (Idempotency-Key, 2xx) has at least one `audit_log` row under its request id, every such row in its
caller's name; no failed/dead outbox row; the invariants — `INVARIANTS` (10 §14.1 / 11 §1.7),
`infra/backup/consistency.sql` and `runInvariants` (docs/06_schema_invariants_test.sql on a fresh database of the same
migrations).

## 2. PNT-090 AC2 — every tracked server action in an end-to-end run

Last step of the same file: the run commits **all 71** domain event types of canon §7.1 (asserted), and each committed
domain event has exactly one `analytics_events` row (`properties.source_event_id`), named after its type (15 §4), with
keys inside its 15 §7 catalog entry, no 15 §3 denylisted key, `findPiiValues` empty, no Arabic text, and none of the
run's phones (E.164, local, digits), key slot or spot ids, paper serials, key tags or plates (substring scan of the
rows) nor its handover codes (read from W-05; matched as whole values only — no hex neighbour — because a six-digit
code can sit inside a UUID of the rows by chance, ~0.4 % per run); `point_analytics_rejected_total{source="server"}`
does not move during the run (nothing refused, no value outside its list stored as null); every press that opened a
cycle carries `ingest_latency_ms` (§4.2), staff and early requests none.

## 3. One incident writer (`openIncident()`)

`INSERT INTO incidents` now exists in one file (`modules/incidents/application/incidents.service.ts`, asserted by
`apps/api/test/incident-writer.int.test.ts`):

- `core/hooks/incident-writer.ts`: `OpenIncidentInput`, `registerIncidentOpener`, `openIncidentViaHook` (throws when
  no writer is registered — never skips an incident 13 §7.1 / §10.2 require). The incidents module registers
  `openIncident` when its index loads (the DriverReleaseHook pattern).
- `openIncident` options keep each flow's documented rows and events: `ownerId`, `dispatchPoolId` (envelope),
  `autoCreated` (`null` = key left out), `openedStatus` (`stored` = the row's status), `timeline` (also appends to
  `ticket_events` through core's `appendTicketEvent`, as tickets-custody's `emitForTicket` does).
- TT-19 (`use-cases/customer-flows/handover-exception.ts`) and the default TT-20 recorder (`use-cases/hooks.ts`) call
  `openIncident` (use-cases may import incidents); payments-reports (`openPaymentDiscrepancyIncident`) goes through
  the core seam (04 §4.3: it may not import incidents).
- Identity proven: the three behavioural tests of `incident-writer.int.test.ts` (rows, envelopes, payloads, timeline
  rows of all three flows) pass unchanged against the previous writers (run once with the old sources restored), and
  the 10 suites that touch incidents stay green.

## 4. Defects found

Levels on the 17 §16 scale (1 حرجة · 2 عالية · 3 متوسطة · 4 منخفضة; any financial mismatch is 1 however rare, and every
level 1 or 2 closes with an automated regression test). The owner confirms the classification (17 §16).

| # | Found by | Level (17 §16) | Defect | Fix |
|---|---|---|---|---|
| 4.1 | G4 (K14) | **1** — a financial mismatch: the cash was booked to a supervisor who never held it, and the 13 §5.2 amount and method checks were skipped (`recordCollection` trusts its caller) | `POST /v1/tickets/{ticketId}/handover-exception` recorded every payment as collected by the supervisor (the body's `collected_by` was ignored), so the driver who took the cash did not owe it at the cash handover (13 §10); the 13 §5.2 checks (method, exact fee, POS reference) never ran on that path | the payment passes the handover's checks before any effect, is recorded with `source = exception` and `collected_by` from the body — the assignee or the approving supervisor, else `VALIDATION_FAILED payment.collected_by not_eligible` (DEC-210, as merged) `` — and the command holds the event FOR SHARE (L2) like TT-18 when money is involved. Regression test (17 §16 rule 4): `apps/api/test/handover-exception-payment.int.test.ts` |
| 4.2 | rehearsal (report row «request saved» empty) | 3 — observability: 15 §10 / 17 M1 unmeasurable in production; no effect on custody or money | `point_retrieval_request_ingest_seconds` (05 §12.2) was declared and never observed; `ingest_latency_ms` of `ticket_retrieval_requested` (15 §7) was always null — the projector reads it from the event and nobody put it there | the inbound processor passes the stored delivery's `received_at` with the message; the button's request puts `ingest_latency_ms` (webhook received → the cycle written) on `ticket.retrieval_requested`; the worker observes the histogram after the commit. Staff requests and early presses converted at parking carry none. `apps/api/test/wa-ingest-latency.int.test.ts` + the G4 AC2 step |
| 4.3 | `pnpm test` on the base | 4 — a test that did not follow DEC-192; no product effect | 0ad3583 (DEC-192) changed the Caddyfile CSP without `apps/api/test/deploy-config.test.ts` | fixed on the base by b0f881a (the cherry-pick of this stream's 5488370). This branch no longer touches the file: 5488370 and 04144be were dropped when it was rebuilt on the moved base |
| 4.4 | review of this stream | 3 — a wrong refusal in a race (13 §17.11): nothing is written either way, but the client is not told to refetch (08: `PAYMENT_ALREADY_RECORDED` → refetch) | the exceptional handover of a ticket already `collected`, with a payment in the body, answered `VALIDATION_FAILED payment not_applicable`; 4.1's fix ran the hook's `check` only for `due` tickets | the gate is TT-18's: the hook's `check` runs for every money state (`PAYMENT_ALREADY_RECORDED` 409 with `payment_id`, `method`, `collected_by`); the S2 gate stays for a hook without `check`. `handover-exception-payment.int.test.ts` |
| 4.5 | review of this stream | 4 — the order of two audit rows of one request | the exception wrote `payment.record` before `handover.exception`; 13 §8.4 reads «`handover.exception` ثم `payment.record`», as manual-reconcile (13 §8.5 «كالبند 8.4») already does | `recordCollection({ deferAudit })` hands its row's writer back; the use case writes it after its own row (same transaction and request id); asserted with `toEqual` |
| 4.6 | rehearsal (M2 row), not fixed | 3 — observability, like 4.2 | `point_dispatch_publish_seconds` (05 §12.2 «Commit of assignment/offer to WebSocket publish», the system source 15 §10 names for its second target) is declared and observed nowhere (not on load-chaos either) | left to the lead: the natural place is the realtime relay (`packages/server/src/realtime/realtime-server.ts`, which load-chaos also edits), observing `now − occurred_at` when `task.claimed` / `task.offered` / `task.broadcast` leave for the sockets. The rehearsal measures 17 M2 on the drivers' sockets meanwhile |

Merge notes for the lead:
- This branch is rebuilt on `origin/claude/stoic-hamilton-pfdo2m` e24c692 and merges into it without conflict
  (`git merge-tree`).
- `modules/whatsapp/application/inbound-processor.ts` conflicts with wave4/load-chaos: the line
  `await this.message(channel, m, v.contacts, new Date(ev.received_at));` sits right above load-chaos's KP-2
  `killPoint('inbound_after_cycle_commit')` lines — keep both.
- `apps/api/test/deploy-config.test.ts`: untouched here now; load-chaos's c6a93cb conflicts with the base's b0f881a on
  its own (the same DEC-192 fix in other words) — take the base's version.
- `package.json`: `ops:rehearsal` is listed after `audit:prod` so it does not touch the `ops:restore-drill` line
  load-chaos appends to.

## 5. PNT-102 — `pnpm ops:rehearsal` (automated rehearsal)

Files: `apps/api/rehearsal/run.mjs` (orchestrator), `apps/api/rehearsal/api-server.mjs` (the api process: the built
`createApp`, the metrics server, and the in-memory bucket's HTTP face — no S3 locally), `apps/api/rehearsal/checks.mjs`
(the SQL and report helpers; `apps/api/test/rehearsal-checks.test.ts` keeps its invariant queries equal to the tests').
Root script `ops:rehearsal`. It lives in apps/api because it uses the app's own dependencies (pg, socket.io-client,
otplib) and is not part of the build (`tsconfig.build.json` compiles `src/` only).

What it does: builds; fresh `point_rehearsal_<hex>` database (migrations + 17 §4 seed; supervisor MFA off as the seed
has no TOTP for supervisors); boots the simulator, the api and the real worker (`apps/worker/dist/main.js`) as child
processes on 4201–4204 (`REHEARSAL_PORT_BASE`), `NODE_ENV=production` (rate limits on; each device has its own
address behind `TRUST_PROXY=1`), SystemMonitor every 10 s; sets the night up through the API (owner and admin with
TOTP, extra drivers created and changing their PIN, more key slots and an overflow zone, `ready.uncollected_alert_min
= 2`, previous shifts closed, the night's shifts and events opened); plays the evening (drivers with a WebSocket each:
heartbeats, offers, `client.offer_seen`; `/v1/me/home` sync; customers through the simulator; supervisors following
the alerts: critical ones acknowledged, the no-show reparked, the locked code's exceptional handover, a few reserved
next tasks moved to a free driver on `idle_driver_while_next_waiting`, the POS reversal; TC-036 «نقل سائق»: once LYL
has taken in its last car, SUP-RL moves an idle LYL driver to RMS — his sessions are revoked, he signs in again,
starts his duty in RMS and serves RMS cars); closes the night (each driver hands over the cash the bots booked to him,
the first count five riyals short); measures from the database and the bots; writes
`docs/test-evidence/rehearsal/<date>.md`; stops and drops everything — the process logs are removed after a passing
run and kept (their folder printed) after a failing or interrupted one; SIGINT / SIGTERM stop the processes and drop
both databases the same way. Exit 0 = every check passed. Variables: `REHEARSAL_TICKETS` (150),
`REHEARSAL_ARRIVAL_WINDOW_S` (240), `REHEARSAL_DWELL_MIN_S`/`_MAX_S` (60/300), `REHEARSAL_SEED`,
`REHEARSAL_DEADLINE_S`, `REHEARSAL_REPORT`, `REHEARSAL_KEEP_DB=1`, `REHEARSAL_SKIP_BUILD=1`.

`REHEARSAL_SEED` fixes the car plan (arrivals, dwell, channels, how each customer pays and his POS slip, the wrong
codes, the scripted moments) and gives every actor its own stream of draws (each driver, each car's customer); which
offer or car a draw meets still depends on the timing, so two runs with one seed play the same plan, not the same
interleaving.

The checks that fail the run: the 10 §14.1 / 11 §1.7 invariants, `consistency.sql`, the schema invariants on a fresh
database, every closed-event check (no open custody, allocation, task, cycle, live code or code copy, no cash left,
nothing due); the money against what the bots took — a ledger per event kept from their own commands (handovers with
a payment, the exceptional handover, the reversal with its replacement), never read back: the settlement per collector
before the cash handovers (cash collected / count / outstanding, POS amount / count), each handover's
`expected_halalas`, `difference_halalas` and linked payments, the recorded cash and POS, the handovers' sums;
settlement collected = recorded payments and its integrity; TC-036 `close_summary` saved (the stored summary = the
close's answer, its `finance` = the settlement after the close, its tickets, closed by the supervisor); TC-036 every
action with its actor (each ticket's created/parked/delivered by = the bot that did it; every keyed 2xx command has
audit rows under its request id, all in the bot's name); every scripted moment's outcome read back from the database
(a planned moment that did not happen fails); no 5xx; one analytics row per domain event; the M1 histogram's count =
the presses that opened a cycle; no failed/dead outbox row; every car delivered before the deadline.

The moments that raced the bots' timing are made deterministic: the driver of the field-cancel car holds before the
key pickup until the supervisor's cancel lands (≤ 30 s, «the guest tells the supervisor at the gate»), the driver
parking an early-press car parks once the press is stored (`pending_retrieval_at`, ≤ 30 s), the opt-out customer
presses again once the supervisor's board shows `opted_out`; a break refused while the driver was finishing a task is
asked again.

The human rehearsal (H-10 step 1 by people with the H-07 phones and the Meta test number, steps 2–4 = the paper
outage drill TC-038, H-09 = the restore TC-037, on staging) stays an owner task: PNT-102 remains `in_progress`.

## 6. Proposed decisions

- DEC-PROPOSED-1: One incident writer — context: three flows inserted incidents with their own SQL (S3 TT-19, S4
  TT-20, payments 13 §7.1/§10.2), 04 §4.2 item 7 names `IncidentService.open` — decision: `openIncident()` of the
  incidents module is the only writer; use-cases call it, modules below incidents use the core seam
  `openIncidentViaHook` registered by the incidents module at load; its options reproduce each flow's documented
  events. Follow-up proposal (not done, payloads kept identical as asked): align the TT-20 `incident.opened` payload
  on 11 §8.8 (`status: open`, then `incident.resolved`) and give TT-19 an explicit `auto_created` — affected files:
  04 §4.2 item 7, §4.3 (seam), 11 §8.8.
- DEC-PROPOSED-2: Exceptional handover with money (13 §8.4) — context: `collected_by` "defaults to the assignee and
  may be the supervisor himself"; the code ignored it and skipped the 13 §5.2 checks — decision: the payment gate is
  TT-18's for every money state (11 TT-19 «قواعد الدفع كما في TT-18»): `due` → `payment` or a prior waiver
  (`PAYMENT_PENDING`); `collected` with a payment → `PAYMENT_ALREADY_RECORDED` (13 §15, §17.11: the exception of a
  collected ticket needs none); `not_required` / `waived` with one → `VALIDATION_FAILED payment not_applicable`; for a
  due ticket `collected_by` must be the open retrieve task's assignee or the approving supervisor
  (`VALIDATION_FAILED payment.collected_by not_eligible` otherwise, DEC-210) and the 13 §5.2 checks run before any effect
  (`PAYMENT_METHOD_NOT_ALLOWED`, `PAYMENT_AMOUNT_MISMATCH`, `VALIDATION_FAILED payment.pos_reference …`);
  `source = exception`; L2 event FOR SHARE between L1 and L4 when the ticket is due or a payment is sent; the audit
  rows in 13 §8.4's order, `handover.exception` then `payment.record`, one request id — affected files: 13 §8.4 and
  §16 (the endpoint's errors: add `PAYMENT_ALREADY_RECORDED`, `PAYMENT_METHOD_NOT_ALLOWED`,
  `PAYMENT_AMOUNT_MISMATCH`, `VALIDATION_FAILED`), 07 `handover-exception` (`x-error-codes`: add
  `PAYMENT_ALREADY_RECORDED` (409), `PAYMENT_METHOD_NOT_ALLOWED`, `VALIDATION_FAILED`), 04 §4.4 (locks of the
  exception).
- DEC-PROPOSED-3: Automated rehearsal tooling — context: 17 H-10 describes a manual rehearsal; 16 PNT-102 asks for
  evidence — decision: `pnpm ops:rehearsal` (apps/api/rehearsal, never deployed) is the scripted operational part
  of H-10 (step 1) on a throwaway database with the real processes and the simulator: it plays every TC-036 scope
  item (the driver transfer included) and checks every TC-036 expected result (zero reconciliation with the cash
  against what the bots took, `close_summary` saved, every action with its actor); it does not replace the human
  rehearsal; its accelerated settings are `ready.uncollected_alert_min = 2` (schema minimum) with every other canon
  §12 default; supervisors sign in without MFA because the seed holds no TOTP secret for them — affected files: 17
  §3.3 / H-10, 05 (ops commands), CLAUDE.md §7 (command list).
- DEC-PROPOSED-4: What «حفظ الطلب» measures (15 §10, 05 §12.2, 17 H-08 M1) — context: the target says «from the
  webhook (or the API request) to the commit of the retrieval cycle»; a press during parking only stores
  `pending_retrieval_at` and its cycle opens later at parking; no stored timestamp marks a commit — decision:
  `point_retrieval_request_ingest_seconds` is the measure of the target (the worker observes it after the commit:
  `whatsapp_inbound_events.received_at` → the inbound transaction committed); `ingest_latency_ms` on the domain event
  is the same span up to the cycle's write inside that transaction, taken with the injected clock
  (`tx.clock.now()`) when the event is emitted — an explicit exception to 15 §13.3 («durations from the stored
  timestamps, not now()»), since the end point is not stored anywhere; both cover the presses that open a cycle only;
  early presses converted at parking and staff requests carry none (a staff request is measured by
  `point_http_request_duration_seconds` of `POST /v1/tickets/{ticketId}/retrievals`) — affected files: 11 §8
  `TicketRetrievalRequested` (add `ingest_latency_ms?: number` — ms from the webhook's `received_at` to the cycle's
  write, present only when a WhatsApp press opens the cycle), 15 §7 (`ticket_retrieval_requested`), 15 §10 targets
  table, 15 §13.3 (the exception), 05 §12.2, 17 H-08 (M1 read from the histogram).

## 7. Review responses

Two reviewers, 16 findings (two are the same point). Each was checked against the code and the spec first.

| # | Finding | Verdict | What was done |
|---|---|---|---|
| R1 | (major) the rehearsal claims TC-036 but never runs the driver transfer and never checks «close_summary محفوظ» nor «كل فعل بفاعله» | real | option (a): the transfer moment (§5), the `close_summary` check and both actor checks fail the run; the report states the TC-036 coverage and lists the human parts under Owner tasks (H-10 step 1 by people, steps 2–4 / TC-038, H-09 / TC-037, AC-12/AC-19 evidence, the 17 §16 classification); evidence regenerated |
| R2 | (major) the exception's gate answers VALIDATION_FAILED instead of PAYMENT_ALREADY_RECORDED for a collected ticket | real (reproduced: 422 `payment not_applicable`) | fixed (§4.4): `pay.check` for every money state; the S2 gate only without `check`; `collected_by` checked for due tickets. Tests: 409 with `payment_id`/`method`/`collected_by`, nothing changed, then the exception without a payment delivers; a waived ticket stays `not_applicable` |
| R3 | (minor) the cash half of «amounts match» is circular in G4 and the rehearsal | real (the amount handed over was read from the settlement; `difference_halalas` is generated) | fixed in both: a ledger of what each collector took from the scenario's / bots' own commands; settlement per collector compared before the handovers; each driver hands over his ledger amount; `expected` / `difference` / linked payments / sums checked against it |
| R4 | (minor) M1/M2 rows are not 17's M1/M2 | real | M1 = the worker's `point_retrieval_request_ingest_seconds` (after the commit; bucket bounds and mean; its count must equal the presses that opened a cycle); the event property is its own row («before the commit»); M2 = `task.claimed` at the other drivers' sockets, from the envelope's `occurred_at` — the realtime `task.claimed` payload has no `claimed_at` (only the domain event does), and the envelope's `occurred_at` is the accept transaction's `tx.now`, the very value written to `tasks.claimed_at`; the offer card latency is its own row, not a target. Found on the way: §4.6 |
| R5 | (minor) G4 says «every command left its audit row» without asserting it | real | asserted: every 2xx command with an Idempotency-Key has ≥ 1 `audit_log` row under its request id, every such row with `actor_id` = its caller; plus the tickets' created/parked/delivered by |
| R6 | (minor) the test claims 13 §8.4's audit order while the code wrote the opposite | real | the code now writes 13 §8.4's order (§4.5), consistent with manual-reconcile (13 §8.5 «كالبند 8.4»); asserted with `toEqual` and one request id |
| R7 | (minor) severities not on 17 §16's scale | real | §4 reclassified (4.1 → 1 with its regression test; 4.2, 4.4, 4.6 → 3; 4.3, 4.5 → 4); the rehearsal report's defect note uses the same scale |
| R8 / R13 | (minor, the same point twice) `ingest_latency_ms` is on `ticket.retrieval_requested` but not in 11's payload; DEC-PROPOSED-4 does not name 11; the value comes from the clock, not stored timestamps (15 §13.3) | real | DEC-PROPOSED-4 now names 11 §8 `TicketRetrievalRequested` (`ingest_latency_ms?: number`, only when a WhatsApp press opens the cycle), the 15 §13.3 exception and 17 H-08; docs/11 is left to the lead, as for DEC-PROPOSED-1…3 (proposals are applied when recorded) |
| R9 | (minor) the leak scan can fail at random (codes inside UUIDs) | real | codes matched as whole values (`(?<![0-9a-f])code(?![0-9a-f])`); phones, serials, key tags and spot/slot ids keep the substring scan |
| R10 | (minor) the CSP test change no longer merges | real | 5488370 and 04144be dropped when rebuilding the branch on the moved base (b0f881a is the cherry-pick of 5488370); this branch does not touch the file; §4.3 and the merge notes corrected |
| R11 | (minor) «Scripted moments» is the plan, not what happened | real | each moment's outcome read back from the database, rendered as a table, and a planned moment that did not happen fails the run; the racy ones made deterministic (§5) |
| R12 | (minor) PAYMENT_METHOD_NOT_ALLOWED on the exception untested | real | tested on EVT-R2 reduced to cash through `PATCH /v1/events/{eventId}` (13 §3 / §17.2 — the same check the reviewer's cash-only event would reach): 422 with `allowed_methods`, ticket and version unchanged, no payment, no incident, no code revoked. The 07 / 13 §16 edits stay with DEC-PROPOSED-2 |
| R14 | (minor) a failing run writes a full phone number into the report | real | failures and notes name a car by venue, index and display number (`carLabel`), never by phone, plate or code |
| R15 | (minor) an interrupted run leaks its database; the log folder is never removed | real | SIGINT / SIGTERM: stop the bots and processes, drop the rehearsal database and the invariants database (unless `REHEARSAL_KEEP_DB=1`), print the log folder, exit 130 / 143; the log folder is removed after a passing run, kept and printed after a failing one |
| R16 | (minor) the seed does not reproduce a run | real | one stream per actor (seed + the actor's key); the customers' choices (payment method, POS slip, wrong codes) drawn with the car plan; comment, report and §5 say what is and is not reproducible |

## 8. Tests and results

- After the review, on the branch rebuilt on e24c692 (under the lock, after the evidence run): `pnpm lint` (eslint,
  prettier, brand, secrets) and `pnpm typecheck` clean; `pnpm test` (unit + web-unit) 68 files, 1179/1179 passed;
  `pnpm test:int` (full, PostgreSQL 16.15) 71 files passed + 1 skipped, 610 passed + 1 skipped, 592 s.
- Before the review: lint and typecheck clean; `pnpm test` 68 files, 1178/1178; `pnpm test:int` 71 files + 1
  skipped, 608 passed + 1 skipped, 505 s.
- Targeted integration runs during the work: `g4-full-event` 14/14 (four runs, the last with the ingest assertion),
  `incident-writer` 5/5, `handover-exception-payment` 3/3, `wa-ingest-latency` 2/2; the suites around the changes —
  `wa-button`, `wa-inbound`, `dispatch-s4-early-request`, `tickets-parking`, `analytics-projector`,
  `g1-vertical-slice` — 43/43; the 10 suites that touch incidents 85/85.
- After the review: `handover-exception-payment` 5/5 (the two new regression cases fail on the previous use case:
  the audit order and `VALIDATION_FAILED` instead of `PAYMENT_ALREADY_RECORDED`); the payment and handover suites
  (`handover-codes`, `incident-writer`, `payments-collection`, `payments-waiver-reverse`, `payments-cash-settlement`,
  `manual-reconcile`, `alerts-incidents`) 65/65; `g4-full-event` 14/14 with the ledger, the actor checks and the
  whole-value code scan; `rehearsal-checks` 5/5 (unit, with the histogram helpers).
- Rehearsal, smaller runs while building it: 20 cars (passed, 182 s); 90 cars over 120 s (passed, 446 s — every
  scripted moment exercised). After the review: 24 cars over 60 s (passed, 188 s — the transfer, the ledger, both
  actor checks, `close_summary`, M1/M2); the same run interrupted by SIGINT after 30 s (both databases dropped, no
  process left, the log folder printed).
- Rehearsal, the evidence run after the review (`pnpm ops:rehearsal` with its defaults, under the lock, built
  first): **PASSED** in 594 s (577 s of play) → `docs/test-evidence/rehearsal/2026-10-29.md` (regenerated). 150 cars
  (RMS 80: 33 paper / 47 WhatsApp; LYL 70: 30 / 40), all delivered; all 13 scripted moments exercised and read back
  from the database — two early requests, the field cancel, the no-show → repark (W-08) → asked again, five wrong
  codes → locked → exceptional handover with the driver's cash, the opt-out and its resume, two VIP waivers, the POS
  reversal with replacement, DRV8 without network for 130 s with a car, DRV7 transferred LYL → RMS after LYL's last
  arrival (7 RMS cars served after it, his 16 LYL intakes kept in LYL), four breaks, the cash shortfall; 152 retrieve
  tasks, 71 reserved as next (W-03), 1 repark, 1 escalation (acknowledged), 3 reassignments by a supervisor; request
  → delivered p50/p95 RMS 41.7 / 66.1 s, LYL 53.4 / 76.9 s; RMS billable 1,600.00, collected 1,560.00 (= recorded
  payments), waived 40.00, due 0; the cash per collector equal to what the bots took (10 collectors, 1,060.00), 1,055.00
  handed over (−5.00 recorded, `payment_discrepancy` open for review); `close_summary` saved on both events (= the
  settlement after the close); every action with its actor: 150 tickets, 0 mismatches; 2,699 keyed commands on 36
  routes → 2,786 audit rows, 0 without a row, 0 in another name; 35 alerts raised, all resolved (both critical ones
  acknowledged first); 17 M1 p95 ≤ 250 ms (worker histogram, after the commit; n 87), 17 M2 p95 76 ms (n 1,126);
  9,382 bot requests, command p95 67 ms, 0 server errors, 0 unexpected refusals; 6,719 domain events → 6,719
  analytics rows; every 10 §14.1 / 11 §1.7 and consistency.sql check 0; the schema invariants passed.
- Open defects of this stream: 4.6 (level 3, recorded for the lead). The human rehearsal (owner) may still find some
  (17 §16).

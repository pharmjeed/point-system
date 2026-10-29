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
spot/slot allocation, no open task, round, cycle or live code, no code copy); the amounts (settlement collected =
recorded payments; Σ cash handovers = cash collected + the recorded difference; nothing due, nothing outstanding,
integrity ok; `close_summary.finance` = the settlement); the event closed; the transfer completed with the LYL
assignment; no failed/dead outbox row; the invariants — `INVARIANTS` (10 §14.1 / 11 §1.7), `infra/backup/consistency.sql`
and `runInvariants` (docs/06_schema_invariants_test.sql on a fresh database of the same migrations).

## 2. PNT-090 AC2 — every tracked server action in an end-to-end run

Last step of the same file: the run commits **all 71** domain event types of canon §7.1 (asserted), and each committed
domain event has exactly one `analytics_events` row (`properties.source_event_id`), named after its type (15 §4), with
keys inside its 15 §7 catalog entry, no 15 §3 denylisted key, `findPiiValues` empty, no Arabic text, and none of the
run's phones (E.164, local, digits), handover codes (read from W-05), key slot or spot ids, paper serials, key tags or
plates; `point_analytics_rejected_total{source="server"}` does not move during the run (nothing refused, no value
outside its list stored as null); every press that opened a cycle carries `ingest_latency_ms` (§4.2), staff and early
requests none.

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

## 4. Defects found and fixed

| # | Found by | Severity (17) | Defect | Fix |
|---|---|---|---|---|
| 4.1 | G4 (K14) | major | `POST /v1/tickets/{ticketId}/handover-exception` recorded every payment as collected by the supervisor (the body's `collected_by` was ignored), so the driver who took the cash did not owe it at the cash handover (13 §10); the 13 §5.2 checks (method, exact fee, POS reference) never ran on that path | the payment passes the handover's checks before any effect, is recorded with `source = exception` and `collected_by` from the body — the assignee or the approving supervisor, else `VALIDATION_FAILED payment.collected_by not_eligible` (DEC-210, as merged) — and the command holds the event FOR SHARE (L2) like TT-18 when money is involved. `apps/api/test/handover-exception-payment.int.test.ts` |
| 4.2 | rehearsal (report row «request saved» empty) | minor (observability; 15 §10 / 17 M1 unmeasurable in production) | `point_retrieval_request_ingest_seconds` (05 §12.2) was declared and never observed; `ingest_latency_ms` of `ticket_retrieval_requested` (15 §7) was always null — the projector reads it from the event and nobody put it there | the inbound processor passes the stored delivery's `received_at` with the message; the button's request puts `ingest_latency_ms` (webhook received → the cycle's transaction) on `ticket.retrieval_requested`; the worker observes the histogram after the commit. Staff requests and early presses converted at parking carry none. `apps/api/test/wa-ingest-latency.int.test.ts` + the G4 AC2 step |
| 4.3 | `pnpm test` on the base | minor (red unit suite) | 0ad3583 (DEC-192) changed the Caddyfile CSP without `apps/api/test/deploy-config.test.ts` | the file is byte-identical to wave4/load-chaos c6a93cb (same fix, merges cleanly) |

Merge note for the lead: `modules/whatsapp/application/inbound-processor.ts` — the line
`await this.message(channel, m, v.contacts, new Date(ev.received_at));` sits right above load-chaos's KP-2
`killPoint('inbound_after_cycle_commit')` lines: keep both. `package.json`: `ops:rehearsal` is listed after `audit:prod`
so it does not touch the `ops:restore-drill` line load-chaos appends to.

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
next tasks moved to a free driver on `idle_driver_while_next_waiting`, the POS reversal); closes the night; measures
from the database and the bots; writes `docs/test-evidence/rehearsal/<date>.md`; stops and drops everything. Exit 0 =
every check passed. Variables: `REHEARSAL_TICKETS` (150), `REHEARSAL_ARRIVAL_WINDOW_S` (240),
`REHEARSAL_DWELL_MIN_S`/`_MAX_S` (60/300), `REHEARSAL_SEED`, `REHEARSAL_DEADLINE_S`, `REHEARSAL_REPORT`,
`REHEARSAL_KEEP_DB=1`, `REHEARSAL_SKIP_BUILD=1`.

The checks that fail the run: the 10 §14.1 / 11 §1.7 invariants, `consistency.sql`, the schema invariants on a fresh
database, every closed-event check (no open custody, allocation, task, cycle, live code or code copy, no cash left,
nothing due), settlement collected = recorded payments, cash handed over = cash collected + recorded difference,
settlement integrity, no 5xx, one analytics row per domain event, no failed/dead outbox row, every car delivered
before the deadline.

The human rehearsal (H-10 with real staff and devices, the Meta test number, the paper outage drill TC-038 and the
restore TC-037 on staging) stays an owner task: PNT-102 remains `in_progress`.

## 6. Proposed decisions

- DEC-PROPOSED-1: One incident writer — context: three flows inserted incidents with their own SQL (S3 TT-19, S4
  TT-20, payments 13 §7.1/§10.2), 04 §4.2 item 7 names `IncidentService.open` — decision: `openIncident()` of the
  incidents module is the only writer; use-cases call it, modules below incidents use the core seam
  `openIncidentViaHook` registered by the incidents module at load; its options reproduce each flow's documented
  events. Follow-up proposal (not done, payloads kept identical as asked): align the TT-20 `incident.opened` payload
  on 11 §8.8 (`status: open`, then `incident.resolved`) and give TT-19 an explicit `auto_created` — affected files:
  04 §4.2 item 7, §4.3 (seam), 11 §8.8.
- DEC-PROPOSED-2: Exceptional handover with money (13 §8.4) — context: `collected_by` "defaults to the assignee and
  may be the supervisor himself"; the code ignored it and skipped the 13 §5.2 checks — decision: `collected_by` must
  be the open retrieve task's assignee or the approving supervisor (`VALIDATION_FAILED payment.collected_by
  not_eligible` otherwise, DEC-210); the 13 §5.2 checks run before any effect (`PAYMENT_METHOD_NOT_ALLOWED`,
  `PAYMENT_AMOUNT_MISMATCH`, `VALIDATION_FAILED payment.pos_reference …`); `source = exception`; L2 event FOR SHARE
  between L1 and L4 when the ticket is due or a payment is sent — affected files: 13 §8.4 and §16 (the endpoint's
  errors: add `PAYMENT_METHOD_NOT_ALLOWED`, `PAYMENT_AMOUNT_MISMATCH`, `VALIDATION_FAILED`), 07 `handover-exception`
  (`x-error-codes` and the 422 list: add `PAYMENT_METHOD_NOT_ALLOWED`), 04 §4.4 (locks of the exception).
- DEC-PROPOSED-3: Automated rehearsal tooling — context: 17 H-10 describes a manual rehearsal; 16 PNT-102 asks for
  evidence — decision: `pnpm ops:rehearsal` (apps/api/rehearsal, never deployed) is the scripted operational part
  of H-10 on a throwaway database with the real processes and the simulator; it does not replace the human
  rehearsal; its accelerated settings are `ready.uncollected_alert_min = 2` (schema minimum) with every other canon
  §12 default; supervisors sign in without MFA because the seed holds no TOTP secret for them — affected files: 17
  §3.3 / H-10, 05 (ops commands), CLAUDE.md §7 (command list).
- DEC-PROPOSED-4: What «حفظ الطلب» measures (15 §10, 05 §12.2) — context: the target says «from the webhook (or the
  API request) to the commit of the retrieval cycle»; a press during parking only stores `pending_retrieval_at` and
  its cycle opens later at parking — decision: `ingest_latency_ms` and `point_retrieval_request_ingest_seconds` cover
  the presses that open a cycle (webhook stored by the api → the cycle's transaction; the histogram after the
  commit); early presses and staff requests carry none (a staff request is measured by
  `point_http_request_duration_seconds` of `POST /v1/tickets/{ticketId}/retrievals`) — affected files: 15 §7
  (`ticket_retrieval_requested`), 15 §10 targets table, 05 §12.2.

## 7. Tests and results

- `pnpm lint` (eslint, prettier, brand, secrets) and `pnpm typecheck`: clean.
- `pnpm test` (unit + web-unit, under the lock): 68 files, 1178/1178 passed (with `rehearsal-checks` 4/4 and the
  DEC-192 CSP test).
- `pnpm test:int` (full, under the lock, PostgreSQL 16.15): 71 files passed + 1 skipped, 608 passed + 1 skipped,
  505 s.
- Targeted integration runs during the work: `g4-full-event` 14/14 (four runs, the last with the ingest assertion),
  `incident-writer` 5/5, `handover-exception-payment` 3/3, `wa-ingest-latency` 2/2; the suites around the changes —
  `wa-button`, `wa-inbound`, `dispatch-s4-early-request`, `tickets-parking`, `analytics-projector`,
  `g1-vertical-slice` — 43/43; the 10 suites that touch incidents 85/85.
- Rehearsal, smaller runs while building it: 20 cars (passed, 182 s); 90 cars over 120 s (passed, 446 s — every
  scripted moment exercised).
- Rehearsal, the evidence run (`pnpm ops:rehearsal` with its defaults, under the lock, built first):
  **PASSED** in 630 s (616 s of play) → `docs/test-evidence/rehearsal/2026-10-29.md`. 150 cars (RMS 80: 36 paper /
  44 WhatsApp; LYL 70: 30 / 40), all delivered; 152 retrieve tasks, 87 reserved as next (W-03), 1 repark, 0
  escalations; request → delivered p50/p95 RMS 68.5 / 90.7 s, LYL 42.9 / 79.4 s; RMS billable 1,600.00, collected
  1,560.00 (= recorded payments), waived 40.00, due 0; cash 940.00 collected, 935.00 handed over (−5.00 recorded,
  `payment_discrepancy` open for review); 21 alerts raised, all resolved (the critical one acknowledged first);
  offer delivery p95 103 ms (M2 < 3 s), request saved p95 113 ms (M1 < 2 s); 10,321 bot requests, command p95 56 ms,
  0 server errors, 0 unexpected refusals; 6,630 domain events → 6,630 analytics rows; every 10 §14.1 / 11 §1.7 and
  consistency.sql check 0; the schema invariants passed. Scripted moments: field cancel, early requests, no-show →
  repark (W-08) → asked again, five wrong codes → locked → exceptional handover with the driver's cash, opt-out and
  resume, two VIP waivers, POS reversal with replacement, a driver without network for 130 s with a car, four
  breaks, a next task moved by the supervisor, the cash shortfall.
- Open defects: none of this stream's. The human rehearsal (owner) may still find some (17 severity).

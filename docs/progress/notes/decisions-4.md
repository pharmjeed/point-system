# decisions-4 — decisions batch 4 (DEC-192 … DEC-364) and the document fixes

Wave 4 stream: the wave-3 proposals recorded in `docs/DECISIONS.md` with the affected documents fixed in the same
change (CLAUDE.md §2). Next free number: **DEC-365** (CLAUDE.md). The review round (below) corrected rows of this
batch in place and added no new number.

## Number mapping

| Notes file | Proposals | Decisions |
|---|---|---|
| `ops-security.md` | DEC-PROPOSED-8 (CSP, decided by the lead: option b) | DEC-192 |
| `s3-customer-flows.md` | DEC-PROPOSED-18 … 37 | DEC-193 … 212 (the 08 `WA_NOT_LINKED` vs 07 `INVALID_STATE_TRANSITION` item: 07 wins, 08 aligned — DEC-198) |
| `s4-dispatch.md` | DEC-PROPOSED-1 … 21 | DEC-213 … 233 |
| `s6-supervisor.md` | DEC-PROPOSED-1 … 22 | DEC-234 … 255 (+ the DEC-187 clarification) |
| `notifications-staff.md` | DEC-PROPOSED-1 … 19 | DEC-256 … 274 |
| `payments-reports.md` | DEC-PROPOSED-1 … 18 | DEC-275 … 292 (18 recorded in corrected form: PNT-096 added the `export` rate-limit class) |
| `ops-security.md` | DEC-PROPOSED-1 … 7, 9 … 16 | DEC-293 … 299, DEC-300 … 307 |
| `web-supervisor.md` | DEC-PROPOSED-1 … 27 | DEC-308 … 334 |
| `pnt-023.md` | A–F, H–J, L | DEC-335 … 344 (A 335, B 336, C 337, D 338, E 339, F 340, H 341, I 342, J 343, L 344); G recorded in review as part of DEC-351; K not recorded |
| `pnt-035.md` | A–N | DEC-345 … 358 |
| `pnt-036.md` | A–E | DEC-359 … 363 |
| scope item 3 (drift guard, outbox diagram) | — | DEC-364; 11 §6.12 diagram (failed/dead retryable) |

## Not recorded (contradictions)

- pnt-023 **K** (range labels «at least 2 digits with a prefix») contradicts DEC-114 (the width of `to`, as the seed).
- pnt-023 **J**'s clause «pricing is locked after the first ticket» contradicts DEC-109; J recorded without it (DEC-343).
- payments-reports DEC-PROPOSED-18's «no export rate limit» is outdated by PNT-096 (DEC-292 records the `export`
  class).
- pnt-023 **G** was first left out as contradicting DEC-80; the review showed its first remedy (a context text set by
  08) is compatible, so it is now part of DEC-351 (02 §1.9, 08 §4.8).

## API gaps (decisions that wait for a server field or route)

`alerts.*` in `GET /v1/me` (DEC-311) · `GET /v1/venues/{venueId}/operations` (DEC-314) · `TaskCard.ready_at`
(DEC-315, DEC-348) · `DriverLive.custody_count` (DEC-317) · `TicketDetail.allowed_payment_methods` (DEC-326) ·
per-driver average retrieval in `DriverReportRow` and cash handovers in `PaymentsReport` (DEC-331) · a severity
filter on `GET /v1/incidents` and an incident history (DEC-332) · `WhatsAppChannel.last_webhook_at` (DEC-333) ·
the device column of S-05 (audio test, notifications) in `DriverListItem` (DEC-342) · `Me.session.device_id`
(DEC-345) · `DriverHome.settings` (DEC-346) · `DriverHome.shift` (DEC-347).

## Review responses

Two reviewers, one round. Every finding was real; all are fixed. Code fixes went with tests (and the
decision text says what the code does now).

| # | Finding | Response |
|---|---|---|
| 1 | critical — `handover-exception` claimed the handover's payment gate but skipped the 13 §5.2 checks, ignored `collected_by` and put the cash on the supervisor | Fixed in code: the InlinePaymentHook `check` runs before the code is revoked (no effect), L2 FOR SHARE when money is due or sent, `collected_by` must be the assignee or the approving supervisor (`payment.collected_by` `not_eligible`), the payment is recorded with that collector, `source: exception`, the exception's operation and request id; PAYMENT_ALREADY_RECORDED on a collected ticket. PAY-TC-22 + refusals in `payments-collection.int.test.ts`. DEC-210, 07/OpenAPI, 08, 11 TT-19, 13 §8.4/§16. |
| 2, 14 | major — DEC-350 keys reach the customer's W-01 `{{3}}` (and the CSV) in English | Fixed in code: `VEHICLE_MAKE_LABELS_AR` / `VEHICLE_COLOR_LABELS_AR` in `@point/shared` (tested against 02 §8.4), used by `vehicleSummary` and the tickets export; typed text passes through. Unit + sender + export tests. DEC-350, 12 §5, 14 §4, 02 D-05. |
| 3 | major — S-02 ignored `QueueItem.badges` / `TaskCard.badges` and `offer.recipient` | Fixed in the web: `queueStateText` names `offer.recipient`, `queueBadges` / `notCollected` / `taskWaitsLong` take the server badges first; the board e2e mock now has the server shape. DEC-315/316 and 02 S-02 hold as written. |
| 4 | minor — reset-secret ran on one press although DEC-344 requires a confirmation | Fixed in the web: confirmation `Dialog` (text in 02 S-06), cancel sends nothing; e2e in `setup.spec.ts`. |
| 5, 13 | minor/major — DEC-240/DEC-284 named `openIncident()` as the writer of system incidents; nobody calls it, and payments-reports may not import incidents (04 §4.3) | Docs: DEC-240 and DEC-284 reworded to the real writers (TT-19 in its use-case, TT-20 via `IncidentRecorder` — agreeing with DEC-222 —, the payment discrepancies by payments-reports); `openIncident()` is the writer of `POST /v1/incidents` and a later unification seam. 04 §4.2 (7), 11 §6.11, 13 §10.1 and the function's comment. The TT-19 incident events now carry `auto_created: true` like the other producers. |
| 6, 22 | minor — DEC-364 said extra objects are «reported» and cited the `point_retention` role | Docs: the guard prints only what is missing; extras are allowed and not printed; roles and grants are outside the snapshot (DEC-364, 05 §11.1, 06 ERD §9.3). Printing extras was not worth a code change. |
| 7 | minor — manual reconcile: PAYMENT_ALREADY_RECORDED without details, `payment.recorded` without `cycle_id` | Fixed in code (`alreadyRecorded()`, `cycle_id` of the closed cycle) with tests. |
| 8, 17 | minor — S-10 example showed held cash as a discrepancy | Docs: the example's discrepancy is now a non-zero handover difference with its incident; held cash stays the «تحصيل غير مسلّم» blocker (02 S-10, DEC-330). |
| 9 | minor — `safety_note_ar` example vs the server text | Fixed in code: `SAFETY_NOTE_AR` is the 02 D-09 text; the S4 offers test asserts it (DEC-361). |
| 10 | minor — RESOURCE_NOT_FOUND missing from transferCustody / manualReconcile | Docs: x-error-codes, 404 descriptions, 07 §2.3 errors and the 08 row. |
| 11, 19 | minor — the DEC-187 clarification promised `task.key_picked_up` when the transfer moves the accepted retrieval | Fixed in code: the move branch emits `task.key_picked_up` when it sets the pickup for the first time; test in `supervisor-actions.int.test.ts`. DEC-187, DEC-251, 11 TT-16 / §2.4 / §8, 07 + OpenAPI name both cases. |
| 12 | major — DEC-229 gave force-end items `task_type` / `task_status` | Docs: force-end and transfer items are `{type, ticket_id, display_number, task_id?}`; only CUSTODY_OPEN of the disable paths carries `task_type` / `task_status`; 08 §4.8 CUSTODY_OPEN details per route; DEC-229's affected column fixed. |
| 15 | major — 11 §2.4 rows of the direct link and the confirm | Docs: rewritten from DEC-193/194 and DEC-198…200 (allowed states, refusal reasons, conditional `link_version + 1`). |
| 16 | major — the payments report counted the day after S-11's half-open period | Fixed in code: an event belongs to the period when its Riyadh day overlaps `[from, to)` (payments report and the `event_summary` export); tests. DEC-288, DEC-331, 07 + OpenAPI, 13 §13, 02 S-11. |
| 18 | minor — 11 push / alert-resolution cells not aligned with DEC-257/258/264 and DEC-226/236 | Docs: 11 §8 cells copied from 14; `handover_code_locked` resolution adds repark, the cancel after the start and the reconcile (11 §6.10, 14 §8). |
| 20 | minor — DEC-328 offered a parked vehicle to drivers | Fixed in the web: `custodyTransferHolders` offers a parked vehicle only a free spot (unit test); DEC-328 and 02 S-03 amended. |
| 21 | minor — pnt-023 G dropped although its first remedy fits DEC-80 | Docs: recorded in DEC-351 — 08 sets the context text of the S-09 disable routes, the one exception to showing `message_ar` (02 §1.9, 08 §4.8). |

Numbers follow the order of the review list (1–11 the first reviewer, 12–22 the second, which repeats five
findings: 2 = 14, 5 = 13, 6 = 22, 8 = 17, 11 = 19).

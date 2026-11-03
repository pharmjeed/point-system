# int-server — server side of the wave-6 integration findings

Stream: `wave6/int-server`. Scope: `packages/server`, `apps/api`, `apps/worker`, `packages/shared`, 07 + `07_openapi.yaml`.
The web stream owns `apps/web` (only `apps/web/src/api/types.ts` is touched here, for wire types).

## Fixes

| Finding | Fix | Test |
|---|---|---|
| contract:F1 | `GET /v1/me/home` returns `shift {id, status, opened_at}` (DEC-347) and `settings` (DEC-346: `inspection.required_photos`, `inspection.max_extra_photos`, `parking.mode`, `keys.require_slot`, `dispatch.single_offer_ttl_s`, canon §12 defaults completed); `findOpenShiftForPool` also selects `status, opened_at`. 07 §GET /v1/me/home and `DriverHome` in `07_openapi.yaml` document both. | `apps/api/test/tickets-reads.int.test.ts` «the venue rules a driver screen needs (DEC-346) …» |
| contract:F2, decisions:F2 | `loadTaskCard` fills `claim_code` with `loadClaimCodeState` (the TicketDetail projection, DEC-208: state only, never the code, DEC-38) for a retrieve task seen by the assignee or staff; null for park/repark and paper tickets. It also returns `ready_at` (`retrieval_cycles.ready_at`, the gap DEC-348 records), so D-04's «منذ» stays right after a resend (which moves `claim_code.issued_at`). 07 §3.4 (example + rule), `TaskCard` in `07_openapi.yaml`, `TaskCard.ready_at` in `apps/web/src/api/types.ts`. All `loadTaskCard` paths get it: `/ready`, `/key-pickup`, `/start` replies, `GET /v1/me/home`, the realtime `task.updated`, the operations board, `promoted_next_task`. | `apps/api/test/handover-codes.int.test.ts` «ready issues the code …» (the `/ready` reply and `home.current_task` carry the state with the same keys as TicketDetail, and `ready_at`; the code appears in none of them) |
| realtime:RT-3 | `job.link_code_expire` publishes `ticket.updated` with the canon §7.2 job as its cause (`job.link_code_expire`, the DEC-269 precedent) instead of the non-canon `wa.link_code_expired`, so the frame passes `RealtimeCauseSchema` and the web no longer resyncs on every expired QR code (closes driver-gaps.md «A non-canon cause»). | `apps/api/test/wa-linking.int.test.ts` «an active code nobody answered …» (frames parse with `realtimeEnvelopeSchema` + `REALTIME_PAYLOAD_SCHEMAS`) |
| realtime:RT-6 | `RealtimeServer.allowHandshake` (the Engine.IO `allowRequest`): a request with an Origin must match `APP_BASE_URL` as before; one without Origin (the browser's same-origin polling GET) is taken only with `Sec-Fetch-Site: same-origin`; a new WebSocket connection without Origin is refused. The session is not checked in `allowRequest` (review:2/6): the `io.use` middleware validates it on the same handshake and answers the canon connect_error code (AUTH_* / SERVICE_UNAVAILABLE, DEC-370). The upgrade of an established polling session is bound to its `sid` (engine.io never calls `allowRequest` for it, review:7). 07 §4.1 and 09 §7 rule 2 amended. Browsers without Fetch Metadata (Safari < 16.4) still cannot use the polling fallback. | `apps/api/test/realtime.int.test.ts` «long-polling handshake without Origin» (200 same-origin + session and a polling socket connects; 403 cross-site / same-site / no metadata / mismatching Origin; no, forged or revoked session → connect_error AUTH_UNAUTHENTICATED / AUTH_SESSION_REVOKED; WebSocket without Origin refused) |
| decisions:F6 (server half) | Following the brief («prefer making the client read the ticket state»), the DEC-265 coalescing rule is unchanged; instead `TicketSummary` carries `pending_retrieval_at` (DEC-13; it was already in both TicketDetail projections, so no field becomes visible to anyone new), served by `ticketSummary()` and so by every `ticket.updated`, list and board — only while set (review:8: an installed bundle built before the field rejects a strict-schema frame that carries it; TicketDetail always carries it). The shared `TicketSummarySchema`, `07_openapi.yaml` TicketSummary, the 07 §4.3 `ticket.updated` row and `apps/web/src/api/types.ts` have it. | `apps/api/test/wa-button.int.test.ts` «decisions:F6: «إيقاف» then a press during parking …» (the parking driver's only update of the press has cause `ticket.wa_link_changed` and carries `pending_retrieval_at`; the frame parses with the shared schema) |
| realtime:RT-2 (server half) | A command that changes what the assignee's TaskCard shows without a task event bumps `tasks.version` (`bumpTaskCardVersion`) and the dispatch planner republishes the TaskCard to the assignee and the `Task` to the supervisors with the command's cause: an official custody transfer of the key into/out of a slot or of the vehicle into/out of a spot while the task stays with its driver (`custodyTouchesTaskCard`; not bumped again when a key pickup / reset or a reassignment already bumped it), also an official key transfer from/to a driver, which covers the pickup reset of the key leaving the assignee for a supervisor or `unknown` (bumped in the transfer without a task event; review:1/4, the planner used to miss it), a fee waiver, and a reversal without replacement (payment `due` again). `waive` and `reverse` now lock the ticket's open assigned task (L4, before L5) and, under L5, re-read it: a task assigned in between restarts the transaction (`TxRestartError`, 40001, review:5). 13 §6/§7.1 and 11 §2.4/§8.6/§8.7/§9.2 amended (review:3/9). Because the version is newer, the web's existing version gate (`engine.ts` 07 §4.5, `applyTaskCard`) applies it with no client change, and a command sent with the old task `expected_version` is VERSION_CONFLICT. 07 §4.3 `task.updated` row documents it. | `apps/api/test/task-card-realtime.int.test.ts` (slot → slot: card v+1 with the new slot, supervisors' Task v+1, home agrees, pickup at the old slot CUSTODY_HOLDER_MISMATCH and at the new one OK; spot → spot; key picked up then handed to SUP-R → card v+1 with `key_picked_up_at: null`; supervisor → unknown → no card; waiver → `payment_due: null`; an accept committed while the waiver waited on L5 → the waiver's card is v+2; reversal → `payment_due` back) |

## Checks (at cbb9881)

`pnpm lint` clean · `pnpm typecheck` clean · `pnpm test` 92 files / 1423 tests green · `pnpm test:int` (PostgreSQL 16,
under the heavy lock) 85 files passed + 1 skipped / 679 tests passed + 1 skipped. No e2e run: no `apps/web` behaviour
changed here (only optional fields in `apps/web/src/api/types.ts`).

After the review fixes (405ae6f + this notes commit): `pnpm lint` clean · `pnpm typecheck` clean · `pnpm test` 92
files / 1424 tests green · `pnpm test:int` (PostgreSQL 16, under the heavy lock) 85 files passed + 1 skipped / 684
tests passed + 1 skipped. No e2e run (no `apps/web` change); `pnpm ops:load` not re-run (review:10 only removes queries).

## For the web stream

- `TaskCard.ready_at` is now served: `fieldModel.ts` (D-04) can read `card.ready_at ?? card.claim_code?.issued_at ??
  card.requested_at` and `RetrievalPage.tsx` (D-10 «جاهزة» step) `card.ready_at ?? card.claim_code?.issued_at`. The
  e2e fake (`routesDriver.ts`) does not send `ready_at` yet; add it when the web reads it.
- realtime:RT-2: the server now republishes a newer TaskCard (see above), so the client-only refresh the finding
  proposed is optional; the pages' fallbacks (`>=` on the ticket version) remain a belt-and-braces choice.
- decisions:F6, client half: in `driverRuntime.ts` `ticket.updated`, show the 14 §5.1 notice + `reminder` when the
  summary of the parking card's ticket has `pending_retrieval_at` set and the driver has not been told of that value
  yet (e.g. a set keyed by ticket id + `pending_retrieval_at`), instead of requiring
  `cause === 'ticket.retrieval_requested_early'`. A coalesced press after «إيقاف» arrives with cause
  `ticket.wa_link_changed`. The e2e fake's TicketSummary should then carry `pending_retrieval_at` too.

- review:8: parse the four notification payloads (`ticket.updated`, `sync.required`, `channel.status`,
  `incident.updated`) in `apps/web/src/realtime/protocol.ts` with `REALTIME_CLIENT_PAYLOAD_SCHEMAS` instead of the
  strict `*PayloadSchema` (exported by `@point/shared`), so a later additive field never makes an installed bundle
  resync on every frame. Until then `TicketSummary` omits `pending_retrieval_at` while it is null.
- review:2/6: a same-origin polling handshake with a bad session now ends in connect_error with the AUTH_* code, so
  `engine.ts`'s existing `checkSession` path (D-15 ج / S-01) runs on the polling transport too; no client change.

## Proposed decisions (the lead numbers them)

- **DEC-PROPOSED-1** (contract:F1): add `07 (§GET /v1/me/home, DriverHome)` to the affected-files column of DEC-346 and
  DEC-347; both fields are now served by the API (no longer an API gap).
- **DEC-PROPOSED-2** (contract:F2, decisions:F2): `TaskCard.ready_at` (DEC-348's API gap) is adopted and served;
  `TaskCard.claim_code` is the ClaimCodeState of the cycle's current code for a retrieve task (assignee and staff),
  the same projection as TicketDetail (DEC-208), null for park/repark tasks and paper tickets. DEC-348 can drop
  «فجوة في الـAPI»; affected files 07 §3.4, `07_openapi.yaml` TaskCard.
- **DEC-PROPOSED-3** (realtime:RT-6): a new Engine.IO session on `/ws` is accepted without `Origin` only with
  `Sec-Fetch-Site: same-origin` (the same-origin long-polling GET, where browsers omit Origin); any Origin must match
  `APP_BASE_URL`; a new WebSocket connection always needs the matching Origin; the upgrade of an established polling
  session is bound to its `sid`. The session is validated by the Socket.IO middleware on every handshake, so a bad
  session gets the canon connect_error code on both transports (DEC-370). Affected: 07 §4.1, 09 §7 rule 2 (both
  amended here).
- **DEC-PROPOSED-4** (decisions:F6): `TicketSummary.pending_retrieval_at` (DEC-13) is part of the minimal projection;
  clients read the early request from it, not from the coalesced `cause` (DEC-265 stays: cause = the first
  `ticket.*` event). TicketSummary sends it only while set (absent = no early request) so bundles built before the
  field keep parsing; clients parse server frames with `REALTIME_CLIENT_PAYLOAD_SCHEMAS` (unknown top-level keys
  dropped) and the strict schemas stay the server's contract. Affected: 07 TicketSummary + §4.3 `ticket.updated` (done here); 14 §3 intro and 14 §5.1 «طلب
  مبكر أثناء الصف» could name the state as the trigger (not edited here, outside this stream's scope).
- **DEC-PROPOSED-5** (realtime:RT-2): the TaskCard is versioned by `tasks.version`; a command that changes the
  assignee's card without a task event (official custody transfer into/out of a spot or key slot that leaves the task
  with its driver, `payment.waived`, `payment.reversed` without replacement) increments `tasks.version` and republishes
  `task.updated` (TaskCard to the assignee, Task to the supervisors) with that cause. Affected: 07 §4.3,
  11 §2.4 (custody-transfers row), §8.6, §8.7, §9.2, 13 §6 and §7.1 (locks L2 FOR SHARE → L4 open assigned task →
  L5 (→ L9); an assignment between the unlocked read and L5 restarts the transaction), all amended here.

## Review responses

| Finding | Verdict | Response |
|---|---|---|
| review:1, review:4 (key leaves the assignee for a supervisor / unknown: no TaskCard) | real | Reproduced (no `task.updated` to DRV1, card stuck at the old version). The planner's `custody.changed` branch now also plans the assignee card for an official key transfer with a driver on either side; `resolveAssigneeCards` drops a card the transaction already plans, and a card that did not change is the same version and ignored by the client. The earlier note («already bumped and published») is corrected in the RT-2 row. Test: `task-card-realtime.int.test.ts` «the picked-up key handed to a supervisor …» (fails without the fix) and «a key moved between two supervisors … no TaskCard». |
| review:2, review:6 (session checked in `allowRequest`: bare 403 instead of AUTH_* / SERVICE_UNAVAILABLE) | real | `allowHandshake` keeps only the Origin / `Sec-Fetch-Site: same-origin` / no-Origin-WebSocket rules and no longer requires or loads the session; `io.use` validates it on the same handshake, so a socket still connects only with a valid session and the polling path gets the canon codes. The cookie-presence check proposed in review:2 is not kept either: an expired cookie the browser already dropped would otherwise get a bare 403 and never reach D-15 ج. Test: `realtime.int.test.ts` «a same-origin polling handshake with no, a forged or a revoked session gets the canon connect_error code». |
| review:7 (upgrade of a polling session is not Origin-checked) | real (docs) | Confirmed in engine.io's `verify` (a request with `sid` skips `allowRequest`). The `sid` comes from a same-origin response that a cross-site page cannot read (CORS restricted to `APP_BASE_URL`), so the upgrade is bound to the session the same-origin page opened; 07 §4.1, 09 §7 rule 2 and the docstring now say «a new WebSocket connection» needs the matching Origin and the upgrade is bound to its `sid`. No engine hook added. |
| review:3, review:9 (13 / 11 not amended; stale lock comments) | real | 13 §6 and §7.1 give the L2 FOR SHARE → L4 open assigned task → L5 (→ L9) order, the `tasks.version` bump and the `task.updated` with cause `payment.waived` / `payment.reversed` (and the restart); 11 §2.4 (custody-transfers row), §8.6 `custody.changed`, §8.7 `payment.*` and §9.2 `task.updated` name the republish; the `waive` / `reverse` docstrings give the new order and `openRetrieveTaskId` has its comment back. DECISIONS.md is the lead's (DEC-PROPOSED-5 lists the affected files). |
| review:5 (an accept between the unlocked read and L5 is never bumped) | real | Under L5 (every assignment holds the ticket lock: accept, promotion, reassignment, custody transfer) the open assigned task is re-read; if it is not the L4 one the attempt throws `TxRestartError` (SQLSTATE 40001, `core/db/locks.ts`), which `Database.transaction` retries (canon §14ب, 3 attempts; then SERVICE_UNAVAILABLE, retryable) and the next attempt locks it at L4. Test: `task-card-realtime.int.test.ts` «a retrieval accepted between the unlocked task read and the ticket lock …» (a second connection holds L5, the waiver waits on it, the task is accepted, then the waiver's card is v+2; fails without the fix with v+1). |
| review:8 (`pending_retrieval_at` in a strict schema breaks installed bundles) | real | `ticketSummary()` sends the optional key only while an early request is pending, so frames without one still parse with the pre-change strict schema (asserted in `realtime-notifications.int.test.ts` «intake»); an old bundle resyncs once on an early-request frame, and the sync then reads the same state. `@point/shared` exports `REALTIME_CLIENT_PAYLOAD_SCHEMAS` (unknown top-level keys dropped) for the web stream to adopt (above); the strict schemas stay the server contract (`packages/shared/test/push-realtime.test.ts`). No forced PWA update is added (web scope). |
| review:10 (three extra queries per retrieve card on the board) | real, partly | A code exists only from `ready` (TT-17; a resend needs `ready`), so `loadTaskCard` skips the lookup when the cycle has no `ready_at` (every accepted / started retrieval); the operations board passes `handover.max_resends` from the settings it already holds, so a ready card costs two queries (the code row, its W-05 status), not three. Batching per board page is not done: ready cards are a small share of a board. `pnpm ops:load` (k6, 50 drivers) was not re-run in this stream; the change only removes queries. Test: `handover-codes.int.test.ts` «review:10: the TaskCard skips the code lookup …». |

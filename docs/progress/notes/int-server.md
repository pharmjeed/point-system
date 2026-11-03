# int-server — server side of the wave-6 integration findings

Stream: `wave6/int-server`. Scope: `packages/server`, `apps/api`, `apps/worker`, `packages/shared`, 07 + `07_openapi.yaml`.
The web stream owns `apps/web` (only `apps/web/src/api/types.ts` is touched here, for wire types).

## Fixes

| Finding | Fix | Test |
|---|---|---|
| contract:F1 | `GET /v1/me/home` returns `shift {id, status, opened_at}` (DEC-347) and `settings` (DEC-346: `inspection.required_photos`, `inspection.max_extra_photos`, `parking.mode`, `keys.require_slot`, `dispatch.single_offer_ttl_s`, canon §12 defaults completed); `findOpenShiftForPool` also selects `status, opened_at`. 07 §GET /v1/me/home and `DriverHome` in `07_openapi.yaml` document both. | `apps/api/test/tickets-reads.int.test.ts` «the venue rules a driver screen needs (DEC-346) …» |
| contract:F2, decisions:F2 | `loadTaskCard` fills `claim_code` with `loadClaimCodeState` (the TicketDetail projection, DEC-208: state only, never the code, DEC-38) for a retrieve task seen by the assignee or staff; null for park/repark and paper tickets. It also returns `ready_at` (`retrieval_cycles.ready_at`, the gap DEC-348 records), so D-04's «منذ» stays right after a resend (which moves `claim_code.issued_at`). 07 §3.4 (example + rule), `TaskCard` in `07_openapi.yaml`, `TaskCard.ready_at` in `apps/web/src/api/types.ts`. All `loadTaskCard` paths get it: `/ready`, `/key-pickup`, `/start` replies, `GET /v1/me/home`, the realtime `task.updated`, the operations board, `promoted_next_task`. | `apps/api/test/handover-codes.int.test.ts` «ready issues the code …» (the `/ready` reply and `home.current_task` carry the state with the same keys as TicketDetail, and `ready_at`; the code appears in none of them) |
| realtime:RT-3 | `job.link_code_expire` publishes `ticket.updated` with the canon §7.2 job as its cause (`job.link_code_expire`, the DEC-269 precedent) instead of the non-canon `wa.link_code_expired`, so the frame passes `RealtimeCauseSchema` and the web no longer resyncs on every expired QR code (closes driver-gaps.md «A non-canon cause»). | `apps/api/test/wa-linking.int.test.ts` «an active code nobody answered …» (frames parse with `realtimeEnvelopeSchema` + `REALTIME_PAYLOAD_SCHEMAS`) |
| realtime:RT-6 | `RealtimeServer.allowHandshake` (the Engine.IO `allowRequest`): a request with an Origin must match `APP_BASE_URL` as before; one without Origin (the browser's same-origin polling GET) is taken only with `Sec-Fetch-Site: same-origin` and a valid session cookie (`loadActor`); a WebSocket upgrade without Origin is refused. 07 §4.1 and 09 §7 rule 2 amended. Browsers without Fetch Metadata (Safari < 16.4) still cannot use the polling fallback. | `apps/api/test/realtime.int.test.ts` «long-polling handshake without Origin» (200 same-origin + session; 403 cross-site / same-site / no metadata / no or forged session / mismatching Origin; WebSocket without Origin refused) |
| decisions:F6 (server half) | Following the brief («prefer making the client read the ticket state»), the DEC-265 coalescing rule is unchanged; instead `TicketSummary` carries `pending_retrieval_at` (DEC-13; it was already in both TicketDetail projections, so no field becomes visible to anyone new), served by `ticketSummary()` and so by every `ticket.updated`, list and board. The shared `TicketSummarySchema`, `07_openapi.yaml` TicketSummary, the 07 §4.3 `ticket.updated` row and `apps/web/src/api/types.ts` have it. | `apps/api/test/wa-button.int.test.ts` «decisions:F6: «إيقاف» then a press during parking …» (the parking driver's only update of the press has cause `ticket.wa_link_changed` and carries `pending_retrieval_at`; the frame parses with the shared schema) |

## For the web stream

- `TaskCard.ready_at` is now served: `fieldModel.ts` (D-04) can read `card.ready_at ?? card.claim_code?.issued_at ??
  card.requested_at` and `RetrievalPage.tsx` (D-10 «جاهزة» step) `card.ready_at ?? card.claim_code?.issued_at`. The
  e2e fake (`routesDriver.ts`) does not send `ready_at` yet; add it when the web reads it.
- decisions:F6, client half: in `driverRuntime.ts` `ticket.updated`, show the 14 §5.1 notice + `reminder` when the
  summary of the parking card's ticket has `pending_retrieval_at` set and the driver has not been told of that value
  yet (e.g. a set keyed by ticket id + `pending_retrieval_at`), instead of requiring
  `cause === 'ticket.retrieval_requested_early'`. A coalesced press after «إيقاف» arrives with cause
  `ticket.wa_link_changed`. The e2e fake's TicketSummary should then carry `pending_retrieval_at` too.

## Proposed decisions (the lead numbers them)

- **DEC-PROPOSED-1** (contract:F1): add `07 (§GET /v1/me/home, DriverHome)` to the affected-files column of DEC-346 and
  DEC-347; both fields are now served by the API (no longer an API gap).
- **DEC-PROPOSED-2** (contract:F2, decisions:F2): `TaskCard.ready_at` (DEC-348's API gap) is adopted and served;
  `TaskCard.claim_code` is the ClaimCodeState of the cycle's current code for a retrieve task (assignee and staff),
  the same projection as TicketDetail (DEC-208), null for park/repark tasks and paper tickets. DEC-348 can drop
  «فجوة في الـAPI»; affected files 07 §3.4, `07_openapi.yaml` TaskCard.
- **DEC-PROPOSED-3** (realtime:RT-6): the `/ws` handshake accepts a request without `Origin` only with
  `Sec-Fetch-Site: same-origin` and a valid session cookie (the same-origin long-polling GET, where browsers omit
  Origin); any Origin must match `APP_BASE_URL`; a WebSocket upgrade always needs the matching Origin. Affected:
  07 §4.1, 09 §7 rule 2 (both amended here).
- **DEC-PROPOSED-4** (decisions:F6): `TicketSummary.pending_retrieval_at` (DEC-13) is part of the minimal projection;
  clients read the early request from it, not from the coalesced `cause` (DEC-265 stays: cause = the first
  `ticket.*` event). Affected: 07 TicketSummary + §4.3 `ticket.updated` (done here); 14 §3 intro and 14 §5.1 «طلب
  مبكر أثناء الصف» could name the state as the trigger (not edited here, outside this stream's scope).

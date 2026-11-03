# int-server — server side of the wave-6 integration findings

Stream: `wave6/int-server`. Scope: `packages/server`, `apps/api`, `apps/worker`, `packages/shared`, 07 + `07_openapi.yaml`.
The web stream owns `apps/web` (only `apps/web/src/api/types.ts` is touched here, for wire types).

## Fixes

| Finding | Fix | Test |
|---|---|---|
| contract:F1 | `GET /v1/me/home` returns `shift {id, status, opened_at}` (DEC-347) and `settings` (DEC-346: `inspection.required_photos`, `inspection.max_extra_photos`, `parking.mode`, `keys.require_slot`, `dispatch.single_offer_ttl_s`, canon §12 defaults completed); `findOpenShiftForPool` also selects `status, opened_at`. 07 §GET /v1/me/home and `DriverHome` in `07_openapi.yaml` document both. | `apps/api/test/tickets-reads.int.test.ts` «the venue rules a driver screen needs (DEC-346) …» |
| contract:F2, decisions:F2 | `loadTaskCard` fills `claim_code` with `loadClaimCodeState` (the TicketDetail projection, DEC-208: state only, never the code, DEC-38) for a retrieve task seen by the assignee or staff; null for park/repark and paper tickets. It also returns `ready_at` (`retrieval_cycles.ready_at`, the gap DEC-348 records), so D-04's «منذ» stays right after a resend (which moves `claim_code.issued_at`). 07 §3.4 (example + rule), `TaskCard` in `07_openapi.yaml`, `TaskCard.ready_at` in `apps/web/src/api/types.ts`. All `loadTaskCard` paths get it: `/ready`, `/key-pickup`, `/start` replies, `GET /v1/me/home`, the realtime `task.updated`, the operations board, `promoted_next_task`. | `apps/api/test/handover-codes.int.test.ts` «ready issues the code …» (the `/ready` reply and `home.current_task` carry the state with the same keys as TicketDetail, and `ready_at`; the code appears in none of them) |
| realtime:RT-3 | `job.link_code_expire` publishes `ticket.updated` with the canon §7.2 job as its cause (`job.link_code_expire`, the DEC-269 precedent) instead of the non-canon `wa.link_code_expired`, so the frame passes `RealtimeCauseSchema` and the web no longer resyncs on every expired QR code (closes driver-gaps.md «A non-canon cause»). | `apps/api/test/wa-linking.int.test.ts` «an active code nobody answered …» (frames parse with `realtimeEnvelopeSchema` + `REALTIME_PAYLOAD_SCHEMAS`) |

## For the web stream

- `TaskCard.ready_at` is now served: `fieldModel.ts` (D-04) can read `card.ready_at ?? card.claim_code?.issued_at ??
  card.requested_at` and `RetrievalPage.tsx` (D-10 «جاهزة» step) `card.ready_at ?? card.claim_code?.issued_at`. The
  e2e fake (`routesDriver.ts`) does not send `ready_at` yet; add it when the web reads it.

## Proposed decisions (the lead numbers them)

- **DEC-PROPOSED-1** (contract:F1): add `07 (§GET /v1/me/home, DriverHome)` to the affected-files column of DEC-346 and
  DEC-347; both fields are now served by the API (no longer an API gap).
- **DEC-PROPOSED-2** (contract:F2, decisions:F2): `TaskCard.ready_at` (DEC-348's API gap) is adopted and served;
  `TaskCard.claim_code` is the ClaimCodeState of the cycle's current code for a retrieve task (assignee and staff),
  the same projection as TicketDetail (DEC-208), null for park/repark tasks and paper tickets. DEC-348 can drop
  «فجوة في الـAPI»; affected files 07 §3.4, `07_openapi.yaml` TaskCard.

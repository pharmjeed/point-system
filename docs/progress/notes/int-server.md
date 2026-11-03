# int-server — server side of the wave-6 integration findings

Stream: `wave6/int-server`. Scope: `packages/server`, `apps/api`, `apps/worker`, `packages/shared`, 07 + `07_openapi.yaml`.
The web stream owns `apps/web` (only `apps/web/src/api/types.ts` is touched here, for wire types).

## Fixes

| Finding | Fix | Test |
|---|---|---|
| contract:F1 | `GET /v1/me/home` returns `shift {id, status, opened_at}` (DEC-347) and `settings` (DEC-346: `inspection.required_photos`, `inspection.max_extra_photos`, `parking.mode`, `keys.require_slot`, `dispatch.single_offer_ttl_s`, canon §12 defaults completed); `findOpenShiftForPool` also selects `status, opened_at`. 07 §GET /v1/me/home and `DriverHome` in `07_openapi.yaml` document both. | `apps/api/test/tickets-reads.int.test.ts` «the venue rules a driver screen needs (DEC-346) …» |

## Proposed decisions (the lead numbers them)

- **DEC-PROPOSED-1** (contract:F1): add `07 (§GET /v1/me/home, DriverHome)` to the affected-files column of DEC-346 and
  DEC-347; both fields are now served by the API (no longer an API gap).

# int-web — web side of the integration findings (wave 6)

Scope: `apps/web` (src, e2e, test). The server stream fixes `packages/server` / `apps/api` in parallel; nothing
here depends on a server change (each fix works against today's server and against the proposed one). The lead
numbers the proposals below into `docs/DECISIONS.md`.

## Findings and evidence

| Finding | Fix | Evidence |
|---|---|---|
| contract:F3 | D-10 never sends `key_slot_id: ""`: with no slot on the card nor on the detail the pickup cannot match a slot holder (DEC-187), so the custody dialog (DEC-352) and the re-read come at once, nothing is sent; otherwise the slot id is sent and the server decides. The e2e fake now answers 422 VALIDATION_FAILED for a non-uuid `key_slot_id`, as the strict server body does. | `e2e/driver-errors.spec.ts` «D-10: a key outside any slot …» |

## Proposed decisions


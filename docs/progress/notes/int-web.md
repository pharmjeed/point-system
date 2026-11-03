# int-web — web side of the integration findings (wave 6)

Scope: `apps/web` (src, e2e, test). The server stream fixes `packages/server` / `apps/api` in parallel; nothing
here depends on a server change (each fix works against today's server and against the proposed one). The lead
numbers the proposals below into `docs/DECISIONS.md`.

## Findings and evidence

| Finding | Fix | Evidence |
|---|---|---|
| contract:F3 | D-10 never sends `key_slot_id: ""`: with no slot on the card nor on the detail the pickup cannot match a slot holder (DEC-187), so the custody dialog (DEC-352) and the re-read come at once, nothing is sent; otherwise the slot id is sent and the server decides. The e2e fake now answers 422 VALIDATION_FAILED for a non-uuid `key_slot_id`, as the strict server body does. | `e2e/driver-errors.spec.ts` «D-10: a key outside any slot …» |
| contract:F4, decisions:F3, realtime:RT-1 | The realtime engine drops a `ticket.updated` only when its `aggregate.version` is strictly older than the one applied; an equal version passes (a repeated frame is still dropped by `id`). Every other aggregate keeps «not newer → dropped». The staff handlers only invalidate (idempotent) and the driver handler already re-reads the detail for `message` and the code causes, and checks `summary.version` itself. Works unchanged if the server instead sends `version: null` for these causes. | `test/realtime/engine.test.ts` «ticket.updated at the version already applied is delivered …» |
| realtime:RT-4 | `apiFetch` no longer feeds a replayed answer's `meta.server_time` (07 §1.4: the first attempt's stored time) to the server clock, and `RootLayout` no longer moves «آخر مزامنة» with it (`freshServerTime`); a replay is recognised by `meta.replayed` or the `Idempotent-Replayed` header and still confirms the connection. | `test/client.test.ts` «a replayed answer …» |
| contract:F6 | S-11 «التحصيل» always sends `from`/`to`: a chosen event is reported over its Riyadh day (`periodToUtc(event_date, event_date)`, the server's event-day overlap of DEC-288), otherwise the period; without either the card waits instead of asking a 422. The e2e mock now refuses a payments query without `from`/`to` as the server does. | `e2e/staff-reports.spec.ts` «cards follow the filters …» |

## Proposed decisions

**DEC-PROPOSED-1 — a `ticket.updated` at the version already applied is applied** — context: 07 §4.5 / 11 §9.2 say
the client ignores an update whose `aggregate.version` is ≤ the last one known, while 07 §4.3 / DEC-266 / 14 §3.4 send
`ticket.updated` for causes that never write the tickets row (`wa.message_status_changed` with `message`,
`handover.code_issued` on a resend or reissue, `handover.code_attempt_failed`, `handover.code_locked`, `incident.*`),
so they carry the version already applied and the two rules contradicted each other (contract:F4, decisions:F3,
realtime:RT-1). — decision: for `ticket.updated` the client drops only strictly older versions; an equal version is
applied (the summary is the same, so applying it is idempotent; duplicates are dropped by the envelope `id`). Every
other aggregate keeps «≤ known → dropped» (`task.claimed`, DEC-220). If the server publishes these causes with
`aggregate.version: null` (the server stream's option), they are descriptive frames and pass as well; both
readings work with the web as it is. — affected files: 07 §4.5, 11 §9.2 (and 07 §4.3 `ticket.updated` row).


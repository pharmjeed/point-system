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
| decisions:F4 | S-03 «الخط الزمني» has an Arabic line for every ticket-scoped `ticket_events.type`: `task.*`, `handover.*`, `payment.recorded/reversed/waived`, `incident.opened/updated/resolved` (copy in DEC-PROPOSED-2, 02 §8.6 has none), a generic «تحديث على التذكرة» for a type the client does not know, and the template without its placeholder when `data` cannot fill it — never the raw key. `custody.changed` and `wa.message_status_changed` rows are skipped: the custody chain and the message lines already show them. | `test/staff/timelineModel.test.ts` «S-03 timeline texts for every ticket_events.type» |

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

**DEC-PROPOSED-2 — S-03 timeline lines for the non-ticket rows of `ticket_events`** — context: 02 §8.6 / DEC-323
promise a timeline text «لكل `ticket_events.type`», but list `ticket.*` keys only, while the timeline also holds
`task.*`, `custody.changed`, `handover.*`, `payment.*`, `wa.message_status_changed` and the TT-19 `incident.*` rows
(11 §1.6, DEC-186, DEC-210); S-03 showed raw English keys (decisions:F4). — decision: `ticketEventText` in
`ar.staff.ts` adds (to be listed in 02 §8.6 under DEC-323):
`task.created` «إنشاء مهمة» · `task.offered` «عرض الطلب على سائق» · `task.broadcast_opened` «فتح البث لكل السائقين» ·
`task.broadcast_extended` «تمديد البث» · `task.claimed` «قبول المهمة» · `task.promoted` «بدء المهمة المحجوزة» ·
`task.key_picked_up` «استلام المفتاح من الخانة» · `task.started` «بدء المهمة» · `task.completed` «إتمام المهمة» ·
`task.canceled` «إلغاء المهمة» · `task.withdrawn` «سحب المهمة من السائق» · `task.reassigned` «إعادة إسناد المهمة» ·
`task.escalated` «تصعيد للمشرف: لم يُقبل الطلب» · `handover.code_issued` «إصدار رمز التسليم» ·
`handover.code_attempt_failed` «محاولة رمز تسليم خاطئة» · `handover.code_locked` «قفل رمز التسليم بعد المحاولات» ·
`handover.completed` «إتمام التسليم» · `handover.exception_approved` «اعتماد تسليم استثنائي» ·
`payment.recorded` «تسجيل التحصيل» · `payment.reversed` «عكس التحصيل» · `payment.waived` «إعفاء من الرسوم» ·
`incident.opened` «فتح بلاغ» · `incident.updated` «تحديث بلاغ» · `incident.resolved` «حل بلاغ» ·
`other` «تحديث على التذكرة» (a type the client does not know). `custody.changed` and `wa.message_status_changed` rows
are not drawn as ticket lines: the custody chain («السبب: من ← إلى») and the message lines («W-05 — وصلت») of the
same timeline show them. — affected files: 02 §8.6 (the table), optionally 11 §1.6 (`incident.*` rows of TT-19).


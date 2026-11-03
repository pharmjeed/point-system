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
| decisions:F6 | The early-request notice (14 §5.1 «طلب مبكر أثناء الصف», `reminder`) no longer depends on the coalesced cause alone: a newer version of the parking driver's current park/repark ticket under another cause (DEC-265 keeps the first `ticket.*` cause, e.g. `ticket.wa_link_changed` after a resumed link) re-reads the ticket (joining a refetch in flight) and raises the notice when `pending_retrieval_at` is set; once per parking task, whichever path sees it first. | `test/realtime/driverRuntime.test.ts` «an early request merged under another cause …», «a newer version … without an early request …» |
| decisions:F1-d15h | D-15 ح appears only once SERVICE_UNAVAILABLE persists for `SERVICE_DOWN_AFTER_MS` (10 s: past React Query's 1 s / 2 s retries and the engine's 5 s resync retry) with no read succeeding meanwhile; before that the cached snapshot stays as «قديم». The screen under D-15 ح stays mounted (hidden, `inert`), so D-08 / D-11 keep what was typed when the service returns. | `e2e/driver-frame.spec.ts` «decisions:F1-d15h: one SERVICE_UNAVAILABLE keeps D-11 …» (transient: never shown, stub and «استلمت المبلغ» kept; persistent: shown, the form survives the recovery) and the existing «PNT-068 D-15 ح» case; `test/realtime/driverRuntime.test.ts` «02 D-15 ح once SERVICE_UNAVAILABLE persists …» |
| realtime:RT-5 | The staff shell gets the drivers' tap-driven path: «إشعارات الجهاز» in the staff menu (state from D-03, «تفعيل الإشعارات» / «إعداد», the D-03 denied hint and the D-14 iPhone note) asks the permission inside the tap and sends `PUT /v1/me/devices/{deviceId}` with the subscription; the staff frame re-links the subscription the browser already holds to a new sign-in's device, once per device and app session, with no prompt. The hooks moved to `features/session/pushSetup.ts`, shared with D-03 / D-14 / the driver frame. | `e2e/pwa.spec.ts` «realtime:RT-5: staff (ADM1) subscribe from a tap in the menu …» (no prompt on load; one request and one subscribe from the tap; the next sign-in relinks with none) and the existing driver PNT-072 cases |
| contract:F5, decisions:F5 | A client telemetry module (`src/lib/telemetry.ts`): 15 §8 measurements queued only after sign-in, each checked with the shared `parseTelemetryEvent` before it enters a batch (the catalog is a lazy chunk), batches of ≤ 50 events / < 64 KB to `POST /v1/telemetry` every 30 s, at 20 events, on `visibilitychange`→hidden / `pagehide` / `online`, with `fetch` `keepalive`, the CSRF header, `device_id`, `client_session_id` and `seq`, no Idempotency-Key; offline kept in memory up to 200 (oldest dropped), 429 waits `retry_after_s`, a refused batch is dropped; sign-out flushes first (bounded) and closes the queue, the session end closes it. Emitted: `app_started`, `pwa_installed` (first standalone run), `audio_test_completed` (D-03 / D-04 `duty_start`, D-14 `account`), `audio_blocked_detected`, `notification_permission_changed` and `push_subscription_changed` (D-03, D-14, staff menu), `push_notification_clicked` (the worker's `kind`/`age_ms`), `connection_changed`, `sync_completed` (engine, with reason/duration/stale), `page_hidden_during_duty`, `wake_lock_changed`, and the 15 §9.4 `offer_card_seen` fallback: while the socket is down the engine hands a round on screen to the HTTP batch (`via: sync`, `mode`/`eligible_as` from the snapshot, sent at once) and never reports it again over the socket. The e2e fake and the MockApi answer 202; the command-contract checks skip the route. | `test/telemetry.test.ts` (8), `test/realtime/engine.test.ts` «while the socket is down … HTTP telemetry fallback», «… sync_completed»; `e2e/driver-telemetry.spec.ts` (the batch on the wire with every event inside the catalog; `offer_card_seen` with the socket down, once); `e2e/pwa.spec.ts` (`push_notification_clicked` after a `push.click`) |

contract:F1 (the server now sends `home.settings` / `home.shift`): no web change; D-06, D-08 and D-09 keep reading
`home.settings` with the canon §12 defaults when it is absent, as before.

## Checks (on 00bebc7 + this note)

- `pnpm lint`, `pnpm typecheck`: clean.
- `pnpm test` (unit + web-unit): 93 files, 1441 tests passed.
- `pnpm test:int` (PostgreSQL 16, under the lock): 84 files passed, 1 skipped; 669 tests passed, 1 skipped.
- Playwright, full run (`--workers=2`, under the lock): 586 passed, 446 skipped (the 390-only specs at 360/430),
  0 failed.

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

**DEC-PROPOSED-3 — D-15 ح after SERVICE_UNAVAILABLE persists; the screen under it keeps its state** — context:
02 D-15 ح says only «شاشة كاملة», the web raised it on the first 503 and unmounted the task screen, while 08
(SERVICE_UNAVAILABLE: «auto-retry بتباعد، ثم banner إن استمر»), 04 (PostgreSQL outage: stale data first, the paper
procedure «إن طال الانقطاع») and 02 D-15 و (no disruption during a task or an unsaved form) ask for a persistent
outage; since load-chaos the server answers 503 for a pool wait, a statement timeout, 55P03 and 57014
(decisions:F1-d15h). — decision: the driver frame shows D-15 ح when `GET /v1/me/home` has answered
SERVICE_UNAVAILABLE and no read has succeeded for 10 s (past the read retries and the 5 s resync retry); before
that the snapshot stays on screen as «قديم» (D-15 أ) and commands wait for the sync as usual. Under D-15 ح the
current screen stays mounted (hidden and inert), so D-08 / D-11 come back with what was typed. — affected files:
02 D-15 ح (the 10 s rule and «الشاشة تحتها تحتفظ بحالتها»), 08 SERVICE_UNAVAILABLE UI handling (link to D-15 ح).

**DEC-PROPOSED-4 — staff subscribe to Web Push from the staff menu** — context: 14 §6.1 / DEC-258 push `escalation`
alerts to the venue supervisors and, for the multi-venue types (`outbox_lag`, `wa_channel_down`,
`wa_webhook_silent`), to admins and the owner, but 14 §6.4.1 and 02 D-03 / D-14 put the only subscription path in
the driver shell, which admins, the owner and supervisors without `can_drive` never open; their devices never had a
`push_endpoint` (realtime:RT-5). — decision: the staff menu carries «إشعارات الجهاز» with the D-03 state line and
«تفعيل الإشعارات» (or «إعداد» when granted): the permission is requested only inside that tap, the subscription is
sent with `PUT /v1/me/devices/{deviceId}` to the session's device; the staff frame re-sends a subscription the
browser already holds to a new sign-in's device (no prompt, no new subscription), as the driver frame does
(PNT-072). Copy is D-03's / D-14's; no new text. — affected files: 14 §6.4.1 (subscription from an explicit tap in
D-03 / D-14 and in the staff menu), 02 S-02 / staff shell menu (the row), `docs/supervisor-guide.md` §4.

**DEC-PROPOSED-5 — the web telemetry queue (15 §8/§9/§13 item 6)** — context: no client telemetry was ever sent
(decisions:F5) and the 15 §9.4 `offer_card_seen` fallback did not exist (contract:F5). — decision: as implemented in
`apps/web/src/lib/telemetry.ts`: validation with `parseTelemetryEvent` happens when the queue is turned into a batch
(before the event enters it, DEC-167), so the catalog can stay a lazy chunk; a batch the server refuses (4xx other
than 429) is dropped, not retried; the offline queue is in memory only (200 events, the oldest dropped) and does not
survive a reload; the staff menu's notification setup reports `context: account`; D-04's untested-sound line
reports `audio_test_completed.context: duty_start`; `pwa_installed` is reported once per browser
(`detected_standalone`, a localStorage flag). Not emitted yet (no hook in the UI to take them from without
guessing): `offer_card_removed` (needs the card's visible time and the removal reason per path), `ui_error_shown`
(needs the presentation and an S-/D- screen id per error), `form_draft_restored` and `app_update_applied` (the
versions of the old and new worker). — affected files: 15 §8 (a note on the four not yet sent), 15 §13 item 6.


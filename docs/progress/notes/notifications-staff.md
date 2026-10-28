# Staff notifications — Web Push (PNT-072 backend) and the non-dispatch realtime planners

Status: backend done (planner, `job.push_send`, VAPID sender, dev/test sender, outcome bookkeeping, alerts) and the
non-dispatch realtime planners (`ticket.updated`, `sync.required`, `channel.status`, `incident.updated`, the
`job.ws_publish` fallback). The Service Worker and the D-03/D-14 subscription UI are a web ticket: the contract they
need is in §4 below. `docs/DECISIONS.md` is not edited; the proposals of §6 are numbered by the lead.

## 1. Structure

| Place | Content |
|---|---|
| `packages/shared/src/canon/push.ts` | `PushPayloadSchema` (strict, 14 §6.2), `PUSH_TTL_S`, `PUSH_URGENCY`, `pushTopic`, `pushTag`, `PUSH_URLS`, the 14 §6.3 copy (`PUSH_TITLES`, `PUSH_BODIES`, `escalationBody`, `pushTitle`) — titles take the staff brand as an argument (canon §1), never a literal. |
| `packages/shared/src/canon/realtime.ts` | 07 schemas used in realtime payloads: `UserRefSchema`, `PlateSchema`, `TicketSummarySchema` (strict), `IncidentSchema`; the payloads `TicketUpdatedPayloadSchema`, `SyncRequiredPayloadSchema`, `ChannelStatusPayloadSchema`, `IncidentUpdatedPayloadSchema`, `REALTIME_PAYLOAD_SCHEMAS`, and `realtimeEnvelopeSchema(event, payload)` (the socket frame of 07 §4.2; `aggregate.version` nullable for the channel). |
| `notifications/domain/push-rules.ts` | `staffPushIntents(event)`: the «Push» column of 14 §3 as a pure function (unit-tested). |
| `notifications/domain/push-payload.ts` | `buildPushPayload`, `pushDeadline`, `pushTtlSeconds`, `classifyPushResponse`, `nextPushAttemptDelay`, `pushErrorCode`. |
| `notifications/domain/realtime-rules.ts` | `ticketUpdateRequests(event)`: the `ticket.updated` cells of 14 §3 (who besides the supervisors). |
| `notifications/application/push-planner.ts` | `staffPushPlanner` (TxPlanner): intents → recipients → pushable devices → `notifications` (`channel = push`) + `job.push_send`. |
| `notifications/application/push-sender.ts` | `job.push_send` (`mode: external`): fresh read + send-time rules in a short tx, the network call, the outcome in a second short tx. |
| `notifications/application/ticket-updates.ts` | `requestTicketUpdate` (per-transaction coalescer, flushed by a before-commit hook) and the `registerTicketSummaryProjection` seam. |
| `notifications/application/realtime-planner.ts` | `notificationsRealtimePlanner` (TxPlanner): `ticket.updated` requests, `sync.required`, `channel.status`, `incident.updated`. |
| `notifications/infra/push-transport.ts` | `PushSender` port; `WebPushSender` (`web-push` 3.6.7 builds the aes128gcm body + VAPID JWT, `fetch` sends it with a 10 s timeout and reads `Retry-After`); `MemoryPushSender` (dev/test, no network, records parsed payloads, scriptable answers per endpoint); `DisabledPushSender`; `selectPushDriver`/`createPushSender`. |
| `notifications/infra/push-runtime.ts` | `PushRuntime` (env, sender, staff brand) and `defaultPushRuntime()` (lazy, worker). |
| `notifications/jobs/ws-publish.ts` | `job.ws_publish` fallback handler. |
| `use-cases/realtime-projections.ts` | Wiring (runs on import of `@point/server`, like the DEC-32 hook): the tickets-custody `loadTicketSummary` becomes the single TicketSummary projection, and the WhatsApp `registerTicketUpdatePublisher` seam is pointed at the coalescer. 04 §4.3: notifications does not import tickets-custody; use-cases composes both. |

Registration: `registerNotificationPlanner()` (api `NotificationsHttpModule.onModuleInit`, worker `notificationsJobs()`)
now also starts the staff push planner and the realtime planner; `notificationsJobs({ push? })` returns
`job.push_send` and `job.ws_publish`. No new line was needed in `packages/server/src/index.ts`, `apps/api/src/features.ts`
or `apps/worker/src/handlers.ts` (the module was registered already); one export line was appended to
`packages/server/src/use-cases/index.ts`.

Changes outside the module: `core/config/env.ts` (VAPID validation, DEC-PROPOSED-15), `whatsapp/application/channel-health.ts`
and `whatsapp/infra/realtime.ts` (the direct `channel.status` publish is removed: the planner publishes it from
`wa.channel_health_changed`, so it is never published twice), `identity-access/application/me-service.ts` (a new push
subscription auto-resolves `push_failed_repeatedly:{device}`, 14 §8), `notifications/application/planner.ts`
(`insertNotification` sets a UUIDv7 id). New dependencies of `@point/server`: `web-push` 3.6.7 and `@types/web-push` 3.6.4
(dev), the latest stable versions (`npm view`).

## 2. Web Push pipeline

**Planning (inside the producing transaction, DEC-41 for staff).**

| Event (11 §8 payload) | Kind | Recipients | Dedupe key (14 §6.1) |
|---|---|---|---|
| `task.offered` | `offer` | `recipient_id` | `push:offer:{task}:{round}:{device}` |
| `task.broadcast_opened` / `task.broadcast_extended` | `broadcast` | `recipients` / `added` (all eligibilities) | `push:broadcast:{task}:{round}:{device}` |
| `offer.reminded` | `reminder` | recipients with `accept`/`reserve_next` and no `seen_at` (14 §10) | `push:reminder:{task}:{round}:{device}` |
| `task.claimed` | `closed` (claimed) | the other recipients and the claimant — replacement only | `push:closed:{task}:{round}:{device}` |
| `offer.expired` / `offer.revoked` | `closed` (ended) | the recipient(s) — replacement only | `push:closed:{task}:{round}:{device}` |
| `task.promoted` | `next_due` | assignee | `push:next_due:{task}:v{version}:{device}` |
| `task.reassigned` | `next_due` (when it became current) + `closed` (withdrawn) for the previous driver | to / from | `…:v{version}:…` |
| `ticket.reparking` | `next_due` (tag = the repark task) | the holder `assignee_id` | `push:next_due:{repark_task}:1:{device}` |
| `task.withdrawn` | `closed` (withdrawn) | `from_assignee_id` — sent even without a shown request | `push:closed:{task}:v{version}:{device}` |
| `task.canceled` (retrieve, `customer_field_cancel`/`supervisor_cancel`) | `closed` (canceled) | assignee | `push:closed:{task}:v{version}:{device}` |
| `alert.raised` with `severity = critical` | `escalation` | supervisors with a venue scope on the alert's venue; admins and owner too for the multi-venue types (DEC-46) | `push:escalation:{alert}:1:{device}`; multi-venue: `push:escalation:{type}:{epoch}:{device}` |

A device is pushable when (14 §6.1 condition 1) `notification_permission = granted`, a subscription is stored,
`revoked_at IS NULL`, the user is active, and (DEC-PROPOSED-1) a live session of that user is linked to the device.
Within one transaction the last request per device and tag wins (DEC-PROPOSED-4). A replacement-only `closed` is
planned only where a request push of that round exists (`pending` or `sent`).

**Sending (`job.push_send`, `mode: external`, no `ordering_key`).** Tx 1 locks the notification (L9), re-reads the
device (no subscription → `skipped no_subscription`) and the live state: `offer` needs its single round active and not
expired, `broadcast`/`reminder` an active round, `reminder` also no `seen_at` (else `superseded`), `next_due` the task
still current for the driver, `escalation` the alert still `open`, a replacement `closed` a request push of that round
that was `sent` (waits 2 s while one is in flight, gives up after 2 min) and no newer round pushed to the device
(`superseded`); a `withdrawn` closed is superseded if the task came back to the same driver. It builds and validates the
payload (`PushPayloadSchema.parse`), writes `notification_attempts` (attempt n, started) and commits. Then the network
call. Tx 2 records the outcome (14 §6.6): 2xx → `sent`, `push_failed_count = 0` (+ auto-resolve
`push_failed_repeatedly`), `offer_recipients.notified_push_at`; 404/410 → `failed`, subscription cleared (only if the
endpoint is unchanged), count + 1; 429/5xx/network/timeout → retried at +2 s, +5 s, +15 s (`Retry-After` honoured) while
before the deadline, at most 4 provider attempts, then `failed`; other 4xx → `failed`. Every failed attempt adds 1 to the
device's consecutive failures; at `push.max_consecutive_failures` `push_failed_repeatedly` (info, no push) is raised for
the venue of the user's open duty (else his active assignment), `user_id` = the device owner. Metric
`point_push_send_total{outcome}` (`success`, `gone`, `retryable`, `permanent`, `skipped`).

**Driver selection (05 §8).** `APP_ENV = test` → `MemoryPushSender`; both VAPID keys → `WebPushSender`; `local` without
keys → `MemoryPushSender` (warning); staging/production without keys → `DisabledPushSender` (attempts fail
`push_not_configured`, never counted against the device). `loadEnv` refuses one VAPID key without the other and a
subject that is not `mailto:`/`https:`.

## 3. Realtime planners (DEC-48, 07 §4.3, 11 §9)

| Message | From | Rooms | Payload |
|---|---|---|---|
| `ticket.updated` | every `ticket.*`, `custody.changed`, `handover.*`, `payment.*`, `incident.*` (linked), `wa.message_status_changed`, and the WhatsApp adapter's direct updates | `venue:{venue}:supervisors` + `user:` of the concerned drivers | `TicketSummary` (tickets-custody builder) + `cause` (+ `wa_link_pending`, + `message`) |
| `sync.required` | `event.opened` / `event.closing_started` / `event.closed` | venue supervisors + `pool:{event pool}:drivers` | `{cause, reason: event_status_changed, scope: events, event_id, dispatch_pool_id}` |
| `sync.required` | `shift.opened` / `shift.closed` | venue supervisors + `pool:{pool}:drivers` + (open) `user:` of the drivers assigned to the venue / (close) `user:` of the ended duties | `{cause, reason: shift_status_changed, scope: home, shift_id, dispatch_pool_id}` |
| `channel.status` | `wa.channel_health_changed` | `org:{org}:admins` + every venue's supervisors + every pool's drivers (07 §4.3 «every room of the organization») | `{cause, whatsapp, changed_at}` |
| `incident.updated` | `incident.opened` / `incident.updated` / `incident.resolved` | venue supervisors | `Incident` (fresh read) + `cause` |

`ticket.updated` is coalesced per ticket and transaction and built right before COMMIT from the final state
(DEC-PROPOSED-10): one publication per audience — supervisors (all extras), drivers who may see the ticket in full
(creator during intake or for creator events, assignee of the open task: `wa_link_pending`, `message` only for W-01/W-05,
09 §5.1), other concerned drivers (custody holders before/after, early-request parking driver, repark holder, collector:
the summary only). Staff users among them read the supervisors' room. Rooms are chunked by 60 per NOTIFY. Not published
here: `task.*`, `offer.*`, `driver.*` (dispatch realtime), `alert.*` (core/alerts), `session.revoked` and the identity /
settings `sync.required` (their modules).

## 4. Contract for the web Service Worker (web ticket)

Subscribe from a direct tap in D-03/D-14 only: `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey:
VITE_VAPID_PUBLIC_KEY })`, then `PUT /v1/me/devices/{deviceId}` with `notification_permission` and `push_subscription:
{ endpoint, keys: { p256dh, auth } }`. The server pushes a device only while its permission is `granted`, it has a
subscription and a live session (after logout nothing reaches it). A 404/410 from the push service clears the stored
subscription: D-14 shows «الإشعارات لا تصل لجهازك — أعد تفعيلها» from `GET /v1/me` (`push_subscribed: false` with
permission granted) and re-subscribes.

Payload (UTF-8 JSON, aes128gcm; `PushPayloadSchema` in `@point/shared`, strict — every key always present):

```json
{ "v": 1, "kind": "offer", "tag": "task:<task_id>", "title": "<staff brand> — طلب إحضار",
  "body": "تذكرة 125 — افتح التطبيق للقبول", "ticket_no": 125, "task_id": "<uuid>", "offer_id": "<uuid>",
  "url": "/d", "renotify": true, "silent": false, "sent_at": "<ISO>", "expires_at": "<ISO>" }
```

- `kind`: `offer` · `broadcast` · `reminder` · `next_due` · `escalation` · `closed` (canon §5.7, nothing else).
- `tag`: `task:<task_id>` for every driver kind (one slot per task: the request, its reminder, the next-due notice and
  the quiet replacement all share it); `alert:<alert_id>` for `escalation`.
- `title`: `«BRAND_STAFF_NAME_AR» — «suffix»` (14 §6.3); `closed`: the brand alone. `body`: 14 §6.3 copy, the ticket
  number is the only datum (no plate, phone, key slot, spot, name or code — DEC-23).
- `ticket_no`: `null` only for an escalation of an alert without a ticket. `task_id`: `null` only for such an escalation.
  `offer_id`: the round for `offer`/`broadcast`/`reminder` and for a `closed` after a claim/expiry/revocation; `null`
  otherwise.
- `url`: `/d` (D-04) for driver kinds, `/ops/alerts` (S-04) for `escalation`.
- `renotify: true, silent: false` for every kind but `closed` (`false`/`true`).
- `expires_at`: end of a single round (`offer`, single-round `reminder`), else `null`.
- Headers: `TTL` (offer: seconds left in the round, ≤ 30; broadcast/reminder 60; next_due/closed 300; escalation 600),
  `Urgency: high`, `Topic` = the task (or alert) id without dashes.
- Quiet replacement texts (`PUSH_BODIES.closed`): claimed «تم قبول الطلب»; ended «انتهى العرض — افتح التطبيق لمعرفة
  الجديد»; withdrawn «سُحبت مهمة تذكرة N — لا تُحضر السيارة»; canceled «أُلغي طلب تذكرة N».

Service Worker behaviour (14 §6.4): (1) on `push` always show a notification with the payload's `tag`, `renotify`,
`silent`, `body` and the brand icon/badge, `data = { url, kind, task_id, offer_id, ticket_no, sent_at }`, no `actions`;
(2) `expires_at` already past on arrival → show the quiet `closed` instead (`title` = brand, body =
`PUSH_BODIES.closed.ended()`, `silent: true`, `renotify: false`, same tag); (3) `kind = closed`: close the shown
notifications of the tag (`registration.getNotifications({ tag })`) and show the quiet one; (4) 14 §6.1 condition 2 at
display time (DEC-PROPOSED-2): if a focused, visible window of the app exists, show it with `silent: true` (the page plays
its own sound); (5) `notificationclick`: focus a window and `postMessage({ type: 'push.click', url, kind })`, else
`openWindow(url)`; the app syncs (`GET /v1/me/home` / the operations board) before enabling any button and never trusts
the notification; analytics `push_notification_clicked { kind, age_ms = now − sent_at }`. An unknown or invalid payload:
show the quiet ended text with tag `push:unknown`.

## 5. Tests

- Unit: `packages/shared/test/push-realtime.test.ts` (26: AC1 strict payload — phone/plate/key/slot/spot/code/name/wa
  fields rejected and absent from the shape; copy = 14 §6.3 table; TTL = 14 §6.2; realtime payload schemas reject
  fields outside 09 §5.1), `packages/server/test/staff-push.test.ts` (19: intents per event, payload per kind with the
  ticket number as the only datum, TTL/deadline, response classes, retry delays, driver selection, the dev sender),
  `packages/server/test/realtime-rules.test.ts` (6), `packages/server/test/push-webpush.test.ts` (2: the real
  `WebPushSender` against a local push service — headers, VAPID JWT `aud`/`sub`/`exp`, the aes128gcm body decrypted with
  the subscription keys back to the payload; 410/429 Retry-After/503/timeout/connection refused).
- Integration (PostgreSQL 16, real routes, worker dispatcher with the dev sender): `apps/api/test/push-send.int.test.ts`
  (6: offer push exact payload + headers + bookkeeping, quiet replacement on accept, devices without permission /
  subscription / session, expiry → closed + next offer, 410 clears the subscription, 3 failures → `push_failed_repeatedly`
  → success resolves it, attempt limit, new subscription resolves), `apps/api/test/push-planner.int.test.ts` (8: critical
  `no_drivers_on_duty` → supervisors only with the exact payload, acknowledged alert skipped, multi-venue
  `wa_channel_down` → one push per device incl. admins, broadcast to all recipients, reminder only to unseen, claim
  replaces only what was shown, withdrawal via the DEC-32 release hook, last request wins in a transaction),
  `apps/api/test/realtime-notifications.int.test.ts` (9: coalesced `ticket.updated` with rooms per step of the slice,
  the WhatsApp adapter through the same builder (delivery states, W-01 vs W-02 visibility, link change), incident +
  linked ticket, `sync.required` for event open/closing/closed and shift close/open through the routes, one
  `channel.status` for all staff rooms, the `job.ws_publish` fallback, and the Socket.IO frame validated over the wire).
  Every captured message is validated with `realtimeEnvelopeSchema` + `REALTIME_PAYLOAD_SCHEMAS`.

## 6. Proposed decisions

| # | Title — context — decision — affected files |
|---|---|
| DEC-PROPOSED-1 | **A push needs a live session on the device** — 14 §6.1 condition 1 names the permission, the endpoint and `revoked_at`, but logout leaves the device row and its subscription (the next user of a shared browser would see the previous driver's requests). — A device is pushed only if a non-revoked, unexpired `auth_sessions` row of the same user is linked to it (`device_id`), and the user is active; checked at planning and again at send time (`skipped no_subscription`). — 14 §6.1, 09 §9.5. |
| DEC-PROPOSED-2 | **14 §6.1 condition 2 is evaluated by the Service Worker** — «no live WebSocket or the last heartbeat said `visible = false`» needs a persisted presence the schema does not have (`client.heartbeat.visible` is not stored; the worker cannot see the api's sockets). Suppressing on a guess would lose the request on a hidden page. — The server pushes every pushable device; reminders keep the server-side rule (`offer_recipients.seen_at`, 14 §10). The SW shows the notification `silent` when a focused, visible window of the app exists (a notification is still shown, 14 §6.4.2). A later `devices.presence_*` column set could move the check server-side. — 14 §6.1, §6.4; 06 (proposal only). |
| DEC-PROPOSED-3 | **Quiet replacements only replace something** — every push must show a notification, so a `closed` sent to a device that never showed the request creates one. — `closed` after `task.claimed` / `offer.expired` / `offer.revoked` goes only to devices whose request push of that round (offer/broadcast/reminder) is pending or sent, and is sent only once that push was `sent` (waiting 2 s while it is in flight, up to 2 min; its row is locked first so a push still being prepared is seen); skipped `superseded` when a newer round was pushed to the device. `withdrawn` (withdrawal, reassignment away) and `canceled` (field cancel of a retrieval) are informative and go to the driver's devices regardless. — 14 §3.2, §6.4.3; DEC-23. |
| DEC-PROPOSED-4 | **Last request per device and tag wins within a transaction** — a pass may revoke and reopen a round for the same driver, or an accept revokes the driver's other single offer created in the same transaction. — The staff push planner keeps one notification per (device, tag) per transaction, the last in event order; a replacement whose request was dropped in the same transaction is dropped too. — 14 §6.1. |
| DEC-PROPOSED-5 | **`push_failed_count` = consecutive failed provider attempts** — 14 §6.6 resets it on 2xx and alerts after 3 consecutive failures; TC-NT-11 combines 410 with the alert. — Every non-2xx response or transport failure (404/410 included) adds 1; 2xx and a new subscription reset it; at `push.max_consecutive_failures` `push_failed_repeatedly` (info) is raised for the venue of the device user's open duty, else of his active assignment (`user_id` = owner, `details: device_id, consecutive_failures, last_error`), auto-resolved on a successful push or a new subscription (identity me-service). A missing VAPID configuration (`push_not_configured`) is not counted against the device. — 14 §6.6, §8; 15 §708. |
| DEC-PROPOSED-6 | **Retry window** — «up to 3 retries within the TTL». — At most 4 provider attempts per notification at +2 s, +5 s, +15 s (`Retry-After` honoured), never at or past the deadline: the round's `expires_at` for an offer, otherwise `created_at + TTL(kind)`. A notification whose deadline passed before its first attempt is `skipped stale`; after an attempt, `failed ttl_exceeded`. The outbox row allows 20 attempts (waits included). — 14 §6.2, §6.6. |
| DEC-PROPOSED-7 | **Push dedupe keys** — 14 §6.1 gives `push:{kind}:{entity_id}:{round_or_n}:{device_id}`. — entity = the task (`escalation`: the alert); n = the round for offer/broadcast/reminder and offer-driven `closed`; `v{task version}` for task-driven `closed`/`next_due`; `1` for a repark task and a single-venue escalation; for the multi-venue alert types (one row per venue, DEC-46) `push:escalation:{type}:{epoch(raised)}:{device}`, so a supervisor of two venues and the admins get one push per outage. — 14 §6.1, DEC-46. |
| DEC-PROPOSED-8 | **Escalation audience and text** — 14 §8 «escalation / Push» for critical alerts; `Push للمشرفين والإدارة` for `outbox_lag`/`wa_webhook_silent`. — Critical alerts only (14 §10: `info` never, `warning` in-page). Recipients: active supervisors with a venue scope on the alert's venue; admins and the owner only for the multi-venue types (`wa_channel_down`, `outbox_lag`, `wa_webhook_silent`, `transfer_blocked` — the same split as the `alert.raised` rooms). Body: the short 14 §8 text with the ticket number only (`escalationBody` in `@point/shared`: no venue or driver name, no customer brand); `request_unaccepted` reads «طلب تذكرة N دون قبول» (the threshold is a setting). An alert acknowledged or resolved before the send is `skipped stale`. — 14 §6.3, §8. |
| DEC-PROPOSED-9 | **`task.canceled` push scope** — 14 §3.1 sends «أُلغي طلب تذكرة N» for a retrieval cancel only; a void, a manual reconcile and a repark for an absent customer send nothing. — Only `retrieve` tasks with an assignee and `cancel_reason` `customer_field_cancel` or `supervisor_cancel`. — 14 §3.1, §3.2. |
| DEC-PROPOSED-10 | **`ticket.updated` is coalesced per ticket and transaction** — a command emits several events for one ticket (`ticket.created` + `custody.changed` ×2 …) and the client ignores versions it already has (07 §4.5). — One publication per ticket and audience, built right before COMMIT from the final state with the tickets-custody TicketSummary; `cause` = the first `ticket.*` event of the transaction (else the first cause); concerned drivers = union. The WhatsApp adapter's direct updates use the same coalescer through `registerTicketUpdatePublisher`. — 07 §4.3, 11 §9.2, 14 §3. |
| DEC-PROPOSED-11 | **`ticket.updated` audiences and field visibility** — 07 §4.3 «supervisors + the concerned driver (assignee / creator during intake)»; 14 §3.4 adds the custody holders. — Venue supervisors (+ `wa_link_pending`, + every `message`); the creator during intake (`received`/`parking`) or for creator events (`ticket.created`, `intake_submitted`, `wa_link_changed`, `customer_phone_changed`, `inspection_completed`, `voided`, a W-01 state) and the open task's assignee (+ `wa_link_pending`, + `message` only for W-01/W-05, 09 §5.1); custody holders before/after, the parking driver of an early request, the repark holder and the collector (summary only). Staff users are reached through the venue room. Incident-caused updates: supervisors only. — 07 §4.3, 09 §5.1, 14 §3. |
| DEC-PROPOSED-12 | **`sync.required` for shifts** — 11 §8.9 routes `shift.opened` to `pool:{pool}:drivers`, which is always empty when a shift opens (no duty without an open shift); 14 §3.5 adds the supervisors. — Shift open/close: venue supervisors + the pool room (scope `home`), plus at open the `user:` rooms of the drivers with an active assignment at the venue (D-03 waits for the shift) and at close the `user:` rooms of the ended duties (their sockets leave the pool room at once). Event status changes: venue supervisors + the event's pool room (scope `events`). — 11 §8.9, 14 §3.5. |
| DEC-PROPOSED-13 | **One `channel.status` publisher** — the WhatsApp module published it directly and the task asked for a planner. — The notifications realtime planner publishes it from `wa.channel_health_changed` to every staff room of the organization (07 §4.3: admins, every venue's supervisors, every pool's drivers); the direct publish in `setChannelHealth` is removed. — 07 §4.3, 12 §5.14. |
| DEC-PROPOSED-14 | **`job.ws_publish` fallback** — its row carries ids only (`rooms`, the event, its id and aggregate), so the message cannot be rebuilt. — The handler publishes `sync.required {reason: publish_overflow, cause: job.ws_publish}` to the same rooms in chunks of 60 (the clients refetch their snapshot, 11 §9.4); every planner chunks its rooms (60 per NOTIFY) so the fallback is the exception. — DEC-48, 11 §8.11. |
| DEC-PROPOSED-15 | **VAPID configuration** — 05 §8 lists the three variables without rules. — Both keys or none (`EnvError`), the subject `mailto:`/`https:` when keys are set; test → recording sender; keys → web-push; local without keys → recording dev sender; staging/production without keys → disabled sender. — 05 §8, `core/config/env.ts`. |
| DEC-PROPOSED-16 | **Web Push transport** — `web-push`'s `sendNotification` only speaks `https.request` (no hard timeout, no `Retry-After`, untestable against a local http push service of 17 §3.1). — `generateRequestDetails` of `web-push` (aes128gcm + VAPID) and `fetch` with a 10 s timeout. — 05 §4. |
| DEC-PROPOSED-17 | **`incident.updated` is published by the notifications planner** — the incidents module is built in parallel. — From `incident.opened/updated/resolved` (payload `incident_id`), with the `Incident` read fresh and `cause`; the incidents module emits the events and does not publish the message itself. — 07 §4.3, 11 §8.8. |
| DEC-PROPOSED-18 | **Push bookkeeping columns** — `offer_recipients.notified_push_at` (descriptive, 10 §2) is set on the first successful offer/broadcast/reminder push of the recipient, first in the outcome transaction (L7 before L9); `notifications.id` is a backend UUIDv7 (05 §7.1) so rows of one instant keep their order. — 10 §2, 06. |
| DEC-PROPOSED-19 | **PATCH intake has no `ticket.updated`** — 07 lists `[ticket.updated]` for `PATCH /v1/tickets/{ticketId}/intake`, but the command emits no domain event (draft edits are not in canon §7.1) and `cause` is «the causing domain event, if any». — Not published now; proposal: let the use-case call `requestTicketUpdate` with a cause-less update, or keep the S-02 board on `ticket.created` / `ticket.intake_submitted`. — 07 §2.2. |

## 7. Gaps and follow-ups

- No `job.offer_remind` / `job.broadcast_remind` / `job.escalate_unaccepted` handlers exist yet (S4): the reminder and
  broadcast pushes are planned from `offer.reminded` / `task.broadcast_opened` as soon as the dispatch agent emits them
  with the 11 §8 payloads (`recipient_ids`, `recipients[].user_id`, `added[].user_id`, `round_no`). The tests emit them.
- The dispatch realtime (`task.*`, `offer.*`, `driver.state_changed`) is not published here; the dispatch agent must not
  publish `ticket.updated` for ticket events (it is coalesced here).
- Presence-based suppression server-side (DEC-PROPOSED-2) needs schema columns; not added.
- `point_push_send_total` uses the outcome classes of §2 (05 §12.2 names the metric, not its label values).

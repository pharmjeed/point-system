# server-gaps — GAP-9 and the server sweep (metrics, alerts, jobs, routes)

Stream `wave5/server-gaps`, on base `f2a0b2e`. `docs/DECISIONS.md`, `CLAUDE.md`, `state.json`, `tickets.json` and
`STATUS.md` are untouched; the proposals below are numbered `DEC-PROPOSED-n` for the lead (from DEC-365).

## GAP-9 — the WhatsApp quota gauges and their alerts (12 §13, F-03, F-18)

| Place | Content |
|---|---|
| `packages/server/src/modules/audit-monitoring/domain/wa-quota.ts` | The 12 §13 rules as constants and pure functions: 1,000 free service messages a month and the alert at 800 (F-03); 80 % of the messaging limit (F-18); the Meta tier parser (`TIER_50` … `TIER_100K`, `TIER_UNLIMITED`; unknown → the F-18 starting limit 250, `limit_source: assumed`); the dedupe keys; `waQuotaConditions`. |
| `packages/server/src/modules/audit-monitoring/jobs/system-monitor.ts` | `waQuota(tx)`, `waQuotaSnapshot(tx?)` (recomputed at most every `quotaRefreshMs`, 60 s, per process; sets both gauges in the api and the worker) and `evaluateWaQuota(tx)` in the tick that holds the monitor lock; `MonitorReport.quota`. |
| `packages/db/migrations/0005_wa_quota_index.sql` | `ix_whatsapp_messages_accepted (org_id, queued_at) WHERE direction = 'outbound' AND wa_message_id IS NOT NULL` (additive; 06 ERD updated). |
| `packages/server/src/modules/whatsapp/infra/channel.ts` | `phoneNumberFacts` / `storePhoneNumberFacts`: the quality rating and the messaging limit of `GET /{phone_number_id}` (`whatsapp_business_manager_messaging_limit` before the legacy `messaging_limit_tier`, 12 §3.1). |
| `whatsapp/application/sender.ts` (probe), `whatsapp/application/templates.ts` (sync) | Both store those facts on the channel; the sync reads the number in its network phase, best effort (a failed read never fails the sync), audit metadata `number_status` (a key with «phone» would be redacted whole). 07 §2.7 and the openapi description say so. |

Definitions (exactly as 12 says):

- **Service messages this month** — outbound `session_text` rows (W-09 … W-12, and W-05 when it falls back to a session
  text, 12 §8.4) that the provider accepted (`wa_message_id` set) and that did not end `failed`, on the organization's
  active channel (F-03: per business number), `queued_at` since the start of the calendar month in Asia/Riyadh.
- **Unique users outside the window in 24 h** — distinct customers sent a template (accepted, not `failed`) in the
  rolling 24 h, whose send had no inbound message from that customer in the 24 h before it (F-04: the window opens with
  the customer's message; an inbound exactly 24 h old no longer counts), for the whole organization (F-18: per
  portfolio). A QR link therefore never counts (the customer wrote first, 12 §7.2); a direct link does.
- The gauges carry the highest organization's value (one active channel per organization; V1 has one organization).
- Cost: one short transaction per minute and process with `SET LOCAL jit = off` (see the observation below); with
  500,000 messages the two counts take ≈ 100 ms together (measured on PostgreSQL 16, `point_srvgaps_explain`).

Alerts: a holding condition is raised as `wa_send_failed` (warning, no Push) for every venue with an open or closing
event plus the venues already alerted (DEC-46), ticket-less, details refreshed while it lasts; an ended condition (the
month changed, the 24 h count fell under the threshold, the limit rose or became unlimited, the channel changed) is
resolved automatically (`resolved_by` NULL). A supervisor's resolution holds: the service alert is not raised again in
its month (the month is in its key), the messaging-limit alert not for 24 h.

Tests: `packages/server/test/wa-quota.test.ts` (6, unit: tiers, thresholds, keys, details without PII, the phone-number
facts), `packages/server/test/wa-quota-monitor.int.test.ts` (6: the month boundary at midnight Riyadh, per number,
failed/unaccepted/skipped excluded; the window rules case by case incl. the exact 24 h edge and the sliding window; the
800 alert per venue, refreshed, a resolution kept for the month, resolved at the new month; the 80 % alert with
`TIER_250`/`TIER_2K`/`TIER_UNLIMITED`/none; the 24 h silence after a resolution; no row without an open event; the
60 s cache), `apps/api/test/wa-quota.int.test.ts` (1: through the real sender and simulator — a direct W-01 counts,
the QR W-01 does not, W-11 and W-10 are service messages, the gauges match), `apps/api/test/wa-channel.int.test.ts`
(+1: the sync stores GREEN / `TIER_2K` and keeps them when the number read fails), `apps/api/test/wa-sender.int.test.ts`
(the probe that brings the channel back stores them).

## Sweep 1 — every metric of 05 §12.2 registered and populated

`packages/server/test/metrics-catalog.test.ts` (unit) parses the 05 §12.2 table and fails when a catalog metric is not
registered with its labels, when something outside the catalog is registered, or when a registered metric is never
set/observed/incremented in the api, worker or server code. Before this stream seven were never populated and one
was wrong in the processes that had not made its transition:

| Metric | Before | Now |
|---|---|---|
| `point_http_request_duration_seconds{route,status}` | never observed (the 2 s request-save target of 15 §10 had no system source for the API path) | `requestContextMiddleware` times every finished response; `route` = method + canon path template of the matched route (`GET /v1/tickets/{ticketId}`), `unmatched` otherwise — never an id |
| `point_dispatch_publish_seconds` | never observed (the rehearsal recorded it, 15 §10's second target) | the realtime relay observes `task.offered`, `task.broadcast`, `task.claimed` and `task.updated` caused by a claim or a reassignment, from the producing transaction's clock instant (`occurred_at`) to the emit — an upper bound of «commit → publish» |
| `point_dispatch_pool_lock_wait_seconds`, `point_db_lock_wait_seconds` | never observed | `lockRows` / `lockOpenDutyByUsers` time every canonical L1–L8 lock; the L1 pool lock goes to both |
| `point_ws_reconnects_total` | never incremented | a session's new socket within 10 minutes of losing its previous one on the same process |
| `point_wa_service_messages_month`, `point_wa_unique_users_24h_outside_window` | never set | GAP-9 above |
| `point_backup_last_success_timestamp_seconds` | registered in the api and the worker, so both exported `0` and a 26 h backup rule (15 §12) would fire on them for good | removed from the process registry: it is the node_exporter textfile of `backup.sh` (DEC-303); the test keeps it out |
| `point_wa_channel_health` | set only by the process that made a transition: the api (and a restarted worker) said `0` = healthy while the channel was down | the SystemMonitor sets it from `whatsapp_channel` in every process |
| `point_wa_webhook_last_received_timestamp_seconds` | set only by the api that received the webhook: `0` in the worker and after every api restart | the SystemMonitor sets it from `whatsapp_inbound_events` in every process (migration `0006`: `ix_whatsapp_inbound_org_received (org_id, received_at)`, which also serves the sender's `wa_webhook_silent` check that scanned the table once a minute) |
| `point_dispatch_offers_total{mode,outcome}` | `created`, `accepted`, `expired` only | `revoked` too (`revokeRound`), as 05 §12.2 lists |

Tests: `apps/api/test/metrics-sweep.int.test.ts` (4: route/status labels with no id, `unmatched`, a refused command;
the locks of a duty start; the publish histogram for the four dispatch messages and none for the others, with the
1.2 s measured; reconnects within and beyond the window, another session not counted),
`packages/server/test/system-monitor.int.test.ts` (+1: channel health 2/1/0 and the last webhook read from the
database), `apps/api/test/dispatch-offers.int.test.ts` (+1 assertion: a break revokes the round → `revoked` + 1).

## Sweep 2 — every alert type with a raising path and its resolution

Checked type by type against 14 §8 (raise → resolution in the code):

| Type | Raised by | Resolved by |
|---|---|---|
| `no_drivers_on_duty` | dispatch pass (`pass.ts`) | the next pass that finds a driver on duty (duty start, break end) |
| `request_unaccepted` | `job.escalate_unaccepted` | accept (`accept-offer.ts`), `task.claimed`/`task.canceled` (AlertAutoResolver), manual reconcile, supervisor cancel |
| `next_task_waiting_long` | `job.next_task_wait_check` | promotion/start/reassign/withdraw/cancel (`tasks.ts`, AlertAutoResolver, `dispatch-ops.ts`) |
| `idle_driver_while_next_waiting` | dispatch pass | the pass (`no_idle_driver`), start/reassign (`tasks.ts`, resolver) |
| `ready_not_collected` | `job.ready_uncollected_check` | handover, repark, cancel after start, manual reconcile |
| `wa_send_failed` | sender, inbound `failed` status, quota (GAP-9) | supervisor ack + resolve; ticket closure (`wa_send_failed:{ticket}:` prefix); quota condition ended |
| `wa_channel_down` | `setChannelHealth(down)` | `setChannelHealth(healthy)` |
| `driver_connection_lost_with_custody` | `job.heartbeat_sweep` | the sweep (online again, custody gone, duty ended) and `custody.changed` (resolver) |
| `handover_code_locked` | handover attempts, claim codes | new code, exception handover, handover, repark, cancel, manual reconcile |
| `inspection_incomplete` | `submit-intake` | inspection completed / exception approved, void, manual reconcile |
| `draft_abandoned` | SystemMonitor, refused discard | submit, discard/void, manual reconcile, the monitor (draft left `received`) |
| `transfer_blocked` | `job.transfer_activate` | transfer completed or canceled (`transfers.ts`) |
| `outbox_lag` | SystemMonitor | SystemMonitor (2 minutes below the threshold, no dead row) |
| `push_failed_repeatedly` | push sender | successful push, new subscription (`me-service.ts`) |
| `task_stuck` | SystemMonitor | SystemMonitor (phase or assignee changed), manual reconcile |
| `wa_webhook_silent` | sender on acceptance (DEC-146) | any processed webhook (`inbound-processor.ts`) |

No missing path. `packages/server/test/alert-catalog.test.ts` (unit) keeps it so: the 14 §8 table equals canon §5.7, its
severities equal `ALERT_SEVERITY`, the multi-venue set equals DEC-46's four, and for every type the server code has a
`raiseAlert({ type })` and a resolution that builds the type's dedupe key.

## Sweep 3 — every job.* with a handler and a producer

All 18 canon §7.2 jobs have exactly one worker handler and at least one producer (a durable timer, an outbox row or a
notification job descriptor); the recurring ones are seeded and reschedule themselves (`job.dispatch_sweep` at queue
entry, `job.heartbeat_sweep` at duty start, `job.retention_purge` by the SystemMonitor). Tests:
`apps/worker/test/handlers.test.ts` (+2: no canon job without a handler; the network jobs run outside a transaction),
`packages/server/test/job-catalog.test.ts` (18: a producer per job type).

## Sweep 4 — every route of 07 served with its documented errors

- `apps/api/test/routes-contract.test.ts` (unit): the report-only check (`ROUTES_COMPLETE=1`) is now strict — every
  canon §9 route but the internal `GET /metrics` is declared by a controller (130 of 131) with its permission, public
  flag and ✓ `@Command`; `GET /metrics` is the internal metrics server (`startMetricsServer`), now tested in
  `metrics-catalog.test.ts` (200 `text/plain` with the catalog and without the backup textfile metric, 404 elsewhere).
- `packages/shared/test/openapi.test.ts` (+3, unit; reader `packages/shared/test/openapi-doc.ts`, no YAML
  dependency): the 131 operations with their responses; every code a response description or `x-error-codes` lists
  is a canon §8 code under the catalog's HTTP status, and every `x-error-codes` entry has its response; every
  operation with a request body (81) documents `413 PAYLOAD_TOO_LARGE`.
- `apps/api/test/openapi-errors.int.test.ts` (2, integration): each of the 130 served routes (`/v1`,
  `/webhooks/whatsapp`, `/health`) is called with dummy ids and an empty body — anonymously, without an
  Idempotency-Key where ✓, and as each seeded role holding its permission (OWN1, ADM1, SUP-R, SUP-RD, DRV1) — and
  every error envelope must be documented for the operation under the status it came with (over 200 route/code pairs,
  none undocumented); then a body over the limit on each of the 81 body routes must answer `413 PAYLOAD_TOO_LARGE`
  with `details.max_bytes` (1 MB JSON, 3 MB raw webhook). The codes a route reaches only with real data stay with
  its module's tests (08 §10).

| Found | Fixed |
|---|---|
| `PAYLOAD_TOO_LARGE` (08 §4.15, DEC-130) is answered by every route with a JSON body, but no OpenAPI operation documented it (the two media routes listed only `MEDIA_TOO_LARGE` under 413) and 07 §2's list of general errors left it out | `'413': PAYLOAD_TOO_LARGE` on the 81 operations with a `requestBody` (`MEDIA_TOO_LARGE \| PAYLOAD_TOO_LARGE` on the two media ones); 07 §2 general errors |
| Its envelope had no `details.max_bytes` (08 §4.15): the Express adapter of Nest 12 hands a body-parser error over as the `cause` of an `HttpException`, so the filter built `{}` | `toHttpAppError` takes `limit` from the cause (1048576, or 3145728 on the webhook) |

## Proposed decisions

- DEC-PROPOSED-1: WhatsApp quota alerts without a canon type — context: 12 §13 gives alert thresholds for
  `point_wa_service_messages_month` (800 of 1,000, F-03) and `point_wa_unique_users_24h_outside_window` (80 % of the
  current messaging limit, F-18); canon §5.7 and 14 §8 have no alert type for a quota (as for a template leaving
  `approved`, DEC-140) — decision: the SystemMonitor raises them as `wa_send_failed` (warning, `reminder` sound, no Push),
  the canonical type for «messages to customers do not reach them», which is what an exhausted quota causes (service
  replies are not delivered after 1,000 without a payment method; templates to new users are refused above the limit),
  and the signal 12 §14 already pairs with the F-18 metric for this case («مقياس F-18 وأخطاء الإرسال»). Rows: one per
  venue with an open or closing event (DEC-46, source §5 «تنبيه موحد للإدارة وجميع المواقع المتأثرة»), no ticket,
  dedupe `wa_send_failed:service_messages_month:{channel_id}:{YYYY-MM}` and `wa_send_failed:unique_users_24h:{channel_id}`
  (they never collide with `wa_send_failed:{ticket_id}:{purpose}` nor with its ticket-closure resolution), details
  `{quota, channel_id, count, threshold, …}` (ids and counts only). Resolution: automatic when the condition ends; a
  supervisor's resolution is kept for the month / for 24 h. Not wanted: `wa_channel_down` (critical with escalation Push,
  and its title «قناة واتساب متوقفة» would be false at 80 %). Proposal for the canon: a dedicated type (e.g.
  `wa_quota_near_limit`, warning, 14 §8 text «اقتربت حصة رسائل مصاف من حدها — فضّل ربط QR والتذكرة الورقية للفائض»), after
  which these rows move to it; until then S-04 titles them «فشل إرسال رسالة واتساب» — affected files: canon §5.7, 14 §8,
  12 §13–§14, 15 §12, `apps/web/src/i18n/ar.ts` (only if a type is added).
- DEC-PROPOSED-2: how the quota counts are defined — context: 12 §13 names the gauges without a query; F-01 bills on
  delivery, F-03 per number and month, F-18 per portfolio and rolling 24 h — decision: as in «Definitions» above:
  accepted-and-not-failed rows (`wa_message_id` set) at `queued_at` (the acceptance time); the window test uses inbound
  `whatsapp_messages.received_at` of the same customer row in the 24 h before the send (`customers.last_inbound_at` keeps
  only the latest); the calendar month in Asia/Riyadh — secondary sources say Meta counts it in the WhatsApp Business
  Account's time zone, Saudi time for «مصاف» (developers.facebook.com was not reachable from this session: re-verify);
  one count per process and minute (`quotaRefreshMs`), alerts by the tick holding the monitor lock — affected files:
  12 §13, 05 §12.2.
- DEC-PROPOSED-3: the messaging limit the alert compares with — context: 12 §3.1 says `messaging_limit_tier` is read from
  `whatsapp_business_manager_messaging_limit` (F-18), but only the `phone_number_quality_update` webhook wrote it and
  nothing wrote `quality_rating` (S-13 showed both empty) — decision: the phone-number probe of the sender (12 §5.14) and
  the template sync (`POST /v1/admin/whatsapp/templates/sync`, best effort in its network phase, DEC-142) store both on
  the channel; without a stored tier the F-18 starting limit (250) is assumed and the alert says `limit_source: assumed`
  — run the sync after Meta raises the limit — affected files: 12 §3.1, 07 §2.7 (done), `whatsapp-production.md` §8 (done).
- DEC-PROPOSED-4: index for the quota counts — context: `whatsapp_messages` only grows (retention clears text, never
  rows) and the counts run every minute in two processes — decision: migration `0005_wa_quota_index.sql`,
  `ix_whatsapp_messages_accepted (org_id, queued_at) WHERE direction = 'outbound' AND wa_message_id IS NOT NULL`, an
  extra object allowed by the catalog check (as `ix_outbox_failed_dead`, DEC-153) — affected files: 06 ERD
  (done), `06_schema.sql` (if the lead wants it there too).

- DEC-PROPOSED-5: what the four «never populated» process metrics measure — context: 05 §12.2 names them with a
  one-line description — decision: `point_http_request_duration_seconds{route,status}`: every finished HTTP response,
  `route` = `METHOD /canon/{template}` of the matched route or `unmatched` (no raw paths: no ids, bounded
  cardinality), `status` = the HTTP status; `point_dispatch_publish_seconds`: from the producing transaction's instant
  (`occurred_at`, the transaction start) to the emit of `task.offered`, `task.broadcast`, `task.claimed` and of
  `task.updated` caused by `task.claimed`/`task.reassigned` — an upper bound of «commit → publish», measured per api
  instance; `point_db_lock_wait_seconds` / `point_dispatch_pool_lock_wait_seconds`: the duration of each canonical
  lock statement of `lockRows`/`lockOpenDutyByUsers` (L1–L8; the L1 pool lock in both); `point_ws_reconnects_total`: a
  session whose new socket opens within 10 minutes (`RECONNECT_WINDOW_MS`) of losing its previous one on the same
  process — affected files: 05 §12.2, 15 §10.
- DEC-PROPOSED-6: process gauges that describe shared state come from the database — context: `point_wa_channel_health`
  and `point_wa_webhook_last_received_timestamp_seconds` were set only by the process that changed them, and an unlabeled
  prom-client gauge reads `0` until set («healthy», «1970») in every other process and after a restart — decision: the
  SystemMonitor sets both from the database on each tick in the api and the worker (the worst health of the active
  channels; the latest `whatsapp_inbound_events.received_at`), the event-time updates stay; migration
  `0006_wa_inbound_received_index.sql` adds `ix_whatsapp_inbound_org_received (org_id, received_at)` for that read and
  the sender's `wa_webhook_silent` check — affected files: 05 §12.2, 06 ERD (done).
- DEC-PROPOSED-7: the backup gauge is not a process metric — context: DEC-303 has `backup.sh` write
  `point_backup_last_success_timestamp_seconds` to a node_exporter textfile; the same name was also registered in the
  api and the worker, which exported `0` on every scrape — decision: the processes do not register it (the catalog test
  enforces it); the backup rule reads the textfile series only — affected files: 05 §12.2 (already says so), DEPLOYMENT
  §12.

## Observations for other owners

- **PostgreSQL JIT.** With JIT on (the server default, `jit_above_cost` 100,000) the first form of the quota query took
  ≈ 1 s on 500,000 rows, 156 ms with `jit = off`: compiling the plan cost five times running it. The monitor turns it off
  for its own transaction; reports and exports may meet the same cost on large tables. Proposal for the deployment:
  `ALTER ROLE point_api SET jit = off; ALTER ROLE point_worker SET jit = off;` (`infra/db/bootstrap-roles.sql`,
  DEPLOYMENT §10) after a measurement on the chosen host.
- **Malformed JSON.** Under Nest 12 a body that is not JSON reaches the filter as a `BadRequestException` without a
  cause, so it answers `422 VALIDATION_FAILED` with empty `details`; the filter's `fields: body / malformed_json`
  branch for a plain body-parser error is no longer reached. 08 asks nothing more (the real client never sends one);
  left as is.
- **A red test on the base.** The full integration run failed once, on `f2a0b2e` already:
  `manual-reconcile-paper-draft.int.test.ts` (f055e9c) expected `payment.recorded` without `cycle_id`, which
  33bcdf8 added later as DEC-285 / 11 §8.7 require. The expectation now carries `cycle_id: null`; no code changed.
- **S-04 and the quota alerts (for the staff UI).** `alertContext()` shows only `details.display_number` or
  `details.driver_name`, so a quota row reads «فشل إرسال رسالة واتساب» with no context and no ticket link. A context
  line from `details.quota` / `count` / `threshold` needs UI copy, best together with the canon type of
  DEC-PROPOSED-1.

## Not done, and why

- A dedicated canon alert type for the quotas: a canon change (§5.7, 14 §8, and a migration widening the
  `alerts.type` check of 06) — proposed as DEC-PROPOSED-1; the rows use `wa_send_failed` until then.
- The other «عتبة تنبيه مقترحة» of 12 §13 (send p95, webhook p50, inbound backlog, orphan statuses, channel health)
  and the «مراقبة» rows of 15 §12 are rules of the external monitoring stack; this repository holds no Prometheus
  rules file. Every metric they read is now exported with a value.
- `wa_webhook_silent` stays evaluated when the sender accepts a message (DEC-146), not by the SystemMonitor.
- `point_ws_reconnects_total` counts a reconnect on the same api process only, and `point_dispatch_publish_seconds`
  starts at the producing transaction's start (an upper bound of «commit → publish») — DEC-PROPOSED-5.
- The billing month of F-03 is counted in Asia/Riyadh; Meta's own documentation could not be read from this
  session (DEC-PROPOSED-2: re-verify before go-live). WhatsApp Manager stays the billing reference.
- The served-errors test reaches each route with dummy ids and an empty or oversized body; the codes a route returns
  only with real data are covered by its module's tests, not re-proven here.

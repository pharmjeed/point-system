# audit-monitoring — PNT-090, PNT-091 (retention), PNT-092, PNT-094 (notes)

Module `packages/server/src/modules/audit-monitoring/` (04 §4.2 item 9). It imports only `core` (and `@point/shared`):
no other module, no S3 client. Registered in `packages/server/src/index.ts`, `apps/api/src/features.ts` and
`apps/worker/src/handlers.ts`. `/v1/admin/org-settings` (the other half of PNT-091) is not here (venues-events).

## Files

| File | Content |
|---|---|
| `packages/shared/src/analytics.ts` | The 15 §7 / §8 catalogs as code: `SERVER_ANALYTICS_PROPERTIES` (one strict zod shape per canon §7.1 domain event, `satisfies Record<DomainEventType, …>`), `CLIENT_TELEMETRY_PROPERTIES` (the 16 client measurements), the 15 §3 denylist `ANALYTICS_PII_DENYLIST`, `findPiiValues`, `TELEMETRY_LIMITS`, `TelemetryBatchSchema`, `parseTelemetryEvent`. Shared so the web client validates with the same lists. |
| `packages/shared/src/settings.ts` | `retentionPolicyEditableSchema` (the six PUT keys, strict) and `RETENTION_POLICY_LIMITS`. |
| `domain/schedule.ts` | `parseDailyCron`, `nextCronRun` (UTC, strictly after), `retentionDedupeKey` → `retention:YYYY-MM-DD`. |
| `domain/retention-rules.ts` | `TECHNICAL_RETENTION` (06 ERD §8.1 durations that are not settings), `retentionCutoffs`, `minusMonths` (day clamped). |
| `domain/monitor-rules.ts` | `isOutboxLagging`, `lagResolvable` (2 min), `TASK_STUCK_THRESHOLD_MIN`, `maskPhonesInText`. |
| `application/analytics-projections.ts` | `PROJECTIONS`: one projector per domain event (71), payload first, then the entity stamps (15 §13.3). Reads only. |
| `application/analytics-projector.ts` | `createAnalyticsProjector()`: the `EventProjector` the dispatcher runs in the transaction that marks a domain-event row `done`. |
| `application/telemetry-service.ts` | `TelemetryIngest.ingest` (`POST /v1/telemetry`) and `recordOfferSeen` (WebSocket `client.offer_seen`). |
| `application/rate-limiter.ts` | `SlidingWindowLimiter` (in-process, injected clock). |
| `application/audit-query.ts` | `GET /v1/admin/audit-log`; `auditEntryView`. |
| `application/outbox-admin.ts` | `GET /v1/admin/outbox`, `POST /v1/admin/outbox/{outboxId}/retry`; `outboxEventView`. |
| `application/retention-policy.ts` | `GET/PUT /v1/admin/retention-policy`. |
| `application/cursor.ts` | `CursorCodec`: HMAC-signed opaque cursors bound to their list (`SESSION_SECRET`). |
| `jobs/retention-purge.ts` | `RetentionPurger`, `retentionPurgeJob` (`job.retention_purge`), `scheduleRetention`, `ensureRetentionScheduled`. |
| `jobs/system-monitor.ts` | `SystemMonitor`: `outbox_lag`, `task_stuck` (StuckDetector), Prometheus gauges, retention schedule bootstrap. |
| `http/*` | `AuditMonitoringAdminController`, `TelemetryController`, query schemas. |
| `audit-monitoring.module.ts` | `AuditMonitoringHttpModule`; `ApiSystemMonitor` (the monitor loop inside the api). |
| `packages/db/migrations/0004_retention_role.sql` | Role `point_retention` and its grants; partial index `ix_outbox_failed_dead`. |

Changes outside the module (all additive):

- `core/hooks/media-objects.ts`: `registerMediaObjectDeleter(fn, bucket)`, `hasMediaObjectDeleter`, `deleteMediaObjects`,
  `deleterForStore(store, concurrency)` — the seam through which the purge deletes objects without importing media.
- `core/alerts/alerts.ts`: `affectedVenueIds()` exported; `raiseAlertForAffectedVenues` accepts a per-venue
  `dedupeKey` function (`outbox_lag:{venue_id}`, 14 §8).
- `core/metrics/metrics.ts`: `point_outbox_dead{type}`, `point_dispatch_eligible_drivers{pool}`,
  `point_tasks_stuck{type}`, `point_analytics_rejected_total{source,reason}`, `point_retention_rows_total{step}`,
  `point_retention_duration_seconds`.
- `core/config/env.ts` + `.env.example`: `MONITOR_INTERVAL_S` (default 10; 0 = off).
- `realtime/realtime-server.ts`: optional `RealtimeDeps.offerSeen` (same pattern as `heartbeat`); `apps/api/src/bootstrap.ts`
  wires it to `TelemetryIngest.recordOfferSeen`.
- `modules/media/http/media-http.module.ts`: `onModuleInit` registers the deleter of the injected `OBJECT_STORAGE`
  (bucket `media`), unregistered on destroy.
- `apps/worker/src/handlers.ts` / `main.ts`: a `services` list (`WorkerService {start?, stop}`) created before the
  dispatcher starts and stopped first on shutdown; the audit-monitoring block (jobs, projector, monitor) and, in the
  media block, the worker's own storage + deleter (the worker has no Nest container).

## Behaviour

### PNT-090 — analytics

**AnalyticsProjector.** For every outbox row whose type is a canon §7.1 domain event (the row's `payload` holds the
full envelope written by `emitEvent`), inside the dispatcher's transaction: dedupe on
`(name, occurred_at, source='server', properties.source_event_id)` → projection → each key checked against its zod
field (an invalid value becomes `null`, counted `invalid_value`; an unknown key refuses the row) → strict parse → PII
scan → insert with `name = type.replace('.', '_')`, envelope venue/event/pool, `actor_role` (users.role for a user
actor, else `customer`/`system`), ticket/task/cycle ids, `app_version = APP_VERSION`. A refused or failing projection is
rolled back to a savepoint, logged and counted (`point_analytics_rejected_total{source="server"}`); the event row still
becomes `done` (15 §13.1), so analytics can never make the outbox lag. Exactly once: a crash before COMMIT redoes it, an
admin retry of a done row finds the dedupe row.

**`POST /v1/telemetry`** (`telemetry.write`, all four roles; no ✓, no audit row, `202` with no body). Order: CSRF →
session → permission → body schema (`VALIDATION_FAILED`: `app_version` printable ≤ 32, `device_id` uuid,
`client_session_id` `[A-Za-z0-9._:-]{1,64}`, 1–50 events, no other key — organization and actor never come from the
body) → raw body > 64 KB → `VALIDATION_FAILED` (`(body)`, `too_large`) → rate 120 events / device / minute, keyed by
user + device (or session) → `429 RATE_LIMITED` with `retry_after_s` and `Retry-After` → `device_id` not an unrevoked
device of the caller → `VALIDATION_FAILED` (`device_id`, `not_owned`). Then each event on its own (dropped, never failing
the batch, counted by reason): `invalid_event` (shape, screen id), `unknown_name`, `denied_property` (15 §3 keys:
phone, plate, code, key slot, spot, notes, reason…), `invalid_properties` (unknown key, type, closed list),
`pii_value` (Saudi phone, six digits — except provider `error_code` — or Arabic text), `out_of_window`
(`occurred_at` outside [now − 24 h, now + 5 min] of `tx.now`), `unknown_reference` (ticket/task/offer outside the
organization or not the caller's). Rows: `source='client'`, `received_at = tx.now`, venue and pool from the open duty
session, role/id from the session, `properties` + `screen`, `client_seq`, `client_session_id`.

**Offer sightings (15 §9.4).** `offer_card_seen` is written only while `offer_recipients.seen_at` is empty, and fills
it, in the same transaction. Two paths share that SQL: the WebSocket `client.offer_seen` (primary; `via: ws`, `mode`
and `eligible_as` from the offer, `receive_latency_ms` = the client's value when sent, else round creation → message)
and the batch (fallback). A second sighting by either path is dropped (`offer_already_seen`).

### PNT-092 — audit viewer and outbox administration

**`GET /v1/admin/audit-log`** (`audit.read`: owner, admin). Filters `entity_type`, `entity_id`, `actor_id`, `action`,
`venue_id` (`SCOPE_VENUE_DENIED` outside scope), `from`/`to` (`from > to` → `VALIDATION_FAILED`), `limit` 1–200
(default 50), signed `cursor` (`PAGINATION_CURSOR_INVALID` when tampered or from another list). Newest first
(`id DESC`). The view has no `ip`/`user_agent`; `before`/`after`/`metadata` pass `redact()` again and phones in `reason`
are masked. Reading writes its own `audit.read` row (filters, count).

**`GET /v1/admin/outbox`** (`outbox.manage`). `status` (repeatable or comma list; default pending, processing, failed,
dead), `type`, `older_than_s` (on `available_at`), `limit`, `cursor`; newest first (`seq DESC`); `payload_preview` is
the redacted payload.

**`POST /v1/admin/outbox/{outboxId}/retry`** (`outbox.manage`, ✓). Row locked; unknown, other organization or bad uuid →
`RESOURCE_NOT_FOUND` (`outbox_event`); not `failed`/`dead` → `INVALID_STATE_TRANSITION` (`allowed_from`). A `job.*` row
with an `aggregate_version` on a versioned aggregate (tickets, tasks, task_offers, duty_sessions, users,
driver_transfers, incidents, events, shifts) whose version moved, or whose aggregate is gone → closed `canceled`
(outcome `canceled_stale`, reason in `last_error`): the stale job is not replayed. A row with a pending twin of its
dedupe key → `canceled` (`canceled_superseded`). Otherwise `pending`, attempts 0, due now, workers notified after
COMMIT. Domain events are always re-queued (their consumers are idempotent). Audit `outbox.manage` with before/after
and the outcome; replays answer the stored response.

### PNT-091 — retention (the org-settings half is not here)

**`GET /v1/admin/retention-policy`** (`audit.read`) — the canon §12 values (defaults when absent), `approved_by_owner`,
`updated_at` = time of the last `retention.manage` audit row. **`PUT`** (`retention.manage`: owner only, ✓) — the six
durations, all required, positive integers ≤ 36,500 days / 1,200 months; stored in `organizations.settings.retention`
with `approved_by_owner = true` (the owner's approval, Q-06); audit before/after. The PUT touches that one section
only: read-modify-write under `SELECT … FROM organizations … FOR NO KEY UPDATE` and `jsonb_set('{retention}')`, every
other section (`/v1/admin/org-settings`) kept as stored. The purge and the monitor also read their section on its own
(`retentionOf`, `outboxLagThresholdS`; the monitor falls back to the 30 s default rather than stop alerting).

**`job.retention_purge`** (mode `external`, payload `{scope:'all'}`, optional `org_id`, `dry_run`, `reschedule`).
Daily at `RETENTION_PURGE_CRON_UTC` (02:00 UTC = 05:00 Riyadh), dedupe `retention:<date>`; the next run is scheduled at
the end of a real run; the SystemMonitor recreates the schedule when none is pending. Per organization, step by step,
each batch (1,000 rows; 10,000 for analytics) in its own short transaction under `SET LOCAL ROLE point_retention`, each
batch with an audit row (`job.retention_purge`, `entity_type` = table, run id, step, counts), then a summary row
(`entity_type = organization`, policy and every step's candidates/applied/failed). Dry run = the same summary with
counts only, nothing changed.

| Step | Rows | Action |
|---|---|---|
| `idempotency_keys` | expired keys | delete |
| `stale_uploads` | `media_assets` still `pending` after `MEDIA_UPLOAD_URL_TTL_S` + 3,600 s (DEC-101) | mark `failed` |
| `photos` | uploaded photos of released tickets older than `photos_days` | delete object, then mark `deleted` (`delete_reason = retention`) |
| `export_files` | `ready` exports past `expires_at` (bucket `exports`) | delete object, then mark `expired` |
| `export_rows` | expired/failed exports older than 90 days | delete |
| `webhook_raw_bodies` / `webhook_events` | processed inbound webhooks older than `wa_raw_days` / `wa_messages_days` | clear `raw_body` / delete |
| `wa_messages` | messages older than `wa_messages_days` (tickets released) | clear text, payload and addresses |
| `notifications` | non-pending notifications older than `wa_messages_days` | delete with attempts |
| `claim_copies` | expired/used/revoked handover codes still holding `code_ciphertext` (DEC-38) | clear |
| `action_tokens`, `link_codes`, `auth_sessions` | expired/revoked beyond 30 / 7 / 30 days | delete |
| `device_push_keys` | devices revoked over 12 months | clear the push triplet |
| `tickets` | released tickets older than `tickets_months` | anonymize: plate, vehicle, notes, key tag, spot note, customer link, custody notes, inspection notes/marks; `version + 1` |
| `alerts` | resolved over 12 months | delete |
| `audit_log`, `analytics_events` | older than `audit_months` / `analytics_months` | delete |
| `outbox_events` | done/canceled > 14 days, failed/dead > 90 days | delete |

*Released ticket* = `delivered`/`voided`, its event `closed`, no `open`/`in_review` incident on the ticket or on its
event (ticket-less incident), and its base — close time or the last such incident's resolution, whichever is later —
before the cut-off. Objects: candidates read outside any transaction (keyset by id), deleted through
`deleteMediaObjects` with no transaction open, then only the rows whose objects are gone are marked; failures are
counted and retried next run; with no deleter registered the step is skipped (`no_object_deleter`). A failing step
makes the job retry with backoff (`RetryableJobError`) after the other steps ran.

### PNT-094 — monitoring

`SystemMonitor.tick()` (every `MONITOR_INTERVAL_S`, in the worker **and** the api so a stopped worker is still noticed;
`pg_try_advisory_xact_lock` lets one process evaluate per tick; off in tests, which call `tick()`):

- **`outbox_lag`** (critical): due = `pending` with `available_at <= now`, or `processing` with an expired lease.
  Raised when the oldest due row is older than `ops.outbox_lag_alert_s` (30 s) or any row is `dead`; one row per venue
  with an open/closing event (DEC-46) plus venues already alerted, dedupe `outbox_lag:{venue_id}`, details
  `oldest_due_age_s`, `threshold_s`, `due_count`, `dead_count`, `below_since`. The first healthy tick writes
  `below_since`; after 2 minutes below the threshold with no dead row it is auto-resolved (`resolved_by` NULL). The
  window lives in the alert row, so any process continues it. Detection bound = threshold + one interval (≤ 40 s).
- **`task_stuck`** (warning, `task_stuck:{task_id}`): retrieve `accepted` > 10 min, retrieve `in_progress` without
  `ready_at` > 20 min, park/repark `in_progress` > 20 min; resolved when the task leaves that phase or changes assignee.
- **Gauges** (05 §12.2): outbox due / oldest / dead per type, open retrieve tasks, open broadcasts and drivers on duty per
  active pool, drivers on duty and not `online` per venue, WhatsApp inbound backlog and lag, DB pool in use.
- Keeps one `job.retention_purge` scheduled.

OpenTelemetry tracing is **not** wired (see DEC-PROPOSED-17).

## For other modules

- Producers: put the 15 §7 inputs you know in the event payload (11 §8 keys first); missing ones are derived from the
  entity stamps the command stored, so keep those stamps exact (`tasks.queued_at/claimed_at/accepted_at/started_at`,
  `retrieval_cycles.requested_at/ready_at/closed_at`, …). Never put a phone, plate, code or key position in a payload.
- payments-reports: register the exports bucket deleter (`registerMediaObjectDeleter(deleterForStore(store), 'exports')`)
  in its module init and in the worker block; until then `export_files` reports `no_object_deleter`.
- web: telemetry must be sent with `fetch(…, {keepalive: true})` and the CSRF headers (`sendBeacon` cannot set them);
  validate with `parseTelemetryEvent` from `@point/shared` before queueing; send `client.offer_seen` with
  `receive_latency_ms` when the card is actually on screen.
- infra: grant the worker's login role membership in `point_retention` (`GRANT point_retention TO <worker login>`) in
  staging and production; without it every purge batch fails (visible as a failed job and `outbox_lag`).

## Tests

- `packages/shared/test/analytics.test.ts` (13, unit): the catalogs equal the 15 §7 / §8 tables parsed from the
  markdown (names, keys, enum values), denylist and strictness, PII scan, batch bounds, the AC1 cases (phone, plate,
  code, claim code, key slot, spot, notes, reason → refused), retention PUT body.
- `packages/server/test/audit-monitoring-rules.test.ts` (12, unit): cron, cut-offs, section-only settings reads,
  monitor rules, phone masking, cursors (tamper, other list), limiter, `deleterForStore` concurrency and failures.
- `packages/server/test/analytics-projector.int.test.ts` (6): all 71 domain events through the real dispatcher → 71
  allow-listed rows with no leak; computed durations; idempotent re-queue; exactly once across a crash; invalid value →
  `null` and a malformed envelope counted.
- `packages/server/test/retention-purge.int.test.ts` (6): dry run counts; real run with a fake deleter (objects deleted
  with no transaction open, held tickets untouched — ticket and event incidents, recent resolution, open event —,
  DEC-101, redaction, anonymization, housekeeping, batch + summary audit rows, idempotent re-run); storage failure and
  missing deleter; the media `InMemoryObjectStorage` through `deleterForStore`; the job through the dispatcher
  (rescheduled `retention:<next date>` at 02:00; a dry run is not rescheduled); role privileges (`point_app` cannot
  delete audit rows, `point_retention` can, and cannot touch `custody_events.reason` or `ticket_events`).
- `packages/server/test/system-monitor.int.test.ts` (8): **the PNT-094 AC** — the worker stopped, a due row ages past
  30 s with the FakeClock, the monitor raises critical `outbox_lag` for RMS and LYL, then auto-resolves 2 minutes after
  the backlog is drained (by another monitor instance); window restart; dead row; advisory lock; gauges; `task_stuck`
  phases; schedule bootstrap.
- `apps/api/test/audit-monitoring.int.test.ts` (14) and `apps/api/test/telemetry.int.test.ts` (9): every route and
  error code (`PERMISSION_DENIED`, `AUTH_UNAUTHENTICATED`, `VALIDATION_FAILED`, `SCOPE_VENUE_DENIED`,
  `PAGINATION_CURSOR_INVALID`, `RESOURCE_NOT_FOUND`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_KEY_REQUIRED`,
  `RATE_LIMITED`), replays, redaction, stale/superseded retries, owner-only PUT, telemetry drops by reason, session
  enrichment, rate limit with the FakeClock, offer sighting dedupe across the batch and the WebSocket.

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

- DEC-PROPOSED-1: analytics catalogs as code — context: 15 §7/§8 are prose tables; the server and the web must apply the same allow-list — decision: `packages/shared/src/analytics.ts` holds both catalogs; a unit test parses the 15 tables and fails on any difference, so 15 stays the source and the code cannot drift — affected files: 15 §7–§9, 05 §3 (`packages/shared`).
- DEC-PROPOSED-2: telemetry errors per batch vs per event — context: 15 §9.2/§9.3 — decision: only batch problems answer (`VALIDATION_FAILED` for shape, > 50 events, > 64 KB, a device not the caller's; `RATE_LIMITED` 120/device/min keyed by user + device); an invalid event is dropped and counted (`point_analytics_rejected_total{source="client",reason}`: invalid_event, unknown_name, denied_property, invalid_properties, pii_value, out_of_window, unknown_reference, offer_already_seen) — affected files: 15 §9, 07 `postTelemetry`, 08.
- DEC-PROPOSED-3: telemetry is not a command — context: canon §9.7 lists it without ✓ — decision: no Idempotency-Key, no audit row, `202` with an empty body, its own transaction — affected files: 07, 09 §3.
- DEC-PROPOSED-4: outbox retry of a stale or superseded job — context: PNT-092 AC «لا آثار قديمة», 04 §6.5 — decision: a `job.*` row whose `aggregate_version` no longer matches (or whose aggregate is gone) is closed `canceled` with the reason in `last_error` and answered `200` (outcome in the audit row), not replayed and not an error, so an operator can clear dead rows and `outbox_lag` can resolve; a row with a pending dedupe twin is closed the same way; domain events are always re-queued — affected files: 07 `retryOutbox`, 04 §6.5, 02 S-13.
- DEC-PROPOSED-5: object deletion order — context: canon §2 (no network inside a transaction), 06 ERD §8.3 — decision: candidates read outside any transaction, objects deleted, then only the rows whose objects are gone are marked in a short transaction; failures retried next run; no deleter → step skipped and reported; the hold is checked at candidate time only (an object already deleted is always marked) — affected files: 06 ERD §8.3, 13/09 §6.
- DEC-PROPOSED-6: retention audit vocabulary — context: «الحذف مدقق», no silent deletes — decision: audit action `job.retention_purge`, one row per batch (`entity_type` = table, run id, step, counts, objects deleted/failed) and one summary per run (`entity_type = organization`, policy, every step); a dry run writes the summary only — affected files: 09 §3 audit actions, 06 ERD §8.
- DEC-PROPOSED-7: database role of the purge — context: 06 ERD §8.3 "a separate role with DELETE on the purgeable tables", PNT-009 append-only — decision: migration `0004_retention_role.sql` creates `point_retention` (member of `point_app`, plus DELETE on the purged tables and UPDATE (`note`) on `custody_events`); the job uses `SET LOCAL ROLE`; each environment grants the worker login membership; plus `ix_outbox_failed_dead` for the monitor — affected files: 06 ERD §8.3, 06_schema.sql §17, 05 (environments).
- DEC-PROPOSED-8: retention PUT bounds and approval — context: canon §12 gives defaults only, Q-06 — decision: all six keys required, positive integers ≤ 36,500 days / 1,200 months, no legal minimums enforced by the server; a PUT sets `approved_by_owner = true`; `updated_at` is derived from the last `retention.manage` audit row — affected files: 07 `RetentionPolicy`, canon §12.
- DEC-PROPOSED-9: what anonymization keeps — context: 06 ERD §8.1, `ck_tickets_paper_serial`, `ck_cycles_whatsapp_requester`, `ck_customers_identifier` — decision: `paper_serial` is kept (required on a non-voided paper ticket); the ticket's `customer_id` is cleared but `customers` rows are not deleted in V1 (WhatsApp retrieval cycles must keep `requested_by_customer_id` and a customer row needs its identifier); customer deletion needs its own rule — affected files: 06 ERD §8.1, Q list.
- DEC-PROPOSED-10: legal hold — context: 06 ERD §8.2 «حجز ما يخص الوقائع المفتوحة» — decision: an `open`/`in_review` incident on the ticket or a ticket-less incident on its event holds every row of the ticket (photos, messages, notifications, tokens, link codes, anonymization); the retention clock restarts at the last resolution of such an incident; tickets of an event that is not `closed` are never touched — affected files: 06 ERD §8.2, 13 (payment disputes are incidents).
- DEC-PROPOSED-11: where the monitor runs — context: PNT-094 AC (stopping the worker must raise `outbox_lag`) — decision: `SystemMonitor` runs in the worker and in the api, one evaluator per tick by advisory lock, interval `MONITOR_INTERVAL_S` (new env key, default 10 s, 0 = off); detection bound = `ops.outbox_lag_alert_s` + interval — affected files: 04 §6.7, 05 §8, 14 §8.
- DEC-PROPOSED-12: what counts as outbox lag — context: 14 §8 "oldest pending" — decision: due rows are `pending` past `available_at` plus `processing` rows whose lease expired (a crashed worker); `dead` rows count as lag until retried or canceled; the 2-minute healthy window is stored in `details.below_since` — affected files: 14 §8, 15 §12.
- DEC-PROPOSED-13: new metric names — context: 05 §12.2 lists some measures without names — decision: add `point_outbox_dead{type}`, `point_dispatch_eligible_drivers{pool}` (on duty, not on break), `point_tasks_stuck{type}`, `point_analytics_rejected_total{source,reason}`, `point_retention_rows_total{step}`, `point_retention_duration_seconds`; `point_drivers_connection_uncertain` counts every state other than `online` — affected files: 05 §12.2, 15 §12.
- DEC-PROPOSED-14: `task_stuck` thresholds — context: 14 §8 names the alert without numbers — decision: retrieve `accepted` 10 min, retrieve `in_progress` without readiness 20 min, park/repark `in_progress` 20 min (constants, not settings), dedupe `task_stuck:{task_id}`, resolved when the phase or the assignee changes — affected files: 14 §8, canon §12 (if they should become settings).
- DEC-PROPOSED-15: one daily purge for all organizations — context: 04 §6.6 `retention:<date>` — decision: one `job.retention_purge` row per day (`scope: all`, on the first organization's row) at `RETENTION_PURGE_CRON_UTC`, rescheduled after each real run and bootstrapped by the monitor; a run per organization inside it — affected files: 04 §6.6, 11 §8.11.
- DEC-PROPOSED-16: stale upload margin (DEC-101) — context: DEC-101 says "TTL plus a safety margin" — decision: 3,600 s — affected files: 06 ERD §8.1, DEC-101 text.
- DEC-PROPOSED-17: OpenTelemetry deferred — context: PNT-094 description; no collector in any environment yet — decision: not wired in V1 code; proposal when an endpoint exists: `@opentelemetry/sdk-node` 0.300.0 with `@opentelemetry/api` 1.10.0, `sdk-trace-node` 2.12.0, `exporter-trace-otlp-http` 0.300.0, `instrumentation-http` 0.300.0, `instrumentation-pg` 0.77.0, `instrumentation-express` 0.72.0 (versions checked with `npm view` on 2026-10-28), enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and a `traceparent` field in the canon §7 envelope so a worker span continues the api span — affected files: 05 §12, canon §7 envelope, 04.
- DEC-PROPOSED-18: projection granularity — context: 15 §13.5 suggests batched projection — decision: one analytics row per event inside the dispatcher's own transaction (exactly once with the row's `done`); a failing projection is rolled back to a savepoint and never blocks the outbox; batching only if load tests (PNT-097) show a need — affected files: 15 §13.
- DEC-PROPOSED-19: provider error codes in the PII scan — context: 15 §7.6 stores Meta error codes, many six digits (`131026`) — decision: the six-digit rule skips keys named `error_code`; the phone and Arabic rules still apply — affected files: 15 §3, §15.
- DEC-PROPOSED-20: WebSocket offer sighting — context: 15 §9.4 (the WS path writes the row in the same transaction), 07 §4 gives `{offer_id}` only — decision: `client.offer_seen` may also carry `receive_latency_ms`; the gateway calls `RealtimeDeps.offerSeen` (audit-monitoring) which fills `seen_at` once and writes `offer_card_seen` (`via: ws`, mode and eligibility from the offer, latency from the client or round creation → message); the ack stays `{ok: true}` — affected files: 07 §4, 15 §9.4.
- DEC-PROPOSED-21: sensitive keys in 11 §8 payloads — context: `enqueue` refuses payload keys that look sensitive; 11 §8.2 `TicketReady` lists `code_expires_at` — decision: rename it (e.g. `claim_expires_at`) or exempt `*_expires_at` in core — affected files: 11 §8.2, core outbox writer (tickets-custody).
- DEC-PROPOSED-22: telemetry transport — context: the CSRF headers (DEC-29) cannot be set on `navigator.sendBeacon` — decision: the web sends telemetry with `fetch` `keepalive: true` — affected files: 05 (PWA), 15 §9.1.
- DEC-PROPOSED-23: list cursors — context: 07 §1.7 opaque cursors — decision: HMAC-signed with `SESSION_SECRET` and bound to their list; anything else → `PAGINATION_CURSOR_INVALID`; reading the audit log writes an `audit.read` row (09 §3) — affected files: 07 §1.7, 09 §3.

## Not done here

- `GET/PUT /v1/admin/org-settings` (venues-events / lead).
- Deleting `customers` rows (DEC-PROPOSED-9) and their WhatsApp identities.
- OpenTelemetry tracing and dashboards (DEC-PROPOSED-17).
- PNT-090 AC2 ("every tracked action emits its event in an end-to-end run") can only be run once the producing
  commands (S2–S7) and the web client exist; the projector side is complete for all 71 event types.

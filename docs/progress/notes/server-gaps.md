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

## Observations for other owners

- **PostgreSQL JIT.** With JIT on (the server default, `jit_above_cost` 100,000) the first form of the quota query took
  ≈ 1 s on 500,000 rows, 156 ms with `jit = off`: compiling the plan cost five times running it. The monitor turns it off
  for its own transaction; reports and exports may meet the same cost on large tables. Proposal for the deployment:
  `ALTER ROLE point_api SET jit = off; ALTER ROLE point_worker SET jit = off;` (`infra/db/bootstrap-roles.sql`,
  DEPLOYMENT §10) after a measurement on the chosen host.

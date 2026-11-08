# Chaos and self-healing — PNT-098 (17 H-03, 17 §12, AC-06)

`pnpm ops:chaos` breaks the system on purpose — process kills at named points, the database, the WhatsApp
provider, the Push service, the worker — and checks what must still hold. Every scenario gets its own database
(`point_chaos_<scenario>_<run>`, dropped afterwards unless `--keep-db`), seed, WhatsApp simulator, api and worker,
started from the production build as child processes on ports 4120–4199.

```bash
PATH=/opt/node24/bin:$PATH pnpm ops:chaos                       # every scenario (~27 min)
pnpm ops:chaos --only kp1,kp2,kp3,kp4,kp4_silent,kp5,kp6,kp7,kp8,kp9   # the kill points (~6 min; CI on pushes to main)
CHAOS_DB_OUTAGE_S=20 pnpm ops:chaos --only db_outage --no-build # a shorter outage while iterating
```

Results: `results.json` and `report.md` in the output directory (`--out`, default `$TMPDIR/point-chaos-<run>`), the
logs of every process under `<out>/<scenario>/`. The exit code is 0 only when every check of every scenario passed.

## Kill points (17 H-03)

`CHAOS_KILL_AT=<point>` arms one point in one process (`packages/server/src/core/chaos/kill-points.ts`): when the
code reaches it the process writes one line on stderr and kills itself with SIGKILL — no exit handler, no response,
no transaction finished (a container runtime reports exit code 137). The variable is read only outside production:
`APP_ENV=production` never arms a point, a production process refuses to boot with the variable, and any process
refuses an unknown point name. The harness arms the point on a restart, waits for the death, restarts the process
without the variable and verifies:

| Scenario | Point | Process | Verified (TC) |
|---|---|---|---|
| `kp1` | `webhook_after_store_before_ack` | api | the press stored, no 200; Meta's redelivery is deduplicated by `body_sha256`: one inbound row, one cycle, one retrieve task, one W-02 (TC-013) |
| `kp2` | `inbound_after_cycle_commit` | worker | the cycle committed, the event still `pending`; after the lease (10 s in these runs) the job runs again: still one cycle, one inbound message, one W-02, the job `done` with 2 attempts (TC-014) |
| `kp3` | `outbox_after_lock_before_send` | worker | the `job.wa_send` row left `processing`; the next run sends once, same row `done` with 2 attempts (TC-015) |
| `kp4` | `wa_send_after_provider_ok_before_done` | worker | the provider holds W-02, the database no `wa_message_id`; the status webhook (`biz_opaque_callback_data`) proves the acceptance: no resend (TC-016) |
| `kp4_silent` | same, without status webhooks | worker | after `CRASH_WAIT_MS` one more attempt: exactly one duplicate, recorded as attempt 2, never a third; no operational effect repeated (TC-016) |
| `kp5` | `accept_after_commit_before_response` | api | the accept committed with its answer stored under the key, the client got nothing; the same key replays 200 (`Idempotent-Replayed`) twice; one assignment, one `task.claimed` (TC-017) |
| `kp6` | `payment_webhook_after_commit_before_done` | worker | V2 (DEC-561): a 3-D Secure payment completed at the payment simulator; the worker dies with the payment `paid` and its webhook job `processing`; after the lease the job runs again (attempts 2) and does nothing; the gateway's redeliveries are stored once per `event_id`; one `online_payment.paid`, one invoice, the ticket collected once |
| `kp7` | `online_payment_after_gateway_ok_before_record` | worker | V2: a subscription's period moved to end now; the renewal is charged at the gateway and the worker dies before recording it (the row `initiated`, no gateway id); after the restart the same `given_id` reaches the gateway, which charged once: one payment for the period, `paid`, two periods, one invoice |
| `kp8` | `invoice_issued_before_commit` | api | V2: the api dies inside the transaction that issues the invoice of a paid visit; nothing of it committed; the app's retry with the same key answers the same payment `paid` with one invoice; then ten customers pay at once: each series one gapless chain (icv 1..n, previous_hash, `invoice_series`), no number twice |
| `kp9` | `settlement_after_operator_commit` | worker | V2: `job.settlement_monthly` for the previous month dies after the first operator's statement; after the lease every operator has one statement, the first one recomputed to the same lines and total, `settlement.generate` once per operator |

The V2 scenarios (`infra/chaos/v2.mjs`) run on a stage with the payment simulator as a fourth process (port base + 40)
and the e-invoicing simulator inside the api and the worker.

## Outages (17 §12)

| Scenario | How | Verified |
|---|---|---|
| `db_outage` | every backend of the database terminated, then `ALLOW_CONNECTIONS false` + terminated for `CHAOS_DB_OUTAGE_S` (60) — only the run's own database. This is 17 §12's «إيقاف الحاوية مؤقتًا» read as a stop and a start: a fast shutdown ends the sessions and the port refuses connections | reads, readiness and commands answer `503 SERVICE_UNAVAILABLE` with `Retry-After: 2` (never 500); a connected socket's heartbeat acks `SERVICE_UNAVAILABLE` and the device keeps its session (no `session.revoked`, not disconnected); no key kept, the same key runs the command once afterwards; the press made during the outage is redelivered until stored (no request lost); the offer expiry and the escalation due during the outage run once afterwards; api and worker survive |
| `db_freeze` | the same words read as `docker pause`: the api and the worker reach the database through a relay (`startFreezeProxy` of `@point/server/testing`) that accepts connections and bytes and answers nothing for `CHAOS_DB_FREEZE_S` (60) | the `db_outage` expectations, each answer within the PWA's 10 s request timeout: the bounded waits of DEC-PROPOSED-8 (connect `DATABASE_CONNECT_TIMEOUT_MS`, read = statement timeout + 2 s, readiness 2 s) |
| `wa_outage` | the simulator's `channel_down` (Graph `190`) for `CHAOS_WA_OUTAGE_S` (600: the 10 minutes of 17 §12) | `wa_channel_down` raised at the first failure, internal operations go on (requests, accept, start, ready, exception handover); nothing reaches the customers meanwhile; after the recovery each ticket receives only its current state (ready → W-05, delivered → W-06, requested → W-02), the rest skipped `superseded`; the alert resolves itself (TC-WA-22) |
| `wa_outage_temporary` | Graph `131016` for `CHAOS_WA_TEMP_OUTAGE_S` (180) while a request arrives every 20 s | `down` after the 2-minute failing streak, `wa_channel_down`, operations go on; after the recovery **every** request — the earliest included — received exactly the message of its current state (ready → W-05, requested → W-02) and no status message ended `failed`: the W-02 that ran out of the 5 attempts before `down` were held while every attempt of the channel failed (DEC-PROPOSED-6) |
| `push_outage` | the test Push service (17 §3.1, a local endpoint behind real VAPID web-push) stopped | `push_failed_repeatedly` after `push.max_consecutive_failures`, the failures counted on the device, the offer accepted meanwhile; after the restart a push succeeds, the counter resets and the alert resolves |
| `worker_stop` | the worker stopped `CHAOS_WORKER_STOP_S` (120) | webhooks still acknowledged; `outbox_lag` raised by the api's monitor; after the restart the stored press becomes a request, the backlog drains and the escalation due meanwhile runs once |
| `worker_x3` | two more workers on the same outbox, 4 drivers delivering 8 requests | every message sent once per customer, no lease lost at completion, the three workers shared the rows |

Not covered here: the PWA side of 17 §12's database row («الواجهة غير متصل/قديم»). The staff board's stale banner
on a 503 is an e2e case (`apps/web/e2e/staff-outage.spec.ts`); the driver screens' service-unavailable state
(02 D-15 ح) belongs to the PWA.

Test knobs: `WORKER_LEASE_SECONDS=10` (production 30) so a dead worker's rows come back sooner;
`RATE_LIMIT_AUTH_PER_MIN=600` (one address signs every actor in); the simulator redelivers a failed webhook 8 times
(1 s doubling), standing in for Meta's days of retries.

# load-chaos — PNT-097 (load), PNT-098 (chaos), heartbeat fixes

Stream `wave4/load-chaos`. `docs/DECISIONS.md`, `state.json`, `tickets.json` and `STATUS.md` are untouched; the
proposals below are numbered `DEC-PROPOSED-n` for the lead. Evidence: `docs/test-evidence/load/2026-10-29.md`,
`docs/test-evidence/chaos/2026-10-29.md`. The second half of the stream answers two reviews (see «Review
responses»).

## What was built

| Place | Content |
|---|---|
| `packages/server/src/core/chaos/kill-points.ts` | 17 H-03 kill points (`KILL_POINTS`, `killPoint`, `armedKillPoints`, `unknownKillPoints`, test seam `configureKillPoints`/`resetKillPoints`). SIGKILL after one synchronous stderr line. Placed in `webhook-intake.ts` (KP-1), `inbound-processor.ts` (KP-2), the `job.wa_send` handler (KP-3), `sender.ts` (KP-4), `http/interceptors.ts` (KP-5). `deploymentProblems` refuses an unknown point name outside production (production already refused the variable). |
| `packages/server/src/core/errors/pg-constraint-map.ts` | `isDbUnavailableError` / `dbUnavailableError`: SQLSTATE 08/53/57P0x, 55000 «not currently accepting connections», pg's «Connection terminated…», pool connect timeouts and the client read timeout («Query read timeout») → `SERVICE_UNAVAILABLE` (Retry-After 2). Socket errnos (ECONNREFUSED, ECONNRESET, EPIPE…) count only on errors raised by the database layer (`markDbError`, set by `Database`/`Tx`), and an HTTP error object (numeric `status`) never counts. Used by the exception filter, the command runner (before `isPgError`: `EPIPE` looks like a SQLSTATE) and the Socket.IO handshake / heartbeat ack. |
| `packages/server/src/core/db/database.ts`, `tx.ts` | bounded waits (DEC-PROPOSED-8): `connectionTimeoutMillis` = `DATABASE_CONNECT_TIMEOUT_MS` (5000); a client read timeout of the statement timeout + 2 s on every query (pool default; per statement in `Tx` from the transaction's own statement timeout); a broken or timed-out transaction connection gets no ROLLBACK and is destroyed (`release(err)`); `Database.ping(ms)`; `listenClientConfig(name)` for the LISTEN clients. |
| `packages/server/src/http/health.controller.ts` | `/health/ready` answers within `READY_TIMEOUT_MS` (2 s). |
| `packages/server/src/realtime/realtime-server.ts` | only an AUTH_* rejection revokes a socket's session; an unreachable database is thrown to the caller (heartbeat ack `SERVICE_UNAVAILABLE`, the 60 s sweep `revalidateAll` keeps the socket); bounded LISTEN client. |
| `packages/server/src/core/outbox/dispatcher.ts` | bounded LISTEN client (a frozen database no longer holds `start()`), error listener attached before connecting. |
| `packages/server/src/modules/whatsapp/application/sender.ts` | DEC-PROPOSED-6 (a): a template whose temporary attempts run out while every attempt of the channel has been failing since its first one is held (not counted, 30 s) instead of failed, for at most 15 minutes from its first attempt. |
| `packages/server/src/testing/freeze-proxy.ts` | `startFreezeProxy`: a TCP relay that freezes (accepts connections and bytes, answers nothing) — the integration tests and `pnpm ops:chaos` use it. |
| `identity-access` heartbeat | no `duty_sessions.version` bump; `POST /v1/me/heartbeat` ignores an Idempotency-Key (`CommandMeta.ignoreKey`). |
| `infra/harness/*.mjs` | shared by load and chaos: dependency resolution from `apps/api`/`packages/db` (no lockfile change), process envs (random secrets, brand from `.env.example`), child processes from `dist/` with logs and `/proc` sampling, fresh `point_load*`/`point_chaos*` databases only, the production migrator, the harness seed (dev seed + venues/drivers/supervisors), a staff API client (CSRF, keys, TOTP, Socket.IO, `Retry-After`), the consistency queries. |
| `infra/load/run.mjs`, `bots.mjs`, `k6/webhooks.js`, `README.md` | `pnpm ops:load` (17 H-08); the AC-13 verdict requires complete M1/M2 samples and no socket issue in the measured window. |
| `infra/chaos/run.mjs`, `README.md` | `pnpm ops:chaos` (17 H-03, §12): 13 scenarios by default with the 17 §12 durations (database 60 s stopped and 60 s paused, WhatsApp 10 min, worker 2 min). |
| `.github/workflows/ci.yml` | job `chaos` on pushes to main: KP-1 … KP-5 + `kp4_silent` against the production build, report uploaded. |
| `package.json` | `ops:load`, `ops:chaos`. |

## Tests

- `apps/api/test/heartbeat.int.test.ts` (4): HTTP and socket heartbeat back online without a version bump (through the
  real `job.heartbeat_sweep`); the key ignored (200, nothing stored, a repeat is fresh, a malformed key ignored, the
  body still validated); ✓ routes still require their key.
- `apps/api/test/db-outage.int.test.ts` (4): the test database really refuses connections and its backends are
  terminated: reads, commands, `/health/ready` and the socket handshake answer `SERVICE_UNAVAILABLE`; after the
  recovery the same key runs the command once, then replays it; a connected socket keeps its session through the
  cut (heartbeat ack `SERVICE_UNAVAILABLE`, the sweep undecided, no `session.revoked`, still connected, heartbeat
  OK after the restore — fails on the previous code); a really revoked session is still revoked on its socket;
  terminated backends alone are survived.
- `packages/server/test/db-freeze.int.test.ts` (3) and `apps/api/test/db-freeze.int.test.ts` (1): a database behind a
  freezing relay — the read timeout, the connect timeout, a full pool's slot, a transaction frozen half-way failing
  after one read timeout with no backend left open, the pool usable at once after the thaw; through the real routes
  a read, readiness, a command and the socket heartbeat answer `SERVICE_UNAVAILABLE` within the PWA's 10 s, no
  `session.revoked`, the same key runs once after the thaw.
- `apps/api/test/wa-sender.int.test.ts` (+3): the provider outage outlasting the attempts (held past 85 s, `down` at
  2 min, after the recovery the current W-04 sent and the superseded one skipped — fails on the previous sender);
  the counter-case (another message goes through) still fails after 5 attempts with `wa_send_failed`; the bound
  (every send failing while the probe passes: held, then `failed` + `wa_send_failed` after 15 minutes — fails
  without the bound).
- `packages/server/test/db-unavailable.test.ts` (4), `packages/server/test/kill-points.test.ts` (7).
- `apps/web/e2e/staff-outage.spec.ts` (2, at 390 px): a 503 on the board's refresh keeps the last snapshot under the
  stale banner, recovery by the next poll and by «إعادة المحاولة».
- `pnpm ops:load` and `pnpm ops:chaos` runs: see the evidence files and the summary below.

## Results

- **PNT-097 (load, AC-13 / TC-039):** see `docs/test-evidence/load/2026-10-29.md` (the run after the review, with the
  coverage checks, and the first run `48ba8732`).
- **PNT-098 (chaos, AC-06 / TC-013 … TC-017, 17 §12):** see `docs/test-evidence/chaos/2026-10-29.md` — all 13 default
  scenarios, `db_freeze` and the strict `wa_outage_temporary` check included.

## Proposed decisions

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | `POST /v1/me/heartbeat` accepts an `Idempotency-Key` and ignores it (never stored or replayed): canon §9 marks it «—» (optional keys are honoured on the other non-✓ routes), the heartbeat is a descriptive refresh that writes no audit row (06 ERD: it changes neither `version` nor availability), and a replayed answer would carry a stale `server_time`. Implemented as `CommandMeta.ignoreKey`; a ✓ command cannot set it. | canon §9, 06 ERD duty_sessions | 07 `POST /v1/me/heartbeat` |
| DEC-PROPOSED-2 | `CHAOS_KILL_AT` (17 §18 proposal) is adopted as a test-only variable: a comma list of H-03 point names; the process dies by SIGKILL (exit 137 under a container runtime) after one stderr line; never armed with `APP_ENV=production`; refused at boot in production and, anywhere, for an unknown name. Placements: KP-1 after the commit of the inbound row; KP-2 after the transaction of an inbound *button* message (the one that opens the cycle) and before `processed`; KP-3 at the entry of the `job.wa_send` handler (row leased, nothing else done); KP-4 after the Graph answer with a `wamid`, before `recordAccepted`; KP-5 after a successful, non-replayed accept committed, before the response is written. | 17 H-03, §18 | 05 §8 (list the variable as test-only), 17 §18 |
| DEC-PROPOSED-3 | A database that cannot be reached answers `SERVICE_UNAVAILABLE` (retryable, `Retry-After: 2`) whatever the driver reports: SQLSTATE class 08/53/57P0x as already in 08 §5, plus the client-side forms without a SQLSTATE (socket errors raised by the database layer, «Connection terminated unexpectedly», pool connect timeout, client read timeout) and 55000 «not currently accepting connections». A socket errno outside the database layer (an aborted request body, another dependency) is not a database outage. The Socket.IO handshake and the heartbeat ack use the same code, and only an AUTH_* rejection revokes a socket's session (07 §4), so a device keeps its session and its socket during an outage instead of reading `AUTH_UNAUTHENTICATED` or `session.revoked`. | 08 §5, 07 §4, 17 §12 | 08 §5 (one row), 07 §4 (handshake errors, `session.revoked` only for a real revocation) |
| DEC-PROPOSED-4 | Load profile measurement (17 H-08): M1's «commit» is observed from outside as the first `task.updated` of the new retrieve task at the venue's supervisor socket (an upper bound; `retrieval_cycles.created_at` is the lower bound); M2 is measured at every other connected driver of the pool; M3 counts every exchange of the measured window including each attempt of the simulator's status webhooks; 409/410 are counted apart. Because socket delivery is at most once (07 §4.5), the verdict also requires complete samples (every press observed, every claimed task seen by every other connected driver of its pool) and no socket issue in the window. The harness seed turns supervisor MFA off (their sockets open without TOTP) and the mandatory inspection photos off (the direct-to-S3 upload is not part of the profile; no MinIO). | 17 H-08 | 17 H-08 |
| DEC-PROPOSED-5 | Rate limits under load: the run keeps the production limiter (07 §1.9) and raises only `RATE_LIMIT_AUTH_PER_MIN` (600) — the class is keyed by client IP and one generator address signs every actor in, while in production each driver signs in from his own phone (DEPLOYMENT §11.3 already says to raise it behind a shared NAT). Every per-user/per-device class keeps its production value. | 07 §1.9, 05 §8 | 17 H-08 (state it) |
| DEC-PROPOSED-6 (implemented: option a) | WhatsApp provider outage with temporary errors (5xx / `131016`): 12 §5.9 gives a message 5 attempts (1 + 4 + 16 + 64 s ≈ 85 s) and §5.14 turns the channel `down` only after 2 minutes of failing attempts, so the status messages planned in the first ≈ 35 s of an outage ended `failed` before `down` deferred the others — their customers got nothing after the recovery, against source §14 («إعادة إرسال الحالات الحالية فقط بعد عودة الخدمة») and PNT-098 acceptance 2. Decision: when a **template**'s temporary attempts run out while every attempt of the organization's channel has been failing since its first one — no attempt succeeded since, and another notification's temporary attempts failed after the last success (131056, one recipient's pair limit, never counts) — the attempt does not count and the message waits 30 s like a `down` channel (`last_error_code` kept, the 2-minute rule still evaluated); it is sent once the channel works again (the probe and the first real send of 12 §5.14) or skipped by the send-time rules (only the current state, 12 §5.5). The hold lasts at most 15 minutes from the message's first attempt (`HOLD_WINDOW_MS`, the window of the health rules): if every send keeps failing while the phone-number probe passes, the next exhausted attempt then fails as in 12 §5.9 — no endless resend loop (source §14); a long outage that also fails the probe keeps the templates waiting on the `down` channel without attempts, as before (DEC-135). A message that fails alone or while others are delivered keeps the 5 attempts and ends `failed` + `wa_send_failed` (12 §5.9, «لا حلقة بلا نهاية»); session replies are unchanged. Measured: the W-02 of the requests made at 1 s and 21 s into the outage were held, then superseded (the vehicle was ready) and sent. If the lead rejects this, the scenario fails again and the gap is a severity-2 defect (17 §16 «رسائل الحالة لا تُرسل»). Proposed text for 12 §5.9: «استثناء: إذا استُنفدت محاولات قالب مؤقتة وكل محاولات القناة تفشل منذ محاولته الأولى (لا نجاح منذها، وإشعار آخر فشل بعد آخر نجاح) فلا تُعد المحاولة ويُؤجل 30 ثانية كالقناة المتعطلة حتى تعمل القناة أو يتخطاه فحص الحالة، وبحد 15 دقيقة من محاولته الأولى ثم `failed`؛ الرسالة التي تفشل وحدها تبقى بحد 5 محاولات». | 12 §5.9, §5.14, source §14 | 12 §5.9/§5.14, `whatsapp/application/sender.ts` |
| DEC-PROPOSED-7 | Chaos runs use `WORKER_LEASE_SECONDS=10` (production 30) so a killed worker's rows come back sooner; the simulator redelivers a failed webhook 8 times with a doubling delay from 1 s, standing in for Meta's days of retries. 17 §12's «إيقاف الحاوية مؤقتًا» for the database is run both ways: as a stop and a start (`db_outage`: the sessions ended, connections refused for 60 s) and as a pause (`db_freeze`: connections and bytes accepted, nothing answered for 60 s). The WhatsApp outage lasts the 10 minutes of 17 §12. AC-06 (TC-013 … TC-017) runs in CI on every push to main (job `chaos`, ~4 min); the 17 §12 outages (~25 min) run with `pnpm ops:chaos` before a release and on a production-sized staging before the pilot. | 17 H-03, §5, §12, §15.1 | 17 H-03, §5, §12 |
| DEC-PROPOSED-8 (implemented) | A database that stops answering without closing anything — 17 §12's «إيقاف الحاوية مؤقتًا» read as `docker pause`, or a stalled link — was waited for without bound (no `connectionTimeoutMillis`, no `query_timeout`; `statement_timeout` is enforced by the server that stopped). Decision: bounded waits that answer `SERVICE_UNAVAILABLE`: (1) `DATABASE_CONNECT_TIMEOUT_MS` (5000; 0 = none) for a pool slot or a new connection; (2) a client read timeout of the statement timeout + 2 s on every statement (the pool default for reads outside a transaction, the transaction's own statement timeout inside one), after which the connection is destroyed instead of returned to the pool and no ROLLBACK is waited for (the server rolls back the transaction of a closed connection; an unanswered COMMIT is an unknown outcome the client resolves with the same Idempotency-Key, 08 §8.1); (3) `/health/ready` answers within 2 s (the container health check allows 3 s); (4) the LISTEN clients use the same bounds. To weigh: under pool contention a request that waits longer than (1) for a slot answers 503 + Retry-After instead of waiting; a read outside a transaction that runs longer than 7 s now fails 503 instead of finishing late (the reads, reports and retention counts outside a transaction are meant to be short; a long read belongs in a transaction with its own statement timeout, as the exports do with 30 s). Measured with `db_freeze`: read 503 in 7.0 s, readiness 2.0 s, command 5.0 s, heartbeat ack 7.0 s, all checks pass. | 17 §12, 08 §5, 05 §7.4 | `core/db/database.ts`, `core/db/tx.ts`, `http/health.controller.ts`, 05 §7.4 and §8 (one variable, done), `DEPLOYMENT.md` (done) |

## Review responses

Two reviewers, eleven findings (three of them the same defect seen twice). Every finding was verified against the
code before the fix; each fix ships with the test that failed before it.

| # | Finding | Verified | Response |
|---|---|---|---|
| 1 | major — `database.ts`: a paused database is waited for without bound; `db_freeze` opt-in, 13/16 | yes (pool built without connect/read timeouts) | Fixed: DEC-PROPOSED-8 implemented (bounded connect, read and readiness waits; broken connections destroyed). `db_freeze` is in the default set and passes 18/18; `packages/server/test/db-freeze.int.test.ts` and `apps/api/test/db-freeze.int.test.ts` prove it in CI. |
| 2, 9 | major/minor — `wa_outage_temporary` marked pass with a window that skipped the customers who lost their W-02 | yes (`pressed_s > after − 50` excluded the 1 s and 21 s presses) | Fixed both ways: the check now covers every pressed request (exactly its current-state message after the recovery, no status message `failed`), and DEC-PROPOSED-6 option (a) is implemented in `sender.ts` so the early messages are held instead of failed — 8/8. No severity-2 defect remains open unless the lead rejects DEC-PROPOSED-6 (then the scenario fails again, as it should). |
| 3, 7 | minor — `ECONNABORTED` of raw-body (client abort) answered 503 at error level | yes (raw-body 3.0.2 `createError(400, 'request aborted', {code: 'ECONNABORTED'})`) | Fixed at the source of the confusion: socket errnos count only on errors raised by the database layer (`markDbError` in `Database`/`Tx`), and an HTTP error object never counts. The aborted body is 422 `VALIDATION_FAILED` at info again (the reviewers wrote 400; `VALIDATION_FAILED` is 422 in the catalog, which is what it answered before the stream). Unit tests: the raw-body and body-parser shapes, the exception filter's status and log level for both cases. |
| 4 | minor — the UI side of 17 §12 («غير متصل/قديم») not covered | yes | Staff side covered: `apps/web/e2e/staff-outage.spec.ts` (S-02 keeps its last snapshot under «بيانات قديمة — آخر مزامنة …» on a 503 and recovers). Driver side not covered here and listed as such in the evidence: on a 503 the driver home keeps its cached snapshot without a stale or unavailable indication — the D-15 ح «الخدمة غير متاحة» state of 02 belongs to the PWA owner (observation below). |
| 5 | minor — TC-013 … TC-017 not in CI | yes | Fixed: job `chaos` on pushes to main (KP-1 … KP-5 + `kp4_silent` against the production build, ~4 min, report uploaded); DEC-PROPOSED-7 states the split with the long outages. |
| 6 | major — `revalidate` revoked every socket on a database error | yes (reproduced: `session.revoked {reason: admin}` + «io server disconnect») | Fixed: only AUTH_* rejections revoke; anything else is thrown to the caller (heartbeat ack `SERVICE_UNAVAILABLE`, the sweep and the relay keep the socket). `db-outage.int.test.ts` uses the reviewer's cut and fails on the previous code; the chaos `db_outage`/`db_freeze` scenarios now keep a device socket through the outage. |
| 8 | minor — the AC-13 verdict accepted M1/M2 over whatever samples were observed | yes | Fixed: the verdict requires every press observed (stored, cycle created, commit seen), every claimed task's `task.claimed` at every other connected driver of its pool (Σ(pool drivers − 1)), and no socket disconnect or `connect_error` in the measured window (supervisor sockets report theirs too). |
| 10 | minor — the «Retry-After» check never read the header | yes | Fixed: `ApiClient.request` returns `retryAfter`; `db_outage` and `db_freeze` assert `Retry-After: 2`. |
| 11 | minor — `c6a93cb` conflicts with the base's `b0f881a` on `deploy-config.test.ts` | yes | Fixed by rebasing the stream onto the current base and dropping `c6a93cb` (the base already aligned the test with DEC-192); `git merge-tree` against the base is clean. |

## For the lead

- CLAUDE.md §7 (lead-owned) could list `pnpm ops:load` and `pnpm ops:chaos` beside `pnpm ops:restore-drill`.
- The stream's earlier commit aligning `apps/api/test/deploy-config.test.ts` with DEC-192 was dropped in the rebase:
  the base branch fixed the same test in `b0f881a`.
- New environment variable `DATABASE_CONNECT_TIMEOUT_MS` (default 5000): `.env.example`, 05 §7.4 and the 05 env
  block, the DEPLOYMENT env table are updated; 05 §8's variable table has no database rows to extend.
- k6 is not installed on the build host: v1.8.2 was built with `go install go.k6.io/k6@v1.8.2` through the Go module
  proxy (Docker Hub rate-limited, GitHub release downloads blocked) and passed with `--k6`.

## Observations for other owners (no code change here)

- **Driver PWA during a database outage (web, 02 D-15 ح / 17 §12).** On `503 SERVICE_UNAVAILABLE` the driver home keeps
  showing its cached snapshot with no stale or «الخدمة غير متاحة» indication (`DriverHomePage` renders `home.data`
  whenever it exists; only the staff board has the stale banner). 02 D-15 ح asks for the full-screen state with
  «إعادة المحاولة» and the paper procedure.
- **The 2-minute streak counts across quiet periods (whatsapp, 12 §5.14).** `temporaryHealthRules` takes the first
  temporary failure after the last success within 15 minutes, so a failure, ten quiet minutes without any attempt, then
  one more failure reads as a 10-minute streak and turns the channel `down` at once. «فشل كل المحاولات… لأكثر من
  دقيقتين متتاليتين» is literally true (no attempt succeeded), but a quiet gap may deserve to break the streak.
- **Push to the signed-in device (identity / web PNT-072).** The sign-in creates the session's `devices` row
  (09 §9.5) and `POST /v1/me/devices` links a session only when it has none, so a PWA that registers a device after
  signing in gets an unlinked row that `pushableDevices` (a live session on that device) never targets. The app must
  `PUT /v1/me/devices/{its sign-in device}`, whose id `GET /v1/me` does not return yet (`session.device_id`, proposed
  in `pnt-035.md`, already typed in `apps/web/src/api/types.ts`). The chaos run reads it from `auth_sessions`.
- The heartbeat path still does not resolve `driver_connection_lost_with_custody` itself; the next
  `job.heartbeat_sweep` does (≤ `heartbeat.interval_s`), as in the S4 notes.

# load-chaos — PNT-097 (load), PNT-098 (chaos), heartbeat fixes

Stream `wave4/load-chaos`. `docs/DECISIONS.md`, `state.json`, `tickets.json` and `STATUS.md` are untouched; the
proposals below are numbered `DEC-PROPOSED-n` for the lead. Evidence: `docs/test-evidence/load/2026-10-29.md`,
`docs/test-evidence/chaos/2026-10-29.md`.

## What was built

| Place | Content |
|---|---|
| `packages/server/src/core/chaos/kill-points.ts` | 17 H-03 kill points (`KILL_POINTS`, `killPoint`, `armedKillPoints`, `unknownKillPoints`, test seam `configureKillPoints`/`resetKillPoints`). SIGKILL after one synchronous stderr line. Placed in `webhook-intake.ts` (KP-1), `inbound-processor.ts` (KP-2), the `job.wa_send` handler (KP-3), `sender.ts` (KP-4), `http/interceptors.ts` (KP-5). `deploymentProblems` refuses an unknown point name outside production (production already refused the variable). |
| `packages/server/src/core/errors/pg-constraint-map.ts` | `isDbUnavailableError` / `dbUnavailableError`: socket errors, «Connection terminated…», pool connect timeouts, SQLSTATE 08/53/57P0x and 55000 «not currently accepting connections» → `SERVICE_UNAVAILABLE` (Retry-After 2). Used by the exception filter and the command runner (before `isPgError`: `EPIPE` looks like a SQLSTATE), and by the Socket.IO handshake / heartbeat ack. |
| `identity-access` heartbeat | no `duty_sessions.version` bump; `POST /v1/me/heartbeat` ignores an Idempotency-Key (`CommandMeta.ignoreKey`). |
| `infra/harness/*.mjs` | shared by load and chaos: dependency resolution from `apps/api`/`packages/db` (no lockfile change), process envs (random secrets, brand from `.env.example`), child processes from `dist/` with logs and `/proc` sampling, fresh `point_load*`/`point_chaos*` databases only, the production migrator, the harness seed (dev seed + venues/drivers/supervisors), a staff API client (CSRF, keys, TOTP, Socket.IO), the consistency queries. |
| `infra/load/run.mjs`, `bots.mjs`, `k6/webhooks.js`, `README.md` | `pnpm ops:load` (17 H-08). |
| `infra/chaos/run.mjs`, `README.md` | `pnpm ops:chaos` (17 H-03, §12). |
| `package.json` | `ops:load`, `ops:chaos`. |

## Tests

- `apps/api/test/heartbeat.int.test.ts` (4): HTTP and socket heartbeat back online without a version bump (through the
  real `job.heartbeat_sweep`); the key ignored (200, nothing stored, a repeat is fresh, a malformed key ignored, the
  body still validated); ✓ routes still require their key.
- `apps/api/test/db-outage.int.test.ts` (2): the test database really refuses connections and its backends are
  terminated: reads, commands, `/health/ready` and the socket handshake answer `SERVICE_UNAVAILABLE`; after the
  recovery the same key runs the command once, then replays it; terminated backends alone are survived.
- `packages/server/test/kill-points.test.ts` (7), `packages/server/test/db-unavailable.test.ts` (2).
- `pnpm ops:load` and `pnpm ops:chaos` runs: see the evidence files.

## Proposed decisions

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | `POST /v1/me/heartbeat` accepts an `Idempotency-Key` and ignores it (never stored or replayed): canon §9 marks it «—» (optional keys are honoured on the other non-✓ routes), the heartbeat is a descriptive refresh that writes no audit row (06 ERD: it changes neither `version` nor availability), and a replayed answer would carry a stale `server_time`. Implemented as `CommandMeta.ignoreKey`; a ✓ command cannot set it. | canon §9, 06 ERD duty_sessions | 07 `POST /v1/me/heartbeat` |
| DEC-PROPOSED-2 | `CHAOS_KILL_AT` (17 §18 proposal) is adopted as a test-only variable: a comma list of H-03 point names; the process dies by SIGKILL (exit 137 under a container runtime) after one stderr line; never armed with `APP_ENV=production`; refused at boot in production and, anywhere, for an unknown name. Placements: KP-1 after the commit of the inbound row; KP-2 after the transaction of an inbound *button* message (the one that opens the cycle) and before `processed`; KP-3 at the entry of the `job.wa_send` handler (row leased, nothing else done); KP-4 after the Graph answer with a `wamid`, before `recordAccepted`; KP-5 after a successful, non-replayed accept committed, before the response is written. | 17 H-03, §18 | 05 §8 (list the variable as test-only), 17 §18 |
| DEC-PROPOSED-3 | A database that cannot be reached answers `SERVICE_UNAVAILABLE` (retryable, `Retry-After: 2`) whatever the driver reports: SQLSTATE class 08/53/57P0x as already in 08 §5, plus the client-side forms without a SQLSTATE (socket errors, «Connection terminated unexpectedly», pool connect timeout) and 55000 «not currently accepting connections». The Socket.IO handshake and the heartbeat ack use the same code, so a device keeps its session during an outage instead of reading `AUTH_UNAUTHENTICATED`. | 08 §5, 17 §12 | 08 §5 (one row), 07 §4 (handshake errors) |
| DEC-PROPOSED-4 | Load profile measurement (17 H-08): M1's «commit» is observed from outside as the first `task.updated` of the new retrieve task at the venue's supervisor socket (an upper bound; `retrieval_cycles.created_at` is the lower bound); M2 is measured at every other connected driver of the pool; M3 counts every exchange of the measured window including each attempt of the simulator's status webhooks; 409/410 are counted apart. The harness seed turns supervisor MFA off (their sockets open without TOTP) and the mandatory inspection photos off (the direct-to-S3 upload is not part of the profile; no MinIO). | 17 H-08 | 17 H-08 |
| DEC-PROPOSED-5 | Rate limits under load: the run keeps the production limiter (07 §1.9) and raises only `RATE_LIMIT_AUTH_PER_MIN` (600) — the class is keyed by client IP and one generator address signs every actor in, while in production each driver signs in from his own phone (DEPLOYMENT §11.3 already says to raise it behind a shared NAT). Every per-user/per-device class keeps its production value. | 07 §1.9, 05 §8 | 17 H-08 (state it) |
| DEC-PROPOSED-6 (needs a decision) | WhatsApp provider outage with temporary errors (5xx / `131016`): 12 §5.9 gives a message 5 attempts (1 + 4 + 16 + 64 s ≈ 85 s) and §5.14 turns the channel `down` only after 2 minutes of failing attempts, so one message can never reach the streak on its own, and the messages planned in the first ~60 s of an outage end `failed` (`wa_send_failed`) before `down` defers the others — measured: `down` at 121 s, the W-02 of the requests made at 1 s and 21 s failed, every later one sent after the recovery. The source architecture §14 asks for the current states after the service returns. Options: (a) a temporary failure that would exhaust the attempts while no attempt of the channel has succeeded since the streak began is deferred like `down` (not counted) until the streak ends — the send-time skip rules still leave only the current state; (b) a 60 s streak; (c) keep it and rely on `wa_send_failed` + the supervisor's resend. Proposed: (a). The `190`/account-class outage (12 §11.4 `channel_down`, TC-WA-22) is not affected: it defers at once and passed. | 12 §5.9, §5.14, source §14 | 12 §5.9/§5.14, `whatsapp/application/sender.ts` |
| DEC-PROPOSED-7 | Chaos runs use `WORKER_LEASE_SECONDS=10` (production 30) so a killed worker's rows come back sooner; the simulator redelivers a failed webhook 8 times with a doubling delay from 1 s, standing in for Meta's days of retries. | 17 H-03 | 17 H-03 |

## Observations for other owners (no code change here)

- **Push to the signed-in device (identity / web PNT-072).** The sign-in creates the session's `devices` row
  (09 §9.5) and `POST /v1/me/devices` links a session only when it has none, so a PWA that registers a device after
  signing in gets an unlinked row that `pushableDevices` (a live session on that device) never targets. The app must
  `PUT /v1/me/devices/{its sign-in device}`, whose id `GET /v1/me` does not return yet (`session.device_id`, proposed
  in `pnt-035.md`, already typed in `apps/web/src/api/types.ts`). The chaos run reads it from `auth_sessions`.
- The heartbeat path still does not resolve `driver_connection_lost_with_custody` itself; the next
  `job.heartbeat_sweep` does (≤ `heartbeat.interval_s`), as in the S4 notes.

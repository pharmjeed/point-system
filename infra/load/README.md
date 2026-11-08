# Load profile — PNT-097 (17 H-08, AC-13 / TC-039)

`pnpm ops:load` runs the load profile of 17 H-08 against a **locally started production build** and writes the
measured results. It never touches an existing database: every run creates `point_load_<run>` on the PostgreSQL 16
server of `HARNESS_ADMIN_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`), and drops it
at the end unless `--keep-db`.

```bash
PATH=/opt/node24/bin:$PATH pnpm ops:load                                # the H-08 shape, k6 from PATH if present
pnpm ops:load --k6 /path/to/k6 --out ./load-run                         # explicit k6 binary and output directory
pnpm ops:load --rate 200 --duration 60 --venues 5 --drivers 10 --tickets 220   # a heavier variant
pnpm ops:load --k6 off --warmup 10                                      # quick check without k6
```

## What a run does

| Phase | What happens | Measured |
|---|---|---|
| 0 build + data | `tsc` build of shared, db, server, api, worker and the simulator (`--no-build` skips it); a fresh database, the migrations through `packages/db/dist/cli.js migrate`, then the harness seed (`infra/harness/seed.mjs`: the dev seed + three load halls, 10 drivers per venue, one supervisor per venue). | — |
| 1 processes | `tools/wa-simulator/dist/main.js` (Graph API fake + signed webhooks, Meta-like redeliveries), `node apps/api/dist/main.js` and `node apps/worker/dist/main.js` with `NODE_ENV=production` on ports 4100 (api), 4101/4102 (metrics), 4110 (simulator). The owner signs in (password + TOTP) and syncs the templates through the real admin route. | — |
| 2 prep | Every driver signs in, starts duty and opens Socket.IO on `/ws`; one supervisor socket per venue. 120 WhatsApp tickets go through `POST /v1/tickets` → `PATCH intake` → `submit-intake` (W-01) → `complete-parking`; the run waits until all are `parked` and `linked`. | prep requests (reported apart) |
| 3 warm-up | `--warmup` seconds (120) with 50 connected drivers sending `client.heartbeat` every 15 s. | — |
| 4 burst | `--rate × --duration / 60` «request the car» presses (100) as Meta webhooks signed with the app secret: 70 % uniform over the window, two bursts of 15 % within 2 s; 20 per venue. Sent by k6 (`k6/webhooks.js`) when a binary is available, otherwise by Node with the same plan. | webhook acknowledgement |
| 5 drivers | Each driver accepts an offer or broadcast it can act on after 1–10 s (reserves a next task with probability 0.3), then key pickup, start, ready (0.5–3 s steps), reads the handover code from the simulator (what the customer sees in W-05) and hands over with it (cash for paid events). Drain until every request is delivered or `--drain` (900 s). | accept 409s, every route |
| 6 checks | M1 … M5 of H-08, server-error rate (409/410 counted apart), stuck work, the consistency queries (10 §14.1, 11 §1.7, `infra/backup/consistency.sql`), `pnpm db:invariants`, one message per state per customer. | `results.json`, `report.md` |

### Metrics

| H-08 | How it is measured here | Target |
|---|---|---|
| M1 request save | `whatsapp_inbound_events.received_at` (the webhook) → the first `task.updated` of the new retrieve task at the venue's supervisor socket: the cycle's commit as observed from outside (an upper bound; the `retrieval_cycles.created_at` lower bound is reported too) | p95 < 2 s |
| M2 assignment publish | `tasks.claimed_at` → `task.claimed` received by every other connected driver of the pool (same host clock) | p95 < 3 s |
| M3 server errors | 5xx + network failures over every exchange of the measured window: the driver generator, the presses (k6 `webhook_5xx`) and every attempt of the simulator's status webhooks | < 0.1 % |
| M4 outbox age | `processed_at − available_at` of the rows of the window (all, per kind) and the oldest due row sampled every 2 s | alert at `ops.outbox_lag_alert_s` (30 s) |
| M5 resources | CPU % and RSS of api, worker and simulator from `/proc` every 2 s; database connections per application from `pg_stat_activity` | recorded |
| AC-13 stuck work | after the drain: no open task, no due/failed/dead outbox row, no pending notification, no `task_stuck` / `outbox_lag` alert | none |
| coverage | socket delivery is at most once with no replay (07 §4.5), so a lost sample would hide the slowest case: every press must be observed (stored, cycle created, commit seen) and every claimed task must reach every other connected driver of its pool; no socket may disconnect or fail to connect during the measured window | complete |

## Knobs

| Flag | Environment | Default |
|---|---|---|
| `--rate` | `LOAD_RATE` | 100 presses per minute |
| `--duration` | `LOAD_DURATION_S` | 60 |
| `--venues` / `--drivers` / `--tickets` | `LOAD_VENUES` / `LOAD_DRIVERS_PER_VENUE` / `LOAD_TICKETS` | 5 / 10 / 120 |
| `--warmup` / `--drain` | `LOAD_WARMUP_S` / `LOAD_DRAIN_S` | 120 / 900 |
| `--k6` | `LOAD_K6` | `k6` on PATH; `off` sends the plan from Node |
| `--port` | `LOAD_PORT_BASE` | 4100 (api), +1/+2 metrics, +10 simulator |
| `--seed` / `--reserve` | `LOAD_SEED` / `LOAD_RESERVE_P` | random / 0.3 |
| `--auth-rate` | `LOAD_AUTH_RATE_PER_MIN` | 600 (see below) |
| `--out` / `--keep-db` / `--no-build` | `LOAD_OUT` / `LOAD_KEEP_DB=1` / `LOAD_BUILD=0` | `$TMPDIR/point-load-<run>` |

**Rate limits.** The api runs with the production limiter (07 §1.9, per process). Only the `auth` class is raised
for the run (`RATE_LIMIT_AUTH_PER_MIN=600`): it is keyed by client IP, and the generator signs 55 staff in from one
address within seconds, whereas in production each driver signs in from his own phone (and DEPLOYMENT §11.3 already
says to raise it when many drivers share a venue's NAT). Every other class keeps its production value and is keyed
per user or device; a virtual driver sends far fewer than the 60 commands per minute of the `command` class.

## k6

17 §3.1 names k6 for HTTP and webhooks and a Node `socket.io-client` generator for the 50 drivers (k6's Socket.IO
support is not reliable) — the split used here. Official install options for k6: the Grafana apt/rpm repository
(`dl.k6.io`), Homebrew, the `grafana/k6` image, a release binary from GitHub, or `go install go.k6.io/k6@<version>`.
On the build machine Docker Hub is rate-limited and GitHub release downloads are blocked by the proxy, so k6 v1.8.2
was built with `go install go.k6.io/k6@v1.8.2` through the Go module proxy and passed with `--k6`.

`k6/webhooks.js` also runs on its own against any environment whose app secret you hold:
`k6 run -e PLAN=plan.json -e SUMMARY_OUT=summary.json infra/load/k6/webhooks.js`, where `plan.json` is the file a run
writes to its output directory (`apiBase`, `appSecret`, `startAt`, `presses[].raw`): the raw webhook bodies carry the
real action-token payloads of the W-01 that environment sent.

## In another environment

The harness is self-contained (its own database, processes and simulator). To measure on hardware sized like
production (17 §11: staging), run it on that host with `HARNESS_ADMIN_DATABASE_URL` pointing at a PostgreSQL 16 where it
may create `point_load_*` databases — never the staging database itself: the seed refuses staging and production
(`SeedRefusedError`) and the harness refuses any database not named `point_load*`/`point_chaos*`.

## The V2 profile — `pnpm ops:load:v2` (V2-051, 17 H-08ب, DEC-563)

`infra/load/v2.mjs` measures the customer side of V2 on the same kind of throwaway database (`point_load_v2_<run>`,
dropped unless `--keep-db`) with the production build of the api and the worker, the WhatsApp simulator as the Point
number and the payment simulator (`tools/payment-simulator`) as Moyasar, on ports 4600–4699 (refused if one is taken).

```bash
PATH=/opt/node24/bin:$PATH pnpm ops:load:v2                                           # 200 customers, 100 visits, 100 subscriptions
pnpm ops:load:v2 --customers 40 --visits 20 --subs 20 --drivers 6 --signin-window 15   # the reduced run (~1 min)
pnpm ops:load:v2 --visit-window 10 --no-build                                         # the visits as a burst
```

| Phase | What happens |
|---|---|
| sign-in | `--customers` customers arrive over `--signin-window` s: `POST /v1/customer/auth/otp`, the code read from the simulator as the customer reads it, `POST /v1/customer/auth/verify`; a vehicle, `GET /pass`, `/home`, `/me`, the socket on `/customer` |
| intake | the drivers of the first venue scan the pass of `--visits` customers (`POST /v1/tickets/intake-pass`, O-01) and park; the visit's fee is due |
| visits | over `--visit-window` s each customer pays in the app (90 % frictionless card, 10 % 3-D Secure answered at the simulator, then C-12 polled until `paid`), polls C-12 every `--poll` s and requests the car; driver bots accept, retrieve and hand over with the code the customer reads in C-12 |
| subscriptions | `--subs` customers subscribe (C-09/C-10, a card saved for the renewals) and wait until `active` |
| renewal batch | the worker process is stopped; the production worker (`apps/worker/dist`, every handler and projector) runs inside the harness on a `FakeClock` one minute past the last period end and drains until nothing is due at that clock; every job is timed by type |
| checks | the targets of 17 H-08ب, server errors, stuck outbox rows at the injected clock, the consistency queries, `pnpm db:invariants`, and every line of `api.log` and `worker.log` scanned for a full phone number, a sign-in code or a handover code (`scanLogText`) |

Results: `results.json` and `report.md` in the output directory; exit 1 when a target fails. The same rate-limit
reasoning as above applies: the run raises the per-address `auth` class and the per-user classes, because every
customer and driver signs in from one host.

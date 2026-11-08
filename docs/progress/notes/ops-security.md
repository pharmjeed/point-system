# ops-security — production packaging, PNT-095 (backups), PNT-096 (security hardening)

Operator guide (Arabic): `docs/DEPLOYMENT.md`. Restore drill record: `docs/test-evidence/restore/2026-10-28.md`.

## Files

| File | Content |
|---|---|
| `infra/docker/Dockerfile` (+ `.dockerignore`) | backend image: `node:24-alpine` (`NODE_IMAGE` arg for mirrors), manifests-first install, `pnpm deploy --prod` of api / worker / db (workspace packages copied, their `src`/`test` pruned), user `node`, read-only friendly, `HEALTHCHECK` on `/health/live`; optional build secret `build_ca` for TLS-inspecting proxies |
| `infra/docker/web.Dockerfile` (+ `.dockerignore`) | web image: Vite build of `apps/web` (public `VITE_*` build args), refuses an inline `<script>`, Caddy runtime with `/srv` + Caddyfile |
| `.dockerignore` | root safety net (no `.env`, `.git`, `node_modules`, dumps) |
| `infra/caddy/Caddyfile`, `infra/caddy/conf.d/00-site.caddy` | TLS for `DOMAIN`, one origin (`/v1`, `/ws`, `/webhooks/whatsapp`, `/health/*` → api), `/metrics` → 404, optional same-origin buckets → MinIO, PWA with CSP / HSTS / Permissions-Policy / caching, access log without secrets; `conf.d/*.caddy` hook |
| `infra/compose/docker-compose.prod.yml` | migrate (one-shot) → api + worker → web; read-only, `cap_drop: ALL`, `no-new-privileges`, per-service DB roles, log rotation, CA mount for managed PostgreSQL |
| `infra/compose/docker-compose.{local-db,minio,simulator}.yml` | optional parts as extra `-f` files; `postgres-init.sh`, `minio-init.sh` |
| `infra/db/bootstrap-roles.sql` | roles `point_owner` / `point_api` / `point_worker` (+ groups `point_app`, `point_retention`) and the database, once per environment |
| `infra/backup/backup.sh`, `restore.sh`, `restore-drill.sh`, `consistency.sql`, `drill-activity.sql` | PNT-095 |
| `packages/shared/src/canon/routes.ts` | `RATE_LIMIT_CLASSES`, `RouteDef.rateLimitClass` (method default + 17 listed exceptions) |
| `packages/server/src/core/rate-limit/{token-bucket,policy}.ts` | in-process token buckets; 07 §1.9 class rules from env; IPv6 /64 keys |
| `packages/server/src/http/rate-limit.ts` | `RateLimiter`, `RateLimitGuard` (first guard), `UserRateLimitGuard` (after AuthGuard) |
| `packages/server/src/core/config/env.ts` | rate-limit variables per class, `TRUST_PROXY`, `loadDeployedEnv` + `deploymentProblems` (used by `loadEnvOrExit`) |
| `apps/api/src/app.module.ts`, `bootstrap.ts` | guard registration; `trust proxy` from env; helmet CSP `default-src 'none'` and `X-Frame-Options: DENY` |
| `apps/api/src/cli.ts`, `apps/api/src/ops/create-owner.ts` | `node api/dist/cli.js create-owner` |
| `scripts/check-secrets.mjs` | secrets scan (repo + built web bundle), part of `pnpm lint` |
| `package.json` | `check:secrets`, `audit:prod`, `ops:restore-drill`; lint runs the secrets scan |
| `.github/workflows/ci.yml` | `pnpm audit:prod`, shellcheck, restore drill |
| `.env.example`, `.gitignore`, `docs/05_Tech_Stack_Environment.md` §8 | rate-limit block per class, `TRUST_PROXY` (05 §8 mirrors `.env.example`); ignore dumps, backups, site conf.d |

Tests: `packages/shared/test/rate-limit-classes.test.ts` (3, all 131 routes = `x-rate-limit-class`, classes = 07 §1.9 rows),
`packages/server/test/rate-limit.test.ts` (8), `apps/api/test/deployment-env.test.ts` (7), `apps/api/test/ops-scripts.test.ts`
(3, secrets scan), `apps/api/test/deploy-config.test.ts` (7, Caddyfile and compose values), `apps/api/test/security.int.test.ts`
(14: rate limits by IP / user / device / accept, 429 never stored with the key, IPv6 /64, webhook valve, health free, API
headers, production cookie flags, session fixation, cookie name, stale signed webhook replay), `apps/api/test/create-owner.int.test.ts`
(5: rows, hash = server hasher, first sign-in → secret change → MFA → full owner session, refusals, options).

## Validated here, and how

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int` (PostgreSQL 16.15), `pnpm build` green; `pnpm audit --prod`: no known
  vulnerabilities (full audit: 1 moderate, `esbuild` ≤ 0.24.2 under `drizzle-kit`, dev server only, not shipped — accepted).
- Backend image built with BuildKit from the mirrored `node:24-alpine` (Node 24.22.1): argon2id and sharp (libvips 8.18.7, musl)
  load; `migrate`, `invariants`, the api, the worker and `create-owner` run from the image with `--read-only --cap-drop ALL
  --security-opt no-new-privileges` against the local PostgreSQL.
- Caddy v2.11.7 built from the Go module proxy: `caddy validate` / `caddy fmt` clean; served the built PWA in front of the api
  container: CSP and headers, SPA fallback, immutable assets, missing asset 404 (not index.html), `.map` 404, manifest type,
  `/metrics` 404, http → https, webhook verify token absent from the access log, rate limit through the proxy with a spoofed
  `X-Forwarded-For` (Caddy replaces it: the 11th login is 429).
- Owner bootstrap through the proxy with the image: `create-owner` → login (`__Host-point_sid; HttpOnly; Secure; SameSite`)
  → `AUTH_SECRET_CHANGE_REQUIRED` → secret change → `AUTH_MFA_SETUP_REQUIRED` → TOTP setup/confirm → full owner session →
  Socket.IO over `/ws` (WebSocket upgrade through Caddy).
- MinIO and mc built from source: `minio-init.sh` twice (idempotent), versioned bucket refused, anonymous GET 403; the server's
  own `S3ObjectStorage` with `S3_ENDPOINT=https://<proxy>` path-style: presigned PUT/GET through Caddy, head/get/put/delete,
  signatures stripped from the access log.
- `bootstrap-roles.sql` on PostgreSQL 16 (twice), migrations as the non-superuser `point_owner`, privileges of `point_api` /
  `point_worker` (see DEC-PROPOSED-10), cleanup.
- `pnpm ops:restore-drill` (age and openssl), retention pruning of `backup.sh`, shellcheck 0.11 clean.
- Chromium (headless shell 1243) through Caddy: no CSP violation on `/login`, `/staff/login` and the signed-in staff shell;
  one when a Radix sheet opens (DEC-PROPOSED-8).

Not validated here: pulling `caddy:2.11-alpine`, `postgres:16-alpine`, `minio/*` from Docker Hub (rate-limited; the web image's
final stage and the optional services were exercised with locally built binaries instead), ACME certificate issuance (no public
DNS), a managed PostgreSQL with TLS, AWS S3 CORS/lifecycle, the GitHub Actions steps (runners blocked, DEC-60).

## Proposed decisions (for `docs/DECISIONS.md`, to be numbered by the lead)

- DEC-PROPOSED-1: rate-limit configuration — context: 05 §8 (`RATE_LIMIT_LOGIN_PER_15MIN=10`, `COMMANDS 120`, `READS 600`,
  `WEBHOOK 6000`) vs 07 §1.9 classes (auth 10/min/IP, command 60, write 30, read 300, device 60, export 5/h, accept 20/10 s,
  webhook «no application limit») and 09 §9.2 (follows 07) — decision: 07 wins on the numbers (specialised file); one variable
  per class: `RATE_LIMIT_AUTH_PER_MIN`, `RATE_LIMIT_COMMANDS_PER_MIN`, `RATE_LIMIT_ACCEPT_PER_10S`, `RATE_LIMIT_WRITES_PER_MIN`,
  `RATE_LIMIT_READS_PER_MIN`, `RATE_LIMIT_DEVICE_PER_MIN`, `RATE_LIMIT_EXPORTS_PER_HOUR`, `RATE_LIMIT_WEBHOOK_PER_MIN` (0 = no
  limit), `RATE_LIMIT_ENABLED`; `RATE_LIMIT_LOGIN_PER_15MIN` removed (the per-account part is the lock after
  `security.max_login_attempts`); the webhook keeps a per-source-IP valve (05 §14.3, 04 §5) — affected: 05 §8 (its
  `.env.example` block already updated in this change, with `TRUST_PROXY`), 07 §1.9.
- DEC-PROPOSED-2: limiter design — context: 05 §4 names `@nestjs/throttler` «لكل نسخة» — decision: an in-process token bucket in
  core (no new dependency) driven by `ROUTES.rateLimitClass` (= `x-rate-limit-class`, tested), answering the canon envelope
  `429 RATE_LIMITED` + `Retry-After` + `details.retry_after_s` and `RateLimit-Limit/Remaining/Reset`; subjects: before login the
  client IP (IPv6 by /64), after login the user, `device` by session; per process (N instances → N × limit), the cross-instance
  protections stay in PostgreSQL; a request with a cookie that turns out invalid is not IP-limited (volumetric protection is
  the edge's job); `health` unlimited — affected: 05 §4, 07 §1.9, 09 §8.1.
- DEC-PROPOSED-3: guard order — context: 08 §2 / 09 §8.1 put the rate limit first — decision: `RateLimitGuard` runs first for
  IP-keyed checks; the user/device check runs right after the session and permission guards (the user is known only then), so an
  over-limit authenticated request that also fails CSRF answers `PERMISSION_DENIED` — affected: 08 §2, 09 §8.1.
- DEC-PROPOSED-4: rate limiting in tests — decision: `RATE_LIMIT_ENABLED` unset = on, except `NODE_ENV=test` (the API suites
  send hundreds of requests at one FakeClock instant; same rule as the SystemMonitor); the limiter tests switch it on — affected:
  05 §8.
- DEC-PROPOSED-5: `TRUST_PROXY` (default 1 = Caddy) for Express `trust proxy`; behind a CDN 2 + Caddy `trusted_proxies` —
  affected: 05 §8, §14.2.
- DEC-PROPOSED-6: boot guards for hosted environments (`loadDeployedEnv`, used by `loadEnvOrExit`, api, worker and the CLI):
  staging/production need `SESSION_COOKIE_NAME=__Host-…` + `SESSION_COOKIE_SECURE=true`, an https `APP_BASE_URL`, `API_BASE_URL`
  on the same origin; `WA_GRAPH_BASE_URL` https when live; staging live needs `WA_TEST_RECIPIENT_ALLOWLIST`; `CHAOS_KILL_AT`
  refused in production (17 H-03); a `__Host-` cookie without Secure refused everywhere. Unit tests that only parse keep `loadEnv`
  — affected: 05 §8, §9, 09 §9.3, 17 H-03.
- DEC-PROPOSED-7: headers — decision: API (helmet) CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'` and `X-Frame-Options: DENY` (05 §4 «CSP للـAPI بسيطة»); PWA: the 05 §14.1 CSP plus `object-src 'none'` and
  `wss://{DOMAIN}` in `connect-src` (older Safari does not match ws with 'self'); `Referrer-Policy: no-referrer` for the PWA too
  (05 §14.1 says strict-origin-when-cross-origin; no-referrer keeps presigned URLs out of Referer); `X-Frame-Options: DENY`,
  COOP/CORP same-origin; `.map` not published; a missing `/assets/*` is 404 (never index.html cached as a script) —
  affected: 05 §14.1, DEC-94.
- DEC-PROPOSED-8 (needs a decision): CSP vs Radix — context: `@radix-ui/react-dialog` → `react-remove-scroll` injects an inline
  `<style>` when a Dialog/Sheet opens; `style-src 'self'` blocks it (observed: one violation when the staff menu opens; scroll
  lock of the page behind is lost; nothing else breaks) — options: (a) keep `style-src 'self'` and accept it (current);
  (b) `style-src 'self'; style-src-elem 'self' 'unsafe-inline'` (inline `<style>` elements only, attributes stay blocked);
  (c) a nonce: `get-nonce`'s `setNonce()` in the web app + a per-response nonce in the CSP (needs a templated `index.html`) —
  affected: 05 §14.1, DEC-94, web (03 §3 Dialog/Sheet).
- DEC-PROPOSED-9: self-hosted storage on the app origin — decision: with the MinIO file, Caddy routes `/{S3_BUCKET_MEDIA}` and
  `/{S3_BUCKET_EXPORTS}` to MinIO; `S3_ENDPOINT=https://{DOMAIN}`, path-style; api/worker reach DOMAIN through a network alias of
  the Caddy service (no hairpin); no CORS, CSP stays 'self'; with a managed S3, `STORAGE_ORIGIN` feeds img-src/connect-src and
  the bucket needs CORS for the app origin; minio-init creates an app user limited to Get/Put/Delete on the two buckets and
  refuses a versioned bucket (DEC-128) — affected: 05 §8, §9 rule 4, §14.1, 09 §6.
- DEC-PROPOSED-10: database roles — context: 06 §17 comments, migrations 0002/0004, audit-monitoring note «GRANT point_retention TO
  <worker login>» — finding: a plain GRANT gives the worker login point_retention's DELETE on `audit_log` / `analytics_events`
  at all times (INHERIT is the default; verified on 16.15) — decision: `point_owner` (LOGIN, CREATEROLE, owns the database and
  every object, runs migrations), `point_api` ∈ `point_app`, `point_worker` ∈ `point_app` and ∈ `point_retention` **WITH INHERIT
  FALSE, SET TRUE** (the purge's `SET LOCAL ROLE` works, nothing else can delete); the group roles are created before the first
  migration with ADMIN OPTION for the owner (PostgreSQL 16 grant rules for 0004's `GRANT point_app TO point_retention`); every
  migration that adds a table grants `point_app` explicitly (no default privileges, so a new append-only table is never writable
  by accident) — affected: 06_schema.sql §17 comment, 06 ERD §8.3, docs/progress/notes/audit-monitoring.md, 05 §10.
- DEC-PROPOSED-11: owner bootstrap — context: 09 §2 «أداة التهيئة عند التثبيت فقط» — decision: `node api/dist/cli.js create-owner
  --phone --name [--org-name-ar --org-name-en | --org-id]`: creates the organization when none exists, the owner (`O-0001`, prefix
  O- as in the seed, DEC-53), the active org scope row, an audit row `owner.bootstrap` (actor `system`, `ops.create_owner`), a
  16-character random temporary password shown once, `must_change_secret = true`, no TOTP secret (first sign-in: secret change,
  then MFA setup); argon2id + `AUTH_SECRET_PEPPER` through the server's `SecretHasher`; refuses when the organization already has
  an owner (exit 3; owner recovery stays out-of-band, 09 §9.1) — affected: 09 §2, §10, DEC-78 (owner code prefix).
- DEC-PROPOSED-12: backups — decision: daily `pg_dump -Fc` streamed through age (public recipients on the server, identity
  offline) or openssl AES-256-CBC + PBKDF2 600k (no built-in authentication → `.sha256` sidecar; prefer age); a manifest with
  migrations and row counts taken in the dump's own snapshot (`pg_dump --snapshot`), so every restore is verified row for row;
  local retention 30 days + the first backup of each of 12 months (05 §13), off-site copy to a separate bucket (that bucket may
  use versioning / Object Lock: DEC-128 is about the media and exports buckets); restore = a new empty database,
  `--single-transaction --no-owner`, verify (migrations, counts, `consistency.sql`), then switch; `point_backup_last_success_timestamp_seconds`
  comes from a node_exporter textfile written by the script (no long-running process exports it); drill automated
  (`pnpm ops:restore-drill`, CI) + quarterly on an isolated restore environment — affected: 05 §12.2, §13, 17 H-09, §13.
- DEC-PROPOSED-13: secrets on a single self-hosted server — context: 05 §7.7/§10 expect `sm://` in staging/production;
  `SecretResolver` has no secret-manager adapter — decision: until Q-02 picks a provider with a secret manager, the root-only
  `.env` (0600) with `env://` references is the secret store — affected: 05 §7.7, §10.
- DEC-PROPOSED-14: packaging — decision: one backend image on `node:24-alpine` (sharp musl and argon2 prebuilds verified), user
  `node`, `pnpm deploy` per process (≈ 590 MB on disk, 110 MB compressed; the worker's copy could later share the api's
  dependencies), healthcheck `/health/live` (compose: `/health/ready` for the api, metrics port for the worker, none for migrate);
  web image = Caddy + `apps/web/dist` with VITE_* build args; optional components as extra compose files rather than profiles,
  because compose interpolates the required variables of inactive profiles too (the requested «commented local option» for
  PostgreSQL is `docker-compose.local-db.yml`) — affected: 05 §3, §11, §17.
- DEC-PROPOSED-15: webhook replay window — context: 12 §6 / 17 §10 «إعادة جسم قديم … بلا أثر» — decision: no timestamp window
  (Meta redelivers for up to 7 days, F-08); a correctly signed old delivery is acknowledged and deduplicated by `body_sha256`
  (kept after `retention.wa_raw_days` clears `raw_body`) and `wa_message_id`; a stale button press is governed by the action
  token rules (72 h TTL, `link_version`) — affected: 12 §6.2 (state it).
- DEC-PROPOSED-16: MinIO images — context: the community `minio/minio` and `minio/mc` images are no longer published with
  versioned releases (the Go proxy has pseudo-versions only) — decision: managed S3 recommended for production; the MinIO file
  pins nothing by default and documents `MINIO_IMAGE` / `MINIO_MC_IMAGE` to pin — affected: 05 §9.1, §17.

## Review findings for other owners (no code change here)

- identity-access / core actor loader: `orgScope = role === 'owner' || …` gives the owner the organization scope without an
  active `role_scopes` row, while 09 §2 rule 1 says withdrawing it freezes owner/admin access. `create-owner` writes the row.
- MFA enforcement reviewed: owner/admin always (`mfaRequiredFor`), supervisors per `security.supervisor_mfa_required`, restricted
  sessions blocked outside `auth.self` on every request, `mfa_token` single-use 5 minutes, TOTP step replay blocked,
  `admin_idle_minutes` for owner/admin. Covered by `auth.int.test.ts` and `create-owner.int.test.ts`.
- `security.reveal_phone_per_hour` (Canon §12) and the per-route business limits stay with their modules.

## Owner actions before go-live

Q-01 domain + DNS; Q-02 hosting (server, PostgreSQL 16 managed with PITR and TLS, S3 with a separate backup bucket, region);
generate and keep the secrets and the age identity off the server; Q-03 Meta assets before `APP_ENV=production`; create the first
owner and finish MFA; schedule backups with failure alerting and run one restore drill on the chosen infrastructure (record it);
log/metrics collection; Q-06 retention approval; decide DEC-PROPOSED-8.

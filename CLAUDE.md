# CLAUDE.md — POINT (staff valet platform) + MASAF (customer channel on WhatsApp)

You are building a production valet-parking system for wedding halls and event venues in Saudi Arabia.
This file is your operating manual. The specification lives in `docs/` (Arabic prose, English identifiers) and the identity in `brand/`.

## 1. What you are building

- **One responsive web app (PWA)** used only by staff — drivers, supervisors, admins, owner — branded **«بوينت · POINT»**.
- **One central WhatsApp Business number** for customers, branded **«مصاف · MASAF»**. The customer never opens a web page; the only button in the whole conversation is **«طلب السيارة»**.
- **Backend:** NestJS + TypeScript, two processes from one repo (`api`, `worker`), PostgreSQL 16+ (data, outbox, timers), S3-compatible private storage for vehicle photos, Socket.IO realtime, optional Web Push.
- **Not in scope (V1):** native apps / store publishing, customer web pages, AI, GPS, card processing, subscriptions, per-venue or per-driver numbers, WhatsApp groups, a driver "decline" button.

## 2. Read before writing code

1. `docs/00_Glossary_Canon.md` — **binding names**: tables, enums, events, jobs, WebSocket events, error codes, endpoints, permissions, WhatsApp templates, settings keys, lock order (§14ب), screen IDs.
2. `docs/DECISIONS.md` — decisions `DEC-01…DEC-50` and open owner questions `Q-01…Q-10`.
3. `docs/00_Source_Architecture_v1.2_AR.md` — the original architecture (intent and behaviour).
4. Then the file for the task at hand:

| # | File | Use it for |
|---|---|---|
| 01 | `01_PRD.md` | requirements `FR-*`/`NFR-*`, acceptance `AC-01…AC-22` |
| 02 | `02_Wireframes_Spec.md` | every screen `D-01…D-15`, `S-01…S-13`, WhatsApp `W-01…W-12`, Arabic copy (§8 → `apps/web/src/i18n/ar.ts`) |
| 03 | `03_Design_System.md` | components, tokens usage, RTL, sound, accessibility |
| 04 | `04_Architecture_Flow.md` | modules, command & worker pipelines, sequence diagrams, failure modes |
| 05 | `05_Tech_Stack_Environment.md` | repo layout, libraries, `.env.example`, environments, CI/CD, PWA |
| 06 | `06_ERD_Database_Schema.md`, `06_schema.sql`, `06_schema_invariants_test.sql` | the database (schema.sql is the source of truth) |
| 07 | `07_API_Contract.md`, `07_openapi.yaml` | every endpoint, WebSocket and webhook contract |
| 08 | `08_Error_Codes_Guide.md` | error envelope, every code, UI handling, constraint → code mapping |
| 09 | `09_RBAC_Permissions_Matrix.md` | permissions, scopes, field visibility, sessions/MFA, threat model |
| 10 | `10_Dispatch_Engine_Spec.md` | the dispatch engine: offers, broadcast, accept transaction, next task, timers |
| 11 | `11_State_Machines_Domain_Events.md` | all state machines, transition tables, event payloads |
| 12 | `12_WhatsApp_Integration_Spec.md` | Cloud API, webhook pipeline, linking, templates, simulator |
| 13 | `13_Payments_Settlement_Spec.md` | cash/POS collection, waivers, reversals, settlement |
| 14 | `14_Notification_Matrix_Templates.md` | who gets what on which channel, final Arabic copy, push payloads |
| 15 | `15_Event_Tracking_Plan.md` | analytics events, KPIs with SQL, dashboards, system alerts |
| 16 | `16_Dev_Tickets_Sprint_Plan.md` | **the build order**: sprints S0–S8, tickets `PNT-001…PNT-103`, gates G1–G5 |
| 17 | `17_Test_Acceptance_Plan.md` | test strategy, `TC-###`, race/chaos/device/load designs |
| — | `brand/BRAND_GUIDELINES.md`, `brand/tokens/`, `brand/logo/`, `brand/app-icons/`, `brand/sounds/` | UI identity assets (copy, never redraw) |
| — | `docs/design/README.md`, `docs/design/system/` | the published design system «بوينت · POINT» (Claude Design): every component's look, states and both themes. Read the README first: values come from `brand/tokens`, behaviour and props from 02/03/07 (DEC-49, DEC-50) |

**Precedence when documents disagree:** the canon wins on *names*; the specialised file wins on *details*; the source architecture wins on *intent*. Record any resolution as a new decision (next free number: `DEC-79`) in `docs/DECISIONS.md` and fix the affected file in the same change.

## 3. Non-negotiables (full list: canon §2)

1. The server and PostgreSQL are the source of truth. Never trust the UI, a notification, or a cached screen.
2. Every command checks, **on the server**: organization, venue, shift/duty, role, current assignment, previous state, `version`, and `Idempotency-Key` (required on all ✓ endpoints in canon §9).
3. State change + `ticket_events` + `custody_events` + `audit_log` + `outbox_events` are written in **one transaction**. No network calls (WhatsApp, Push, S3 uploads) inside a transaction.
4. Lock rows in the canonical order L0–L10 (canon §14ب) using `FOR NO KEY UPDATE`; the worker leases outbox rows with `FOR UPDATE SKIP LOCKED`.
5. The business invariants in `06_schema.sql` (partial unique indexes and named `ck_*` checks) are part of the logic: one active movement per driver, one reserved next task per driver, one open retrieval cycle per ticket, one active assignment per driver, one live claim code per cycle, a key slot is never allocated twice, one active WhatsApp channel… **Never drop or weaken them**; map violations to canon error codes (08).
6. Oldest `requested_at` first; offers go to the longest-idle available driver; first server-confirmed accept wins; a busy driver may reserve exactly one next task and never starts a second movement.
7. The handover code is never stored in plaintext, never shown to staff, single use, max attempts, one encrypted copy in `claim_codes.code_ciphertext` only (DEC-38).
8. No customer data, plate, key position or code in lock-screen push payloads (DEC-23). No secrets or full phone numbers in logs or analytics.
9. No silent deletes: cancel / void / reverse with a reason and an audit entry.
10. Times are `timestamptz` UTC; display in `Asia/Riyadh`. Arabic-first RTL UI, Western digits `0-9`.
11. Customer-facing text says **«مصاف»** only; staff UI says **«بوينت»**. Brand names come from `BRAND_*` env vars.

## 4. How to work

- Build **sprint by sprint** following `docs/16_Dev_Tickets_Sprint_Plan.md`. Do not start a sprint behind a gate (G1–G5) until the gate passes.
- One ticket = one branch `pnt-###-slug` = one PR (or one reviewed commit series). Each ticket ships with the tests that prove its acceptance criteria (`docs/17`).
- The first migration is `docs/06_schema.sql` verbatim (Drizzle schema must match it; partial indexes and checks via raw SQL migrations). `docs/06_schema_invariants_test.sql` runs in CI and must stay green.
- Integration tests run on a real PostgreSQL 16 (Testcontainers). Time-dependent logic goes through an injectable `Clock`.
- Pin the latest **stable** versions at implementation time after checking official docs. Do not use version numbers from memory. Minimums: Node.js 24 LTS, PostgreSQL 16.
- Use the WhatsApp simulator (`tools/wa-simulator`) everywhere except the explicitly configured live environment. Never message real customers from dev or staging.
- Copy identity assets from `brand/` (icons → `apps/web/public/icons/`, manifest, sounds → `apps/web/public/sounds/`, tokens → web app). Never redraw or recolour the logos.
- UI components: implement them in code with the names in 03 §3, matching the published design system visually (`docs/design/system/showcase/`, `docs/design/system/screenshots/`). Never import `docs/design/system/components/bundle.js` into the app. Values only from `brand/tokens` (DEC-49, DEC-50).
- If something is missing or contradictory: do not invent silent behaviour. Choose the reading closest to the source architecture, record it as a new `DEC-##`, and update the affected doc in the same change.
- Ask the owner only about genuinely blocking items (`Q-01…Q-10` in DECISIONS.md). Otherwise use the documented defaults and continue.
- At the end of every sprint write `docs/progress/S<n>.md`: done, deferred, test results, open defects with severity (17).

## 5. Definition of Done (summary of 16 §3.2)

Acceptance criteria met · tests at the right layer green in CI · invariants test green · lint + typecheck clean · no new secrets or PII in logs · names match canon/schema · docs updated · Arabic RTL screens checked at 360/390/430 px (for UI tickets) · audit and outbox entries present for every command.

## 6. Repository layout (05 §3)

```
point/
  apps/api        NestJS: /v1, /ws, /webhooks/whatsapp, /health, /metrics
  apps/worker     NestJS standalone: outbox dispatcher, job.* handlers, timers
  apps/web        React + Vite PWA (بوينت): driver, supervisor, admin
  packages/server domain modules + core + use-cases (shared by api and worker)
  packages/shared zod wire schemas, canon enums, error codes, event types, permissions, settings schema
  packages/db     Drizzle schema matching docs/06_schema.sql, SQL migrations, seed
  packages/config shared tsconfig/eslint/prettier
  tools/wa-simulator  fake Graph API + signed webhook emitter
  infra/          docker, compose (postgres16, minio, wa-simulator), k6, CI templates
  docs/           this specification
  brand/          identity assets and tokens
```

## 7. Commands (to be created in S0; keep this section updated)

```
pnpm install
docker compose -f infra/compose/docker-compose.yml up -d   # postgres 16, minio, wa-simulator (file 05)
pnpm db:migrate        # applies migrations (first one = docs/06_schema.sql)
pnpm db:invariants     # runs docs/06_schema_invariants_test.sql
pnpm db:seed           # dev seed = the seed defined in docs/17 (RMS, LYL, DRV1–DRV8, SUP-RD …)
pnpm dev               # api + worker + web + wa-simulator
pnpm test              # unit
pnpm test:int          # integration (Testcontainers, PostgreSQL 16)
pnpm test:e2e          # Playwright (mobile viewports, RTL)
pnpm lint && pnpm typecheck
```

## 8. Git & GitHub

- Remote `origin` is the private GitHub repository created at setup. `main` is always green; never force-push or rewrite it.
- Per ticket: branch `pnt-###-slug` from an up-to-date `main` → commits `PNT-###: …` → push → PR titled `PNT-### — <Arabic title>` with the template in 16 §4 (`gh pr create`) → wait for CI (`gh pr checks --watch`) → squash-merge (`gh pr merge --squash --delete-branch`) → `git pull` on `main`.
- Before PNT-004 adds CI, run the checks locally and paste their results in the PR.
- Keep `docs/progress/STATUS.md` current in every PR: sprint, last merged ticket, next ticket, open blockers. Any new session resumes from it.
- CI minutes on a private repository are limited: CI runs on pull requests and on pushes to `main` only, with `concurrency` cancelling superseded runs.
- Never commit secrets, `.env` files, real customer data, or delivery archives (`*.zip`).

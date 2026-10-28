# ENGINEERING — how code is written in this repository

Binding for every ticket. The specification (`docs/`) decides *what*; this file fixes *how* so that work done in
parallel fits together. When this file and the spec disagree, the spec wins and this file is corrected.

## 1. Layout and imports

```
packages/shared   @point/shared   canon as types: enums, errors (ERROR_CATALOG), events, permissions, ROUTES, settings
packages/db       @point/db       migrations (0001 = docs/06_schema.sql), Drizzle tables, seed (SEED_IDS, SEED_CREDENTIALS)
packages/server   @point/server   core/ (db, locks, idempotency, outbox, audit, errors, actor-context, …), http/ (Nest glue),
                                  modules/<module>/{domain,application,infra,http,jobs}/, use-cases/
apps/api          @point/api      registers controllers: apps/api/src/features.ts (one line per module)
apps/worker       @point/worker   registers job handlers + projectors: apps/worker/src/handlers.ts
apps/web          @point/web      React PWA
tools/wa-simulator @point/wa-simulator
```

- ESM everywhere: relative imports end in `.js`; `module: nodenext`; TypeScript 7 strict + `noUncheckedIndexedAccess`.
- Workspace packages are imported by name (`@point/server`, `@point/shared`, `@point/db/seed`, `@point/db/testing`,
  `@point/server/testing`). The `@point/source` export condition makes tests and typecheck use `src/` directly.
- Module boundaries (04 §4.3): `tickets-custody` never imports `dispatch`; `whatsapp` never imports `dispatch`;
  cross-module flows are use-cases in `packages/server/src/use-cases/` which own the transaction.
- Each module exposes only `modules/<name>/index.ts`. Add **one** export line per module to
  `packages/server/src/index.ts`, **one** Nest module to `apps/api/src/features.ts`, and its handlers to
  `apps/worker/src/handlers.ts`.
- Names are literal from `docs/00_Glossary_Canon.md` and `docs/06_schema.sql`. Wire data is `snake_case` (no camelCase
  mapping layer for DTOs/rows/events). Enum values are imported from `@point/shared`, never retyped.

## 2. A command (state-changing route)

```ts
@Controller('v1/tickets')
export class TicketsController {
  constructor(private readonly startIntake: StartIntakeUseCase) {}

  @Post()
  @RequirePermission('ticket.intake')                // canon §10 — every route has a permission or @Public()
  @Command('POST /v1/tickets')                       // canon §9 ✓ → Idempotency-Key mandatory (default)
  async create(@CurrentTx() tx: Tx, @CurrentActor() actor: ActorContext, @RequestId() requestId: string,
               @Body(zodBody(StartIntakeBody)) body: StartIntakeBody) {
    return created(await this.startIntake.execute(tx, actor, body, requestId));
  }
}
```

- `@Command(op, { idempotent })`: the `CommandInterceptor` opens ONE transaction, claims the idempotency key first (L0),
  runs the handler, stores the response (2xx and deterministic 4xx) before COMMIT, replays it on retries
  (`Idempotent-Replayed: true`, `meta.replayed`). Routes not marked ✓ in canon §9 use `{ idempotent: false }`.
- Inside the use-case, in this order (11 §1.3):
  1. read ids without locks if needed → 2. lock with `lockPools/lockEvents/…/lockDutySessions` (canon §14ب, ascending ids;
     the tracker throws on order violations) → 3. re-check actor policies after the locks (TOCTOU, 09 §8.4) →
  4. guards in 11 §1.2 order (version → state → special guards) → 5. `UPDATE … SET version = version + 1 WHERE id AND version` →
  6. dispatch pass / settle driver if the queue changed (holding L1) → 7. `appendCustodyEvent`, `appendTicketEvent`,
     `audit` (exactly one row per command at least — tests enforce it), `emitEvent(tx, …)` for every domain event.
- Throw `new AppError('CODE', details)` for every rejection (codes from canon §8 only). Use `keepEffects: true` only
  for the documented exceptions (wrong handover code attempts, login failure counters, draft_abandoned alert).
- Never call the network inside a transaction (WhatsApp, Push, S3 uploads). Presigning S3 URLs is local math and allowed.
- **Network, then commit (DEC-96).** A command that needs network or storage work before it can commit (e.g.
  `POST /v1/media/{mediaId}/complete`) does that work in a route guard/preparer that runs after the session and
  permission guards and before the `CommandInterceptor` opens the transaction (`MediaCompletionPreparer`). The phase
  never rejects: it leaves a plan (outcome or error) on the request, and the handler answers it inside the command
  transaction, after L0 and under the normal locks and re-checks, so idempotency is unchanged (a deterministic 4xx is
  stored with the key, a 5xx such as `DEPENDENCY_TIMEOUT` is not). A missing, malformed or already known
  Idempotency-Key skips the phase and lets the interceptor answer. Keep the phase safe to repeat (create-only writes,
  resumable after a commit that failed).
- Time: use `tx.now` (taken once from the injected Clock). Never `new Date()` / `Date.now()` in domain or use-cases.
- Domain events are emitted with `emitEvent`; planners registered with `registerTxPlanner` turn them into notifications,
  WhatsApp jobs and realtime messages before COMMIT (DEC-41, DEC-48). Domain code does not enqueue `job.wa_send` itself.
- Unique-index violations map to canon codes through `core/errors/pg-constraint-map.ts` (08 §5); add new mappings
  there, never catch-and-ignore a constraint you don't own.

## 3. Queries (reads)

- Plain `@Get` handlers with `@RequirePermission(...)`; they may use `@Inject(DATABASE) db` directly (no transaction).
- Scope is part of the query (09 §8.2): filter by `org_id` and `venue_id = ANY(actor.venueIds)`. A resource addressed by
  id and out of scope → its own not-found code (`assertResourceVenue`). A venue named explicitly → `assertExplicitVenue`.
- Return plain objects; the envelope interceptor wraps them in `{ data, meta }`. Lists return `{ data, next_cursor }`.
- Field visibility per 09 §5 (TicketSummary vs TicketDetail, masked phones via `maskPhone`).

## 4. Worker jobs

```ts
export const offerExpireHandler: JobHandler = {
  type: 'job.offer_expire',
  mode: 'tx',                    // DB-only: runs in a tx that first marks the outbox row done
  async handle({ row, tx }) { /* lock in canon order, compare aggregate_version, no-op if stale */ },
};
```

- `mode: 'external'` for network work (Graph API, Push): open short transactions yourself; throw `RetryableJobError`
  or `PermanentJobError`.
- Timers: `schedule(tx, 'job.x', at, { orgId, venueId, dedupeKey, aggregate: { type, id, version } })`. Re-check the
  aggregate version when the timer fires (04 §6.5).
- Payloads carry ids, versions and flags only (never phones, codes, tokens, plates — enqueue rejects sensitive keys).

## 5. Tests

- Unit: `*.test.ts` (vitest project `unit`). Integration: `*.int.test.ts` (project `integration`, real PostgreSQL 16).
  Locally: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:int`.
- `createTestDatabase()` from `@point/db/testing` clones a migrated template (fast). Seed with `seed(pool, { env: 'test' })`
  from `@point/db/seed`; use `SEED_IDS` / `SEED_CREDENTIALS` instead of literals.
- API tests: `createApp({ env: testEnv({ DATABASE_URL }), database, clock })` from `apps/api/src/bootstrap.ts`,
  supertest, the `CSRF` headers from `apps/api/test/test-env.ts`, sessions from `createSessionCookie(db, userId)`
  (`@point/server/testing`) — or real login once PNT-011 exists.
- Time-dependent tests use `FakeClock` (pass it as `clock` to `Database` and to `createApp`).
- Every acceptance criterion of the ticket has at least one test; every error code a route can return has a test that
  reaches it through the real route (08 §10).

## 6. Commits

- `PNT-###: <imperative summary>` and the attribution lines from the session instructions. One ticket = one commit
  (or a few), on the working branch.
- Update `docs/progress/state.json` (status, date, note) for the tickets you finish; run `node tools/progress/build.mjs`.
- New decisions: `docs/DECISIONS.md` next free number (see CLAUDE.md), and update the affected doc in the same commit.
  Parallel agents write proposed decisions to `docs/progress/notes/<ticket>.md` instead; the lead merges them.

## 7. Checks before committing

```bash
pnpm lint && pnpm typecheck
pnpm test
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:int
```

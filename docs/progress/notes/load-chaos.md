# load-chaos — PNT-097 (load), PNT-098 (chaos), heartbeat fixes

Stream `wave4/load-chaos`. `docs/DECISIONS.md`, `state.json`, `tickets.json` and `STATUS.md` are untouched; the
proposals below are numbered `DEC-PROPOSED-n` for the lead.

## Server fixes

| Fix | Where | Test |
|---|---|---|
| The heartbeat (`POST /v1/me/heartbeat` and `client.heartbeat`) no longer bumps `duty_sessions.version` when a driver comes back online (06 ERD duty_sessions: «النبضة لا تزيد `version`»); `driver.connection_changed` carries the unchanged version, like `job.heartbeat_sweep` | `identity-access/application/me-service.ts` | `apps/api/test/heartbeat.int.test.ts` (HTTP and socket, through the real sweep) |
| `POST /v1/me/heartbeat` sent with an `Idempotency-Key` answered 500 in tests (the runner requires an audit row for keyed commands; the heartbeat writes none). The route now accepts and ignores the key: `@Command(…, { idempotent: false, ignoreKey: true })` → `CommandMeta.ignoreKey`; a ✓ command cannot set it (decorator throws) | `http/decorators.ts`, `http/interceptors.ts`, `auth.controller.ts` | same file: 200 with a key, nothing stored in `idempotency_keys`, a repeat is a fresh heartbeat (fresh `server_time`, no `Idempotent-Replayed`), a malformed key ignored too, ✓ routes still answer `IDEMPOTENCY_KEY_REQUIRED` |

## Proposed decisions

| # | Decision | Source | Affects |
|---|---|---|---|
| DEC-PROPOSED-1 | `POST /v1/me/heartbeat` accepts an `Idempotency-Key` and ignores it (never stored or replayed): canon §9 marks it «—» (optional keys are honoured on the other non-✓ routes), the heartbeat is a descriptive refresh that writes no audit row (06 ERD: it changes neither `version` nor availability), and a replayed answer would carry a stale `server_time` used for clock offset. Implemented as `CommandMeta.ignoreKey`. | canon §9, 06 ERD duty_sessions, 07 heartbeat | 07 `POST /v1/me/heartbeat` (state it) |

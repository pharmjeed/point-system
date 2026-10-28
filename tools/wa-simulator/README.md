# @point/wa-simulator

Local fake of the **WhatsApp Cloud (Graph) API** plus a **signed-webhook emitter**, so development, CI and
staging-on-simulator never message a real customer (docs/12 §11, docs/05 §9.2, PNT-037).

- Fakes `POST /{version}/{phone_number_id}/messages` (validates the body like Meta, answers with a `wamid`),
  the phone-number health read and the `message_templates` list/create routes.
- Stores every outbound message in memory (template, parameters, quick-reply payload, `phone_number_id`,
  `biz_opaque_callback_data`, rendered text) so tests can inspect it and "press" the button.
- Emits webhooks signed with `X-Hub-Signature-256: sha256=<HMAC-SHA256(APP_SECRET, rawBody)>`: button presses,
  text (free text, QR link code, stop keyword), interactive replies, statuses `sent/delivered/read/failed` in
  natural / reversed / duplicated / reordered order, the same event N times, BSUID-only users.
- Fault injection: Graph errors (retryable and permanent), bare 5xx, timeouts, latency, channel down.
- Zero runtime dependencies (`node:http`, `node:crypto`, global `fetch`). In-memory only; `reset` clears it.

**It refuses to start when `APP_ENV=production` or `NODE_ENV=production`** (exit code 1, also from
`startSimulator`). Production uses the live Cloud API (`WA_MODE=live`).

## Running

| How | Command |
|---|---|
| Docker compose | `wa-simulator` service in `infra/compose/docker-compose.yml` (`build: ../../tools/wa-simulator`, port 4010) |
| Docker | `docker build -t wa-simulator tools/wa-simulator && docker run -p 4010:4010 -e APP_SECRET=… -e WEBHOOK_URL=http://host.docker.internal:3000/webhooks/whatsapp wa-simulator` |
| Node | `pnpm --filter @point/wa-simulator build && APP_SECRET=… pnpm --filter @point/wa-simulator start` |
| In-process (tests) | `const sim = await startSimulator({ appSecret, webhookUrl })` — see below |

Point the API at it with `WA_MODE=simulator` and `WA_GRAPH_BASE_URL=http://localhost:4010`.
The Docker base image is a build arg (`NODE_IMAGE`, default `node:24-alpine`) for registry mirrors.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4010` | listen port (`HOST` default `0.0.0.0`) |
| `APP_SECRET` (or `WA_APP_SECRET`) | — **required** | HMAC secret of the webhook signature; same value as the API `WA_APP_SECRET` |
| `WEBHOOK_URL` | unset | target of every webhook (the API `POST /webhooks/whatsapp`); can be set later with `PATCH /_sim/config` |
| `VERIFY_TOKEN` (or `WA_VERIFY_TOKEN`) | unset | used by `POST /_sim/verify-webhook` for the GET handshake |
| `PHONE_NUMBER_ID` (or `WA_PHONE_NUMBER_ID`) | unset = any | when set, sends to another id fail with `100`; webhooks carry it in `metadata.phone_number_id` (unset: the last id seen, `100000000000001` before the first send) |
| `DISPLAY_PHONE_E164` (or `WA_DISPLAY_PHONE_E164`) | `+966500000000` | business number (`metadata.display_phone_number`, `context.from`) |
| `ACCESS_TOKEN` (or `WA_ACCESS_TOKEN`) | unset = any | when set, the bearer token must match (else `190`) |
| `WABA_ID` (or `WA_BUSINESS_ACCOUNT_ID`) | `200000000000001` | `entry[].id` |
| `AUTO_STATUSES` | `true` | emit `sent → delivered → read` after each accepted send |
| `STATUS_DELAY_MS` / `STATUS_ORDER` | `250` / `natural` | delay before each auto status; `natural·reversed·duplicated·reorder·shuffled` |
| `WEBHOOK_RETRIES` / `WEBHOOK_RETRY_DELAY_MS` | `0` / `1000` | redeliver non-2xx answers with exponential backoff (Meta retries; off by default for deterministic tests) |
| `WEBHOOK_TIMEOUT_MS` | `10000` | per delivery |
| `TEMPLATE_APPROVAL_DELAY_MS` | `0` | created templates stay `PENDING` that long, then `APPROVED` + status webhook |
| `DETERMINISTIC_FAULTS` | `true` | number rules below |
| `INCLUDE_USER_IDS` | `true` | add `user_id` / `from_user_id` (BSUID) to inbound webhooks |
| `HANG_MS` | `30000` | how long a request is held in timeout mode |
| `BRAND_CUSTOMER_NAME_AR` / `_EN` | from `fixtures/brand.json` | name shown by the dev page and the phone-number profile |

## Graph API fake

| Route | Behaviour |
|---|---|
| `POST /{v}/{phone_number_id}/messages` | Bearer token required. Validates `messaging_product`, `to` / `recipient` (BSUID), `type`, `text.body` (≤ 4096), template name + language in the local catalog (`fixtures/templates.json`, W-01…W-08), template status, body parameter count, text parameters (no newline/tab/5+ spaces), quick-reply button index + `payload`, `context.message_id`, `biz_opaque_callback_data` (≤ 512). Answers `{ messaging_product, contacts: [{ input, wa_id }], messages: [{ id: "wamid.SIM.<uuid>", message_status: "accepted" }] }` (`message_status` for templates only). |
| `GET /{v}/{phone_number_id}` | phone-number status (`quality_rating`, `health_status`, …) for the channel health check |
| `GET /{v}/{waba_id}/message_templates` | the catalog in Graph listing shape (`?name=`, `?status=`) |
| `POST /{v}/{waba_id}/message_templates` | accepts a definition → `APPROVED` (or `PENDING` with a delay; `REJECTED` when the name contains `reject`) and emits `message_template_status_update` |

Errors use the Graph shape `{ error: { message: "(#code) …", type: "OAuthException", code, error_data: { messaging_product, details }, fbtrace_id } }`
with the HTTP status of Meta's error-code table (e.g. `132001` → 404, `131000` → 500, `131016` → 503, `190` → 401,
most others 400). Classify by `error.code`, not by HTTP status.

### Deterministic rules (docs/12 §11.3)

| Condition | Result |
|---|---|
| recipient ends in `0000` | accepted (200 + wamid), then a `failed` status with `131026` |
| recipient ends in `1111` | `131056` on the first attempt of each message, success on its retry |
| number ends in `2222` | webhooks carry only the BSUID (`user_id`, `from_user_id`, `recipient_user_id`), no `from` / `wa_id` / `recipient_id` |
| header `X-Sim-Fault: <code>` / `http_<status>` / `timeout` | that error for this request |
| template not in the catalog / not `APPROVED` | `132001` (`PAUSED` → `132015`, `DISABLED` → `132016`) |

## Control API (`/_sim/*`, also served under `/sim/*`)

All JSON. Inbound emitters answer an `EmitResult` `{ wamids, deliveries: [{ httpStatus, ok, bodySha256, signature, attempts, … }], payloads }`.

| Method & path | Purpose |
|---|---|
| `GET /_sim/health` | liveness + counters |
| `GET` · `PATCH /_sim/config` | runtime config (`webhookUrl`, `autoStatuses`, `statusDelayMs`, `statusOrder`, `phoneNumberId`, …) |
| `POST /_sim/reset` | clear messages, inbound, deliveries, faults, template statuses (`{ resetConfig: true }` also restores the start config) |
| `GET /_sim/messages?to=&template=&purpose=&type=&phoneNumberId=&afterSeq=` | outbound messages |
| `GET /_sim/messages/last?…` · `GET /_sim/messages/{wamid}` | one message |
| `GET /_sim/customers/{phone or BSUID}/last-message?template=` | last message to a number |
| `GET /_sim/customers/{id}/claim-code` | handover code of the last W-05 (`masaf_vehicle_ready_v1` `{{2}}`, or the session-text fallback) |
| `POST /_sim/customers/{id}/tap` `{ context_wamid? }` · `/text` `{ body }` · `/link-code` `{ code }` · `/stop` | the virtual customer acts (docs/12 §11.2) |
| `GET /_sim/conversations` · `GET /_sim/conversations/{id}` | conversations as the customer sees them |
| `POST /_sim/press` | press a quick-reply button: `{ wamid }` or `{ to, template?, purpose?, ticketNumber?, index? }`, plus `from` (another number, AC-02), `payloadOverride`, `omitContext`, `buttonIndex` |
| `POST /_sim/text` · `/link-code` · `/stop` · `/interactive` | inbound text, QR link text, stop keyword, `button_reply` |
| `POST /_sim/statuses` | `{ wamid \| to+template, statuses?, order?, errorCode?, copies?, delayMs?, timestamp? }` |
| `POST /_sim/webhooks/raw` | any body (object or exact string), any signature mode |
| `GET /_sim/webhooks` | delivery log |
| `GET /_sim/send-attempts` | every Graph send attempt with its HTTP status / error code / cause |
| `POST /_sim/verify-webhook` | runs the GET handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`) against the webhook URL |
| `GET` · `POST` · `DELETE /_sim/faults` | fault rules (below) |
| `POST /_sim/channel` `{ state: up\|down\|timeout, code?, httpStatus?, durationMs? }` | channel outage |
| `POST /_sim/latency` `{ ms }` · `POST /_sim/status-delay` `{ delayMs, count }` | latency on every Graph call · hold the status webhooks of the next sends |
| `GET /_sim/templates` · `POST /_sim/templates/{name}/status` `{ status, emitWebhook? }` | template statuses |
| `GET /_sim/scenarios` · `POST /_sim/scenarios/{name}` · `POST /_sim/scenarios` (document) | scenarios |
| `GET /` (also `/_sim/ui`, `/sim/ui`) | dev page (RTL Arabic): conversations, the request button per W-01, handover codes |

Every inbound emitter accepts `from`, `userId`, `bsuidOnly`, `profileName`, `timestamp` (unix seconds or ISO),
`copies`, `parallel`, `duplicateMode` (`same_body` = byte-identical redelivery · `same_wamid` = same message id in
different raw bodies · `distinct` = new wamid per copy), `delayMs`, `signature` (`valid` · `invalid` · `missing`),
`webhookUrl`, `phoneNumberId`.

### Fault rules

```jsonc
{ "code": 131056 }                                   // next send: pair rate limit (retryable)
{ "code": 130429, "count": 3 }                       // next 3 sends
{ "code": 131026, "mode": "async" }                  // 200 + wamid, then a failed status webhook
{ "code": 132001, "match": { "template": "masaf_vehicle_ready_v1" } }
{ "code": 131047, "match": { "type": "text" } }      // session reply outside the window
{ "httpStatus": 503, "count": "unlimited" }          // bare 5xx until DELETE /_sim/faults
{ "kind": "timeout" }                                // hold the request (client timeout)
{ "latencyMs": 800, "count": 5 }                     // slow sends only
```

`RETRYABLE_CODES`, `PERMANENT_CODES` and `graphErrorInfo(code)` (exported) follow the classes of docs/12 §5.9.

## Scenarios

Built-ins (docs/12 §11.4): `dup10`, `taps10`, `reorder`, `forwarded`, `two_tickets`, `two_venues`, `qr_link`,
`qr_race`, `opt_out_then_tap`, `channel_down`, `crash_after_accept`. They act on messages the API already sent,
e.g. `POST /_sim/scenarios/dup10 { "to": "+966551234567" }`.

A scenario document (docs/17 §3.4) is `{ name?, description?, steps: [...] }`; each step is
`{ "action": "press" | "text" | "link_code" | "stop" | "interactive" | "statuses" | "raw" | "fault" | "clear_faults" | "channel" | "latency" | "status_delay" | "wait" | "config" | "scenario", ...options }`.
Examples live in `scenarios/`. Replay one against a running simulator:

```sh
SIM_URL=http://localhost:4010 pnpm --filter @point/wa-simulator replay scenarios/ac01-duplicate-press.json
SIM_URL=http://localhost:4010 pnpm --filter @point/wa-simulator replay forwarded '{"to":"+966551234567"}'
```

## Using it from tests

```ts
import { startSimulator, verifyWebhookSignature } from '@point/wa-simulator';

const sim = await startSimulator({ appSecret: 'test-secret', autoStatuses: false }); // free port, 127.0.0.1
process.env.WA_GRAPH_BASE_URL = sim.url;
await sim.client.configure({ webhookUrl: `${apiUrl}/webhooks/whatsapp`, phoneNumberId: WA_PHONE_NUMBER_ID });

const w01 = await sim.client.waitForMessage({ to: '+966551234567', template: 'masaf_ticket_issued_v1' });
await sim.client.pressButton({ wamid: w01.wamid, copies: 10, parallel: 5 });      // AC-01
await sim.client.pressButton({ wamid: w01.wamid, from: '+966500001234' });         // AC-02
await sim.client.emitStatuses({ wamid: w01.wamid, order: 'reversed' });
const code = await sim.client.claimCode('+966551234567');                         // after W-05
await sim.close();
```

`SimulatorClient` methods: `health`, `reset`, `getConfig`, `configure`, `listMessages`, `getMessage`, `lastMessage`,
`waitForMessage`, `sendAttempts`, `claimCode`, `claimCodeDetails`, `conversations`, `conversation`, `pressButton`,
`tap`, `sendText`, `sendLinkCode`, `sendStop`, `sendInteractive`, `emitStatuses`, `emitRaw`, `webhookDeliveries`,
`verifyWebhook`, `faults`, `addFault`, `addFaults`, `clearFaults`, `setChannel`, `setLatency`, `delayStatuses`,
`templates`, `setTemplateStatus`, `scenarios`, `runScenario`, `runScenarioDocument`, `runScenarioFile`.
Also exported: `startSimulator`, `createSimulatorServer`, `signWebhookBody`, `verifyWebhookSignature`,
`SIGNATURE_HEADER`, `assertNotProduction`, `optionsFromEnv`, `bsuidFor`, `BUILTIN_SCENARIOS` and the wire types.

## Notes

- The template catalog is a local copy (`fixtures/templates.json`) of docs/12 §8.2 until the shared catalog of
  PNT-039 exists; brand names may only appear in `fixtures/` (scripts/check-brand.mjs).
- Fake BSUIDs are deterministic per phone: `SA.<20 digits>`. The real format is re-verified at implementation.
- Spec gaps and the readings chosen are in `docs/progress/notes/pnt-037.md`.

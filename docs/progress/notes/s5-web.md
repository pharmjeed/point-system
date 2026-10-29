# S5 web — the live driver app (PNT-065 … PNT-072, web parts)

Scope: `apps/web` (sync protocol, in-page audio, live offer card, full D-04 and D-15, D-12/D-13, D-14 and the PWA,
form persistence, Web Push in the Service Worker) and the bundle split of the Arabic dictionary. The lead numbers
the proposals below into `docs/DECISIONS.md`.

## Tickets and evidence

| Ticket | Acceptance | Evidence |
|---|---|---|
| PNT-065 sync protocol | 1. after two minutes in airplane mode the return shows the right state without acting on old cards · 2. commands disabled while stale until the sync completes | `e2e/driver-live.spec.ts` (airplane mode 2 min with `page.clock`, the stale card dimmed, the press refused locally, the resync replaces it), `test/realtime/{engine,syncStore,driverHome,protocol}.test.ts` (version merge, dedupe, the generation rule of «قديم», heartbeat fallback, invalid frame → full sync) |
| PNT-066 in-page sound | 1. no play attempt before the unlock; blocked state visible · 2. the reservation stops the sound at once (fake AudioContext) | `test/audio.test.ts` (12), `e2e/driver-system.spec.ts` (recording AudioContext: nothing constructed before the tap, `broadcast` + vibration after it, the press stops the sound while the reply is pending, a context that will not resume stays «محجوب» and is recorded on the device) |
| PNT-067 live D-09 card | 1. only the oldest actionable request · 2. a stale card press is handled gracefully (two contexts) | `e2e/driver-live.spec.ts` (two drivers: TASK_ALREADY_CLAIMED / OFFER_EXPIRED / OLDER_REQUEST_PENDING with the 08 texts, the card leaves, no stuck state), `test/realtime/driverHome.test.ts` |
| PNT-068 D-04 + D-15 | 1. every banner reproducible in Playwright · 2. a failed wake lock shows no error | `e2e/driver-system.spec.ts` (offline, uncertain, WhatsApp down/up, session end, sound off; wake lock refused without an alert or a console error, held during the duty and released from D-14) |
| PNT-069 D-12 / D-13 | 1. minimal projection for a driver who is not assigned (channel, link and payment status; no phone, slot or photos); masked phone and slot for the assignee/creator · 2. on-behalf errors with the 08 texts | `e2e/driver-vehicles.spec.ts` (9: list scope and order, digits search after 300 ms, chips, cursor pages, both projections on screen and on the wire, RETRIEVAL_ALREADY_ACTIVE / TICKET_NOT_PARKED / TICKET_CLOSED, cancel before/after assignment, phone change, incident report, offline) |
| PNT-070 D-14 + PWA | 1. installable on Android Chrome · 2. iOS guide only outside standalone; no permission prompt without a tap | `e2e/pwa.spec.ts` (CDP `Page.getInstallabilityErrors` empty in a persistent Chromium profile — an ordinary Playwright context is off the record and reports only `in-incognito` —, the brand manifest, a controlling worker, precache without `/v1`, the app running offline from the cache), `e2e/driver-account.spec.ts` (guide hidden in standalone, zero `requestPermission` calls on load, one after the tap) |
| PNT-071 persistence | AC-21 / TC-061: a cut at the submit keeps the inputs; one effect on return | `e2e/driver-persistence.spec.ts` (D-05 inputs after a reload; a photo cut mid-upload resumes after the reload with the same media row; four aborted submits and the resend after the reload all carry one Idempotency-Key, one 2xx, the ticket `parking` once; the draft rows gone after the intake; a session end keeps the draft; sign-out deletes this user's rows only), `test/intakePersistence.test.ts`, `test/command.test.ts` |
| PNT-072 Web Push (web part) | 1. payload without phone/plate/slot/code (schema) · 2. replacement on reservation on Android Chrome · 3. refused permission keeps the in-page alert mode clear (AC-22) | `test/push.test.ts` (strict canon schema, a plate or a phone → the quiet ended text), `e2e/pwa.spec.ts` (push delivered through CDP: the ticket number only under `task:{id}`; `closed` replaces it under the same tag; a plate payload never shown; `push.click` → D-04 + resync; `push_subscription` stored on the device), `e2e/driver-account.spec.ts` (refused → «وضع التنبيه: داخل الصفحة فقط», the intake still works). Real-device checks remain (PNT-099). |

## Proposed decisions

**DEC-PROPOSED-1 — `Me.session.device_id`** — context: `POST /v1/me/audio-test` needs `device_id` and
`PUT /v1/me/devices/{deviceId}` needs the id in the path, but `GET /v1/me` did not say which `devices` row the sign-in
linked (09 §9.5, `auth_sessions.device_id`; proposal A of pnt-035.md). Without it the web app cannot record the D-03
audio test, the notification permission or the Web Push subscription on the real API (the e2e fake already sent it).
— decision: `Me.session.device_id` (uuid or `null` for a session without a linked device) is returned by
`buildMe` (`packages/server/src/modules/identity-access/application/views.ts`, one column of `auth_sessions`);
`apps/api/test/me-device.int.test.ts` proves the id, the audio test and the push subscription on it. — affected
files: 07 §2.1 and `07_openapi.yaml` (`Me.session.device_id`), 09 §9.5.

**DEC-PROPOSED-2 — the dispatch and alert payloads have no shared zod schema yet** — context: 07 §4.3 names the
payloads of `task.*`, `offer.*`, `driver.state_changed`, `alert.*` as 07 components (`OfferCard`, `TaskCard`, `Task`,
`DriverLive`, `Alert`); `packages/shared` has schemas only for `ticket.updated`, `sync.required`, `channel.status`,
`incident.updated`. — decision: the web client parses the shared envelope (`realtimeEnvelopeSchema`) and the shared
payloads strictly, and checks the identifying fields of the others (`src/realtime/protocol.ts`, loose objects); a frame
that fails is never applied and triggers a full sync (11 §9.4). The shared schemas for those payloads are a follow-up
for the shared package. — affected files: 07 §4.3, `packages/shared/src/canon/realtime.ts` (follow-up).

**DEC-PROPOSED-3 — the HTTP heartbeat is not a command** — context: `POST /v1/me/heartbeat` (07 §4.4, fallback of
`client.heartbeat` while the socket is down) changes no business state; the e2e command contract (every unsafe call
carries an Idempotency-Key) flagged it. — decision: it is sent without an Idempotency-Key, every
`heartbeat.interval_s`, by drivers on duty only (a supervisor's socket-less tab does not report presence); the
contract check excludes it. — affected files: 07 §4.4 (state it), `apps/web/e2e/support/actors.ts`.

**DEC-PROPOSED-4 — polling as the fallback of the socket** — context: 02 §1.7 asks for a full sync on (re)connect and
foreground but does not fix a refresh period when the socket is down; 15 §11.1 mentions a 15 s fallback refetch. —
decision: the driver's home snapshot is re-read every 15 s with the socket connected (a missed event heals) and
every 5 s without it; the staff screens keep their 15 s polling (web-supervisor.md). — affected files: 02 §1.7.

**DEC-PROPOSED-5 — commands wait while the data is stale (drivers), staff screens are not gated** — context: PNT-065
acceptance 2 («الأوامر معطلة أثناء الحالة القديمة»); 03 §4.4 names the acceptance and handover buttons. — decision:
every driver command button (D-03 … D-14) is disabled while «قديم» or offline (`useCommandGate`), except D-05 «التالي»
offline which moves on locally as 02 D-05 says; the supervisor screens refresh on resync but their commands are not
gated (each carries `expected_version`, and the server answers VERSION_CONFLICT). — affected files: 03 §4.4.

**DEC-PROPOSED-6 — the request banner over the task screens** — context: 02 D-05 shows a «عرض» banner opening D-09 in
a Sheet when a broadcast arrives during the intake; D-06 … D-11 are silent about it. — decision: the same banner and
Sheet on every task screen (D-05 … D-11, the frame without the BottomNav), so a reservation as next task is possible
from any of them; the sound plays once per new head card, with a local reminder at `reminder_at` when the server's
`offer.reminder` did not arrive. — affected files: 02 D-05/D-09.

**DEC-PROPOSED-7 — the screen wake lock** — context: 02 §1.10 «Screen Wake Lock بأفضل جهد»; D-03 lists the check;
D-14 has no setting in 02. — decision: held over the whole driver frame while a duty is open, re-acquired on return
to the foreground; a D-14 switch «إبقاء الشاشة مضاءة أثناء الوردية» (default on, stored per device) turns it off; a
refusal is listed only in the connection sheet («تعذّر التفعيل»), never as an error. The live states of the sheet
(«مفعّل» · «متوقف» · «تعذّر التفعيل») are not in 02. — affected files: 02 §1.3, §1.10, D-14, §8.

**DEC-PROPOSED-8 — D-14 notification state** — context: D-14 says «التدفق نفسه في D-03»; 14 §5.1 has the in-page
texts «وضع التنبيه: داخل الصفحة فقط — أبقِ الصفحة مفتوحة أثناء الوردية» and «الإشعارات لا تصل لجهازك — أعد
تفعيلها». — decision: D-14 shows the first as a banner when notifications are refused, unsupported or need the home
screen (AC-22), with D-15 هـ's sentence as its detail when refused; the second when the permission is granted but
the server has no subscription (`checks.push_enabled = false`), with «إعداد». — affected files: 02 D-14.

**DEC-PROPOSED-9 — the Service Worker precaches the whole build** — context: 05 §15.2 «precache app shell». — decision:
the precache list is every emitted asset (JS chunks including the lazy ones, CSS, fonts) plus the public files
(icons, sounds, manifest) and `/index.html`, so a driver who loaded once can open any screen offline and every sound
plays offline; source maps and the development gallery are excluded; `/v1`, `/ws`, `/webhooks`, `/health` are never
cached; the cache name carries a hash of the list (a new build = a new worker = «تحديث متاح»); cached files are
matched with `ignoreVary` (hashed names; a module script's `Origin` header must not miss the cache). — affected
files: 05 §15.2.

**DEC-PROPOSED-10 — the test tone is outside the 14 §7 ranking** — context: 14 §7 rule 4 ranks the alerts only;
ranking the tap's test tone above them silenced a broadcast arriving during the test. — decision: the test tone
always plays (it is the driver's own tap) and any alert replaces it. — affected files: 14 §7.

**DEC-PROPOSED-11 — the customer brand stays off D-13** — context: 02 D-05/D-13 write the consent sentence «وافق
العميل على استلام رسائل «مصاف» على واتساب لهذه التذكرة»; canon §1 rule 2 allows «مصاف» on the staff screens only in
D-07, S-03 and S-13 (the canon wins on names). — decision: D-13 «تغيير رقم الجوال» uses «وافق العميل على استلام رسائل
واتساب لهذه التذكرة»; the same applies to D-05 when its WhatsApp modes are built. — affected files: 02 D-05, D-13
(and canon §1 if the brand should be allowed there).

**DEC-PROPOSED-12 — D-13 rows and actions by projection** — context: 02 D-13 shows «سجّلها», the channel, the masked
phone, spot/slot/photos and four actions; 07 §1.10 and the API's `loadTicketDetail` give `created_by` to staff only,
the masked phone/spot/slot/photos to the assignee and the creator during the intake, and allow the phone change to
the creator or the assignee of a WhatsApp ticket after the intake. — decision: the rows follow the fields the server
sent («سجّلها» therefore only for a supervisor using the driver shell); the payment row reuses S-03's «التحصيل:
«…»» (the minimal projection carries `payment_status`); a paper ticket shows «قناة العميل: تذكرة ورقية» without a
link status; «تغيير رقم الجوال» appears with the full projection only (a creator after the intake, who only gets the
minimal one, asks the supervisor); «إعادة الربط بواتساب» waits for the WhatsApp modes of D-07 (PNT-043/044 web). —
affected files: 02 D-13.

**DEC-PROPOSED-13 — D-12 search input** — context: 02 D-12 «إدخال أرقام فقط يبحث في أرقام اللوحة (بادئة) ورقم
التذكرة (تطابق تام)»; the API matches plate digits anywhere (`LIKE '%' || q || '%'`). — decision: the web sends the
digits of the input (Arabic-Indic digits normalised) 300 ms after the last keystroke; letters only send nothing and
show «لا توجد مركبات مطابقة.»; the prefix-vs-contains difference is left to the API owner (contains is a superset).
— affected files: 02 D-12 or `packages/server/src/use-cases/queries.ts` (one of the two).

**DEC-PROPOSED-14 — the local intake store** — context: 02 §1.8 item 1, D-05, D-06 and 03 §4.3 ask for IndexedDB
drafts per user and ticket, pending photos resumed automatically, cleared at sign-out and when the ticket leaves
`received`; 02 §1.9 keeps the drafts through a session end (DEC-88). — decision: one database `point-field` with
`drafts` (`${userId}:${ticketId}`: the D-05/D-06 inputs, the unsent step 1 and the unfinished intake intents — key +
body fingerprint of step 1, the D-06 save and submit) and `photos` (`${userId}:${ticketId}:${slot}`: the compressed
bytes, the media request intent, the tile state) written 300 ms after a change; a reload resumes uploads that were
running or failed on the network (a refused photo is not resumed) with the same media request key; the rows are
deleted when the draft ends (submitted, discarded, or seen outside `received`) and at sign-out (that user's rows
only); a session end writes the pending changes and keeps them. — affected files: 02 §1.8, D-05, D-06; 03 §4.3.

**DEC-PROPOSED-15 — push click analytics** — context: 15 `push_notification_clicked` with `age_ms`. — decision: the
worker posts `{type: 'push.click', url, kind, age_ms}` to the focused window (a same-origin path only, `/d`
otherwise); the app navigates and resyncs; sending the analytics event is left to the analytics ticket. — affected
files: 15 (event source).

## Bundle

`vite build` (e2e build of this branch): the entry chunk `index-*.js` 278 kB and the largest preloaded chunk 203 kB
— no chunk reaches Vite's 500 kB warning; the realtime runtime (Socket.IO, the zod schemas), the staff copy, the
task screens and D-12/D-13 are lazy chunks.

## Observations for the lead

- `pnpm lint` (`scripts/check-secrets.mjs`) scans `apps/web/dist` when it exists: the S-13 WhatsApp settings
  (`src/features/admin/WhatsAppSections.tsx`, web-supervisor stream) show `env://WA_ACCESS_TOKEN`-style references,
  which put server-only variable names into the bundle and fail the check after any local build. CI lints before
  building, so it stays green there; either the placeholders or the check's dist rule needs a decision.
- The Service Worker matches its cache with `ignoreVary` (DEC-PROPOSED-9): `vite preview` (and any server adding
  `Vary: Origin`) otherwise misses every module script offline.

## Not in 02 (copy)

`connectionSheet.wakeActive/wakeOff/wakeFailed` (DEC-PROPOSED-7), `d14.wakeLock` (from D-03's check label),
`d13.consent` (DEC-PROPOSED-11). The `live` texts are 14 §5.1's (checked by `test/copy.test.ts`).

## Owner actions

- Real-device checks of PNT-099 (DM matrix): iOS Safari tab and home screen, Android Chrome tab and installed — sound
  unlock, the push replacement on reservation (PNT-072 acceptance 2), the wake lock, the offline shell.
- VAPID keys per environment: `VITE_VAPID_PUBLIC_KEY` for the web build, the private key for the worker's
  `job.push_send` (never in the web build).

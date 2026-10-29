# S5 web — the live driver app (PNT-065 … PNT-072, web parts)

Scope: `apps/web` (sync protocol, in-page audio, live offer card, full D-04 and D-15, D-12/D-13, D-14 and the PWA,
form persistence, Web Push in the Service Worker) and the bundle split of the Arabic dictionary. The lead numbers
the proposals below into `docs/DECISIONS.md`.

## Tickets and evidence

| Ticket | Acceptance | Evidence |
|---|---|---|
| PNT-065 sync protocol | 1. after two minutes in airplane mode the return shows the right state without acting on old cards · 2. commands disabled while stale until the sync completes | `e2e/driver-live.spec.ts` (airplane mode 2 min with `page.clock`, the stale card dimmed, the press refused locally, the resync replaces it), `e2e/driver-frame.spec.ts` («الاتصال غير مؤكد» closes D-09 and D-11 and dims the cards until the next confirmation; D-05 «التالي» and «إلغاء الاستلام» wait for the resync; a socket the server closed is checked and connected again), `e2e/staff-alerts.spec.ts` (staff socket: `alert.updated` marks «أُقِرّ» and stops the escalation before any poll, `alert.raised` re-reads), `test/realtime/{engine,syncStore,driverHome,protocol,driverRuntime,staffRuntime}.test.ts` (version merge, dedupe, the generation rule of «قديم», heartbeat fallback, invalid frame → full sync; a 5xx/429/unanswered snapshot keeps «قديم» and retries, a definitive 4xx is the server state; nothing written after stop; events of one commit in either order; the staff event → query-key map) |
| PNT-066 in-page sound | 1. no play attempt before the unlock; blocked state visible · 2. the reservation stops the sound at once (fake AudioContext) | `test/audio.test.ts` (13: + a lower sound asked while a higher one decodes never replaces it), `e2e/driver-system.spec.ts` (recording AudioContext: nothing constructed before the tap, `broadcast` + vibration after it, the press stops the sound while the reply is pending, a context that will not resume stays «محجوب» and is recorded on the device) |
| PNT-067 live D-09 card | 1. only the oldest actionable request · 2. a stale card press is handled gracefully (two contexts) | `e2e/driver-live.spec.ts` (two drivers: TASK_ALREADY_CLAIMED / OFFER_EXPIRED / OLDER_REQUEST_PENDING with the 08 texts, the card leaves, no stuck state; the OLDER_REQUEST_PENDING text on the older head the resync shows; one assertive announcement per transition, never the clock), `e2e/driver-frame.spec.ts` (a request on D-12: the banner, the badge on «الرئيسية», D-09 in a Sheet; no «قبل الطلب سائق آخر» for a card never shown), `test/realtime/driverHome.test.ts` |
| PNT-068 D-04 + D-15 | 1. every banner reproducible in Playwright · 2. a failed wake lock shows no error | `e2e/driver-system.spec.ts` (offline, uncertain, WhatsApp down/up, session end, sound off; wake lock refused without an alert or a console error, held during the duty and released from D-14), `e2e/driver-frame.spec.ts` (D-15 ح full screen and back; the promotion announced on D-14 with `next_due`, once; the 14 §5.1 notices: cancel without a sound, withdrawal red with `reminder`, DEC-30 repark → D-08 with `next_due`, early request with `reminder`), `e2e/pwa.spec.ts` (D-15 و: not offered during a task, «تحديث الآن» → `SKIP_WAITING` → one reload) |
| PNT-069 D-12 / D-13 | 1. minimal projection for a driver who is not assigned (channel, link and payment status; no phone, slot or photos); masked phone and slot for the assignee/creator · 2. on-behalf errors with the 08 texts | `e2e/driver-vehicles.spec.ts` (10: list scope and order, digits search after 300 ms, chips, cursor pages, a failed next page → inline «إعادة المحاولة» without a request loop, PAGINATION_CURSOR_INVALID → the first page again, both projections on screen and on the wire, RETRIEVAL_ALREADY_ACTIVE / TICKET_NOT_PARKED / TICKET_CLOSED, cancel before/after assignment with the server's text, phone change, incident report, offline) |
| PNT-070 D-14 + PWA | 1. installable on Android Chrome · 2. iOS guide only outside standalone; no permission prompt without a tap | `e2e/pwa.spec.ts` (CDP `Page.getInstallabilityErrors` empty in a persistent Chromium profile — an ordinary Playwright context is off the record and reports only `in-incognito` —, the brand manifest, a controlling worker, precache without `/v1`, the app running offline from the cache; sign-out closes the shown notifications), `e2e/driver-account.spec.ts` (guide hidden in standalone, zero `requestPermission` calls on load, one after the tap) |
| PNT-071 persistence | AC-21 / TC-061: a cut at the submit keeps the inputs; one effect on return | `e2e/driver-persistence.spec.ts` (D-05 inputs after a reload; a photo cut mid-upload resumes after the reload with the same media row; four aborted submits and the resend after the reload all carry one Idempotency-Key, one 2xx, the ticket `parking` once; «المتابعة دون انتظار» then a reload: the pending photo still uploads, once; the rows of tickets no longer open are removed at the next start; a session end keeps the draft; a transfer revocation and sign-out delete this user's rows only), `test/intakePersistence.test.ts`, `test/intakeSettle.test.ts`, `test/command.test.ts` |
| PNT-072 Web Push (web part) | 1. payload without phone/plate/slot/code (schema) · 2. replacement on reservation on Android Chrome · 3. refused permission keeps the in-page alert mode clear (AC-22) | `test/push.test.ts` (strict canon schema, a plate or a phone → the quiet ended text), `e2e/pwa.spec.ts` (push delivered through CDP: the ticket number only under `task:{id}`; `closed` replaces it under the same tag; a plate payload never shown; `push.click` → D-04 + resync; `push_subscription` stored on the device; the next sign-in re-links the held subscription with no prompt and no new subscription), `e2e/driver-account.spec.ts` (refused → «وضع التنبيه: داخل الصفحة فقط», `notification_permission = denied`; TC-062: the intake, and a request accepted on D-04, retrieved on D-10 and handed over on D-11 with the in-page sound). Real-device checks remain (PNT-099). |

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

**DEC-PROPOSED-16 — «الاتصال غير مؤكد» closes the server-confirmed commands (extends DEC-PROPOSED-5)** — context: 03
§4.4 and the design system (ConnectionIndicator README) disable acceptance and handover on `uncertain` and `offline`;
02 D-15 ب only says the indicator changes neither the tasks nor the availability (server state). — decision: the
command gate treats `uncertain` like `offline` (`unconfirmed`): every driver command waits, the cards are dimmed
(`data-stale`), D-09 says 02's «لا يمكن القبول دون اتصال» (03 §6: 02's text wins over the component's «يتطلب
اتصالًا») and D-11 «لا يمكن التسليم دون اتصال…»; the next confirmation reopens them after the resync it triggers. The
server state is untouched (02 D-15 ب stays true). — affected files: 02 D-15 ب (say the commands wait), 03 §4.4.

**DEC-PROPOSED-17 — the request over D-12, D-13, D-14 (extends DEC-PROPOSED-6)** — context: 02 D-09 «في Sheet فوق
الشاشات الأخرى», 02 §1.4 «شارة رقمية على «الرئيسية»», 02 D-05's banner sentence; the tab screens had only the sound. —
decision: every driver screen but D-04 shows the head request as a banner with «عرض» (D-09 in a Sheet, the screen and
its inputs kept): 02 D-05's «طلب إحضار مفتوح — يمكنك حجزه كمهمة تالية» when it can be reserved, 14 §5.1's card title
(«طلب إحضار — تذكرة n» / «طلب مفتوح للجميع — تذكرة n») when it can be accepted, D-09's view-only note otherwise;
«الرئيسية» carries the badge «1» while it is actionable; «قبل الطلب سائق آخر» shows only when the card was on screen
(D-04 or the open Sheet) and the page visible — otherwise the banner leaves quietly. — affected files: 02 §1.4, D-05,
D-09.

**DEC-PROPOSED-18 — the promotion of the reserved next task is announced by the frame** — context: 02 D-04 «بدأت
مهمتك التالية: #n» with `next_due` (14 §7, 10 §6.2–§6.3) was raised only while D-04 was mounted; a promotion happens
on a cancel, reassignment, custody transfer or reconcile of the current task, on any screen. — decision: the driver
runtime detects it (a card that was the next task, or `cause = task.promoted`, arriving as `accepted`/`in_progress`)
and the frame shows the dialog with `next_due` on every driver screen, once per task; after D-08's or D-11's own
completion (a 30 s window) those screens keep announcing it themselves (D-11 «بعد ثانيتين»). — affected files: 02
D-04, D-08, D-11.

**DEC-PROPOSED-19 — the 14 §5.1 notices as frame banners** — context: 14 §5.1/§7 define the cancel («أُلغي طلب الإحضار
— تذكرة n», no sound), withdrawal (red, `reminder`), DEC-30 repark («أعد سيارة تذكرة n إلى الموقف…», `next_due`) and
the early request during parking (`reminder`); 02 places them on D-04/D-08/D-10 only. — decision: banners under the
TopBar on every driver screen, each with «فهمت» (the repark with «فتح» → D-08); the repark and early-request
notices leave by themselves when their task leaves the driver; the early request is not repeated on the D-08 of that
task (its own banner says it). Events of one commit may arrive in any order (07 §4.5 best effort): the slot of a
task card follows the card learned last (versions only order one task's updates) and a cancel or withdrawal still
names a card a snapshot removed first. — affected files: 02 D-04, D-08, D-10; 14 §5.1 (where they show).

**DEC-PROPOSED-20 — when D-15 ح shows** — context: 02 D-15 ح «الخدمة غير متاحة (`SERVICE_UNAVAILABLE`): شاشة كاملة»
does not say which read decides. — decision: the driver's home snapshot (`GET /v1/me/home`, the read every driver
screen depends on) answering SERVICE_UNAVAILABLE puts the frame in D-15 ح (no BottomNav, no banners, the drafts
kept); «إعادة المحاولة» resyncs, and the next successful read (that tap, the resync retry or the polling) brings the
screens back. A 503 on any other read keeps that screen's own error with the 08 text. — affected files: 02 D-15 ح.

**DEC-PROPOSED-21 — pending photos outlive the submit; the session-end split (extends DEC-PROPOSED-14)** — context: a
submit with «المتابعة دون انتظار» deleted the rows of photos still uploading; 02 §1.11 clears the previous venue's
data on a transfer; drafts of tickets never reopened stayed. — decision: the submit (or the ticket leaving `received`)
deletes the `drafts` row only; a `photos` row stays until the server confirmed it (`complete`), refused it for good,
or its ticket can no longer take it (not `received`/`parking`); the driver frame settles the rows at the first
snapshot of an app session and on `online` (resumes the pending uploads, deletes the rest and every draft other than
`home.draft_ticket_id`). AUTH_SESSION_REVOKED with reason `transfer` or `disabled` deletes the user's rows; expiry and
an admin revocation keep them (DEC-88). — affected files: 02 §1.8, §1.11, D-06; 03 §4.3.

**DEC-PROPOSED-22 — the Web Push subscription follows the sign-in** — context: every sign-in links a new `devices`
row (09 §9.5) without a push endpoint, and the subscription was sent only from a tap in D-03/D-14 (14 §6.4.1), so
Web Push stopped at the second shift. — decision: when the permission is already granted and the browser holds a
subscription, the frame sends it (`pushManager.getSubscription()`, no prompt, no new subscription) to the session's
device once the snapshot says `checks.push_enabled = false`; D-03 also shows 14 §5.1's «الإشعارات لا تصل لجهازك —
أعد تفعيلها» with «إعداد» when nothing reaches the device. Sign-out and a session end close the notifications already
shown (02 D-15 ج, best effort). — affected files: 14 §6.4.1, 02 D-03, D-14.

**DEC-PROPOSED-23 — reconnecting after the server closed the socket** — context: Socket.IO never reconnects after
`io server disconnect` (the server's `disconnect(true)`) nor after a refused handshake; 07 §4.1 does not say what the
client does then. — decision: the client checks the session (`GET /v1/me`: an ended session goes to D-15 ج / S-01 and
stops the engine) and otherwise connects again after a backoff (1 s doubling to 15 s, with jitter; 15 s after a
refused AUTH_* handshake); the reconnection runs the full resync of 07 §4.5. — affected files: 07 §4.1.

**DEC-PROPOSED-24 — a D-12 page that fails** — context: 02 §1.9 says PAGINATION_CURSOR_INVALID reloads the list from
the start; a next page failing otherwise has no text in 02 D-12. — decision: the rows already loaded stay; the next
page is not asked again by itself (no request loop with the end of the list in view); an inline `Banner` with the
server's text and «إعادة المحاولة» asks again; PAGINATION_CURSOR_INVALID resets the list to its first page by
itself once — refused again within 10 s, the same banner waits for the tap (which reloads from the start). —
affected files: 02 D-12.

**DEC-PROPOSED-25 — the D-13 cancel after an assignment shows the server's text** — context: DEC-80 forbids 02's
screen sentences for server replies; 02 D-13 shows «لا يمكن الإلغاء بعد إسناد الطلب. تواصل مع المشرف.» for the
driver's cancel after the assignment (INVALID_STATE_TRANSITION, `details.reason = driver_cancel_after_assignment`).
— decision: D-13 shows the reply's `message_ar` (the 08 INVALID_STATE_TRANSITION text) like every server reply; 02
D-13's sentence goes. — affected files: 02 D-13 (or 08, if a dedicated code for this refusal is preferred).

## Review responses

Two reviewers, 28 findings (numbered as received). Every finding was checked against the code; all were real. Fixed
in `75df9a1`, `d65b882`, `dc62021`, `db21c59`; the e2e proof in `3578668`, `1ede0dd` and the commit after these notes.

| # | Finding | Response |
|---|---|---|
| 1, 18 | the resync counted any ApiError (5xx, 429) as a sync | Fixed: `isDefinitiveError` (a non-retryable 4xx other than RATE_LIMITED / IDEMPOTENCY_IN_PROGRESS) in both runtimes; anything else keeps «قديم» and retries after `RESYNC_RETRY_MS`. `driverRuntime.test.ts` (503, 504, 500, a bare 502, 429 → stale, gate closed, retry scheduled; 403 ASSIGNMENT_REQUIRED → complete), `staffRuntime.test.ts`. #18 is the same finding. |
| 2, 19 | accept/reserve/handover enabled while «غير مؤكد» | Fixed: `commandGate` — `unconfirmed = offline ‖ uncertain`, `ready = !unconfirmed && !stale`; D-04/D-12 cards dimmed. DEC-PROPOSED-16. `e2e/driver-frame.spec.ts` (D-11 and D-09 closed under `uncertain`, reopened after the next confirmation). #19 is the same. |
| 3 | a request on D-12/13/14 only sounded | Fixed: the frame's banner + Sheet on every screen but D-04, the badge on «الرئيسية», the claimed toast only for a card on screen. DEC-PROPOSED-17. `e2e/driver-frame.spec.ts` (D-12). |
| 4 | the promotion was announced only on D-04 | Fixed: detection in `driverRuntime` (`announcePromotion`), `FramePromotion` in the frame, D-08/D-11 keep theirs (`completingUntil`, `showAt`). DEC-PROPOSED-18. `driverRuntime.test.ts`, `e2e/driver-frame.spec.ts` (on D-14, once). |
| 5, 22 | cancel / DEC-30 repark / early request notices missing; a Task-view cancel used the withdrawal text and sound | Fixed: `notice('canceled')` without a sound for a known card or Task view in `canceled`; `withdrawn` + `reminder` only for a withdrawal or reassignment away; the repark notice with «فتح» → D-08 and `next_due`; the early request with `reminder` for the parking driver. DEC-PROPOSED-19. `driverRuntime.test.ts` (both event orders), `e2e/driver-frame.spec.ts`. #22 overlaps #5. |
| 6 | D-15 ح not implemented | Fixed: `serviceDown` from the home snapshot's SERVICE_UNAVAILABLE → full screen with «إعادة المحاولة». DEC-PROPOSED-20. `driverRuntime.test.ts`, `e2e/driver-frame.spec.ts` (the case is there rather than in driver-system.spec.ts: it needs the frame's fake). |
| 7 | the D-05/D-06 banner said the card's aria sentence | Fixed: `d05.openRequest` (02 D-05) when reservable, 14 §5.1's card titles when acceptable, D-09's view-only note otherwise (`offerBannerText`, copy in `live`/`d05` checked by `copy.test.ts`). DEC-PROPOSED-17. |
| 8 | D-09 offline text | Fixed with 02's text «لا يمكن القبول دون اتصال» (`d09.offline`, 03 §6 precedence); the component keeps «يتطلب اتصالًا» as its default for other uses. `e2e/driver-live.spec.ts`. |
| 9 | D-13 cancel used a 02 sentence for a server reply | Fixed: `displayMessage(error)` (DEC-80); `d13.cancelAfterAssignment` removed. DEC-PROPOSED-25 aligns 02 D-13. `e2e/driver-vehicles.spec.ts` (409 INVALID_STATE_TRANSITION, `driver_cancel_after_assignment`, the 08 text). |
| 10 | the whole card was an assertive region with the ticking clock | Fixed: a visually hidden `aria-live="assertive"` element changed only on arrival, reminder and expiry; the card and its clock are outside it. `e2e/driver-live.spec.ts` (one region, unchanged while the clock ticks, the reminder announced). |
| 11 | SYNC_FIRST refusal lost with the old card; a Sheet error under the next card | Fixed: the refusal lives in the offer store (`refusal`, cleared when no head card or on the next press) and shows on the head the resync brings; the Sheet's card is keyed by `offer_id`. `e2e/driver-live.spec.ts` (OLDER_REQUEST_PENDING → the older request with the 08 text). |
| 12 | a failing next page looped and showed nothing | Fixed: the observer stops after a next-page error, an inline «إعادة المحاولة» asks again, PAGINATION_CURSOR_INVALID resets to the first page by itself once (refused again within 10 s: the banner, whose tap reloads from the start). DEC-PROPOSED-24. `e2e/driver-vehicles.spec.ts` (503 ×3: no further request for 1.5 s with the end in view, the retry loads 55; an invalid cursor → page 1 again; a second one right after → the banner, no reload until the tap). |
| 13, 26 | old system notifications not closed at session end / sign-out | Fixed: `closeShownNotifications()` (registration `getNotifications()` → `close()`, best effort, try/catch) from RootLayout's session end and `useLogout`. `e2e/pwa.spec.ts` (a pushed notification gone after sign-out). #26 is the same. |
| 14 | AC-22 proof covered the intake only | Fixed: TC-062 case in `e2e/driver-account.spec.ts` — refused from the tap (`denied` stored), then accept on D-04 with the in-page `offer` sound, D-10 steps and the D-11 handover; one `requestPermission` call in total. |
| 15 | staff realtime wiring untested | Fixed: `staffRuntime.test.ts` (every canon event → the query keys of web-supervisor.md, `alert.updated` patched into the cached lists, the staff resync) and `e2e/staff-alerts.spec.ts` (`FakeRealtime.standalone()` on the MockApi: `alert.updated` → «أُقِرّ» and the escalation paused before any poll; `alert.raised` re-reads and plays the reminder once). |
| 16 | D-15 و untested | Fixed: `e2e/pwa.spec.ts` with a stubbed registration holding a waiting worker — not offered while a retrieval is in hand, offered once nothing is, «تحديث الآن» posts `SKIP_WAITING`, one reload on `controllerchange`, nothing waits afterwards. |
| 17 | submit deleted photos still uploading (critical) | Fixed: the submit keeps pending `photos` rows (`forgetIntake(…, { keepPendingPhotos: true })`), uploads continue in the background and the frame resumes them after a reload (`settleLocalIntake`). DEC-PROPOSED-21. `test/intakePersistence.test.ts`, `test/intakeSettle.test.ts`, `e2e/driver-persistence.spec.ts` («المتابعة دون انتظار» + reload → the photo uploaded once, inspection complete, the store empty). |
| 20 | no reconnection after `io server disconnect` | Fixed: the transport reports `closed`; the engine checks the session and reconnects with backoff (refused AUTH_* handshakes too). DEC-PROPOSED-23. `engine.test.ts`, `e2e/driver-frame.spec.ts` (the hub sends `41`; `GET /v1/me`, a new connection, live events again). |
| 21 | Web Push stopped after a new sign-in | Fixed: `usePushRelink` sends the held subscription to the new device without a prompt; D-03 shows «الإشعارات لا تصل لجهازك — أعد تفعيلها» with «إعداد». DEC-PROPOSED-22. `e2e/pwa.spec.ts` (two sign-ins, two device rows, one PUT each, no `subscribe`, no `requestPermission`). |
| 23 | a transfer kept the previous venue's drafts | Fixed: AUTH_SESSION_REVOKED `transfer`/`disabled` → `forgetUserDrafts`; expiry and admin revocation → `detachDrafts` (DEC-88). DEC-PROPOSED-21. `e2e/driver-persistence.spec.ts` (transfer → the rows gone). |
| 24 | discard, resend and D-05 «التالي» ignored the gate | Fixed: discard and the D-11 resend wait for `gate.ready`; D-05 «التالي» waits while stale online and still moves on locally offline (02 D-05). `e2e/driver-frame.spec.ts` (D-05 during a pending resync). |
| 25 | a lower sound requested during a higher one's decode replaced it | Fixed: refused when `pendingKey` holds a higher-ranked sound; the ticket only moves when the new sound may replace. `test/audio.test.ts` (same-tick case). |
| 27 | a resync in flight wrote after sign-out | Fixed: `getHome` gets the engine's AbortSignal, aborted by `stop()`; nothing is written to the cache or the sync store once stopped. `engine.test.ts`, `driverRuntime.test.ts`. |
| 28 | orphan drafts and photos stayed | Fixed: `settleLocalIntake` at the first snapshot of an app session and on `online` (drafts other than `home.draft_ticket_id`; photos of tickets not `received`/`parking`; the pending uploads of #17 kept and resumed). `test/intakeSettle.test.ts`, `e2e/driver-persistence.spec.ts`. |

Found while proving them: the fake hub published a task card for a withdrawal and the new card before the one that
left (the API publishes the Task view, and the cancel before the repark it causes); fixed in the fake, and the client
now handles either order (DEC-PROPOSED-19).

## Test results (this branch, 2026-10-29)

- `pnpm test:e2e` (mocked, Chromium, 360/390/430, `--workers=2`): 440 passed, 280 skipped (the functional specs run at
  390 only), 0 failed — including the new driver-vehicles (9), driver-persistence (3), pwa (4), driver-account (6),
  driver-system (7) specs and the layout entries for D-12, D-13 and D-14.
- `pnpm test:int` (PostgreSQL 16): 68 files passed, 1 skipped; 586 tests passed, 1 skipped.
- `pnpm lint` and `pnpm typecheck`: clean.
- `pnpm test` (unit + web-unit): 1235 passed, 1 failed — `apps/api/test/deploy-config.test.ts` «CSP of the PWA», a
  failure of the wave base (the Caddyfile of DEC-192 allows `'unsafe-inline'` in `style-src-elem`; the test was not
  updated). This branch does not touch either file; `wave4/load-chaos` (c6a93cb) and `wave4/g4-rehearsal` (b0f881a)
  each carry the test fix.

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

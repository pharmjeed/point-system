# Web — supervisor, admin and owner screens (S-02…S-13) — notes

Scope delivered in `apps/web/` (PNT-074…PNT-079, PNT-083, PNT-086…PNT-089, PNT-091, PNT-092 — the screens; their
backends are built in parallel and not merged yet, so the screens follow the 07 contract and are proved against
the e2e `MockApi`). Code: `src/features/supervisor/` (S-02, S-03, S-04, S-07, S-10, S-12 and the shared staff
layer), `src/features/reports/` (S-11), `src/features/admin/` (S-13); routes in `src/app/routes.staff.tsx` (one
spread in `router.tsx`); wire types appended to `src/api/types.ts`, copy appended to `src/i18n/ar.ts`, fixtures and
`mockStaffApi()` appended to `e2e/support/api.ts`. No new dependencies. `docs/progress/state.json` untouched.

The **proposed decisions** below are numbered `DEC-PROPOSED-n` for the lead to renumber into `docs/DECISIONS.md`
(not edited here).

## Screens

| Screen | Ticket | Status | Notes |
|---|---|---|---|
| S-02 لوحة التشغيل | PNT-074 | done | KPIs, queue oldest first with local counters and badges, active/next, drivers, alerts, failed messages, custody; tabs below 1024px, three columns from 1024px; «كل الحفلات المفتوحة»; search; quick actions to S-03 |
| S-04 مركز التنبيهات | PNT-075 | done | status/severity/type filters, «إقرار» / «حل» with a required note, escalation sound with unlock banner |
| S-03 تفاصيل التذكرة | PNT-076 | partial | header rows, tabs (timeline, custody, messages with the customer-brand preview, photos by signed URL, payments, incidents), action panel; **not built:** «تغيير الجوال», «إعادة الربط بواتساب», «مطابقة يدوية بعد انقطاع» (PNT-085) |
| S-03 إظهار الجوال | PNT-077 | done | reason list + «أخرى», 60 s, `tel:` link, never stored |
| S-03 التسليم الاستثنائي | PNT-078 | done | ≥2 of the three 07 identity checks, reason, payment section with the collector |
| S-03 استثناء الفحص / نقل العهدة | PNT-079 | done | inspection exception (reason); custody transfer (subject, holder: driver / me / free key slot / free spot, reason) |
| S-12 الوقائع | PNT-083 | done | list + filters + create; detail with PATCH (status machine, owner, severity, description, resolution required) |
| S-07 نقل سائق | PNT-086 | done | checklist from the snapshot, now/scheduled (Riyadh time → UTC), server `details.items`, pending transfer + cancel |
| S-10 إغلاق الحفل | PNT-087 | done | start closing, reconciliation + settlement, flagged blockers, «استلام نقد», discrepancies, close / EVENT_CLOSE_BLOCKED |
| S-11 التقارير والتصدير | PNT-088/089 | done | venue/event/period filters, the four cards, «تصدير CSV» + polling + download link |
| S-13 الإدارة | PNT-092 | partial | index per permission, audit log, outbox + retry, WhatsApp channel (+ owner edit) and templates (+ sync); **«الموظفون» not built** (another ticket) |
| S-13 الاحتفاظ وإعدادات المؤسسة | PNT-091 | done | retention (read: `audit.read`, edit: `retention.manage`), org settings (owner) with inline bounds and heartbeat order |

## Acceptance evidence

| Requirement | Evidence |
|---|---|
| S-02 oldest request first with its waiting time | `e2e/staff-board.spec.ts` (reply sent unsorted; order 47 → 50 → 52; `5:1x` counter that ticks; «متأخر») · `test/staff/opsModel.test.ts` |
| S-04 acknowledge stops the escalation sound; resolve needs text | `e2e/staff-alerts.spec.ts` (fake `window.Audio`, `page.clock`: silent before the tap, repeat at 60 s, pause on «إقرار», no play after 5 min; cap of 3 repeats; reminder once) · `test/staff/alertSound.test.ts` |
| S-13 bad heartbeat order inline + server VALIDATION_FAILED fields | `e2e/staff-admin.spec.ts` (no PUT while invalid; `security.max_login_attempts` error from `details.fields`; edit clears it; new key next time) · `test/staff/settingsModel.test.ts` |
| S-10 shows close blockers | `e2e/staff-close.spec.ts` (summary ✗, flagged sections, disabled close; EVENT_CLOSE_BLOCKED `details.blockers`) · `test/staff/closeModel.test.ts` |
| S-03 reveal needs a reason, never persisted | `e2e/staff-reveal.spec.ts` (`browserStorageDump` while shown and after; masked again after 60 s; no toast) |
| server refusal text when a hidden command is called anyway | `e2e/staff-ticket.spec.ts` (PERMISSION_DENIED `message_ar` toast, `/v1/me` refetched, button gone) |
| handover code never on screen | `e2e/staff-ticket.spec.ts` · `test/staff/timelineModel.test.ts` (`maskCodes`) |
| buttons hidden without permission | `test/staff/permissions.test.ts` (02 S-03 table × canon §10 roles) · e2e role checks in ticket, reveal, alerts, incidents, admin specs |
| 360/390/430 layout, RTL, 16px, ≥44px targets | `e2e/staff-layout.spec.ts` (14 screens with data, the action sheet and a dialog, at the three widths) + 1280px board columns |
| every command sends an Idempotency-Key, button disabled until the reply | `useStaffCommand` → `useCommand`; asserted on each command call in the e2e specs |

## Query keys (for the realtime client, PNT-064/065)

All reads are React Query queries under `staffKeys` (`src/features/supervisor/staffApi.ts`), every key prefixed
`['staff', …]`, nested so a prefix invalidates a family (`['staff','ticket',id]` covers its timeline). Until the
Socket.IO client exists the screens poll: board, alerts, ticket + timeline, incidents, reconciliation + settlement
every 15 s (`LIVE_REFETCH_MS`, 15 §11.1 fallback refetch), venue events every 60 s, export jobs every 2 s while
`pending`/`running`. Suggested invalidation per server event (canon §7.3):

| Event | Invalidate |
|---|---|
| `ticket.updated` | `staffKeys.ticket(id)` (and its timeline), `staffKeys.boards()`, `staffKeys.event(eventId)` (reconciliation, settlement), `['staff','ticket-search']` |
| `task.offered` · `task.broadcast` · `task.claimed` · `task.updated` · `offer.closed` | `staffKeys.boards()`, `staffKeys.ticket(ticketId)` |
| `driver.state_changed` | `staffKeys.boards()`, `['staff','drivers']`, `staffKeys.driver(id)` |
| `alert.raised` | `staffKeys.alerts()`, `staffKeys.boards()` |
| `alert.updated` | `applyAlertReply(qc, alert)` (`cache.ts`: stops the sound at once), then `staffKeys.alerts()`, `staffKeys.boards()` |
| `incident.updated` | `staffKeys.incidents()`, `staffKeys.incident(id)`, `staffKeys.timeline(ticketId)` |
| `channel.status` | `staffKeys.boards()` (`channel_health`), `staffKeys.waChannel()` |
| `sync.required` | `staffKeys.all` |

Command replies are applied or invalidated by the command itself (`useStaffCommand` `invalidate`, and refetch on
VERSION_CONFLICT / INVALID_STATE_TRANSITION / *_NOT_FOUND / TICKET_CLOSED …).

## Proposed decisions

**DEC-PROPOSED-1 — Resolution note required (S-04).** 02 S-04 says «حل» with an optional note; PNT-075 asks for
«ملاحظة الحل محفوظة» and the brief says resolve requires text. Adopted: «حل» opens a dialog whose note (3+
characters) is required; «إقرار» sends `note: null`. 07 keeps `note` nullable. Fix 02 S-04.

**DEC-PROPOSED-2 — «إقرار» or «استلام».** 02 S-04 names the button «استلام»; the `AlertItem` component (03 §3.16,
`components.alert.ack`) says «إقرار» and «أُقِرّ». The component text is kept (component behaviour is not changed
here); the status filter keeps 02's «مستلمة». Align 02 and 03.

**DEC-PROPOSED-3 — Read-only alerts.** `AlertItem` always draws «إقرار»/«حل». Without `alert.manage`, and for a
resolved alert, the row is drawn read-only with the same classes and no buttons. Propose an `AlertItem` prop to hide
the actions (03 §3.16).

**DEC-PROPOSED-4 — Escalation repeat and cap.** Canon §12 `alerts.escalation_repeat_s` (60) and
`alerts.escalation_max_repeats` (3) are not sent to the web client; the defaults are used: a critical alert plays
`escalation` at once and again every 60 s, at most 3 repeats, until acknowledged/resolved/gone; a new warning plays
`reminder` once (never for the warnings present on the first load); info is silent; one sound at a time,
escalation first. Propose `alerts.*` in `/v1/me` (like `heartbeat`).

**DEC-PROPOSED-5 — Audio unlock and where the sound plays.** The unlock is the «تفعيل صوت التنبيهات» tap (02 S-02,
D-15 د): it plays `point-test.mp3` and plays each alert element once muted in the same gesture (iOS unlocks audio per
element), in memory only (a reload asks again). The live alert list and the sound live in a pathless layout over the
«التشغيل» destination (S-02, S-03, S-04, S-12); S-07, S-10, S-11 and S-13 are silent. A refused `play()` brings
the banner back. Decide whether the staff shell should carry the sound everywhere (shell is another stream's).

**DEC-PROPOSED-6 — Polling until realtime.** 15 s refetch for the live screens (15 §11.1), keys documented above.

**DEC-PROPOSED-7 — «كل الحفلات المفتوحة».** One `GET /v1/events/{id}/operations` per open event, merged in the UI:
lists concatenated and de-duplicated, queue re-sorted, driver counters recomputed from the de-duplicated drivers (one
pool per venue), oldest wait = max, 30-minute accept average = mean of the events that have one (the reply has no
counts). Propose `GET /v1/venues/{venueId}/operations`.

**DEC-PROPOSED-8 — Escalation badge sources.** «متأخر»: `QueueItem.escalated_at`, an open `request_unaccepted`
alert for the task, or the local counter ≥ `dispatch.unaccepted_escalation_s` (from `GET /v1/venues/{id}/settings`,
canon default until loaded). «انتظار طويل»: the next task's `assigned_waiting_at` (from `next_tasks`) ≥
`dispatch.next_task_wait_alert_s`, or its open alert. «لم تُستلم»: stage start of the ready task ≥
`ready.uncollected_alert_min`, or an open `ready_not_collected` alert. Propose `assigned_waiting_at` on `QueueItem`
and `ready_at` on `TaskCard`.

**DEC-PROPOSED-9 — The offered driver.** «معروض على {سائق}» needs the recipient of a single offer; `QueueItem` has
only `assignee` and `offer` without a recipient. The UI shows the name when `assignee` is set, else «معروض» with the
offer countdown. Propose `offer.recipient: UserRef` in `QueueItem`.

**DEC-PROPOSED-10 — Driver custody count.** `DriverLive` has no custody count; the DriverRow count is derived from
the board (moving task → vehicle + key, accepted after key pickup → key, plus `custody_issues` held by the driver).
Propose `custody_count` in `DriverLive`.

**DEC-PROPOSED-11 — KPI «تنبيهات حرجة».** Added to the 02 S-02 strip from the `KpiStrip` description in 03 §3.16
(open critical alerts of the board).

**DEC-PROPOSED-12 — Tabs.** 02 S-02/S-03 draw `[Tabs]` but 03 §3 has no Tabs component: a feature-local `Tabs`
(`role="tablist"` of FilterChips-styled buttons, wraps, arrow keys follow the reading direction). Propose adding
`Tabs` to 03 §3.

**DEC-PROPOSED-13 — Venue/event selection.** In memory (zustand, no persistence); default first venue in scope, the
only open event or «كل الحفلات المفتوحة» when several (02 §1.3); survives navigation, not a reload.

**DEC-PROPOSED-14 — Array query parameters.** 07 arrays without `style` use the OpenAPI default (form/explode:
`?status=open&status=acknowledged`); only `GET /v1/tickets` `status` is a comma list (its 07 description). State it
in 07 §1.7.

**DEC-PROPOSED-15 — Routes added to 02 §9.1.** `/incidents/:incidentId` (S-12 detail), `/admin/:section` (S-13
sections: `channel`, `templates`, `outbox`, `audit`, `retention`, `org`), and `?action=<id>` on
`/ops/tickets/:ticketId` for the S-02 quick actions (opened once, only when the action is offered). S-07 «رجوع» goes
back in history (S-06 belongs to the driver-screens stream).

**DEC-PROPOSED-16 — New copy for 02 §8.5.** Everything in `ar.ts` under `staff`, `custodySubject`,
`paymentRecordStatus`, `waHealth`, `waChannelMode`, `waTemplateStatus`, `outboxStatus`, `exportKind`,
`ticketEventText`, and the `s02`…`s13` strings that are not «quoted» in 02 §4 (tab and section titles, empty states,
validation lines such as «الحد الأدنى {n}», «اختر فترة صحيحة…», «اكتب ملاحظة الحل.», the timeline lines per
`ticket_events.type`, the S-13 field labels).

**DEC-PROPOSED-17 — Handover code masking.** The server redacts message bodies (DEC-38); the UI masks any standalone
6-digit run in a preview again («••••••»), so a code never reaches the screen even from an unredacted body.

**DEC-PROPOSED-18 — Reveal phone.** Reason list from 02 (the label is sent as `reason`; «أخرى» sends the typed
text); the number is kept in component state only for 60 s (countdown from server time), with a `tel:` link; no
toast, no cache, no storage; RATE_LIMITED and PERMISSION_DENIED show the server text.

**DEC-PROPOSED-19 — Handover-exception identity checks.** 02's three checks map to 07 `identity_checks`:
«آخر 4 أرقام» → `phone_last4`, «استمارة المركبة أو الهوية» → `document_note` (what was seen), «وصف محتويات
المركبة» → `vehicle_description_confirmed`; `plate_confirmed` is never sent alone (the UI requires two of the
three). The collector defaults to the task's driver, else the supervisor. Payment methods are `cash`/`pos` because
`TicketDetail` lacks the event's `allowed_payment_methods` (the server checks PAYMENT_METHOD_NOT_ALLOWED): propose it in
`TicketDetail`.

**DEC-PROPOSED-20 — Reassign.** Drivers from `GET /v1/drivers?venue_id&driver_state=available` (minus the current
assignee); an offered/broadcast task can only go to a named driver (02); «تجاوز أولوية الطلب الأقدم» appears after
OLDER_REQUEST_PENDING and sends `override_priority: true` (audited). While the key is held by the assignee the sheet
asks «إقرار إعادة المفتاح» first.

**DEC-PROPOSED-21 — Custody-transfer holders.** Key → driver on duty / the supervisor (me) / a free active key slot;
vehicle → driver / me / a free spot (`available_only`). `customer` and `unknown` are not offered (handover and
reconcile own those).

**DEC-PROPOSED-22 — S-07 checklist.** Built from the snapshot (the driver's `live`, the boards of the old venue's open
events); a park/repark seen only through `driver_state = intake_parking` counts as a movement. A
TRANSFER_BLOCKED_CUSTODY reply replaces vehicles/keys/movements with `details.items` (with «فتح» per ticket). The
scheduled time is typed as Riyadh wall-clock time and sent in UTC (`+03:00`, no DST).

**DEC-PROPOSED-23 — S-10 details.** The reconciliation has no «مفاتيح في الخانات» count, so the summary shows
«عهدة لدى سائقين» from `keys_not_in_slots`; per-driver cash lines are «مسجّل / مُسلّم / بعهدته / الفرق» from the
settlement; «استلام نقد» is hidden for the supervisor's own line (13: no self-handover); blockers are highlighted
whenever closing is blocked, and EVENT_CLOSE_BLOCKED `details.blockers` replaces the lists.

**DEC-PROPOSED-24 — S-11 timings.** 02 says «متوسطات»; `EventSummaryReport.timings_seconds` gives p50/p90/max, so
the cards show p50 with p90 under it. Per-driver «متوسط الإحضار» is not in `DriverReportRow`, and cash handovers are
not in `PaymentsReport`: propose both in 07. Periods are Riyadh calendar days sent as UTC `[from, to+1)`.

**DEC-PROPOSED-25 — S-12 details.** Severity is filtered in the UI (`GET /v1/incidents` has no severity parameter);
«المسؤول» offers «تعييني مسؤولًا» / «بلا مسؤول» (no staff picker without `GET /v1/staff`); «سجل التحديثات» shows
the created/updated/resolved/closed timestamps (no history endpoint): propose `GET /v1/incidents/{id}/history` or
include `incident.updated` events in the reply.

**DEC-PROPOSED-26 — S-13 details.** «آخر Webhook» is not in `WhatsAppChannel`: `health_changed_at` is shown as
«آخر تغيّر للحالة» — propose `last_webhook_at`. `PUT /v1/admin/whatsapp/channel` needs every secret reference again
(they are never returned). Retention is readable with `audit.read` and editable with `retention.manage`; org
settings need `org.settings_manage`; VALIDATION_FAILED `details.fields` are matched by dotted path
(`security.max_login_attempts`, `heartbeat.uncertain_after_s`); an edit clears the server's field errors.

**DEC-PROPOSED-27 — Forbidden pages keep their title.** A screen the user may not open shows its h1 and «لا تملك
صلاحية عرض هذه الصفحة.» (02 §1.6), so the shell keeps one heading per page.

## Observations

- `ar.ts` is in the main chunk; the S-02…S-13 copy (~20 kB) takes the main chunk from about 490 kB to 510 kB, over
  Vite's 500 kB advisory (a build warning, not an error). Propose splitting the dictionary by area (driver / staff)
  or raising `chunkSizeWarningLimit`; not changed here (`ar.ts` is append-only for this stream).
- `DataTable` renders both the table and the cards (CSS picks one), so a cell's button exists twice in the DOM; the
  e2e selectors filter on visibility.
- The other web stream owns S-05/S-06/S-08/S-09; S-06's route (`/drivers/:driverId`) does not exist yet.

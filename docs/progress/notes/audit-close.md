# audit-close — the audit items the gap streams left open (wave 7)

Branch `wave7/audit-close` from `26e9b33`. Inputs: the staff audit list given to the staff-gaps fix agent (A-S13-1 …
A-S05-3; its run stopped at the usage limit before these items), the «Audit responses» of
`docs/progress/notes/driver-gaps.md` and the int-server review leftover (`docs/progress/notes/int-server.md`, RT-2).
`docs/DECISIONS.md`, `STATUS.md`, `state.json` and `tickets.json` are not edited here; the lead numbers the proposals
below.

## Closed

| Item | Sev | Spec | Fix | Proof |
|---|---|---|---|---|
| A-S13-1 S-13 «قناة واتساب» without a channel | 2 | 02 S-13; 07 §2.7 (GET → RESOURCE_NOT_FOUND, DEC-142; PUT «أو إنشاؤه أول مرة») | `fetchWaChannel` reads RESOURCE_NOT_FOUND as «no channel» (null); `ChannelSection` shows «لم تُضبط القناة بعد.» and, for the owner (`wa.channel_manage`), the create form at once (no «إلغاء» while nothing exists); the administration reads the empty state only. `DEPLOYMENT.md` §8 and `whatsapp-production.md` §10.2 name the screen next to the PUT | `e2e/staff-admin.spec.ts` «audit A-S13-1 …» (no not-found state, the PUT body with Idempotency-Key, the saved channel shown; admin: no form, no «فتح») |
| A-S05-2 S-05 table from 1024 px | 3 | 02 S-05 «على الشاشات الكبيرة: جدول بأعمدة …»; 02 §1.4; 03 §3.16 | `DriversTable` (`DataTable layout="table"`) from 1024 px with the seven 02 columns, sortable name / code / duty start; «المهمة» and «الجهاز» show «—» (API gaps 1–2 of staff-gaps.md, A-S06-1); the DriverRow list stays below 1024 px (`.st-below-desktop` / `.st-desktop-only`) | `e2e/staff-audit-close.spec.ts` «A-S05-2 …» (390: list, no table; 1280: headers in 02 order, «منذ», connection, sort, link to S-06, no horizontal scroll) |
| A-SHELL-1 TopBar alerts badge, shared venue | 3 | 02 §1.3 «شارة «التنبيهات» … وتفتح S-04»; DEC-320; DEC-342 | The staff TopBar carries «التنبيهات (n)» (open alerts, `alert.read`) on every staff screen, one query shared with S-02/S-04 (`liveAlerts.ts`); S-02's body button is gone (one entry, the TopBar). S-05 and S-11 start from the venue chosen in S-02 (the in-memory `useSelectionStore`) and S-05 writes a chosen venue back; S-05's «كل المواقع» stays local | `e2e/staff-audit-close.spec.ts` «A-SHELL-1 …» |
| A-SHELL-2 staff commands while stale / resyncing | 3 | 02 §1.6 «إعادة المزامنة … الأوامر معطلة حتى تكتمل»; §1.7; S-02 «بلا اتصال … وتعطيل الأوامر» | `useStaffCommandsReady()` (`commandReady.ts`) replaces `useOnline()` in S-02, S-03, S-04, S-07, S-10, S-12: online, a connection confirmed by heartbeat (not `uncertain`/`offline`) and no stale/resync after the first sync — the state the shell's banner shows | `test/staff/commandReady.test.ts`; `e2e/staff-audit-close.spec.ts` «A-SHELL-2 …» (`sync.required` with the resync held: «إقرار» disabled, then enabled) |
| A-SHELL-3 scope-denied reads | 4 | 02 §1.9; DEC-80 | `ReadError` / `ForbiddenState` show «هذا العنصر خارج نطاق موقعك.» for SCOPE_VENUE_DENIED, as the shared `QueryView` | `e2e/staff-audit-close.spec.ts` «A-SHELL-3 …» |
| A-S09-1 `intake.draft_abandoned_alert_min` | 3 | 02 S-09; DEC-340; canon §12 | in «المؤقتات» (integer, minutes, ≥ 1), labelled with the canon «المعنى» text | `e2e/staff-audit-close.spec.ts` «A-S09-1 …» (default 10, 0 refused locally, 15 saved in the PUT); `test/copy.test.ts` (label = canon §12) |
| A-S10-1 «إغلاق الحفل» confirmation | 3 | 03 §4.5; 11 §6.4; 13 §12 | a destructive Dialog before `POST …/close` (DEC-PROPOSED-1 copy); a refusal closes it and shows the blockers as before | `e2e/staff-audit-close.spec.ts` «A-S10-1 …»; `e2e/staff-close.spec.ts` (refused close through the dialog) |
| A-S11-1 S-11 payments per event | 3 | 02 S-11; 01 FR-RPT-03; 13 §13 | `PaymentsReport.rows` as a DataTable under the totals (event, cash, POS, reversed, waived, outstanding) | `e2e/staff-audit-close.spec.ts` «A-S11-1 …» |
| A-S11-2 self-approval visible (audit-log half) | 3 | 09 §10 rule 2 | the S-13 audit log marks `metadata.self_approved = true` with «اعتماد ذاتي» in the reason column and shows `metadata` under «قبل / بعد» | `e2e/staff-audit-close.spec.ts` «A-S11-2 …» |
| A-S03-1 the waiver in «التحصيل» | 4 | 02 S-03; 13 §6 | a «إعفاء من الرسوم» row with «السبب: …» from `payment_waiver_reason` when the fee is waived (no empty state then) | `e2e/staff-audit-close.spec.ts` «A-S03-1 …» |
| A-S13-2 the retry result | 4 | 02 S-13; DEC-150 | «إعادة المحاولة» says «أُعيد الحدث إلى الطابور: «{status}».» or «أُغلق الحدث «ملغى» دون إعادة: {reason}» from the reply | `e2e/staff-admin.spec.ts` «outbox …» and «audit A-S13-2 …» |
| int-server review leftover (RT-2) | — | 07 §4.3, §4.5; int-server.md review:1/4 | the planner's condition is `custodyRepublishesTaskCard` (task-card.ts, next to `custodyTouchesTaskCard`): an official transfer into/out of a spot or key slot, or of the key from/to a driver — so the key of an accepted retrieval leaving its assignee for a supervisor **or `unknown`** republishes his TaskCard (version bumped by the pickup reset) | `apps/api/test/task-card-realtime.int.test.ts` «the picked-up key declared unknown (lost) …»; `packages/server/test/task-card-custody.test.ts` |

Already closed on the base (checked against `26e9b33`, no change): A-S05-1 (`driver.state_changed` and the resync
invalidate `queryKeys.drivers`), A-S06-2 (the DEC-32 preview in «تعطيل الحساب»), A-S08-1 («إعادة فتح الحفل», GAP-4),
A-S10-2 («فتح» and «فتح واقعة» `key_missing` on each custody row), A-S04-1 (the driver link of an alert), A-S07-1 (the
live single-offer count in the S-07 checklist); driver side A-driver-8 (client telemetry, int-web).

## Final round — left, and why

| Item | Sev | Why it stays |
|---|---|---|
| A-S06-1 sound-test result and notification permission per driver (S-06, S-05 «الجهاز», S-02) | 3 | API missing: `DriverLive` / `DriverListItem` carry no device fields (the server stores `devices.audio_test_result` and `notification_permission` but serves them on `/v1/me` only). Needs a contract change (07 `DriverLive.device {audio_test_result, notification_permission}` of the open duty's device) before the column can leave «—» — DEC-PROPOSED-3 |
| A-S11-2 self-approval in the event report | 3 | API missing: `EventSummaryReport` has no self-approved count; the audit-log half is closed above — DEC-PROPOSED-4 |
| A-SHELL-1 the venue / event pickers in the TopBar itself | 3 (rest) | The badge and the shared venue are closed; moving both Selects into the 56 px TopBar needs a design for 360 px (☰, mark, title, two selects, badge, connection do not fit one row) — 03 §3.2 has no picker anatomy. S-02/S-12 keep the pickers under the TopBar, S-05/S-11 their Select on the shared venue |
| A-S06-3 «المعتمد» in the assignment history | 4 | API missing (`DriverAssignment` has no approver; staff-gaps API gap 3) |
| A-S05-3 S-05 phone search for a supervisor | 4 | API missing: supervisors get `phone_masked` only and `GET /v1/drivers?q=` searches name and code only (09 field visibility) — a server-side phone match is a 09 decision, not a UI one |
| A-LIST-1 S-04 / S-12 as DataTables from 1024 px | 4 | The alert and incident cards carry their commands («إقرار», «حل», links) and the sound state; a table needs an actions column design (03 §3.16 has none for row commands). The new `.st-below-desktop` / `.st-desktop-only` pair is ready for it |
| A-driver-6 creator changes the phone of a parked ticket | 3 | API missing (`viewer_is_creator`, driver-gaps DEC-PROPOSED-30) |
| A-driver-7 D-03 venue choice for a driving supervisor with several venues | 3 | Design gap (driver-gaps DEC-PROPOSED-27): 02 D-03 draws no venue picker; the canonical driving supervisor (17 §4 SUP-RD) has one venue |
| A-driver-13 D-05 Latin letters, make search | 4 | Design gap (03 §3.9 defines neither); the label part was closed |
| A-driver-14 on-behalf reasons as §8.4 keys | 4 | Not only D-13 and S-03: `retrieval_cycles.request_reason` is also written to the CSV exports and the S-13 audit list by the server, which would print raw keys; the switch needs the server's export translation in the same change (driver-gaps DEC-PROPOSED-28) |
| A-driver-15 the transfer banner on the driver frame | 4 | API missing: `driver.transfer_*` reach the supervisor rooms only and `DriverLive` has no transfer fields |

## Proposed decisions (DEC-PROPOSED-n; the lead numbers them)

- **DEC-PROPOSED-1: the «إغلاق الحفل» confirmation** — context: 03 §4.5 lists «إغلاق الحفل» among the actions that need
  a confirmation and 02 S-10 gives no text. — decision: a destructive Dialog titled «إغلاق الحفل» with «إغلاق الحفل
  نهائي: لا يُعاد فتحه بعده ولا يُقبل عليه أي تحصيل أو عكس أو إعفاء.» (11 §6.4, 13 §12) and the confirm «إغلاق الحفل»;
  nothing is sent before it. — affected files: 02 S-10 step 3, 02 §8.6 (`s10.closeConfirmBody`).
- **DEC-PROPOSED-2: staff commands follow the sync state** — context: 02 §1.6/§1.7 disable commands while stale or
  without a confirmed connection; the staff screens only checked `navigator.onLine`. — decision: S-02, S-03, S-04,
  S-07, S-10 and S-12 enable a command only when the browser is online, the heartbeat confirms the connection (not
  `uncertain`/`offline`) and no resync is pending **after the first sync** (before it the shell shows no «قديم»
  banner and the screen's own reads are the state shown, so a socket that never connects does not freeze the
  screens). S-13 settings keep `navigator.onLine` (no realtime state behind them). — affected files: 02 §1.6.
- **DEC-PROPOSED-3: device state in `DriverLive`** — context: 01 FR-DUTY-02/03, FR-SUP-01 and 02 S-05/S-06 want the
  supervisor to see each on-duty driver's sound test and notification permission (A-S06-1). — decision proposed:
  `DriverLive.device: { audio_test_result, notification_permission, last_seen_at } | null` from the open duty
  session's device, visible to `driver.read`; S-05 «الجهاز» and S-06 «المناوبة الحالية» show it with a lasting
  warning when the result is not `heard`. — affected files: 07 `DriverLive`, 09 §5 field visibility, 02 S-05/S-06.
- **DEC-PROPOSED-4: self-approved exceptions in the event report** — context: 09 §10 rule 2 says they «تظهر في تقرير
  الحفل»; `EventSummaryReport` has no field (A-S11-2). — decision proposed: `EventSummaryReport.self_approved` (a count
  per action: handover exception, reversal, waiver, inspection exception) read from `audit_log.metadata.self_approved`;
  until then the S-13 audit log is the place (closed here). — affected files: 07 `EventSummaryReport`, 15 §11.
- **DEC-PROPOSED-5: the S-13 channel before its first setup** — context: 07 §2.7 answers RESOURCE_NOT_FOUND without a
  channel (DEC-142); 02 S-13 draws only an existing channel. — decision: the section reads that answer as «لم تُضبط
  القناة بعد.» (`s13.channel.empty`) and gives the owner the create form directly (all secret references required,
  as for an edit); the administration sees the empty state only. — affected files: 02 S-13.
- **DEC-PROPOSED-6: copy not in 02 (for 02 §8.6)** — `s10.closeConfirmBody` (above); `s03.waiverReason` «السبب:
  {reason}»; `s13.outbox.requeued` «أُعيد الحدث إلى الطابور: «{status}».» and `s13.outbox.canceled` «أُغلق الحدث «ملغى»
  دون إعادة: {reason}»; `s13.audit.metadata` «بيانات إضافية» and `s13.audit.selfApproved` «اعتماد ذاتي». The S-05 table
  headers and the S-09 label are 02 / canon §12 text.

## Checks

At `7a95ea1` (the code; this notes commit changes docs only), local PostgreSQL 16 (`TEST_DATABASE_URL`), each full
run as one holder of the shared heavy lock:

| Suite | Command | Result |
|---|---|---|
| lint | `pnpm lint` (eslint, prettier, brand, secrets) | clean |
| typecheck | `pnpm typecheck` | clean |
| unit | `pnpm test` | 1452 tests passed (+6: `commandReady`, `task-card-custody`) |
| integration | `pnpm test:int` | 85 files passed, 1 skipped; 685 tests passed, 1 skipped (+1: the `unknown` TaskCard case) |
| e2e | `playwright test --workers=2` (360, 390, 430) | 598 passed, 470 skipped (390-only specs at 360/430), 0 failed (+11) |

Targeted first: `staff-audit-close.spec.ts` 10/10, `staff-admin.spec.ts`, `staff-close.spec.ts` at 390 px;
`task-card-realtime.int.test.ts` 8/8.

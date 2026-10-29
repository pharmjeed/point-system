# staff-gaps — supervisor and admin gaps GAP-2 … GAP-6 and the S-01 … S-13 sweep (wave 5)

Branch `wave5/staff-gaps` from `34ffe37`. Web only (`apps/web`): the server routes of these gaps were built and tested
before (PNT-017, PNT-049, PNT-084, PNT-085, PNT-087; `docs/runbooks/go-live-checklist.md` §2). The lead numbers the
proposals below from DEC-365; `docs/DECISIONS.md`, `STATUS.md`, `state.json` and `tickets.json` are not edited here.

## Gaps closed

| Gap | Screen (02) | What was built | Proof |
|---|---|---|---|
| GAP-2 | S-03 «مطابقة يدوية بعد انقطاع» · «تغيير الجوال» · «إعادة الربط بواتساب» | `TicketRecoveryActions.tsx`: the three sheets, `permissions.ts` (`relinkMethods`, `reconcileTargets`, the rows of the 02 S-03 table), `staffApi.ts` commands | `test/staff/permissions.test.ts` (recovery actions), `e2e/staff-recovery.spec.ts` (9) |
| GAP-3 | S-13 «الموظفون» | `/admin/staff` (`StaffSection.tsx`, `staffModel.ts`): the list (`GET /v1/staff`, every page), «إضافة موظف» with the temporary password once, «تعديل البيانات», «النطاقات» (venues of a supervisor, the org scope of an admin), «تعطيل الحساب» / «تفعيل الحساب» with a reason and CUSTODY_OPEN items, «إعادة ضبط التحقق الثنائي» (owner) | `test/staff/staffModel.test.ts` (6), `test/staff/permissions.test.ts` (sections), `e2e/staff-team.spec.ts` (5) |
| GAP-4 | S-08 table «بدء الإغلاق │ S-10» | `VenuePage.tsx` event card: «بدء الإغلاق» (open), «إغلاق الحفل والمطابقة» and «إعادة فتح الحفل» behind a confirmation (closing; `POST /v1/events/{eventId}/open`, closing → open, 07, 11 §6.4), «عرض التقرير» (closed, `report.read`); S-10 goes back to the venue page | `e2e/staff-event-links.spec.ts` (2) |
| GAP-5 | S-06 table «نقل إلى موقع آخر │ S-07» | `DriverProfilePage.tsx`: the button for `driver.transfer`, an active driver with an active assignment; S-07 goes back in history, else to S-06 | `e2e/staff-driver-profile.spec.ts` (2 of 6) |
| GAP-6 | S-06 table «إنهاء المناوبة قسرًا» + «تأكيد التعطيل وإنهاء المناوبة قسرًا (Dialog، DEC-32)» | `ForceEndDialog` (`duty.force_end`, the supervisor's alone; `live.duty_session_id`; `POST /v1/duty-sessions/{sessionId}/force-end` with the mandatory reason): the DEC-32 snapshot (`CustodyChecklist.tsx`, shared with S-07) with «فتح» on each item and the 02 sentence «المهمة التالية المحجوزة … وتُسحب عروضه الفردية.»; DUTY_END_BLOCKED_CUSTODY replaces it with `details.items` and «لا يمكن تنفيذ الإجراء وبعهدة السائق: {العناصر}.» | `e2e/staff-driver-profile.spec.ts` (4 of 6), `test/staff/transferModel.test.ts` |

## Sweep of S-01 … S-13 against 02

| Screen | 02 reference | Found | Done | Proof |
|---|---|---|---|---|
| S-05 | S-05 wireframe rows ««متاح» منذ 4:10 │ ● متصل», «البيانات: … التحديث الحي عبر `driver.state_changed`» | rows without the connection or «منذ»; S-05/S-06 queries (`['drivers']`) not refreshed by `driver.state_changed` nor by the resync | `RowMeta` (venue, «منذ m:ss» from `available_since`, `ConnectionIndicator` of an open duty); `staffRuntime.ts` invalidates `queryKeys.drivers` on `driver.state_changed` and on the resync | `e2e/staff-sweep.spec.ts`, `test/realtime/staffRuntime.test.ts` |
| S-06 | S-06 «تأكيد التعطيل … (Dialog، DEC-32): يعرض من اللقطة ما يمنع الإجراء …»; «الأخطاء: CUSTODY_OPEN «لا يمكن تنفيذ الإجراء وبعهدة السائق: {العناصر}.»» | «تعطيل الحساب» showed only the server's generic text and the items after a refusal | the same DEC-32 preview as the forced end; CUSTODY_OPEN with the S-06 text, the refusal under the list (`role=alert`), the reason error under the reason | `e2e/staff-driver-profile.spec.ts`, `e2e/setup.spec.ts` (updated assertion) |
| S-07 | S-07 checklist «مفاتيح بعهدته: 1 │ ✗ #125 — يجب إعادته أو نقله رسميًا │ [فتح]»; DEC-32 «مهمة صف/إعادة صف» blocks | «فتح» only after a TRANSFER_BLOCKED_CUSTODY refusal; an accepted park/repark counted as «إحضار مقبول قبل استلام المفتاح» | «فتح» on the snapshot rows (`ticketIds`); an accepted park/repark is a movement (as the server's `blockingCustody`) | `test/staff/transferModel.test.ts`, `e2e/staff-driver-profile.spec.ts` |
| S-10 | S-10 «[Row] خالد │ مفتاح #141 │ [نقل عهدة] [فتح]»; ««فتح واقعة» ← `POST /v1/incidents` بنوع … `custody_mismatch` أو `key_missing`» | custody rows with «نقل عهدة» only | «فتح» (S-03) and «فتح واقعة» (`key_missing`, the ticket attached) on each key not in its slot, wrapping at 360 px | `e2e/staff-sweep.spec.ts`, `e2e/staff-layout.spec.ts` (S-10 at 360/390/430) |
| S-04 | S-04 «كل تنبيه: … رابط التذكرة أو السائق» | the ticket link only | an alert without a ticket links to its driver (`user_id`) for `driver.read` | `e2e/staff-sweep.spec.ts` |
| S-01, S-02, S-03 (other rows), S-08 (other rows), S-09, S-11, S-12, S-13 (other sections) | each screen of 02 §4 | matching (built in PNT-023, PNT-080 … PNT-092) | — | existing specs |

New layout checks at 360/390/430 (`e2e/staff-gaps-layout.spec.ts`): the S-03 recovery sheets and the QR panel, S-13
«الموظفون» (list, member sheet, «إضافة موظف»), the S-06 confirmations, the S-08 cards with the reopen confirmation, S-05 rows.

### Not done (deferred)

- S-05 «على الشاشات الكبيرة: جدول» (02 S-05): the rows stay the 02 mobile list at every width; two of the seven columns have no
  data yet («المهمة» numbers, «الجهاز», API gaps 1–2 below).
- S-06 «نتيجة اختبار الصوت، إذن الإشعارات» and the history's «المعتمد»: no data (API gaps 2–3).
- S-10 open-ticket rows «A-12 │ خانة 33» and «جاهزة» منذ 22:10, and the holder of a key («خالد │ مفتاح #141»): no data (API gap 4).

## Proposed decisions (DEC-PROPOSED-n, numbered by the lead from DEC-365)

- **DEC-PROPOSED-1: S-03 «إعادة الربط بواتساب» — when and how** — 02 S-03 offers it for `wa_link_status` = `none` or `failed`
  only, but 12 §7.6 brings an opted-out customer back by his own QR message alone and DEC-198 lets venue supervisors answer
  a pending QR confirmation. — The action shows for an open WhatsApp ticket: «إعادة الإرسال» (direct) after the intake for
  `none`/`failed` with a recorded number not opted out; «الربط عبر QR» in `received`/`parking`/`parked` for
  `none`/`failed`/`opted_out`; the confirmation only («هل هو جوال العميل الذي أمامك؟») while `pending_confirmation` with
  `wa_link_pending`. The server stays the judge (consent, channel health, template). — 02 S-03 table; `permissions.ts`
  (`relinkMethods`).
- **DEC-PROPOSED-2: the customer-brand QR panel in S-03** — canon §1 rule 2 lists D-07's QR panel, S-03's message preview
  and S-13's channel as the only staff surfaces with «مصاف»; the supervisor's QR re-link shows the same panel. — S-03 shows
  `QrPanel` (brand inside the panel only, the rest of the sheet brand-less). — canon §1 rule 2; 02 S-03.
- **DEC-PROPOSED-3: S-03 «تغيير الجوال» scope and consent text** — 02 S-03 says «تذكرة مفتوحة»; DEC-211 refuses a draft
  (`draft_use_intake`) and a paper ticket. — Offered for an open WhatsApp ticket after the intake; the consent line is D-13's
  brand-less sentence (canon §1 rule 2, as `d13.consent`); the «تحقق ميداني» box is local. — 02 S-03 table.
- **DEC-PROPOSED-4: S-03 «مطابقة يدوية بعد انقطاع» inputs** — 02 S-03 gives «الحالة الفعلية + الدليل + السبب» only. — The
  sheet offers the true states the server accepts (a paper ticket without its stub → «ملغاة» only, `paper_serial_missing`; a
  recorded payment → no «ملغاة», 13 §8.6; `parked` → `parked` as a correction); the paper-log reference is free text ≤ 60
  with the hint «P02-R07» (`paper-fallback.md` §5.4); spot (or a place note) and slot for «متوقفة» from the current one and
  the free ones; the payment of a due «مُسلّمة» with the event's `allowed_payment_methods` (fallback cash/pos, as DEC-326),
  the fee as the amount and the collector among the venue's drivers and the supervisor himself; the incident among the
  ticket's own incidents. — 02 S-03; `TicketRecoveryActions.tsx`.
- **DEC-PROPOSED-5: the S-13 «الموظفون» route** — 02 §9.1 / DEC-322 list `/admin/:section` without this section. —
  `/admin/staff`, first in the S-13 sections, read with `staff.manage`. — 02 §9.1, 02 S-13.
- **DEC-PROPOSED-6: a reason for «تفعيل الحساب» too** — the server requires `reason` for any staff status change
  (`patchStaff`); `07_openapi.yaml` `PATCH /v1/staff/{userId}` documents it for `disabled` only. — The UI asks a reason for both;
  07 to say «any status change». — `07_openapi.yaml`, 07 §2.6.
- **DEC-PROPOSED-7: «إعادة ضبط التحقق الثنائي» only for a member with MFA enabled** — the reset (owner only) revokes the
  sessions; without MFA there is nothing to reset and the next sign-in asks the set-up anyway. — Offered when `mfa_enabled`.
  — 02 S-13.
- **DEC-PROPOSED-8: «النطاقات» of an administration account** — 02 S-13 «النطاقات» is per supervisor venue. — For an admin the
  sheet toggles the org scope (`org_scope`, owner only, the administration does not manage admins). — 02 S-13.
- **DEC-PROPOSED-9: the S-06 DEC-32 confirmations leave the judgement to the server** — 02 S-07 disables «تأكيد النقل» «الآن»
  with a ✗; 02 S-06 says «والحكم النهائي للخادم» for disable and forced end. — In S-06 the confirm stays enabled whatever the
  snapshot shows (a stale snapshot never blocks a valid command; a boards read that failed hides the list and leaves only the
  sentence); the refusal replaces the list with `details.items`. — 02 S-06.
- **DEC-PROPOSED-10: S-06 refusals use the S-06 text** — DUTY_END_BLOCKED_CUSTODY's 08 text speaks to the driver («وبعهدتك»);
  02 S-06 gives «لا يمكن تنفيذ الإجراء وبعهدة السائق: {العناصر}.» for CUSTODY_OPEN and «بالقائمة نفسها» for the forced end. —
  Both refusals show the S-06 sentence with the items («مفتاح #39، مركبة #44»), an exception to DEC-80 like S-07's
  TRANSFER_BLOCKED_CUSTODY. — 02 S-06, 08 §4.
- **DEC-PROPOSED-11: «إعادة فتح الحفل» in S-08** — 07 `openEvent` reopens a closing event (11 §6.4) and `paper-fallback.md`
  §5.3 step 0 needs it to enter cars received on paper; 02 S-08's «فتح حفل» row has no card wording for it. — A closing
  event's card has «إعادة فتح الحفل» behind a confirmation («يعود الحفل «مفتوحًا» ويُسمح بتسجيل مركبات جديدة فيه. ابدأ الإغلاق
  من جديد بعد الانتهاء.») next to «إغلاق الحفل والمطابقة». — 02 S-08 table, 02 §8.6 copy.
- **DEC-PROPOSED-12: «عرض التقرير» on a closed event card** — 02 S-10 step 3 leads to S-11 once; a closed event is otherwise
  reached from S-11's filters. — The closed card links to S-11 of the event for `report.read`. — 02 S-08.
- **DEC-PROPOSED-13: the S-07 snapshot rows** — 02 S-07 shows «[فتح]» on the ✗ row of the snapshot; DEC-32 counts an active
  park/repark as blocking. — «فتح» on every numbered snapshot row (not only after a refusal); an accepted `park`/`repark`
  counts as «مهمة جارية أو صف/إعادة صف», as the server's `blockingCustody`. — 02 S-07 «قائمة التحقق».
- **DEC-PROPOSED-14: S-10 «فتح واقعة» on a key not in its slot** — 02 S-10 names `custody_mismatch` and `key_missing` without
  a row. — The custody row opens the incident with `key_missing` preset and the ticket attached (the type stays editable). —
  02 S-10.

## API gaps (what the screens need and the server does not give)

1. `DriverLive` has `active_task_id` / `next_task_id` but no ticket numbers: S-05 «يحضر/يسلّم» #125 and the large-screen
   «المهمة» column (02 S-05).
2. Device state per driver (audio test result, notification permission): S-05 «الجهاز» and S-06 «المناوبة الحالية» (02 S-05,
   S-06; DEC-342).
3. `DriverAssignment` has no approver: S-06 «سجل التعيينات … المعتمد».
4. `Reconciliation.blockers.open_tickets` (TicketSummary) has no spot, key slot or ready time («#140 │ «متوقفة» │ A-12 │ خانة 33»,
   «جاهزة» منذ 22:10), and `keys_not_in_slots` has no holder («خالد │ مفتاح #141») (02 S-10).
5. `TicketDetail` has no `allowed_payment_methods`: the manual reconcile reads `GET /v1/events/{eventId}` for them (as DEC-326
   for the handover exception).
6. `07_openapi.yaml` `PATCH /v1/staff/{userId}`: the reason is documented for `disabled` only; the server requires it for
   every status change (DEC-PROPOSED-6).
7. An `Alert` carries `user_id` but not the driver's name: S-04 links «فتح» to S-06 without naming him.
8. `payment.collected_by` of the manual reconcile accepts any user of the organization, but only drivers are listable
   (`GET /v1/drivers`): a supervisor other than the caller who collected on paper cannot be chosen.

## Copy not in 02 §8 (for 02 §8.6)

All in `apps/web/src/i18n/ar.staff.ts`. S-03 (`s03.relink`, `s03.reconcile`):

- `s03.relink.status` «حالة الربط: «{status}»»
- `s03.reconcile.note` «لا تُشغّل أوامر مؤجلة ولا تُرسل رسائل عميل قديمة.»
- `s03.reconcile.paperRef` «مرجع السجل الورقي» · `paperRefHint` «مرجع آخر سطر للمركبة، مثل P02-R07»
- `s03.reconcile.evidenceNote` «ملاحظة الدليل (اختياري)» · `evidenceNoteHint` «كل أسطر المركبة وطريقة التحقق»
- `s03.reconcile.unknownHolder` «دونهما يبقى الحائز «غير معروف».» · `collectorHint` «المحصِّل من السجل الورقي»
- `s03.reconcile.incident` «الواقعة المرتبطة (اختياري)»
- `s03.reconcile.paperOnlyVoid` «تذكرة ورقية بلا رقم كعب: «ملغاة» فقط.» · `paymentRecorded` «عليها تحصيل مسجّل: لا تُلغى (اعكس
  التحصيل أولًا).»

S-13 «الموظفون» (`s13.staff`):

- `add` «إضافة موظف» · `noScope` «بلا نطاق» · `lastLogin` «آخر دخول» · `never` «لم يدخل بعد» · `empty` «لا يوجد موظفون مطابقون.»
- `tempSecret` «كلمة المرور المؤقتة: {secret}. أعطها للموظف؛ سيُطلب منه تغييرها وإعداد التحقق الثنائي عند أول دخول. لن تظهر مرة
  أخرى.» (S-05's PIN sentence for a password)
- `resetMfa` «إعادة ضبط التحقق الثنائي» · `resetMfaConfirm` «إعادة ضبط التحقق الثنائي لـ{name}؟ تنتهي جلساته الحالية، ويُطلب منه
  إعداد التحقق الثنائي عند دخوله التالي.»
- `orgScopeHint` «حساب الإدارة يعمل على كل المواقع؛ سحب النطاق يوقف وصوله دون تعطيل الحساب.» · `venuesHint` «المشرف يرى المواقع
  المختارة فقط، والسحب يسري فورًا.» · `canDriveHint` «يبدأ مناوبة ويدخل التوزيع كسائق داخل نطاقه.» · `enableReason` «سبب التفعيل»

S-08 (`s08`, listed in `test/copy.test.ts` NOT_IN_02): `reopen` «إعادة فتح الحفل» · `reopenBody` «يعود الحفل «مفتوحًا» ويُسمح
بتسجيل مركبات جديدة فيه. ابدأ الإغلاق من جديد بعد الانتهاء.»

Everything else added by this stream is 02's own text (S-03 action names and D-07 relink lines, `s06.transfer`,
`s06.forceEnd`, `s06.autoRelease`, `s06.custodyOpen`, `s08.startClosing`, `s08.closeEvent`, `s08.viewReport`; the copy test
checks the s06/s08 ones).

## Docs updated

- `docs/runbooks/go-live-checklist.md` §2: the rows GAP-2 … GAP-6 marked closed with their proof (rows GAP-1, GAP-7, GAP-8 and
  GAP-9 untouched). §0 «فجوات واجهة» and §4 row 4 «○ (GAP-1…GAP-4)» count the gaps of every stream: left to the lead's merge.
- `docs/training/supervisor-guide.md`: the five build-status rows of these gaps, §1 (MFA reset in S-13), §5 (the three S-03
  rows), §9 (S-06 buttons and the forced end), §10 (the way in from S-08, the custody row), the appendix as a fallback.
- `docs/runbooks/paper-fallback.md`: §5.3 step 0 (reopen from the S-08 card), §5.4 (the S-03 sheet), the appendix as a fallback.

# driver-gaps — GAP-1, GAP-7, GAP-8 and the D-01…D-15 sweep (apps/web)

Scope: the driver screens of `apps/web` against 02 D-01…D-15, on branch `wave5/driver-gaps` (base `34ffe37`). The
server side of every gap was complete and tested before this stream; nothing in `packages/server` or `apps/api` was
changed. The lead numbers the proposals below into `docs/DECISIONS.md` (from DEC-365).

## Gaps closed

| Gap | What the driver has now (02 reference) | Evidence |
|---|---|---|
| GAP-1 | D-05 «تذكرة العميل» (واتساب / تذكرة ورقية) and «طريقة الربط» (رقم جوال العميل / رمز QR يمسحه العميل), the phone with `PhoneInput`, the consent box with the question read to the customer, local checks (02 D-05 «الجوال وخانة الموافقة إلزاميان»), the QR choice empties the number and the consent; the step-1 body by `channelBody` (02 D-05 «طريقة الربط اختيار محلي…»). D-06 issues `whatsapp-link {qr}` right before `submit-intake` in the QR mode, reusing a code with ≥ 60 s left (02 D-06 «في وضع QR فقط»); WA_TEMPLATE_NOT_APPROVED / WA_CHANNEL_UNAVAILABLE send the driver back to D-05. D-07 mode أ (status chip «جارٍ الإرسال…» ← «أُرسلت» ← «تعذر الإرسال», the last three digits, «العميل لم تصله الرسالة؟», «إعادة الإرسال», «الربط عبر QR», «تذكرة ورقية» DEC-40) and mode ب (the customer-brand panel with the QR drawn on the device, «قاعة … · تذكرة n · صالح لمدة m:ss», «بانتظار رسالتك…», «رمز جديد», «تغيير الطريقة», «ملء الشاشة», the confirmation Dialog → `whatsapp-link/confirm`, «تم الربط — وصلت التذكرة للعميل.» once linked only, «انتهت صلاحية الرمز.»); the channel down while W-01 waits shows «واتساب متوقف مؤقتًا. سلّم العميل تذكرة ورقية.» with the stub; «متابعة إلى الصف» and DEC-40's paper stub only on the park task in this driver's hands, «العودة» otherwise (D-07 opened from D-13) | `apps/web/e2e/driver-whatsapp.spec.ts` (21 tests), `apps/web/test/linkModel.test.ts` (25), `apps/web/test/intakeErrors.test.ts` (5), `apps/web/e2e/layout.spec.ts` (D-05 QR, D-05 paper, D-07 sending, D-07 QR panel, D-07 QR full screen, D-07 channel down at 360/390/430 × 2 themes) |
| GAP-7 | D-10 «إبلاغ عن مشكلة»: the Sheet of 02 D-10 (four types, a mandatory description) → `POST /v1/incidents` with the ticket (DEC-237) → «أُبلغ المشرف.»; «تعذر إرسال الرسالة للعميل. أُبلغ المشرف.» when W-05 failed or was skipped (02 D-10 «فشل رسالة العميل») | `apps/web/e2e/driver-help.spec.ts` (2), `apps/web/e2e/layout.spec.ts` (D-10) |
| GAP-8 | D-11 «العميل لم يصله الرمز؟ │ إعادة الإرسال (متبقٍ n)» before the expiry, `resends_left` from the server, 30 s apart; the Sheet «إعادة إرسال الرمز» / «طلب المشرف (تحقق يدوي)» → a `manual_verification` incident with a mandatory description (DEC-210), kept after the expiry and with no resend left (only a locked code drops it); a WhatsApp ticket without a code (not linked at `ready`) shows «التذكرة غير مربوطة بواتساب.» and «طلب المشرف (تحقق يدوي)» instead of the cells, a ticket linked since gets its first code from «إرسال رمز جديد»; a code the supervisor reissued opens the cells again with «أُرسل الرمز للعميل»; the 14 §5.1 banners (W-05 not sent, the code expired by server time with «إرسال رمز جديد», locked, opted out) | `apps/web/e2e/driver-help.spec.ts` (9), `apps/web/e2e/layout.spec.ts` (D-11 WhatsApp code, D-11 WhatsApp without a code) |

## Sweep D-01…D-15 — further controls closed

| # | 02 reference | Change |
|---|---|---|
| 1 | D-13 «إعادة الربط بواتساب: يظهر عند `wa_link_status` بقيمة `none` أو `failed`، ويفتح D-07» | the action (WhatsApp ticket after the intake, `wa.link`) → D-07; covered by `driver-whatsapp.spec.ts` |
| 2 | D-07 «بعد المغادرة: … «تعذر إرسال تذكرة #125 للعميل.» بزر «فتح» إلى D-13» | a frame notice raised by `ticket.updated` (W-01 failed), gone when the link is no longer failed or on that ticket's D-07 (DEC-PROPOSED-11); `driver-whatsapp.spec.ts`, `test/realtime/driverRuntime.test.ts` |
| 3 | 14 §5.1 «العميل أوقف الرسائل» (02 D-13 row `WA_CUSTOMER_OPTED_OUT`) | a frame notice for the drivers the event reaches; the banner on D-07 and D-11 |
| 4 | D-06 `INTAKE_INCOMPLETE` «إبراز الحقول في `details.missing` والانتقال للخطوة التي تحتويها» | D-05 now highlights the fields of `details.missing` with the server's text (before: a form message only); `driver-whatsapp.spec.ts` «02 D-06 INTAKE_INCOMPLETE…» |
| 5 | D-11 `HANDOVER_CODE_EXPIRED` «+ زر «إرسال رمز جديد»» | also when the code expired by server time, before any wrong attempt (with 14 §5.1's banner) |
| 6 | D-11 «[Hint] الرمز من 6 أرقام ووصل العميل في رسالة …» | shown without the customer brand (DEC-PROPOSED-3) |
| 7 | D-10/D-11 W-05 failure | `ticket.updated` with a `message` state re-reads the ticket although its version did not move |
| 8 | D-05 (old drafts) | a draft saved before the WhatsApp choice existed (a stub number only) comes back as paper (`channelForm`) |
| 9 | D-11 «ويتحدث «متبقٍ {n}»» | the newest code state wins (a resend's reply until the ticket catches up, `newestClaim`), so a later W-05 failure of the new code shows |
| 10 | 14 §5.1 notices | an older `ticket.updated` arriving after a newer one raises no WhatsApp notice (per-ticket version) |
| 11 | D-11 + 14 §3.4 `handover.code_issued` «أُرسل الرمز للعميل» (audit A-driver-1) | the code causes re-read the ticket and the task card; the attempts and the lock belong to the code they were learned on, so a reissued code opens the cells (DEC-PROPOSED-19); `driver-help.spec.ts` «audit A-driver-1…», `driverRuntime.test.ts` |
| 12 | D-14 «نقد بعهدتك» + 13 §8.7 «تعرض D-14 تنبيهًا للسائق قبل إنهاء الوردية» (A-driver-9) | both end-of-shift dialogs carry «نقد بعهدتك: {المبلغ}» (DEC-PROPOSED-25); `driver-account.spec.ts` |
| 13 | 01 FR-DUTY-02 «تحذير دائم ظاهر في D-04» (A-driver-10) | D-04 keeps a warning with «تفعيل واختبار الصوت» until a heard test (DEC-PROPOSED-26); `driver-account.spec.ts` «audit A-driver-10…» |
| 14 | D-05 «[ ] لوحة غير سعودية» (A-driver-13; 03 §6: 02's text over 03 §3.7) | the toggle and the raw field read «لوحة غير سعودية» |
| 15 | D-05 a draft resumed without this device's copy | the method follows the number on record and a recorded number is kept (DEC-PROPOSED-21) |

Checked and left as built (reason): D-01 … D-04, D-08, D-09, D-12, D-14, D-15 match 02 (built and reviewed in S5,
`docs/progress/notes/s5-web.md`) except the rows above; D-10 «سحب المهمة من المشرف» stays the 14 §5.1 red banner
(DEC-PROPOSED-14); D-07 «يرفع السطوع إن أمكن» has no web API (DEC-PROPOSED-10). Not built, with the reasons under
«Audit responses»: the D-03 venue choice of a driving supervisor with several venues (DEC-PROPOSED-27), the client
telemetry of 15 §8 (DEC-PROPOSED-29), the on-behalf reasons as §8.4 keys (DEC-PROPOSED-28), typing Latin plate
letters and searching the make list (D-05, sev 4).

## Safety rules kept

- The customer's number exists on the device only in the current D-05/D-06 draft (memory + the IndexedDB draft row,
  05 §14), and goes with it at the submit, a discard or a sign-out; afterwards D-07 shows the last three digits of
  the server's masked number and D-13 the masked number (09 §5.1); a paper or QR body sends `customer_phone: null`
  (DEC-PROPOSED-4). The e2e proves the page and the browser storage no longer hold it after the submit.
- The link code and its wa.me link live in memory only (`linkStore`, 09 §5.1 «للسائق الطالب فقط … طالما هو active»);
  the code is drawn as a QR, never written as text; the panel shows the site and the ticket number only.
- The handover code is never shown or kept (DEC-38): the e2e checks the page for both codes after a resend and
  after the first code of a ticket linked late.
- No browser autofill on a phone field (`PhoneInput` defaults to `autocomplete=off`; the sign-in pages keep
  `username`): the browser would offer the device owner's own number for the customer's (05 §14.2).
- No brand literal in `src/` or `e2e/support/` (canon §1 rule 4): the consent question takes `{customer}` from the
  settings; the e2e sets it on the fake (`fake.brand`).

## Proposed decisions

**DEC-PROPOSED-1 — the consent question names the business; the box does not** — context: 02 D-05 writes both the
checkbox and the hint with «مصاف»; canon §1 rule 2 allows the customer brand on the staff screens only on D-07, S-03
and S-13, while 12 §7.1 / F-17 require the question read to the customer to name the business. — decision: the box
is `d13.consent` without the brand (as notes/s5-web.md DEC-PROPOSED-11 for D-13); the hint
«اسأل العميل: «هل توافق أن تصلك تذكرة السيارة وتحديثاتها من {customer} على واتساب؟»» takes the customer brand from
the settings (`useBrand().customerNameAr`). — affected files: canon §1 rule 2 (add «سؤال الموافقة في D-05»), 02 D-05,
`apps/web/src/i18n/ar.ts` (`d05.consentHint`).

**DEC-PROPOSED-2 — D-07 mode أ without the brand** — context: 02 D-07 «أُرسلت تذكرة «مصاف» إلى الرقم المنتهي بـ 123.»
is outside the QR panel (canon §1 rule 2). — decision: «أُرسلت تذكرة واتساب إلى الرقم المنتهي بـ 123.» (`d07.sentTo`).
— affected files: 02 D-07 and §8, `ar.ts`, `test/copy.test.ts` (NOT_IN_02).

**DEC-PROPOSED-3 — D-11 hint without the brand** — context: 02 D-11 «[Hint] الرمز من 6 أرقام ووصل العميل في رسالة
«مصاف».» — decision: «الرمز من 6 أرقام ووصل العميل في رسالة واتساب.» (`d11.codeHint`). — affected files: 02 D-11, `ar.ts`.

**DEC-PROPOSED-4 — the channel body nulls what the channel does not use** — context: 02 D-05 nulls the number and the
consent when switching to QR; nothing says what a paper ticket keeps. — decision: paper sends `customer_phone: null`,
`consent: null`; QR sends both `null` and `paper_serial: null`; direct sends `paper_serial: null` (`channelBody`), so no
customer number is stored for a ticket that does not message him (05 §14 data minimisation). — affected files: 02 D-05.

**DEC-PROPOSED-5 — the QR after a reload** — context: the code exists only in the issuing reply (09 §5.1); after a
reload, a rejected sender («لا، ليس هو») or a confirmation there is none to draw. — decision: the panel area says
«اضغط «رمز جديد» ليظهر رمز QR للعميل.» with «رمز جديد» (`d07.noCode`); no command runs without a tap. — affected files:
02 D-07 and §8, `ar.ts`.

**DEC-PROPOSED-6 — the confirmation without a sender number** — context: `wa_link_pending.inbound_phone_masked` is
empty for a username sender (F-21) and absent from the minimal projection (a parked ticket of another driver). —
decision: «وصلت رسالة الربط.» then «هل هو جوال العميل الذي أمامك؟» (`d07.confirmTitleUnknown`); the link code id comes
from the projection, the realtime payload, or the code this driver issued. — affected files: 02 D-07, `ar.ts`.

**DEC-PROPOSED-7 — D-07 reads the ticket again while it waits** — context: 07 §4.3 events are not a source of truth,
and a driver who issued the QR of a ticket he neither created nor holds receives no `ticket.updated` (API gap 1). —
decision: while D-07 waits (W-01 pending, a live code, a pending confirmation) it polls `GET /v1/tickets/{id}` every
4 s besides the events (`LINK_POLL_MS`). — affected files: 02 D-07 (or 07 §4.3 if API gap 1 is closed instead).

**DEC-PROPOSED-8 — «العميل لم تصله الرسالة؟» offers what the server takes now** — context: 02 D-07 lists «الخيارات
الثلاثة نفسها» with «تأكد مع العميل من الرقم، أو اطلب منه مسح رمز QR.»; for a `linked` ticket the server refuses all
three (`already_linked`, `ticket_linked`). — decision: the Sheet shows the allowed ones (`linkActions`) plus
«تغيير رقم الجوال» (D-13's Sheet, `PATCH …/customer-phone`) for the creator or the assignee. — affected files: 02 D-07.

**DEC-PROPOSED-9 — «تغيير الطريقة» in mode ب** — context: 02 D-07 names the button, not its choices; after the intake
the only way to give the ticket a number is `PATCH …/customer-phone`. — decision: «رقم جوال العميل» opens D-13's
«تغيير رقم الجوال» Sheet; «تذكرة ورقية» opens the DEC-40 stub Sheet (parking only). — affected files: 02 D-07.

**DEC-PROPOSED-10 — «ملء الشاشة»** — context: 02 D-07 «يخفي منطقة السائق ويرفع السطوع إن أمكن؛ الضغط المطوّل أو زر
«إغلاق» صغير في الزاوية يعيدها». The web has no brightness API and iOS Safari no element fullscreen. — decision: an
in-app overlay with the panel only, «إغلاق» (44 px target) in the corner, a 0.8 s long press or Escape; the panel's
«ارفع سطوع الشاشة» (03 §3.13) asks the driver; the overlay closes when the code expires. — affected files: 02 D-07.

**DEC-PROPOSED-11 — «بعد المغادرة» is a frame notice** — context: 02 D-07 asks a «Toast دائم حتى يُغلق» with «فتح» →
D-13; the driver frame shows its persistent 14 §5.1 notices as banners. — decision: a banner «تعذر إرسال تذكرة #n
للعميل.» with «فتح» (→ D-13, which offers the relink), one per ticket, not over that ticket's D-07, gone when the link
is no longer failed. — affected files: 02 D-07, 14 §5.1.

**DEC-PROPOSED-12 — channel errors at the submit go back to D-05** — context: 02 D-06's table sends CONSENT_REQUIRED,
PHONE_INVALID, PLATE_INVALID and WA_CUSTOMER_OPTED_OUT back to D-05; WA_TEMPLATE_NOT_APPROVED (the submit's direct link)
and WA_CHANNEL_UNAVAILABLE (the QR issued before the submit) have D-07 texts «سلّم العميل تذكرة ورقية». — decision: both
also return to D-05 with the server's text, where the driver switches to paper; WA_CUSTOMER_OPTED_OUT shows under the
number (the QR and paper choices are on the form). — affected files: 02 D-06.

**DEC-PROPOSED-13 — a code issued while W-01 is pending** — context: QR is allowed from `pending_send` (DEC-196) and
the customer's message links unless W-01 was accepted first (12 §7.2). — decision: the QR method shows the panel
until the ticket is `linked` — while W-01 is pending too, and with «انتهت صلاحية الرمز.» + «رمز جديد» once the code
ran out (never «تم الربط» before the link; `linkBody`); D-07 keeps reading the ticket while W-01 waits; a direct
resend drops the code from memory (the server revokes it); a code the customer sent is never drawn again (it never
becomes active again, 11 §5.2). — affected files: 02 D-07.

**DEC-PROPOSED-14 — the D-10 withdrawal with the key in hand** — context: 02 D-10 shows on a withdrawal «أعد المفتاح
إلى الخانة {خانة} ثم أكّد» with «أعدت المفتاح» → `release-custody`; 10 §9.1 refuses the withdrawal while the key is
with the driver (`CUSTODY_RELEASE_REQUIRED`), so the release always comes first and the dialog's key branch is
unreachable; there is no event asking the driver to return the key. — decision: the withdrawal stays the 14 §5.1
banner «سحب المشرف المهمة — تذكرة n. لا تُحضر السيارة.» with `reminder`; the release is the supervisor's (or a
custody transfer). A driver-side «أعدت المفتاح» needs a trigger the contract does not have. — affected files: 02 D-10,
10 §9.2, `docs/training/driver-guide.md` §8 (done).

**DEC-PROPOSED-15 — «فشل رسالة العميل» on D-10 covers W-05 only** — context: 02 D-10 names W-04 and W-05; 09 §5.1
lets a driver see the W-01 and W-05 states only. — decision: the banner follows `claim_code.sent_status` (W-05);
a W-04 failure is the supervisor's (S-03). — affected files: 02 D-10 or 09 §5.1.

**DEC-PROPOSED-16 — D-11 texts not in 02** — context: 02 D-11 gives no text for the W-05 failure, the local expiry,
the lock and the opt-out, and no success text for «طلب المشرف (تحقق يدوي)». — decision: the 14 §5.1 lines
(`live.codeSendFailed`, `codeExpired`, `codeLocked`, `optedOut`, checked against 14 by `test/copy.test.ts`) and
D-10's «أُبلغ المشرف.» — affected files: 02 D-11 and §8.

**DEC-PROPOSED-17 — D-11 for a WhatsApp ticket without a code** — context: the API issues the code at `ready` only
for a linked ticket and otherwise expects `supervisor_exception` (use-cases/movement.ts markReady); the resend gives
a code-less cycle its first code once linked (07 resend), and answers WA_NOT_LINKED otherwise; 02 D-11 assumes a
code. — decision: no code cells and no code hint; not linked → 08's WA_NOT_LINKED text «التذكرة غير مربوطة بواتساب.»
(or 14 §5.1's opt-out line) with «طلب المشرف (تحقق يدوي)» (the Sheet on the supervisor request alone), «تأكيد
التسليم» disabled; linked → «إرسال رمز جديد» (the first code) with «العميل لم يصله الرمز؟». — affected files: 02 D-11.

**DEC-PROPOSED-18 — «العميل لم يصله الرمز؟» after the expiry** — context: 02 D-11 places the row before the expiry;
RESEND_LIMIT_REACHED and WA_CHANNEL_UNAVAILABLE tell the driver to ask the supervisor (02 D-11, 08). — decision: the
row's «العميل لم يصله الرمز؟» and its Sheet stay in every WhatsApp state except a locked code (`handover_code_locked`
already alerted the supervisor); «إعادة الإرسال (متبقٍ n)» before the expiry, «إرسال رمز جديد» after it, both off at
0 left with 08's RESEND_LIMIT_REACHED text («وصلت للحد الأقصى لإعادة إرسال الرمز. اتصل بالمشرف.»). — affected
files: 02 D-11.

**DEC-PROPOSED-19 — D-11 follows the live code** — context: 14 §3.4 handover.code_issued → the driver «أُرسل الرمز
للعميل» (no code); DEC-207 lets the supervisor reissue a locked code; the event moves no ticket version. — decision:
the code causes (`handover.code_issued`, `code_attempt_failed`, `code_locked`) re-read the ticket and the task card;
D-11 takes the newest code by `issued_at`, the attempts and the lock it learned belong to that code, and a newer code
this screen did not ask for shows the Toast «أُرسل الرمز للعميل» (`live.codeIssued`). — affected files: 02 D-11,
14 §3.4.

**DEC-PROPOSED-20 — D-06 retries the submit once with a fresh code** — context: the QR kept in memory can be dead on
the server (revoked by another device or a paper save, used); `submit-intake` then answers INTAKE_INCOMPLETE
`{missing: [customer_phone]}`. — decision: a paper save drops the kept QR (the server revoked it, `channel_paper`);
when a submit that reused a kept code is refused with only `customer_phone` missing, D-06 issues a fresh code and
submits once more (a new Idempotency-Key: the refusal was definitive); any other INTAKE_INCOMPLETE returns to D-05,
where a field the choice does not show is the form message. — affected files: 02 D-06.

**DEC-PROPOSED-21 — D-05 resumed without this device's draft** — context: the typed number stays in the device's
draft only (05 §14); a draft resumed on another device has none, while the server holds the number and its consent.
— decision: the method follows the record (a WhatsApp draft saved without a number → QR; a fresh draft → «رقم جوال
العميل»); a number on record shows as «الجوال: 05•••••567» with «تغيير رقم الجوال» and is kept — neither the number
nor the consent is sent — until another number is typed, which needs the consent again. — affected files: 02 D-05.

**DEC-PROPOSED-22 — D-07 for a ticket the driver does not park** — context: wa.link is open to any driver of the
venue on duty (canon §10), DEC-40's paper conversion is the creator's (`not_ticket_creator`), and 02 D-13 shows the
relink at `none`/`failed` whatever D-07 can do. — decision: «متابعة إلى الصف» and «تذكرة ورقية» only on the park /
repark task in this driver's hands (`ownParkTask`), «العودة» to D-13 otherwise; D-13 «إعادة الربط بواتساب» only when
D-07 can act — a QR while received / parking / parked, or the resend to a number this viewer sees (`canRelink`). —
affected files: 02 D-07, D-13.

**DEC-PROPOSED-23 — D-07 when the channel is down** — context: 12 §7.3 «القناة down وقت الاستلام: … D-07 يعرض
«واتساب متعطل — سلّم العميل تذكرة ورقية احتياطًا»»; 02 D-07 words it «واتساب متوقف مؤقتًا. سلّم العميل تذكرة ورقية.»
(the WA_CHANNEL_UNAVAILABLE row). — decision: 02's text as a banner while the health is `down` and the link `none` or
`pending_send` (W-01 waits), with «تذكرة ورقية» for the parking driver (DEC-40). — affected files: 12 §7.3 (point to
02's text).

**DEC-PROPOSED-24 — no autofill on phone fields** — context: 03 §3.8 says nothing about autofill; the customer's and a
new driver's numbers are not the device owner's (05 §14.2). — decision: `PhoneInput` sends `autocomplete="off"` by
default; the sign-in pages pass `username`. — affected files: 03 §3.8.

**DEC-PROPOSED-25 — the cash in hand at the end of the shift** — context: 13 §8.7 «تعرض D-14 تنبيهًا للسائق قبل
إنهاء الوردية» gives no text. — decision: both end-of-shift dialogs of D-14 carry 02 D-14's line «نقد بعهدتك:
{المبلغ}» as their body when `cash_outstanding_halalas > 0`; the end is not blocked (13 §8.7). — affected files:
02 D-14.

**DEC-PROPOSED-26 — the D-04 sound warning** — context: 01 FR-DUTY-02 «يمكن بدء المناوبة بنتيجة غير heard مع تحذير
دائم ظاهر في D-04» gives no text; the D-15 د banner covers a stopped AudioContext only. — decision: while the sound
runs and the device's result is not `heard` (`checks.audio_tested`, or this page's answer), D-04 shows 02 D-03's
«لم تختبر الصوت بعد، وقد لا تسمع طلبات الإحضار.» (after «لا»: «ارفع صوت الجهاز وأوقف الوضع الصامت ثم أعد
الاختبار.») with «تفعيل واختبار الصوت». — affected files: 02 D-04 and §8.

**DEC-PROPOSED-27 — D-03 for a driving supervisor with several venues (not built)** — context: FR-ACC-10 / DEC-22
let a `can_drive` supervisor start a duty «في موقع ضمن نطاقه», DEC-182 makes `venue_id` mandatory when he has
several, and `GET /v1/me/home` answers `venue = null` for him without a duty; 02 D-03 has no venue choice. — decision
proposed: when `Me.scopes` holds two or more venues, D-03 shows a venue `Select` (names from `GET /v1/venues`), the
chosen venue's shift state from `GET /v1/venues/{venueId}/shifts`, and «بدء الوردية» sends `venue_id`; until then a
driving supervisor is scoped to one venue (as SUP-RD of 17 §4). Needs 02 copy for the picker. — affected files: 02
D-03, `apps/web/src/features/driver/StartShiftPage.tsx`, the e2e fake (`POST /v1/me/duty/start` for supervisors).

**DEC-PROPOSED-28 — on-behalf reasons as keys (not built)** — context: 02 §9.3 item 16 (approved) stores the §8.4 lists
as English keys translated in the UI; D-13 and S-03 send the Arabic label as `reason`, and the S-13 audit list shows
the stored text. — decision proposed: send `paper_ticket` · `no_whatsapp` · `wa_down` · `verbal` (free text for
`other`) from D-13 and S-03 in the same change, and translate the keys where the reason is shown (the audit list,
any export); one side alone would mix keys and labels in `retrieval_cycles.request_reason`. — affected files:
`apps/web/src/features/driver/vehicles/actions.tsx`, `apps/web/src/features/supervisor/TicketActions.tsx`,
`apps/web/src/features/admin/AuditLogSection.tsx`.

**DEC-PROPOSED-29 — the client telemetry of 15 §8 (not built)** — context: `POST /v1/telemetry` and the catalog
(`packages/shared/src/analytics.ts`, `parseTelemetryEvent`) exist; the web app sends nothing. — decision proposed: its
own ticket — a memory queue validated with `parseTelemetryEvent`, batches of ≤ 50 sent with `fetch(…, {keepalive:
true})` and the CSRF header on a timer and on `pagehide`, after sign-in only, `device_id` and a per-tab
`client_session_id`; the events wired at their sources (D-03/D-14 audio, the engine's connection and sync, offers,
visibility during duty, wake lock, drafts, updates, push clicks from the service worker) and `offer_card_seen` in the
batch while the socket is down (15 §9.4); the e2e fake answers 202. — affected files: `apps/web/src/lib/` (new),
the call sites, `apps/web/e2e/support/fake`.

**DEC-PROPOSED-30 — the creator of a parked ticket and «تغيير رقم الجوال»** — context: 02 D-13 and canon §10 give the
phone change to the creator or the assignee; after `parking` the driver's projection is minimal and does not say
that he created the ticket, so D-13 cannot offer it (the server would accept him, DEC-211). — decision proposed: the
driver's TicketDetail carries `viewer_is_creator: boolean` (no other field), and D-13 shows the action for it; until
then the creator changes the number while the ticket is in parking (D-07 or D-13) or asks the supervisor (S-03, GAP-2).
— affected files: 07 `TicketDetail`, 09 §5.1, `packages/server/src/modules/tickets-custody/application/views.ts`,
`apps/web/src/features/driver/vehicles/model.ts`.

## API gaps (for the server owners)

1. **`ticket.updated` for the code's creator** — a driver who issues the QR of a ticket he neither created nor holds
   (D-13 relink of another driver's parked ticket) gets no `ticket.updated` and no `wa_link_pending` (the coalescer's
   privileged drivers are the creator and the assignee), and the parked ticket's creator reads no `wa_link_pending`
   from `GET /v1/tickets/{id}` (`isCreatorIntake` covers `received`/`parking` only). The creator does get it in
   `ticket.updated` for ticket.wa_link_changed (a CREATOR_EVENT; corrected after the review — the e2e fake now does
   the same and «D-13 → D-07 on a parked ticket» covers it). Proposal: publish to `link_codes.created_by` and include
   `wa_link_pending` for the code's creator. Until then D-07 polls (DEC-PROPOSED-7) and the dialog may lack the
   number (DEC-PROPOSED-6).
2. **F-21 senders** — `inbound_phone_masked` is `''` for a username sender and no profile name is sent: the driver
   confirms without any hint of the sender.
3. **A non-canon cause** — `packages/server/src/modules/whatsapp/application/link-service.ts:341` publishes
   `ticket.updated` with `cause: 'wa.link_code_expired'`, neither a canon §7.1 event nor a §7.2 job (the job is
   `job.link_code_expire`); `RealtimeCauseSchema` rejects the frame and the client falls back to a full sync.
4. **W-04 for the driver** — 02 D-10 asks a banner for a failed W-04; 09 §5.1 and the projection give drivers W-01 and
   W-05 only (DEC-PROPOSED-15).
5. **Back to «رقم الجوال» after a QR in D-06** — a code issued at a failed submit stays live; if the driver then
   switches D-05 to the number, `submit-intake` does not link directly (a live code exists), and D-07 offers
   «إعادة الإرسال», which revokes the code and sends W-01. One extra press; `PATCH …/intake` with a number could revoke
   the live codes instead.
6. **The creator flag for a driver (audit A-driver-6)** — after `parking` the driver's projection is minimal and
   carries nothing that says he created the ticket, so D-13 cannot offer him «تغيير رقم الجوال» although
   `PATCH …/customer-phone` accepts him (DEC-211). Proposal DEC-PROPOSED-30 (`viewer_is_creator`).
7. **The transfer of a driver, to the driver (audit A-driver-15)** — 14 §3.3 gives the driver an information banner
   with the transfer time and the new venue (driver.transfer_requested) and «النقل معلّق حتى تسليم العهدة»
   (driver.transfer_blocked); the server publishes both to the supervisor rooms only
   (`packages/server/src/modules/dispatch/application/realtime.ts`) and `DriverLive` / `DriverHome` carry no transfer
   fields. The driver side needs the event (or a `pending_transfer {effective_at, venue_name_ar, blocked}` in the
   snapshot) before the frame can show it.

## Review responses (two reviewers, wave 5)

All seventeen findings were real and are fixed; the tests below fail on the code before the fix.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | (critical) D-07 «تم الربط» after a QR expired while W-01 was pending | the QR method shows the panel until `linked` (`linkBody`), D-07 keeps reading while W-01 waits; «تم الربط» only once linked (DEC-PROPOSED-13) | `driver-whatsapp.spec.ts` «review D-07: a QR issued while W-01 is pending expires…»; `linkModel.test.ts` «D-07 body» |
| 2 | (major) D-11 help hidden when expired, with no resend left, without a code, or linked after `ready` | DEC-PROPOSED-17/18: the trigger and the Sheet in every unlocked state, the no-code state, the first code | `driver-help.spec.ts` «review D-11: …» ×3; layout «D-11 WhatsApp without a code» |
| 3 | (major) the «ملء الشاشة» «إغلاق» at about 1.1:1 in the dark theme | the overlay is `data-theme="light"` (the panel's white surface) | `driver-whatsapp.spec.ts` «…keeps its contrast in the dark theme» (≥ 3:1); layout «D-07 QR full screen» × 2 themes |
| 4 | (major) two primary buttons in mode ب | «رمز جديد» is secondary in every state | the two D-07 review tests count one `main .pt-btn--primary` |
| 5 | (minor) D-13 relink to a D-07 with nothing to do; «اضغط «رمز جديد»…» without the button | `canRelink`; the panel text only with `canIssue` (DEC-PROPOSED-22) | `driver-whatsapp.spec.ts` «review D-13: no «إعادة الربط بواتساب»…»; `linkModel.test.ts` |
| 6 | (minor) the fake's confirm (`pending_send`), reject reason, code at `ready`, `channel_health` | the fake follows the API (`linked`, `driver_rejected_match`, a code for a linked ticket only, `s.whatsapp.health`, the resend and the no-code verification as the API) | the specs above; `driver-whatsapp.spec.ts:241` now asserts `linked` |
| 7 | (minor) `d07.channelDown` defined, never rendered | rendered (DEC-PROPOSED-23) | `driver-whatsapp.spec.ts` «review D-07: the channel down…»; layout «D-07 channel down» |
| 8 | (minor) G2-M14 still by the API in whatsapp-production.md | §14.3 row and §14.4 run it from D-07 / D-13 «تغيير رقم الجوال»; row 11 is the equivalent and the supervisor's way until GAP-2 | — (runbook) |
| 9 | (critical) D-06 reused a QR the D-05 paper save had revoked: a silent loop back to D-05 | a paper save drops the kept QR; INTAKE_INCOMPLETE {customer_phone} drops it; a refused submit that reused a kept code is retried once with a fresh one (DEC-PROPOSED-20) | `driver-whatsapp.spec.ts` «review D-05/D-06: QR → paper → QR…» and «review D-06: a code kept in memory but no longer live…» |
| 10 | (minor) QR-mode INTAKE_INCOMPLETE {customer_phone} silent on D-05 | a field error only for a field on screen, else the form message (`intakeErrors.ts`) | `intakeErrors.test.ts`; `driver-whatsapp.spec.ts` «review D-05: INTAKE_INCOMPLETE about the number in the QR mode…» |
| 11 | (major) a stale `wa_link_pending` answered for the newer code | the runtime clears the kept one on any other link state (the API omits the field); D-07 ignores a kept message for another code than the one it issued (`pendingConfirmation`), clears it on «رمز جديد» / «إعادة الإرسال», closes the dialog on INVALID_STATE_TRANSITION, and never redraws a code the customer sent | `driverRuntime.test.ts` (the field omitted as the API does; the second pending without the field); `linkModel.test.ts`; `driver-whatsapp.spec.ts` «review D-13 → D-07 on a parked ticket: a stale message never answers…» |
| 12 | (minor) D-07 offered «تذكرة ورقية» and «متابعة إلى الصف» on another driver's ticket | `ownParkTask` (DEC-PROPOSED-22) | `driver-whatsapp.spec.ts` «review D-13 → D-07 on another driver's parking ticket…»; `linkModel.test.ts` |
| 13 | (minor) the W-01 notice for an older W-01 failing on a linked ticket | only while the link is `failed` | `driverRuntime.test.ts` «the failure of an older W-01…» |
| 14 | (minor) the customer's phone field offered the device owner's number (`tel-national`) | `PhoneInput` defaults to `autocomplete=off` (DEC-PROPOSED-24) | `driver-whatsapp.spec.ts` «review D-05: a direct draft resumed…» checks the attribute |
| 15 | (minor) D-07 without a channel-down state; the fake withheld `wa_link_pending` from the parked ticket's creator | as 7; the fake publishes like the coalescer (privileged drivers, the creator for a creator event); API gap 1 corrected | as 7 and 11 |
| 16 | (minor) `channelForm` ignored the number on record | DEC-PROPOSED-21 | `linkModel.test.ts` (two cases); `driver-whatsapp.spec.ts` «review D-05: a direct draft resumed without this device's copy…» |
| 17 | (minor) the runbook G2-M14 (as 8) | as 8 | — |

## Audit responses (the D-01…D-15 audit on the base)

| Item | Sev | Verdict | Where / why |
|---|---|---|---|
| A-driver-1 D-11 follows the live code | 3 | **closed** | DEC-PROPOSED-19; `driver-help.spec.ts` «audit A-driver-1…» (the supervisor's reissue after the lock opens the cells, «أُرسل الرمز للعميل», the handover goes through), `driverRuntime.test.ts` «a handover code issued or locked…» |
| A-driver-2 W-05 failure on D-10 / D-11 | 3 | **closed earlier in this branch** | `d10.messageFailed`, `live.codeSendFailed`; `driver-help.spec.ts` «GAP-7 D-10: a W-05 the provider refused…». The W-04 half has no API source (DEC-PROPOSED-15, API gap 4) |
| A-driver-3 opt-out notice | 3 | **closed earlier in this branch** | `optedOut` notice; `driver-whatsapp.spec.ts` «…بعد المغادرة…» (the opt-out part), the D-11 banner in `driver-help.spec.ts` |
| A-driver-4 W-01 failure after D-07 | 3 | **closed earlier in this branch**, refined by review 13 | `waFailed` notice with «فتح» → D-13; `driver-whatsapp.spec.ts`, `driverRuntime.test.ts` |
| A-driver-5 D-13 relink | 3 | **closed earlier in this branch**, refined by review 5/12 | `canRelink`, «العودة»; `driver-whatsapp.spec.ts` |
| A-driver-6 the creator of a parked ticket changes the phone | 3 | **API gap** | the minimal projection does not say who created the ticket (API gap 6, DEC-PROPOSED-30); offering the action to every driver would answer PERMISSION_DENIED to all others. Meanwhile the creator changes it while the ticket is in parking (D-07 / D-13), or the supervisor (S-03, GAP-2) |
| A-driver-7 D-03 venue choice for a driving supervisor with several venues | 3 | **not built** | DEC-PROPOSED-27: 02 D-03 has no venue picker (copy and the shift line of an unselected venue are new design), and the e2e fake starts a duty from a driver assignment only; the canonical driving supervisor (17 §4 SUP-RD) has one venue and works today |
| A-driver-8 client telemetry (15 §8) | 3 | **not built** | DEC-PROPOSED-29: a cross-cutting client subsystem (driver and staff, 16 event kinds, the service worker), not a D-screen control; a partial set would skew the 15 KPIs. Its own ticket |
| A-driver-9 the cash in hand at the end of the shift | 3 | **closed** | DEC-PROPOSED-25; `driver-account.spec.ts` «PNT-070: D-14 shows…» |
| A-driver-10 the D-04 sound warning | 3 | **closed** | DEC-PROPOSED-26; `driver-account.spec.ts` «audit A-driver-10…» |
| A-driver-11 «أعدت المفتاح» on D-10 | 3 | **left as decided** | DEC-PROPOSED-14: a withdrawal with the key in hand is refused (CUSTODY_RELEASE_REQUIRED) before any event reaches the driver, so 02's key branch has no trigger; the release is the supervisor's (S-03 «إقرار إعادة المفتاح») |
| A-driver-12 the D-11 hint | 4 | **closed earlier in this branch** | `d11.codeHint` without the brand (DEC-PROPOSED-3) |
| A-driver-13 D-05 «لوحة غير سعودية», Latin letters, make search | 4 | **label closed**; the rest **not built** | the label follows 02 (03 §6); typing Latin letters needs a text field 02 does not draw (the 17-letter pad is always on screen and «يمنع إدخال أشكال خاطئة»), and a searchable make list needs a component 03 §3.9 does not define — both sev 4, left for a design pass |
| A-driver-14 on-behalf reasons as §8.4 keys | 4 | **not built** | DEC-PROPOSED-28: D-13 and S-03 (another stream's file) must switch together with the audit list's translation, else `request_reason` mixes keys and labels |
| A-driver-15 the transfer banner on the driver frame | 4 | **API gap** | API gap 7: the transfer events reach the supervisor rooms only and `DriverLive` has no transfer fields |

## Test results

- `pnpm lint` (eslint, prettier, brand and secrets checks) and `pnpm typecheck` (every package): clean.
- `pnpm test` (unit + web-unit): 81 files, 1326 tests passed — the new `linkModel` (17), `fieldModel` (+1) and
  `driverRuntime` (+5) tests included.
- `pnpm test:int` on PostgreSQL 16 (local, `TEST_DATABASE_URL`), under `heavy.lock`: 79 files — 77 passed, 1 skipped,
  1 failed; tests 635 passed, 1 skipped, 1 failed. The failure is **pre-existing on the base `34ffe37`** (this branch
  changes no server code): `apps/api/test/manual-reconcile-paper-draft.int.test.ts` «received → delivered with the
  documented collection…» expects the `payment.collected` payload without `cycle_id`, and the server now emits
  `cycle_id: null`; it fails the same way when run alone. For the server owners.
- Targeted Playwright first (`--workers=2`): `driver-whatsapp.spec.ts` and `driver-help.spec.ts` at 390 px,
  `driver-g1`, `driver-persistence`, `driver-errors` 15/15, the driver screens of `layout.spec.ts` at 360/390/430 ×
  2 themes 108/108.
- Full Playwright, all specs and the three widths, under `heavy.lock` (`E2E_PORT=5411`, `--workers=2`): **503
  passed, 346 skipped, 0 failed** (13.9 min); the new `driver-whatsapp.spec.ts` 8/8 and `driver-help.spec.ts` 5/5 at
  390 px (functional specs run at 390 only, `runOnlyAt390`).
- Added after that run (a test only, no app change; the same build served): the sweep item 4 test —
  `driver-whatsapp.spec.ts` at 390 px **9/9 passed** (40.8 s).

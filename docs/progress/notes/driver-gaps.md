# driver-gaps — GAP-1, GAP-7, GAP-8 and the D-01…D-15 sweep (apps/web)

Scope: the driver screens of `apps/web` against 02 D-01…D-15, on branch `wave5/driver-gaps` (base `34ffe37`). The
server side of every gap was complete and tested before this stream; nothing in `packages/server` or `apps/api` was
changed. The lead numbers the proposals below into `docs/DECISIONS.md` (from DEC-365).

## Gaps closed

| Gap | What the driver has now (02 reference) | Evidence |
|---|---|---|
| GAP-1 | D-05 «تذكرة العميل» (واتساب / تذكرة ورقية) and «طريقة الربط» (رقم جوال العميل / رمز QR يمسحه العميل), the phone with `PhoneInput`, the consent box with the question read to the customer, local checks (02 D-05 «الجوال وخانة الموافقة إلزاميان»), the QR choice empties the number and the consent; the step-1 body by `channelBody` (02 D-05 «طريقة الربط اختيار محلي…»). D-06 issues `whatsapp-link {qr}` right before `submit-intake` in the QR mode, reusing a code with ≥ 60 s left (02 D-06 «في وضع QR فقط»); WA_TEMPLATE_NOT_APPROVED / WA_CHANNEL_UNAVAILABLE send the driver back to D-05. D-07 mode أ (status chip «جارٍ الإرسال…» ← «أُرسلت» ← «تعذر الإرسال», the last three digits, «العميل لم تصله الرسالة؟», «إعادة الإرسال», «الربط عبر QR», «تذكرة ورقية» DEC-40) and mode ب (the customer-brand panel with the QR drawn on the device, «قاعة … · تذكرة n · صالح لمدة m:ss», «بانتظار رسالتك…», «رمز جديد», «تغيير الطريقة», «ملء الشاشة», the confirmation Dialog → `whatsapp-link/confirm`, «تم الربط — وصلت التذكرة للعميل.», «انتهت صلاحية الرمز.»); «العودة» instead of «متابعة إلى الصف» when D-07 is opened from D-13 | `apps/web/e2e/driver-whatsapp.spec.ts` (8 GAP-1 tests), `apps/web/test/linkModel.test.ts` (17), `apps/web/e2e/layout.spec.ts` (D-05 QR, D-05 paper, D-07 sending, D-07 QR panel at 360/390/430 × 2 themes) |
| GAP-7 | D-10 «إبلاغ عن مشكلة»: the Sheet of 02 D-10 (four types, a mandatory description) → `POST /v1/incidents` with the ticket (DEC-237) → «أُبلغ المشرف.»; «تعذر إرسال الرسالة للعميل. أُبلغ المشرف.» when W-05 failed or was skipped (02 D-10 «فشل رسالة العميل») | `apps/web/e2e/driver-help.spec.ts` (2), `apps/web/e2e/layout.spec.ts` (D-10) |
| GAP-8 | D-11 «العميل لم يصله الرمز؟ │ إعادة الإرسال (متبقٍ n)» before the expiry, `resends_left` from the server, 30 s apart; the Sheet «إعادة إرسال الرمز» / «طلب المشرف (تحقق يدوي)» → a `manual_verification` incident with a mandatory description (DEC-210); the 14 §5.1 banners (W-05 not sent, the code expired by server time with «إرسال رمز جديد», locked, opted out) | `apps/web/e2e/driver-help.spec.ts` (3), `apps/web/e2e/layout.spec.ts` (D-11 WhatsApp code) |

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

Checked and left as built (reason): D-01 … D-04, D-08, D-09, D-12, D-14, D-15 match 02 (built and reviewed in S5,
`docs/progress/notes/s5-web.md`); D-10 «سحب المهمة من المشرف» stays the 14 §5.1 red banner (DEC-PROPOSED-14); D-07
«يرفع السطوع إن أمكن» has no web API (DEC-PROPOSED-10).

## Safety rules kept

- The customer's number exists on the device only in the current D-05/D-06 draft (memory + the IndexedDB draft row,
  05 §14), and goes with it at the submit, a discard or a sign-out; afterwards D-07 shows the last three digits of
  the server's masked number and D-13 the masked number (09 §5.1); a paper or QR body sends `customer_phone: null`
  (DEC-PROPOSED-4). The e2e proves the page and the browser storage no longer hold it after the submit.
- The link code and its wa.me link live in memory only (`linkStore`, 09 §5.1 «للسائق الطالب فقط … طالما هو active»);
  the code is drawn as a QR, never written as text; the panel shows the site and the ticket number only.
- The handover code is never shown or kept (DEC-38): the e2e checks the page for both codes after a resend.
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
the customer's message links unless W-01 was accepted first (12 §7.2). — decision: D-07 shows the panel for a live
code even while W-01 is pending; a direct resend drops the code from memory (the server revokes it). — affected files:
02 D-07.

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

## API gaps (for the server owners)

1. **`ticket.updated` for the code's creator** — a driver who issues the QR of a ticket he neither created nor holds
   (D-13 relink of another driver's parked ticket), and the creator once the ticket is `parked`, get no
   `wa_link_pending` (realtime and projection: `isCreatorIntake` covers `received`/`parking` only). Proposal: publish
   to `link_codes.created_by` and include `wa_link_pending` for the code's creator. Until then D-07 polls (DEC-PROPOSED-7)
   and the dialog may lack the number (DEC-PROPOSED-6).
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

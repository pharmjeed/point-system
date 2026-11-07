# 08 — دليل رموز الأخطاء (Error Codes Guide)

الإصدار 1.0 — 27 أكتوبر 2026 — الحالة: معتمد للتنفيذ.

المرجع الملزم للأسماء: `00_Glossary_Canon.md` §8. هذا الملف يفصّل سلوك كل رمز: متى يُرفع، ماذا يحمل، كيف تعرضه الواجهة، وكيف يُسجَّل. لا يُضاف رمز هنا دون إضافته إلى القاموس أولًا (انظر §11).

ملفات مرتبطة: `07_API_Contract.md` (العقود وبروتوكول التكرار)، `09_RBAC_Permissions_Matrix.md` (الصلاحيات وترتيب الفحص)، `06_schema.sql` (أسماء القيود)، `10_Dispatch_Engine_Spec.md` (القبول والأولوية)، `11_State_Machines_Domain_Events.md` (الانتقالات المسموحة)، `12_WhatsApp_Integration_Spec.md` (أخطاء المزود التفصيلية)، `14_Notification_Matrix_Templates.md` (تنبيهات المشرف)، `17_Test_Acceptance_Plan.md`.

---

## 1. الغلاف الموحد والقواعد

### 1.1 الشكل

```json
{
  "error": {
    "code": "TASK_ALREADY_CLAIMED",
    "message": "Another driver accepted this request.",
    "message_ar": "قبل الطلب سائق آخر.",
    "request_id": "req_01JBQ7Z3M8X4K2N6P0R5T9V1W3",
    "retryable": false,
    "details": { "task_id": "0193b6f2-5c1e-7a40-9d2f-6b8e1c0a4f11" }
  }
}
```

### 1.2 الحقول

| الحقل | النوع | القاعدة |
|---|---|---|
| `code` | string | من الكتالوج في §4 فقط؛ ثابت عبر الإصدارات؛ الواجهة تتفرع عليه وحده |
| `message` | string | إنجليزية مختصرة للمطور والسجلات؛ لا تُعرض للسائق |
| `message_ar` | string | نص عربي جاهز للعرض: قصير ويقول للمستخدم ماذا يفعل |
| `request_id` | string | `req_` + ULID؛ يطابق ترويسة الرد `X-Request-Id` وسجلات الخادم |
| `retryable` | boolean | `true` فقط إذا كانت إعادة الطلب نفسه بنفس `Idempotency-Key` قد تنجح دون تغيير من المستخدم |
| `details` | object | حقول محددة لكل رمز (§4)؛ `{}` إن لم توجد؛ لا تحمل أي بيانات لا يحق للفاعل رؤيتها |

### 1.3 القواعد العامة

1. كل رد غير 2xx من `/v1/*` يحمل الغلاف مع `Content-Type: application/json; charset=utf-8`، وحالة HTTP تساوي حالة الرمز في الكتالوج دائمًا.
2. العميل لا يتفرع على حالة HTTP وحدها ولا على النص؛ فقط على `code`.
3. النصوص و`details` لا تحتوي أبدًا: رقم جوال كامل، رمز تسليم، رمز إجراء، سرًّا، موضع مفتاح لمن لا يحق له، استعلام SQL، أو تتبع مكدس.
4. **عدم الكشف (non‑disclosure):** المورد المطلوب بمعرّفه هو (تذكرة، مهمة، عرض، دورة، وسائط، تحصيل، واقعة...) وهو خارج نطاق الفاعل (مؤسسة أو موقع آخر، أو تذكرة مغلقة لا يراها السائق) يُرد عليه بـ404 برمز المورد (`TICKET_NOT_FOUND` أو `OFFER_NOT_FOUND` أو `RESOURCE_NOT_FOUND`) وليس 403، فلا يتعلم الفاعل وجود مورد في موقع آخر. يُستخدم 403 فقط حين يكون المورد مرئيًا للفاعل لكن الإجراء غير مسموح له (`PERMISSION_DENIED`، `NOT_TASK_ASSIGNEE`، ...)، أو حين يختار الفاعل بنفسه موقعًا خارج نطاقه: `{venueId}` في المسار أو `venue_id` في الاستعلام أو الجسم (`SCOPE_VENUE_DENIED`)، لا لمورد معنون بمعرّفه (DEC-191). ويسبق فحصُ النطاق شروطَ المناوبة (`DUTY_REQUIRED`، `DRIVER_ON_BREAK`) في أوامر التذكرة والمهمة والعرض، فسائق خارج مناوبته من موقع آخر لا يعرف شيئًا عن التذكرة (§2 البندان 7–8، DEC-169).
5. ترويسة `Retry-After` (بالثواني) إلزامية مع 429 و503 و`IDEMPOTENCY_IN_PROGRESS`، وترويسات `RateLimit-*` على كل رد (07 §1.9).
6. الأمر المرفوض لا يترك أثرًا تشغيليًا: بعد حجز مفتاح التكرار (L0) يتراجع المعالج إلى نقطة الحفظ عند خطأ أعمال حتمي (4xx) ثم يحفظ رد الخطأ مع المفتاح فتعيده الإعادة حرفيًا مع الترويسة `Idempotent-Replayed: true`؛ وأخطاء 5xx تتراجع كليًا ولا يبقى صف للمفتاح (07 §1.4). يُستثنى ما يجب أن يبقى رغم الرفض: (أ) عدّاد محاولات التحقق عند التسليم (`claim_codes.attempts`، ولتذكرة الورق صف `ticket_events` من النوع `handover.code_attempt_failed`، DEC-176) وقفله وتنبيهه — يلتزم في المعاملة نفسها مع رد الخطأ دون تراجع إلى نقطة الحفظ؛ (ب) سجلات الأمان لفشل الدخول وعدّاد `users.failed_login_count` والقفل؛ (ج) رفع أو تحديث تنبيه المشرف المرتبط بالرفض (`draft_abandoned`).
7. أخطاء التحقق تجمع كل الحقول الخاطئة مرة واحدة في `details.fields`.
8. الواجهة تعرض `message_ar` القادم من الخادم (وهو نص §4 نفسه)، وتعود إلى خريطة نصوص §4 المحلية (`apps/web/src/i18n/errors.ts`) حين يصل رد بلا غلاف خطأ؛ والنصوص الخاصة بالشاشات في 02 لرموز الخادم لا تُعرض لردود الخادم (DEC-80).
9. ردود 5xx لا تحمل تفاصيل داخلية؛ التفاصيل في السجل مربوطة بـ`request_id`، وتظهر للمستخدم تحت «تفاصيل» للدعم.
10. نقاط Webhook لها سلوك خاص (§7)، ومسارات الصحة لا تحمل بيانات.

### 1.4 خريطة حالات HTTP

| HTTP | الاستخدام |
|---|---|
| 400 | طلب مشوّه لا يتعلق بحقل محدد (`PAGINATION_CURSOR_INVALID`) |
| 401 | لا هوية صالحة، أو خطوة العامل الثاني منتهية أو خاطئة، أو توقيع Webhook غير صالح |
| 403 | هوية صالحة دون صلاحية أو نطاق أو تكليف |
| 404 | غير موجود أو خارج النطاق (عدم الكشف) |
| 409 | تعارض مع الحالة الحالية أو قيد تشغيلي |
| 410 | مورد كان صالحًا وانتهى (عرض، رمز تسليم، رمز ربط) |
| 413 / 415 | حجم الوسائط أو نوعها |
| 422 | مدخلات غير صالحة أو ناقصة أو رمز تحقق خاطئ |
| 423 | قفل مؤقت (حساب أو تحقق التسليم) |
| 428 | ترويسة إلزامية مفقودة (`Idempotency-Key`) |
| 429 | تجاوز معدل الطلبات أو حد إعادة إرسال الرمز |
| 500 / 502 / 503 / 504 | خطأ داخلي، رفض من مزود خارجي، خدمة غير متاحة، مهلة مزود |

---

## 2. ترتيب الفحوص (رمز واحد متوقع لكل حالة)

يتبع ترتيب دورة الطلب في NestJS (Middleware ← Guards ← Interceptors ← Pipes ← Handler):

1. **حد المعدل بالعنوان** (أول الحراس، قبل الجلسة لحماية الدخول؛ الفئات في 07 §1.9): فئتا `auth` و`webhook` وكل طلب بلا كوكي جلسة: `RATE_LIMITED`؛ أما حد المستخدم أو الجهاز فبعد البند 4 مباشرة لأن المستخدم لا يُعرف قبله، فالطلب الموثق المتجاوز للحد الذي يفشل CSRF أيضًا يرد `PERMISSION_DENIED` (DEC-295).
2. **حماية CSRF** لكل `POST/PUT/PATCH/DELETE` عدا `/webhooks/whatsapp` (ومنها مسار الدخول): الترويسة `X-Requested-With: point-web` وترويسة `Origin` مطابقة لـ`APP_BASE_URL`، وإلا `PERMISSION_DENIED` (`reason = csrf`) — DEC-29.
3. **الجلسة** (`SessionAuthGuard`، كوكي `__Host-point_sid`): `AUTH_UNAUTHENTICATED`، `AUTH_SESSION_EXPIRED`، `AUTH_SESSION_REVOKED`، `AUTH_ACCOUNT_DISABLED`، ثم قيدا الجلسة المقيدة لأي مسار خارج `auth.self`: `AUTH_SECRET_CHANGE_REQUIRED` أولًا ثم `AUTH_MFA_SETUP_REQUIRED` (كل مسارات `auth.self` مسموحة للقيدين معًا).
4. **الصلاحية حسب الدور** (`PermissionGuard`): `PERMISSION_DENIED`.
5. **التكرار** للمسارات المعلّمة ✓ في القاموس §9: `IDEMPOTENCY_KEY_REQUIRED`، ثم في أول المعاملة (L0) الإعادة: الرد الأصلي المحفوظ يُعاد كما هو قبل أي فحص لاحق، أو `IDEMPOTENCY_KEY_REUSED`، أو `IDEMPOTENCY_IN_PROGRESS` (07 §1.4).
6. **شكل المدخلات** (zod Pipe): `VALIDATION_FAILED`، `PHONE_INVALID`، `PLATE_INVALID`، `REASON_REQUIRED`، `CONSENT_REQUIRED`، `PAGINATION_CURSOR_INVALID`، `MEDIA_TYPE_UNSUPPORTED`، `MEDIA_TOO_LARGE`.
7. **تحميل المورد ضمن النطاق**: `TICKET_NOT_FOUND`، `OFFER_NOT_FOUND`، `RESOURCE_NOT_FOUND`، أو `SCOPE_VENUE_DENIED` لموقع يختاره الفاعل.
8. **شروط الفاعل على المورد**: `ASSIGNMENT_REQUIRED`، `DUTY_REQUIRED`، `DRIVER_ON_BREAK`، `NOT_TASK_ASSIGNEE`، `NOT_OFFER_RECIPIENT`، `TRANSFER_SCOPE_DENIED`.
9. **داخل المعاملة بعد الأقفال** (ترتيب L0–L10 في القاموس §14ب): إعادة التحقق من البند 8 (TOCTOU)، ثم `VERSION_CONFLICT`، ثم قواعد الحالة والعمل (بقية رموز 409/410/422/423).
10. **البنية** في أي نقطة: `INTERNAL_ERROR`، `SERVICE_UNAVAILABLE`، `DEPENDENCY_TIMEOUT`، ورموز `WA_*` المتزامنة.

---

## 3. أنماط المعالجة في الواجهة

| النمط | السلوك |
|---|---|
| `inline` | رسالة تحت الحقل أو النموذج؛ **المدخلات لا تُمسح أبدًا** (المعمارية §12) |
| `toast` | رسالة عابرة لا تحتاج إجراء |
| `dialog` | نافذة حاجبة تتطلب إقرارًا أو اختيار إجراء بديل |
| `refetch` | إبطال الذاكرة وإعادة جلب الحالة من الخادم (`GET /v1/me/home` للسائق أو الكيان المعني) |
| `remove-card` | إزالة بطاقة العرض فورًا وإيقاف صوتها وأي تذكير محلي |
| `relogin` | إيقاف كل الأصوات، إغلاق `/ws`، مسح الحالة في الذاكرة، والانتقال إلى D-01 أو S-01؛ السائق عند `AUTH_SESSION_EXPIRED` أو `AUTH_SESSION_REVOKED` يمر بـD-15 الحالة ج بنص السبب، والموظف يعود إلى S-01 بسطر السبب (DEC-88) |
| `auto-retry` | إعادة تلقائية بنفس `Idempotency-Key` بعد `Retry-After` أو بتباعد 1 ثم 3 ثم 7 ثوانٍ |
| `banner` | شريط حالة دائم في أعلى الشاشة حتى يزول السبب (D-15) |

---

## 4. الكتالوج الكامل

لكل مجموعة جدولان: (أ) السجل: الرمز وحالة HTTP وإمكانية الإعادة والنصوص؛ (ب) السلوك: متى يُرفع، وحقول `details`، ومعالجة الواجهة، ومستوى السجل وتنبيه المشرف (`alerts.type`) إن وُجد. «تقني» = تنبيه مراقبة للفريق التقني وليس تنبيه مشرف.

### 4.1 الدخول والجلسة

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `AUTH_UNAUTHENTICATED` | 401 | لا | سجّل الدخول للمتابعة. | Sign in to continue. |
| `AUTH_INVALID_CREDENTIALS` | 401 | لا | بيانات الدخول غير صحيحة. | Invalid credentials. |
| `AUTH_ACCOUNT_DISABLED` | 403 | لا | هذا الحساب معطّل. راجع الإدارة. | This account is disabled. Contact your administrator. |
| `AUTH_ACCOUNT_LOCKED` | 423 | لا | أُوقف الدخول مؤقتًا لكثرة المحاولات. حاول لاحقًا. | Too many attempts. Try again later. |
| `AUTH_MFA_REQUIRED` | 401 | لا | انتهت خطوة التحقق. سجّل الدخول مجددًا. | The verification step expired. Sign in again. |
| `AUTH_MFA_INVALID` | 401 | لا | رمز التحقق غير صحيح. | Incorrect verification code. |
| `AUTH_MFA_SETUP_REQUIRED` | 403 | لا | فعّل التحقق الثنائي لإكمال الدخول. | Set up two-factor authentication to continue. |
| `AUTH_SECRET_CHANGE_REQUIRED` | 403 | لا | غيّر الرقم السري المؤقت قبل المتابعة. | Change your temporary PIN or password to continue. |
| `AUTH_SESSION_EXPIRED` | 401 | لا | انتهت الجلسة. سجّل الدخول مجددًا. | Your session expired. Sign in again. |
| `AUTH_SESSION_REVOKED` | 401 | لا | أُنهيت جلستك. سجّل الدخول مجددًا. | Your session was ended. Sign in again. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `AUTH_UNAUTHENTICATED` | أي مسار غير عام دون كوكي جلسة؛ مصافحة `/ws` دون جلسة | — | `relogin` | info · — |
| `AUTH_INVALID_CREDENTIALS` | `POST /v1/auth/login` (جوال غير موجود أو سر خاطئ — الرد نفسه للحالتين)؛ `POST /v1/auth/secret/change` (السر الحالي خاطئ) | — | `inline`؛ يُمسح حقل السر فقط | warn (الجوال مجزّأ hash) · — ؛ يزيد `failed_login_count` |
| `AUTH_ACCOUNT_DISABLED` | `POST /v1/auth/login` **بعد** صحة البيانات فقط حتى لا يُكشف وجود الحساب | — | `dialog` ثم البقاء في الدخول | warn · — |
| `AUTH_ACCOUNT_LOCKED` | `POST /v1/auth/login` و`POST /v1/auth/mfa/verify` بعد 5 إخفاقات (`security.max_login_attempts`) لمدة 15 دقيقة | `locked_until` | `inline` مع عدّاد تنازلي | warn · مؤشر أمني تقني |
| `AUTH_MFA_REQUIRED` | `POST /v1/auth/mfa/verify` و`mfa_token` غير معروف أو منتهٍ (5 دقائق) أو مستخدم سابقًا. ليس ردًّا على الدخول: `POST /v1/auth/login` الصحيح لحساب `mfa_enabled` يرد 200 `LoginResult` بـ`mfa_required: true` و`mfa_token` (صالح 5 دقائق، استخدام واحد) دون كوكي جلسة | — | العودة لخطوة الجوال وكلمة المرور في S-01 (إعادة الدخول من البداية) | info · — |
| `AUTH_MFA_INVALID` | `POST /v1/auth/mfa/verify`، `POST /v1/auth/mfa/confirm` | `attempts_left` | `inline`؛ تُحتسب ضمن حد القفل | warn · — |
| `AUTH_MFA_SETUP_REQUIRED` | أي مسار خارج `auth.self` لجلسة مالك/إدارة (أو مشرف عند `security.supervisor_mfa_required`) لم يُفعَّل لها MFA، بعد فحص `AUTH_SECRET_CHANGE_REQUIRED`. كل مسارات `auth.self` مسموحة (القاموس §9.1): `POST /v1/auth/mfa/setup`، `POST /v1/auth/mfa/confirm`، `POST /v1/auth/secret/change`، `POST /v1/auth/logout`، `GET /v1/me`، `POST /v1/me/devices`، `PUT /v1/me/devices/{deviceId}`، `POST /v1/me/audio-test`، `POST /v1/me/heartbeat` | `allowed_paths` (مسارات `auth.self`) | توجيه إلى إعداد MFA في S-01 (بعد تغيير السر إن لزم) | info · — |
| `AUTH_SECRET_CHANGE_REQUIRED` | أي مسار خارج `auth.self` و`users.must_change_secret = true`؛ يُفحص قبل `AUTH_MFA_SETUP_REQUIRED`، وكل مسارات `auth.self` مسموحة (القائمة نفسها في الصف السابق) | `secret_kind` (`pin` / `password`)، `allowed_paths` (مسارات `auth.self`) | توجيه إلى D-02 أو شاشة تغيير كلمة المرور أولًا، ثم إعداد MFA إن لزم | info · — |
| `AUTH_SESSION_EXPIRED` | أي مسار بعد `auth_sessions.expires_at` (14 ساعة للسائق `security.driver_session_hours`، 12 للموظفين `security.staff_session_hours`) | — | `relogin` مع حفظ مدخلات النماذج غير المرسلة محليًا لنفس المستخدم | info · — |
| `AUTH_SESSION_REVOKED` | أي مسار بعد إبطال الجلسة؛ ويصل حدث `session.revoked` عبر `/ws` | `reason` = قيمة `auth_sessions.revoked_reason` | `relogin`؛ إذا `reason = transfer` تُمسح كل البيانات المحلية الخاصة بالموقع القديم | info · — |

### 4.2 الصلاحية والنطاق

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `PERMISSION_DENIED` | 403 | لا | لا تملك صلاحية هذا الإجراء. | You don't have permission for this action. |
| `SCOPE_VENUE_DENIED` | 403 | لا | هذا خارج نطاق موقعك. | This is outside your venue scope. |
| `ASSIGNMENT_REQUIRED` | 403 | لا | لا يوجد تعيين نشط لك في هذا الموقع. راجع المشرف. | You have no active assignment at this venue. |
| `DUTY_REQUIRED` | 409 | لا | ابدأ ورديتك أولًا. | Start your shift first. |
| `NOT_TASK_ASSIGNEE` | 403 | لا | هذه المهمة ليست مسندة إليك. | This task isn't assigned to you. |
| `NOT_OFFER_RECIPIENT` | 403 | لا | لم يُعرض هذا الطلب عليك. | This request wasn't offered to you. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `PERMISSION_DENIED` | أي مسار لا تمنحه مصفوفة الملف 09 لدور الفاعل (مثال: سائق يستدعي `POST /v1/tickets/{ticketId}/void`)؛ قيد فصل المهام (تعديل الفاعل لنفسه، استلام المشرف نقده بنفسه)؛ `POST /v1/staff/{userId}/reset-mfa` من غير المالك؛ أمر غير آمن دون `X-Requested-With: point-web` أو بـ`Origin` لا يطابق `APP_BASE_URL` (DEC-29) | `permission`، `reason` اختياري (`csrf`، `self_modification`، `self_handover` في تسليم النقد قبل أي قفل، DEC-275؛ ولقواعد الفاعل على المورد: `not_link_code_creator` في تأكيد QR من سائق غير منشئ الرمز، DEC-198، و`not_creator_or_assignee` في تغيير الجوال من سائق ليس المنشئ ولا المكلّف، DEC-211؛ و`audit_read_required` لتصدير `audit` دون `audit.read` مع `permission: audit.read`، DEC-289) | `toast` وإخفاء الإجراء؛ لا يحدث في الاستخدام الطبيعي | warn (مؤشر عبث محتمل) · — |
| `SCOPE_VENUE_DENIED` | اختيار الفاعل موقعًا خارج نطاقه: `{venueId}` في مسارات `/v1/venues/{venueId}/*`، أو `venue_id` في الاستعلام أو الجسم: `GET /v1/tickets?venue_id=`، `GET /v1/reports/*`، `POST /v1/exports`، `POST /v1/drivers/{driverId}/assignments`. لصاحب نطاق الموقع (المشرف والسائق) دون فحص الوجود، أما صاحب نطاق المؤسسة فيأخذ للموقع غير الموجود `404 RESOURCE_NOT_FOUND` (`resource: venue`) (DEC-112) | `venue_id` | `toast` وإعادة الفلتر لموقع ضمن النطاق | warn · — |
| `ASSIGNMENT_REQUIRED` | `POST /v1/me/duty/start` و`GET /v1/me/home` لسائق بلا تعيين نشط؛ أوامر السائق في الفاصل بين انتهاء تعيينه وإبطال جلسته | — | `dialog` «راجع المشرف» ثم `refetch` لـ`GET /v1/me` | info · — |
| `DUTY_REQUIRED` | أوامر تشغيلية تتطلب مناوبة: `POST /v1/tickets`، `POST /v1/task-offers/{offerId}/accept`، `POST /v1/tickets/{ticketId}/whatsapp-link`، و`POST /v1/tickets/{ticketId}/retrievals` و`POST /v1/retrieval-cycles/{cycleId}/cancel` حين ينفذها سائق | — | `dialog` بزر «بدء الوردية» (D-03) | info · — |
| `NOT_TASK_ASSIGNEE` | مسارات `task.execute` و`handover.verify` و`payment.record`، و`handover-code/resend` و`release-custody` حين ينفذها سائق ليس المكلّف | `task_id` | `toast` ثم `refetch` (غالبًا أُعيد الإسناد) | warn · — |
| `NOT_OFFER_RECIPIENT` | `POST /v1/task-offers/{offerId}/accept` لعرض في نفس المجموعة لم يُرسل إليه (عرض فردي لغيره، أو كان في استراحة لحظة البث) | — | `remove-card` ثم `refetch` | warn · — |

### 4.3 الموارد والتحقق من المدخلات

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | لا | العنصر غير موجود. | Resource not found. |
| `TICKET_NOT_FOUND` | 404 | لا | التذكرة غير موجودة. | Ticket not found. |
| `OFFER_NOT_FOUND` | 404 | لا | هذا الطلب لم يعد متاحًا. | This offer is no longer available. |
| `VALIDATION_FAILED` | 422 | لا | تحقّق من الحقول المحددة. | Some fields are invalid. |
| `PHONE_INVALID` | 422 | لا | رقم الجوال غير صالح. تأكد من الرقم ومفتاح الدولة. | Invalid phone number. |
| `PLATE_INVALID` | 422 | لا | رقم اللوحة غير صالح. تحقّق من الأرقام والحروف. | Invalid plate number. |
| `CONSENT_REQUIRED` | 422 | لا | فعّل موافقة العميل على واتساب أو اختر التذكرة الورقية. | Customer consent is required for WhatsApp. |
| `REASON_REQUIRED` | 422 | لا | اكتب سبب هذا الإجراء. | A reason is required for this action. |
| `PAGINATION_CURSOR_INVALID` | 400 | لا | تعذّر تحميل المزيد. حدّث القائمة. | Invalid pagination cursor. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `RESOURCE_NOT_FOUND` | أي مورد غير التذكرة والعرض (مهمة، دورة، حفل، وردية، موقف، خانة، سائق، تنبيه، واقعة، تصدير، وسائط، جهاز، تحصيل) غير موجود أو خارج النطاق؛ ومعرّف مرجعي في الجسم غير موجود (مثل `parking_spot_id`، و`to_holder_id` في نقل العهدة بـ`user` أو `parking_spot` أو `key_slot`، DEC-250، و`incident_id` و`payment.collected_by` والموقف والخانة في المطابقة اليدوية، DEC-253)؛ ومنه: رمز ربط لا يخص التذكرة في `whatsapp-link/confirm` (`link_code`، DEC-198)، وتذكرة بلا جوال في `reveal-phone` (`customer`، DEC-248)، و`owner_id` غير معروف في `PATCH /v1/incidents/{incidentId}` (`user`، DEC-239)، وحفل خارج النطاق في `POST /v1/incidents` (`event`، DEC-237)؛ وفي مسارات المال والتقارير: حفل معنون أو `event_id` في الجسم أو المرشح (`event`)، وسائق `driver_id` من مؤسسة أخرى (`driver`)، وتحصيل خارج النطاق (`payment`)، وتصدير لغير طالبه (`export`) (DEC-276) | `resource` (اسم النوع فقط) | `toast` ثم `refetch` | info · — |
| `TICKET_NOT_FOUND` | `GET /v1/tickets/{ticketId}` وكل مسارات `/v1/tickets/{ticketId}/*` عند عدم الوجود أو الخروج عن النطاق أو عدم الأهلية (مثل سائق يطلب تذكرة مغلقة أو في موقع آخر) | — | `toast` والعودة لقائمة المركبات D-12 | info · — |
| `OFFER_NOT_FOUND` | `POST /v1/task-offers/{offerId}/accept` لعرض غير موجود أو في مجموعة/موقع آخر (مثل إشعار قديم بعد النقل) | — | `remove-card` ثم `refetch` | info · — |
| `VALIDATION_FAILED` | جسم أو معاملات لا تطابق مخطط zod؛ جسم ليس JSON صالحًا على أي مسار غير `GET` (المحلل يسبق المسار: `(body)`، `issue = malformed_json`، DEC-126)؛ `PATCH` لكيان ذي عمود `version` دون `expected_version` (القاموس §9: التذاكر، الحفلات، الورديات، المستخدمون، الوقائع، إعدادات الموقع؛ كيانات التخطيط بلا `version` فلا يُطلب فيها)؛ أكثر من حفل مفتوح دون `event_id` في `POST /v1/tickets` (`issue = required_multiple_open_events`)؛ تكرار اسم أو ملصق في الإعداد (قيود `*_key` في §5)؛ مرجع POS يشبه رقم بطاقة؛ `consent` في `PATCH /v1/tickets/{ticketId}/intake` دون جوال (`field: consent`، `issue: customer_phone_required`، DEC-171)؛ المشرف بعدة مواقع دون `venue_id` في `POST /v1/me/duty/start` (`issue = required_multiple_venues`، أو `no_venue_scope` بلا موقع في نطاقه، DEC-182)؛ موقف أو خانة أو منطقتهما أو لوحتها معطلة في `complete-parking` (`issue` = `inactive` أو `zone_inactive` أو `board_inactive` على `parking_spot_id` أو `key_slot_id`، DEC-190)؛ دفعة قياس مخالفة في `POST /v1/telemetry` (الشكل، أكثر من 50 حدثًا، جسم أكبر من 64 KB بالحقل `(body)` و`issue = too_large`، جهاز ليس من أجهزة المستخدم بالحقل `device_id` و`issue = not_owned`، DEC-148)؛ ومشكلات مسارات بعينها: النقل إلى الموقع نفسه (`to_venue_id`، `same_as_current`، DEC-224)؛ فحوص الهوية في التسليم الاستثنائي (`identity_checks`، `insufficient_checks`؛ و`identity_checks.phone_last4` بـ`mismatch` أو `no_customer_phone`، DEC-209)؛ الجوال نفسه في `customer-phone` (`customer_phone`، `unchanged`، DEC-211)؛ دورة بلا رمز (`verification.method`، `not_applicable`، DEC-206)؛ فتح واقعة (`ticket_id` بـ`required_for_driver`، و`venue_mismatch`، و`ticket_event_mismatch`، DEC-237)؛ تعديل واقعة (`resolution` بـ`required`، و`owner_id` بـ`not_eligible`، DEC-239)؛ نقل العهدة (`use_handover`، `not_allowed_for_subject`، `parked_vehicle_spot_or_unknown`، `driver_not_on_duty`، `not_a_driver`، DEC-250)؛ و`payment` غير منطبق في المطابقة اليدوية أو التسليم أو التسليم الاستثنائي (`not_applicable`، DEC-252، DEC-278، DEC-210)؛ ومحصِّل التسليم الاستثنائي ليس مكلّف الإحضار ولا المشرف المعتمد (`payment.collected_by`، `not_eligible`، DEC-210)؛ ومرجع POS (`pos_reference`: `not_applicable` مع النقد، و`invalid_format`، و`looks_like_card_number`، بالبادئة `payment.` أو `replacement.` حسب المسار، DEC-280)؛ وبديل بلا تغيير (`replacement`، `no_change`، DEC-281)؛ ولا نقد يُسلَّم (`amount_halalas`، `nothing_to_hand_over`، DEC-283)؛ وفترة تقرير مقلوبة (`from`، `after_to`، DEC-288) | `fields: [FieldError]` حيث `FieldError = { field, issue, message_ar }` (07)؛ كل مفتاح غير معروف حقل مستقل بمساره المنقّط (`issue = unrecognized_key`)، ومشكلة جذر الجسم بالحقل `(body)` (DEC-126) | `inline` لكل حقل | info · — |
| `PHONE_INVALID` | `PATCH /v1/tickets/{ticketId}/intake`، `PATCH /v1/tickets/{ticketId}/customer-phone`، `POST /v1/drivers`، `POST /v1/staff`، `POST /v1/auth/login` (صيغة الجوال)؛ و`POST /v1/tickets/{ticketId}/whatsapp-link` بالإرسال المباشر لتذكرة بلا جوال (`issue: missing`، DEC-194) | `field`، و`issue` (`missing` حين لا جوال) | `inline` | info · — |
| `PLATE_INVALID` | `PATCH /v1/tickets/{ticketId}/intake`، `POST /v1/tickets/{ticketId}/submit-intake` | `field`، `reason` (`digits` / `letters` / `mapping`) | `inline` على مكوّن اللوحة | info · — |
| `CONSENT_REQUIRED` | إقرار الموافقة ناقص في الطلب نفسه: `submit-intake` بقناة `whatsapp` وجوال دون إقرار الموافقة؛ `PATCH .../customer-phone` دون إقرار موافقة العميل في الجسم. أما الإرسال المباشر دون موافقة سارية مسجلة فـ`WA_CONSENT_MISSING` (§4.13)، و`consent` في `PATCH .../intake` دون جوال فـ`VALIDATION_FAILED` (DEC-171) | `field: "consent"` | `inline` على خانة الموافقة مع خيار «تذكرة ورقية» | info · — |
| `REASON_REQUIRED` | كل أمر في الجدول §4.16 دون سبب أو بسبب أقصر من 3 أحرف | `field: "reason"`، `min_length: 3` | `inline` داخل نافذة التأكيد | info · — |
| `PAGINATION_CURSOR_INVALID` | قوائم `GET` بمؤشر معدّل أو منتهٍ (المؤشر معتم وموقّع HMAC) | — | `refetch` من الصفحة الأولى | info · — |

### 4.4 التزامن والتكرار والحالة

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `VERSION_CONFLICT` | 409 | لا | تغيّرت البيانات. حدّثنا الشاشة، أعد المحاولة. | The record changed. Refresh and try again. |
| `IDEMPOTENCY_KEY_REQUIRED` | 428 | لا | تعذّر إرسال الطلب. حدّث التطبيق. | The Idempotency-Key header is required. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | لا | تعذّر تنفيذ الطلب. أعد المحاولة. | The idempotency key was reused with a different request. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | نعم | جارٍ تنفيذ الطلب… | The same request is still being processed. |
| `INVALID_STATE_TRANSITION` | 409 | لا | لا يمكن تنفيذ هذا الإجراء في الحالة الحالية. | This action isn't allowed in the current state. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `VERSION_CONFLICT` | أمر يحمل `expected_version` لا يطابق `version` الحالي (إلزامي في `PATCH` للكيانات ذات عمود `version` فقط، القاموس §9)؛ وتعارض متزامن على قيد «حي» (`uq_link_codes_live_ticket`، `uq_claim_codes_live`) | `entity`، `id`، `current_version` | `refetch` للكيان و`toast`؛ مدخلات المستخدم غير المحفوظة تبقى وتُعرض فوق البيانات الجديدة ليعيد الحفظ | info · — |
| `IDEMPOTENCY_KEY_REQUIRED` | أي مسار معلّم ✓ في القاموس §9 دون الترويسة | — | خطأ برمجي: `toast` عام وتسجيل قياس عميل | warn · — |
| `IDEMPOTENCY_KEY_REUSED` | نفس المفتاح لنفس المستخدم بمسار أو جسم مختلف (`request_hash` مختلف) خلال 24 ساعة | `operation` | توليد مفتاح جديد لكل فعل مستخدم؛ `toast` | warn · — |
| `IDEMPOTENCY_IN_PROGRESS` | طلب مكرر بنفس المفتاح والأول ما زال داخل معاملته ولم يتحرر خلال مهلة الانتظار (تجاوز `lock_timeout` 3s عند L0 على صف `idempotency_keys`، `55P03`)؛ دون ذلك ينتظر المكرر ثم يُعاد له الرد المحفوظ | — | `auto-retry` بنفس المفتاح بعد `Retry-After` (حتى 3 مرات) | info · — |
| `INVALID_STATE_TRANSITION` | أي أمر غير مسموح من الحالة الحالية وفق الملف 11 (مثل `ready` لمهمة ليست `in_progress`، `repark` لتذكرة ليست `ready`، تحصيل لتذكرة `not_required`، إلغاء السائق طلبًا بعد إسناده)؛ وطلب رابط صورة إضافية فوق `inspection.max_extra_photos` (`reason: max_extra_photos`، DEC-102)؛ وفتح حفل أو وردية ومجموعة توزيعها معطلة، وتغيير مجموعة حفل بعد فتحه، وتعطيل مجموعة عليها مهام أو وردية مفتوحة (DEC-111)؛ وإلغاء تذكرة نهائية بـ`void` (`allowed_from: [received, parking]`، لا `TICKET_CLOSED`، DEC-45، DEC-175)؛ وربط واتساب في حالة لا تقبله: الإرسال المباشر في `received` أو لتذكرة `linked` أو أثناء انتظار تأكيد QR، وQR لتذكرة `linked` أو `pending_confirmation`، والورقية لأي منهما (DEC-193، DEC-196)؛ وتأكيد QR لرمز ليس `pending_confirmation` (DEC-198)؛ وتغيير الجوال لمسودة أو تذكرة ورقية (DEC-211)؛ وإعادة إسناد مهمة في الطابور إلى الطابور أو إلى مكلّفها نفسه (DEC-214)؛ وإقرار تحرير العهدة بعد إعادة المفتاح (DEC-230)؛ وأمر مالي على حالة مالية لا تقبله (`current_status` = `payment_status`، و`allowed_from` `[due]` أو `[collected]`، DEC-282)؛ وتسليم نقد لحفل `draft` (`allowed_from: [open, closing]`، DEC-283)؛ وإغلاق حفل `open` (`allowed_from: [closing]`، DEC-287) | شكل 11 §1.5 في كل الوحدات (DEC-106، DEC-111): `entity_type`، `entity_id`، `current_status`، `current_version` إن كان للكيان إصدار، `command`، `allowed_from`، و`reason` عند الحاجة: `max_extra_photos` (ومعه الحد `max_extra_photos`)، `dispatch_pool_inactive`، `dispatch_pool_fixed_after_open`، `open_shift`، `open_tasks`، `submit_intake_links_directly`، `already_linked`، `qr_pending_confirmation`، `paper_channel`، `draft_use_intake`، `driver_cancel_after_assignment`، `already_in_queue`، `same_assignee`، `key_not_picked_up`، `ticket_closed` (استثناء الفحص والمطابقة اليدوية لتذكرة نهائية)، `inspection_not_incomplete`، `incident_closed`، `payment_recorded`، `payment_not_required`، `payment_waived`، `payment_integrity` (DEC-249، DEC-239، DEC-252، DEC-253، DEC-282) | `refetch` و`toast` | info · — |

### 4.5 المناوبة والتوفر

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `DRIVER_NOT_AVAILABLE` | 409 | لا | لديك مهمة جارية. أكملها أولًا. | You already have an active task. |
| `DRIVER_ON_BREAK` | 409 | لا | أنت في استراحة. أنهِ الاستراحة أولًا. | You're on break. End your break first. |
| `DUTY_ALREADY_STARTED` | 409 | لا | ورديتك بدأت بالفعل. | Your shift has already started. |
| `DUTY_END_BLOCKED_CUSTODY` | 409 | لا | لا يمكن إنهاء الوردية وبعهدتك مركبة أو مفتاح أو مهمة. | You can't end your shift while holding a vehicle, key or task. |
| `SHIFT_NOT_OPEN` | 409 | لا | لا توجد وردية مفتوحة في موقعك. راجع المشرف. | There is no open shift at your venue. |
| `EVENT_NOT_OPEN` | 409 | لا | الحفل غير مفتوح للاستلام. | The event isn't open. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `DRIVER_NOT_AVAILABLE` | `POST /v1/task-offers/{offerId}/accept` لجولة `single` والقابل غير متاح؛ `POST /v1/tasks/{taskId}/reassign` لسائق هدف لا يستطيع أخذ المهمة؛ `POST /v1/me/duty/break` لبدء استراحة مع مهمة نشطة أو تالية (العهدة دون مهمة ← `CUSTODY_OPEN`). لا يُرفع في بدء الاستلام `POST /v1/tickets`: هناك `DUTY_REQUIRED` أو `DRIVER_ON_BREAK` أو `MOVEMENT_IN_PROGRESS` | `active_task_id`، `next_task_id` | `toast` ثم `refetch` للرئيسية | info · — |
| `DRIVER_ON_BREAK` | `POST /v1/tickets`، `POST /v1/task-offers/{offerId}/accept`، و`POST /v1/tickets/{ticketId}/retrievals` من سائق أثناء الاستراحة | — | `dialog` بزر «إنهاء الاستراحة» | info · — |
| `DUTY_ALREADY_STARTED` | `POST /v1/me/duty/start` بمفتاح تكرار جديد والمناوبة مفتوحة (`uq_duty_sessions_open`) | `duty_session_id` | `refetch` للرئيسية دون إظهار خطأ | info · — |
| `DUTY_END_BLOCKED_CUSTODY` | `POST /v1/me/duty/end` (السائق بنفسه، الأشد): أي عهدة مركبة أو مفتاح أو أي مهمة مفتوحة أو تالية. `POST /v1/duty-sessions/{sessionId}/force-end` (DEC-32، لا تجاوز): عهدة مركبة أو مفتاح، أو مهمة `in_progress`، أو مهمة صف/إعادة صف نشطة فقط؛ أما المهمة التالية المحجوزة (`assigned_waiting`) ومهمة الإحضار المقبولة قبل استلام المفتاح فلا تمنعان الإنهاء القسري وتعودان للطابور بأولويتهما الأصلية (`task.withdrawn`) | `items: [{ type: vehicle / key / task / next_task / draft, ticket_id, display_number }]` (`next_task` يظهر في إنهاء السائق لمناوبته فقط)؛ وفي `force-end` صفوف `blockingCustody` نفسها التي تمنع النقل والتعطيل بشكل عناصر النقل: `{ type, ticket_id, display_number, task_id? }` بالنوع `vehicle` أو `key` أو `task` ومع المهمة `task_id` (بلا `task_type` ولا `task_status`، فهما في `CUSTODY_OPEN` للتعطيل وحده) (DEC-229) | `dialog` يسرد العناصر مع روابطها | info · — |
| `SHIFT_NOT_OPEN` | `POST /v1/me/duty/start` ولا وردية `open` في مجموعة التوزيع | `venue_id` | `dialog` «راجع المشرف» | info · — |
| `EVENT_NOT_OPEN` | `POST /v1/tickets` لحفل ليس `open` — الاستلام ممنوع في `closing`؛ الحفل يُحدَّد عند بدء الاستلام ولا يُعدَّل بعده (DEC-37)؛ ولا حفل مفتوح في الموقع ← هذا الرمز بـ`event_id: null`، و`event_id` لحفل موقع آخر ← `404 RESOURCE_NOT_FOUND` (`resource: event`) (DEC-183) | `event_id` (`null` إن لم يوجد حفل مفتوح)، `event_status` | `toast` ثم `refetch` قائمة الحفلات المفتوحة | info · — |

### 4.6 التوزيع والعروض

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `OFFER_EXPIRED` | 410 | لا | انتهى وقت هذا الطلب. | This offer has expired. |
| `OFFER_REVOKED` | 410 | لا | سُحب هذا الطلب. | This offer was withdrawn. |
| `TASK_ALREADY_CLAIMED` | 409 | لا | قبل الطلب سائق آخر. | Another driver accepted this request. |
| `OLDER_REQUEST_PENDING` | 409 | لا | يوجد طلب أقدم. اقبله أولًا. | An older request must be accepted first. |
| `NEXT_TASK_ALREADY_RESERVED` | 409 | لا | لديك مهمة تالية محجوزة بالفعل. | You already have a reserved next task. |
| `MOVEMENT_IN_PROGRESS` | 409 | لا | أنهِ حركتك الحالية قبل بدء حركة جديدة. | Finish your current movement first. |
| `TASK_NOT_STARTABLE` | 409 | لا | لا يمكن بدء هذه المهمة الآن. | This task can't be started now. |
| `REASSIGN_BLOCKED_MOVEMENT` | 409 | لا | بدأت الحركة؛ لا يمكن إعادة الإسناد. تواصل مع السائق. | Movement has started; it can't be reassigned. |
| `CUSTODY_RELEASE_REQUIRED` | 409 | لا | أكّد إعادة المفتاح إلى خانته قبل سحب المهمة. | Confirm the key was returned before withdrawing. |
| `RETRIEVAL_ALREADY_ACTIVE` | 409 | لا | يوجد طلب إحضار نشط لهذه التذكرة. | A retrieval is already active for this ticket. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `OFFER_EXPIRED` | `accept` لعرض فردي بعد `task_offers.expires_at` + سماحية `dispatch.accept_grace_ms` (افتراضيًا 1500 ms) — الخادم يقارن الوقت حتى لو لم يُعالج مؤقت الانتهاء بعد | `offer_id` | `remove-card` ثم `refetch` | info · — (لا `rejected_late`؛ يُسجل مع `TASK_ALREADY_CLAIMED` فقط) |
| `OFFER_REVOKED` | `accept` لعرض أُغلق لغير القبول: تحويل فردي/بث، إلغاء الطلب، إعادة إسناد، نقل السائق؛ وقبول متأخر لجولة `accepted` أعيدت مهمتها للطابور لاحقًا (سحب) بـ`close_reason: accepted`، فالبطاقة صارت تاريخًا (DEC-181) | `offer_id`، `close_reason` | `remove-card` ثم `refetch` | info · — |
| `TASK_ALREADY_CLAIMED` | `accept` لمهمة حجزها سائق آخر — الخاسرون في سباق البث داخل قفل المجموعة | `task_id` | `remove-card` و`toast` قصير ثم `refetch` | info (متوقع في البث) · — ؛ `rejected_late` |
| `OLDER_REQUEST_PENDING` | `accept` لطلب أحدث بينما طلب أقدم متاح لنفس المستلم في المجموعة (حارس الأولوية، الملف 10) | `older_task_id`، `older_offer_id` | `refetch` وإظهار بطاقة الطلب الأقدم | info · — |
| `NEXT_TASK_ALREADY_RESERVED` | `accept` من سائق مشغول لديه مهمة `assigned_waiting` (`uq_tasks_next_per_driver`) | `next_task_id` | `remove-card` (البطاقة كانت للعرض فقط) | info · — |
| `MOVEMENT_IN_PROGRESS` | `POST /v1/tickets` (بدء استلام) وللسائق أي مهمة حركة نشطة (`accepted` أو `in_progress` من أي نوع، ومنها مهمة تالية رُقّيت)؛ `POST /v1/tasks/{taskId}/key-pickup` أو `start-retrieval` وللسائق مهمة أخرى `in_progress` (جهازان أو سباق)؛ `POST /v1/tickets/{ticketId}/custody-transfers` حين تنتقل مهمة التذكرة إلى سائق لديه حركة نشطة — `uq_tasks_active_movement_driver` | `active_task_id` | `refetch` | info (warn للجهازين) · — |
| `TASK_NOT_STARTABLE` | `key-pickup` أو `start-retrieval` لمهمة ليست `accepted` (مثل `assigned_waiting` قبل ترقيتها، أو أُلغيت أو أُعيد إسنادها) | `task_status`، `reason` | `refetch` | info · — |
| `REASSIGN_BLOCKED_MOVEMENT` | `POST /v1/tasks/{taskId}/reassign` لمهمة `in_progress` (المعمارية §6: بعد بدء الحركة لا يُعاد الإسناد آليًا). إلغاء الطلب بعد بدء الحركة لا يرفع هذا الرمز بل يتبع DEC-30 (تحويل التذكرة إلى `reparking` مع السائق نفسه) | `task_id`، `started_at` | `dialog` للمشرف بإرشاد للتواصل الميداني | info · — |
| `CUSTODY_RELEASE_REQUIRED` | `reassign` أو `POST /v1/retrieval-cycles/{cycleId}/cancel` لمهمة `accepted` سبق تأكيد استلام مفتاحها (`key_picked_up_at` موجود) ولم يُعد المفتاح | `task_id`، `key_holder_id` | `dialog` بإجراء `POST /v1/tasks/{taskId}/release-custody` | info · — |
| `RETRIEVAL_ALREADY_ACTIVE` | `POST /v1/tickets/{ticketId}/retrievals` والتذكرة `parked` ولها دورة مفتوحة (`uq_retrieval_cycles_open`)؛ التذكرة غير `parked` ترد `TICKET_NOT_PARKED` أولًا (DEC-25). مسار واتساب لا يرفعه بل يرد W-09 بالحالة | `cycle_id`، `ticket_status` | `toast` وعرض حالة الطلب الحالي | info · — |

### 4.7 التذاكر والاستلام

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `TICKET_NOT_PARKED` | 409 | لا | المركبة ليست متوقفة بعد؛ أكمل الاستلام أولًا. | The vehicle isn't parked yet. |
| `TICKET_CLOSED` | 409 | لا | التذكرة مغلقة (سُلّمت أو أُلغيت). | This ticket is closed. |
| `INTAKE_INCOMPLETE` | 422 | لا | أكمل بيانات الاستلام الناقصة. | Intake details are incomplete. |
| `INSPECTION_INCOMPLETE` | 409 | لا | صور الفحص ناقصة. أكملها أو تابع وسيُبلَّغ المشرف. | Inspection photos are incomplete. |
| `DRAFT_HAS_DATA` | 409 | لا | المسودة فيها بيانات؛ يلزم إلغاؤها من المشرف. | The draft has data; a supervisor must void it. |
| `PAPER_SERIAL_IN_USE` | 409 | لا | رقم التذكرة الورقية مستخدم في هذا الحفل. | This paper ticket number is already used in this event. |
| `KEY_TAG_IN_USE` | 409 | لا | رقم علاقة المفتاح مستخدم لمركبة أخرى. | This key tag is already in use. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `TICKET_NOT_PARKED` | `POST /v1/tickets/{ticketId}/retrievals` (طلب الموظف نيابة عن العميل) لتذكرة ليست `parked` ولا دورة مفتوحة لها: `received` أو `parking` أو `reparking` (DEC-25). الطلب المبكر المعلّق (DEC-13) يأتي من زر واتساب فقط | `ticket_status` | `toast` «انتظر حتى تُصف المركبة» | info · — |
| `TICKET_CLOSED` | أي أمر على تذكرة `delivered` أو `voided`: طلب إحضار، تحصيل، تعديل جوال، ربط واتساب، إعادة إرسال رمز، إلغاء، نقل عهدة، وتسليم ثانٍ بعد نجاح التسليم بطلب جديد (بنفس مفتاح التكرار يُعاد رد 200 المحفوظ)؛ فحص التذكرة المغلقة يسبق فحوص الرمز؛ والتسليم الاستثنائي أيضًا (DEC-210)؛ عدا `void` الذي يرد `INVALID_STATE_TRANSITION` (DEC-175)، و`inspection-exception` و`manual-reconcile` اللذين يردان `INVALID_STATE_TRANSITION` بـ`reason: ticket_closed` (DEC-249، DEC-253) | `ticket_status` | `refetch` و`toast` | info · — |
| `INTAKE_INCOMPLETE` | `POST /v1/tickets/{ticketId}/submit-intake` دون الحقول الإلزامية: اللوحة (أرقام وحروف أو `plate_raw`)، الصنع، اللون، `key_tag`، والحفل؛ وحسب القناة: لـ`whatsapp` جوال للربط المباشر أو رمز QR صادر لهذه التذكرة (نشط أو بانتظار التأكيد أو مؤكد)، ولـ`paper` رقم `paper_serial`. الجوال موجود والموافقة ناقصة ← `CONSENT_REQUIRED` لا هذا الرمز | `missing: [field]` بالأسماء `plate`، `vehicle.make`، `vehicle.color`، `key_tag`، ومعها `paper_serial` (ورقية) أو `customer_phone` (واتساب بلا عميل ولا رمز QR حي أو مستهلك ولا ربط) (DEC-172) | `inline` مع الانتقال للخطوة التي فيها النقص | info · — |
| `INSPECTION_INCOMPLETE` | `submit-intake` والصور الإلزامية (`inspection.required_photos`) ناقصة أو فاشلة الرفع والطلب لا يحمل `acknowledge_incomplete_inspection: true`؛ إعادة الإرسال بالإقرار تنقل التذكرة إلى `parking` بـ`inspection_status = incomplete` (DEC-31) | `missing` (أنواع الصور)، `failed_media_ids` | `dialog`: «إعادة المحاولة» أو «متابعة الصف وإبلاغ المشرف» | info · `inspection_incomplete` عند المتابعة |
| `DRAFT_HAS_DATA` | `POST /v1/tickets/{ticketId}/discard-draft` لمسودة فيها أي بيانات مركبة أو عميل أو صور (DEC-20) | `fields_present` ∈ `plate`، `vehicle`، `customer_phone`، `key_tag`، `paper_serial`، `notes`، `damage_marks`، `photos` (DEC-173) | `dialog`: «سيُطلب من المشرف إلغاء المسودة»؛ يبقى السائق مشغولًا حتى قرار المشرف | info · `draft_abandoned` فورًا عند هذا الرفض، إضافة لكشف المراقب بعد `intake.draft_abandoned_alert_min` (DEC-174) |
| `PAPER_SERIAL_IN_USE` | `PATCH .../intake`، `submit-intake` (`uq_tickets_paper_serial`) | `field: "paper_serial"` | `inline` | info · — |
| `KEY_TAG_IN_USE` | `PATCH .../intake`، `submit-intake` (`uq_tickets_key_tag_open`) | `field: "key_tag"`، `conflicting_display_number` | `inline` | info · — |

### 4.8 العهدة والمواقف

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `KEY_SLOT_OCCUPIED` | 409 | لا | خانة المفتاح مشغولة. اختر خانة أخرى. | This key slot is occupied. |
| `PARKING_SPOT_OCCUPIED` | 409 | لا | الموقف مشغول. اختر موقفًا آخر أو اكتب ملاحظة. | This parking spot is occupied. |
| `KEY_NOT_PICKED_UP` | 409 | لا | أكّد استلام المفتاح أولًا. | Confirm key pickup first. |
| `CUSTODY_HOLDER_MISMATCH` | 409 | لا | هذه العهدة ليست لديك. | You aren't holding this item. |
| `CUSTODY_OPEN` | 409 | لا | توجد عهدة مفتوحة يجب إقفالها أو نقلها أولًا. | Open custody must be settled first. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `KEY_SLOT_OCCUPIED` | `POST /v1/tasks/{taskId}/complete-parking`، `POST /v1/tasks/{taskId}/release-custody` (إعادة لخانة)، `POST /v1/tickets/{ticketId}/custody-transfers` إلى خانة (`uq_key_alloc_slot_active`)؛ `PATCH /v1/key-slots/{slotId}` لتعطيل خانة مشغولة | `key_slot_id` | `inline` على منتقي الخانة مع تحديث الخانات الحرة؛ وفي التعطيل (S-09) نص السياق «لا يمكن تعطيله الآن؛ مشغول بتذكرة مفتوحة.» بدل `message_ar` الذي يخص التخصيص (DEC-351) | info · — |
| `PARKING_SPOT_OCCUPIED` | `complete-parking` بموقف محدد مشغول (`uq_spot_alloc_spot_active`)؛ `PATCH /v1/parking-spots/{spotId}` لتعطيل موقف مشغول | `parking_spot_id` | `inline` على منتقي الموقف؛ وفي التعطيل (S-09) نص السياق «لا يمكن تعطيله الآن؛ مشغول بتذكرة مفتوحة.» بدل `message_ar` الذي يخص التخصيص (DEC-351) | info · — |
| `KEY_NOT_PICKED_UP` | `POST /v1/tasks/{taskId}/start-retrieval` قبل `POST /v1/tasks/{taskId}/key-pickup` | `task_id` | إبراز خطوة «استلمت المفتاح» في D-10 | info · — |
| `CUSTODY_HOLDER_MISMATCH` | `complete-parking`، `key-pickup` (الخانة لا تطابق موضع المفتاح الحالي)، `release-custody`، `handover` عندما لا يطابق الحائز الحالي الفاعلَ؛ `repark` والإلغاء بعد بدء الحركة (`POST /v1/retrieval-cycles/{cycleId}/cancel`) حين لا تكون المركبة والمفتاح مع سائق المهمة الجارية (DEC-226)؛ `custody-transfers` لا يذكر مصدرًا (الجسم `to_holder_*` فقط والمصدر هو الحائز الحالي على التذكرة يستنتجه الخادم)، فيُرد فيه الرمز حين يكون الحائز الجديد المطلوب هو الحائز الحالي نفسه | `subject`، `current_holder_type` | `refetch` و`dialog` «راجع المشرف» | warn · — |
| `CUSTODY_OPEN` | `POST /v1/me/duty/break` والسائق بعهدته مركبة أو مفتاح دون مهمة نشطة أو تالية (مع مهمة ← `DRIVER_NOT_AVAILABLE`)؛ `POST /v1/drivers/{driverId}/disable` والسائق بعهدته مركبة أو مفتاح أو لديه مهمة `in_progress` أو مهمة صف/إعادة صف نشطة (DEC-32، لا تجاوز؛ المهمة التالية المحجوزة ومهمة الإحضار المقبولة قبل استلام المفتاح لا تمنعان وتعودان للطابور `task.withdrawn`)؛ `POST /v1/tickets/{ticketId}/void` والعهدة على التذكرة غير محسومة (`custody_returned_to_customer` ليس `true`؛ `items` عناصر العهدة البعيدة عن العميل، DEC-175) | `items` حسب المسار (DEC-229): للاستراحة والإلغاء `[{ type: vehicle / key, ticket_id, display_number, holder_type }]`؛ وللتعطيل (`disable`، وتعطيل مشرف يقود بـ`PATCH /v1/staff/{userId}`) صفوف `blockingCustody` كاملة `[{ type: vehicle / key / task, ticket_id, display_number, task_id?, task_type?, task_status? }]` بلا `holder_type` | `dialog` يسرد العناصر | info · — |

### 4.9 التسليم

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `HANDOVER_NOT_READY` | 409 | لا | المركبة ليست جاهزة للتسليم. اضغط «جاهزة» أولًا. | The vehicle isn't ready for handover. |
| `HANDOVER_CODE_INVALID` | 422 | لا | الرمز غير صحيح. | Incorrect handover code. |
| `HANDOVER_CODE_EXPIRED` | 410 | لا | انتهت صلاحية الرمز. أرسل رمزًا جديدًا للعميل. | The handover code has expired. |
| `HANDOVER_CODE_LOCKED` | 423 | لا | قُفل التحقق بعد محاولات خاطئة. اتصل بالمشرف. | Verification is locked after too many attempts. |
| `HANDOVER_CODE_CONSUMED` | 409 | لا | استُخدم هذا الرمز من قبل. | This code was already used. |
| `PAPER_STUB_MISMATCH` | 422 | لا | رقم كعب التذكرة لا يطابق. | The paper stub number doesn't match. |
| `RESEND_LIMIT_REACHED` | 429 | لا | وصلت للحد الأقصى لإعادة إرسال الرمز. اتصل بالمشرف. | The resend limit has been reached. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `HANDOVER_NOT_READY` | `POST /v1/tickets/{ticketId}/handover`، `handover-code/resend`، `handover-exception` والتذكرة مفتوحة وليست `ready` (التذكرة النهائية ← `TICKET_CLOSED`) | `ticket_status` | `refetch` | info · — |
| `HANDOVER_CODE_INVALID` | `handover` برمز لا يطابق `claim_codes.code_hash`؛ زيادة `attempts` تلتزم مع رد الخطأ في المعاملة نفسها (القاعدة 1.3/6)، وإعادة نفس الطلب بنفس المفتاح لا تستهلك محاولة ثانية | `attempts_left` | `inline`: مسح الحقل وعرض المحاولات المتبقية؛ الرمز الصحيح لا يُعرض أبدًا | info · — |
| `HANDOVER_CODE_EXPIRED` | `handover` بعد `claim_codes.expires_at` (30 دقيقة من الجاهزية، `handover.code_ttl_min`) أو بعد تنظيفه (`expired_cleanup`)؛ الترتيب: المستهلك ← `HANDOVER_CODE_CONSUMED`، ثم المقفل ← `HANDOVER_CODE_LOCKED` (ولو بعد تنظيفه)، ثم المنتهي؛ ولا رمز للدورة ← `VALIDATION_FAILED` (`verification.method`، `not_applicable`) (DEC-206) | `expired_at` | `dialog` بزر «إرسال رمز جديد» | info · — |
| `HANDOVER_CODE_LOCKED` | `handover` عند بلوغ `max_attempts` صف الرمز (من `handover.max_attempts` لحظة الإصدار، 5) بالرمز أو بكعب الورق، وكل محاولة بعدها ولو بالرمز الصحيح أو بعد تنظيف الرمز المقفل (DEC-206)؛ و`handover-code/resend` من المكلّف لرمز مقفل (المشرف وحده يعيد إصداره، DEC-207) | `locked_at`، `alert_id` | `dialog` حاجب «اتصل بالمشرف»؛ وفي الكعب الورقي (D-11) النص تحت حقل الكعب مع تعطيل الحقل والزر، ويجوز أن تتبعه النافذة (DEC-363)؛ البديل `POST /v1/tickets/{ticketId}/handover-exception` | warn · `handover_code_locked` |
| `HANDOVER_CODE_CONSUMED` | دفاعي فقط: `handover` والتذكرة ما زالت `ready` لكن رمز دورتها مستهلك (`claim_codes.consumed_at` مضبوط)؛ لا يحدث في المسار السليم لأن استهلاك الرمز وإغلاق التذكرة في معاملة واحدة تحت قفل التذكرة. التسليم الثاني بعد النجاح لا يصل لفحص الرمز: بنفس مفتاح التكرار يُعاد رد 200 المحفوظ، وبأي طلب آخر `TICKET_CLOSED` | — | `refetch` | warn (يدل على خلل) · — |
| `PAPER_STUB_MISMATCH` | `handover` لتذكرة قناتها `paper` برقم كعب لا يطابق `paper_serial`؛ يُحتسب ضمن نفس حد المحاولات | `attempts_left` | `inline` | info · — |
| `RESEND_LIMIT_REACHED` | `POST /v1/tickets/{ticketId}/handover-code/resend` بعد `handover.max_resends` (3) | `max_resends` | `dialog` «اتصل بالمشرف» | info · — |

### 4.10 التحصيل

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `PAYMENT_PENDING` | 409 | لا | سجّل التحصيل قبل التسليم. | Record the payment before handover. |
| `PAYMENT_AMOUNT_MISMATCH` | 422 | لا | المبلغ لا يطابق رسوم الحفل. | The amount doesn't match the event fee. |
| `PAYMENT_METHOD_NOT_ALLOWED` | 422 | لا | وسيلة التحصيل غير مسموحة في هذا الحفل. | This payment method isn't allowed for this event. |
| `PAYMENT_ALREADY_RECORDED` | 409 | لا | التحصيل مسجّل مسبقًا لهذه التذكرة. | A payment is already recorded for this ticket. |
| `PAYMENT_ALREADY_REVERSED` | 409 | لا | هذا التحصيل معكوس مسبقًا. | This payment was already reversed. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `PAYMENT_PENDING` | `handover` و`handover-exception` و`tickets.payment_status = due` دون تحصيل مضمّن؛ و`manual-reconcile` إلى `delivered` لتذكرة `due` دون `payment` ولا إعفاء سابق (13 §8.5، DEC-252) | `amount_halalas`، `allowed_methods` | الانتقال لخطوة التحصيل في D-11 | info · — |
| `PAYMENT_AMOUNT_MISMATCH` | `POST /v1/tickets/{ticketId}/payments` بمبلغ يختلف عن `tickets.fee_halalas`؛ وكذلك `payment` في `handover` و`handover-exception` و`manual-reconcile` وبديل العكس | `expected_halalas`، `received_halalas` | `inline` مع عرض المبلغ الصحيح | info · — |
| `PAYMENT_METHOD_NOT_ALLOWED` | `payments` بوسيلة خارج `events.allowed_payment_methods`؛ وكذلك `payment` في `handover` و`handover-exception` و`manual-reconcile` وبديل العكس | `allowed_methods` | `inline` | info · — |
| `PAYMENT_ALREADY_RECORDED` | `payments` مع وجود تحصيل `recorded` (`uq_payments_ticket_recorded`)؛ `POST /v1/tickets/{ticketId}/payment-waiver` بعد التحصيل؛ و`manual-reconcile` بـ`payment` لتذكرة محصّلة (DEC-252)؛ و`handover` و`handover-exception` بـ`payment` لتذكرة محصّلة (DEC-278، DEC-210) | `payment_id`، `method`، `collected_by` | `refetch` | info · — |
| `PAYMENT_ALREADY_REVERSED` | `POST /v1/payments/{paymentId}/reverse` لتحصيل معكوس | — | `refetch` | info · — |

ملاحظة: محاولة تحصيل لتذكرة `not_required` (حفل `included`) ترد `INVALID_STATE_TRANSITION` بـ`reason = payment_not_required`، ولتذكرة `waived` بـ`payment_waived`؛ ورفض الحالة المالية يحمل `current_status` = `payment_status` للتذكرة و`allowed_from` (`[due]` للتحصيل والإعفاء، و`[collected]` للعكس)، وعكس تحصيل تذكرته ليست `collected` ← `reason = payment_integrity` (DEC-282).

### 4.11 النقل والتعيين والحسابات

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `TRANSFER_BLOCKED_CUSTODY` | 409 | لا | لا يمكن نقل السائق وبعهدته مركبة أو مفتاح أو مهمة. | The driver holds custody or an active task. |
| `TRANSFER_SCOPE_DENIED` | 403 | لا | النقل يحتاج صلاحية على الموقعين. | A transfer requires scope over both venues. |
| `TRANSFER_ALREADY_PENDING` | 409 | لا | يوجد طلب نقل مفتوح لهذا السائق. | A transfer is already pending for this driver. |
| `ASSIGNMENT_CONFLICT` | 409 | لا | للسائق تعيين نشط آخر؛ استخدم النقل. | The driver already has an active assignment. |
| `DRIVER_DISABLED` | 409 | لا | حساب السائق معطّل. | The driver's account is disabled. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `TRANSFER_BLOCKED_CUSTODY` | `POST /v1/drivers/{driverId}/transfers` بنقل فوري والسائق بعهدته مركبة أو مفتاح أو لديه مهمة `in_progress` أو مهمة صف/إعادة صف نشطة (DEC-32، لا تجاوز): يُرد 409 دون إنشاء سجل نقل ودون تنبيه. المهمة التالية المحجوزة ومهمة الإحضار المقبولة قبل استلام المفتاح لا تمنعان النقل وتعودان لطابور الموقع القديم بأولويتهما (`task.withdrawn`). وعند تعذّر تفعيل النقل المجدول (`job.transfer_activate`) يُحفظ نفس الرمز والعناصر في `driver_transfers.blocked_details` وتصير الحالة `blocked` مع تنبيه `transfer_blocked`، ويُعاد تقييمه آليًا | `items` | `dialog` للمشرف بالعناصر وروابط إقفالها | info · `transfer_blocked` (للمجدول فقط) |
| `TRANSFER_SCOPE_DENIED` | `transfers` من مشرف لا يملك نطاق الموقع الحالي والهدف معًا، و`POST /v1/transfers/{transferId}/cancel` بالقاعدة نفسها (DEC-224) | `missing_venue_id` | `toast` | warn · — |
| `TRANSFER_ALREADY_PENDING` | `transfers` مع طلب `pending` أو `blocked` (`uq_driver_transfers_open`) | `transfer_id` | `refetch` وعرض الطلب القائم | info · — |
| `ASSIGNMENT_CONFLICT` | `POST /v1/drivers/{driverId}/assignments` والسائق له تعيين `active` (`uq_driver_assignments_active`)؛ و`POST /v1/drivers/{driverId}/transfers` حين يتغيّر التعيين النشط تزامنًا (`reason: assignment_changed`، DEC-224) | `active_assignment_id`، `venue_id`، أو `reason` | `dialog` يقترح «نقل» بدل التعيين | info · — |
| `DRIVER_DISABLED` | `POST /v1/drivers/{driverId}/assignments`، `POST /v1/drivers/{driverId}/transfers`، `POST /v1/drivers/{driverId}/reset-secret` لحساب `disabled` | — | `toast` مع إجراء «تفعيل الحساب» للإدارة | info · — |

### 4.12 الحفلات والورديات

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `EVENT_CLOSE_BLOCKED` | 409 | لا | لا يمكن إغلاق الحفل: توجد عناصر مفتوحة. | Event close is blocked by open items. |
| `EVENT_ALREADY_CLOSED` | 409 | لا | الحفل مغلق. | The event is already closed. |
| `SHIFT_CLOSE_BLOCKED` | 409 | لا | لا يمكن إغلاق الوردية: سائقون بعهدتهم عناصر أو لديهم مهام مفتوحة. | Shift close is blocked by drivers holding custody or open tasks. |
| `SHIFT_ALREADY_OPEN` | 409 | لا | توجد وردية مفتوحة لهذه المجموعة بالفعل. | A shift is already open for this dispatch pool. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `EVENT_CLOSE_BLOCKED` | `POST /v1/events/{eventId}/close`؛ و`POST /v1/events/{eventId}/cancel` وللحفل تذكرة غير `voided` (DEC-120) | `blockers: { open_tickets, keys_not_in_slots, open_requests, open_tasks, unsettled_payments, cash_outstanding: [{ driver, amount_halalas }], payment_integrity: [{ check, entity_id }] }` — بنية `Reconciliation.blockers` في 07 نفسها، دون جوال العميل؛ وللإلغاء `{ reason: 'non_voided_tickets', ticket_count, blockers: { non_voided_tickets: [{ id, display_number, status }] } }` (حتى 50 تذكرة، والعدد كامل) | توجيه لمعالج S-10 عند أول بند غير مغلق | info · — |
| `EVENT_ALREADY_CLOSED` | `PATCH /v1/events/{eventId}`، `open`، `start-closing`، `close`، `cancel` لحفل `closed` أو `canceled` (نهائيتان)؛ أما `closing` في `PATCH` و`cancel` فـ`INVALID_STATE_TRANSITION` (DEC-110) | `event_id`، `current_status` | `refetch` | info · — |
| `SHIFT_CLOSE_BLOCKED` | `POST /v1/shifts/{shiftId}/close` وفي الوردية سائق بعهدته مركبة أو مفتاح أو لديه مهمة مفتوحة؛ بقية المناوبات المفتوحة (بلا عهدة ولا مهمة مفتوحة) لا تمنع الإغلاق وتُنهى آليًا (`end_reason = shift_closed`) | `blocking_drivers: [{ driver, items }]` (`items` بالبنية نفسها في `DUTY_END_BLOCKED_CUSTODY` مع `task_id` لعناصر المهام، والسائقون مرتبون برمز الموظف، DEC-122) | `dialog` بقائمة السائقين المانعين وعناصرهم وروابطها (نقل العهدة رسميًا أو إنهاء المهمة أولًا) | info · — |
| `SHIFT_ALREADY_OPEN` | `POST /v1/shifts/{shiftId}/open` ولمجموعة التوزيع نفسها وردية `open` (`uq_shifts_open_per_pool`) | `open_shift_id` | `refetch` وعرض الوردية المفتوحة | info · — |

### 4.13 واتساب

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `WA_CONSENT_MISSING` | 409 | لا | لا توجد موافقة سارية من العميل على واتساب. | There is no valid WhatsApp consent for this customer. |
| `WA_NOT_LINKED` | 409 | لا | التذكرة غير مربوطة بواتساب. | The ticket isn't linked to WhatsApp. |
| `WA_LINK_CODE_EXPIRED` | 410 | لا | انتهت صلاحية رمز الربط. أنشئ رمزًا جديدًا. | The link code has expired. |
| `WA_CUSTOMER_OPTED_OUT` | 409 | لا | أوقف العميل رسائل واتساب. استخدم QR من جوال العميل أو التذكرة الورقية. | The customer opted out of WhatsApp messages. |
| `WA_TEMPLATE_NOT_APPROVED` | 409 | لا | قالب الرسالة غير معتمد. راجع الإدارة. | The message template isn't approved. |
| `WA_CHANNEL_UNAVAILABLE` | 503 | نعم | واتساب متعطل حاليًا. استخدم التذكرة الورقية. | WhatsApp is currently unavailable. |
| `WA_SEND_FAILED` | 502 | لا | تعذّر إرسال رسالة واتساب. | WhatsApp message delivery failed. |
| `WA_WEBHOOK_SIGNATURE_INVALID` | 401 | لا | — | Invalid webhook signature. |
| `WA_WEBHOOK_VERIFY_FAILED` | 403 | لا | — | Webhook verification failed. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `WA_CONSENT_MISSING` | إرسال W-01 دون موافقة سارية مسجلة: `POST .../whatsapp-link` بالإرسال المباشر ولا موافقة سارية مسجلة (أو أُلغيت). نقص إقرار الموافقة في جسم الطلب نفسه (مثل `PATCH .../customer-phone`) يرد `CONSENT_REQUIRED` (422) | — | `dialog` لأخذ الموافقة أو اختيار QR أو الورق | info · — |
| `WA_NOT_LINKED` | `handover-code/resend` لتذكرة `paper` أو `wa_link_status` ليست `linked` (بعد فحص `WA_CUSTOMER_OPTED_OUT`، DEC-207). أما `whatsapp-link/confirm` لرمز ليس `pending_confirmation` فيرد `INVALID_STATE_TRANSITION` كما في 07 (DEC-198) | `wa_link_status` | `toast`؛ التسليم بكعب الورق أو استثناء مشرف | info · — |
| `WA_LINK_CODE_EXPIRED` | `whatsapp-link/confirm` بعد `link_codes.expires_at` (10 دقائق، `link.qr_ttl_min`) ولو لم يعلّمه مؤقته بعد (DEC-197، DEC-198) | `expired_at` | `dialog` «إنشاء رمز جديد» | info · — |
| `WA_CUSTOMER_OPTED_OUT` | `submit-intake` بالربط المباشر (قناة `whatsapp` مع جوال)، `whatsapp-link` بالإرسال المباشر، `handover-code/resend`، تغيير الجوال — لعميل `wa_opted_out_at` لديه قيمة. البديل ربط QR (رسالة العميل نفسها تعيد موافقته) أو التذكرة الورقية | — | `dialog` بخياري «QR من جوال العميل» و«تذكرة ورقية» | info · — |
| `WA_TEMPLATE_NOT_APPROVED` | فحص مبكر في `submit-intake` (الربط المباشر؛ يتراجع الإرسال كله، DEC-195) و`whatsapp-link` و`handover-code/resend` حين يكون القالب اللازم غير `approved` — وفي إعادة إرسال الرمز فقط إن كانت نافذة الخدمة 24 ساعة مغلقة، وإلا يُرسل W-05 رسالة جلسة (12 §8.4، DEC-207)؛ ويظهر في نتيجة `POST /v1/admin/whatsapp/templates/sync` | `template_name`، `template_status` | السائق: `toast` وبديل ورقي؛ الإدارة: شاشة القوالب في S-13 | error · `wa_send_failed` |
| `WA_CHANNEL_UNAVAILABLE` | `whatsapp-link` (الطريقتان) و`handover-code/resend` حين لا قناة فعالة أو `whatsapp_channel.health_status = down`، وQR حين لا رقم عرض مضبوط (`reason: display_phone_not_configured`؛ `whatsapp_channel.phone_display` وإلا `WA_DISPLAY_PHONE_E164`)، و`submit-intake` لا يرفعه بل ينتظر W-01 عودة القناة (12 §7.3، DEC-195)؛ ومسارات القناة الإدارية عند `down`؛ و`POST /v1/admin/whatsapp/templates/sync` عند تعطل Graph أو رده 5xx أو خطأ من فئة القناة (المهلة ← `DEPENDENCY_TIMEOUT`، وغير ذلك ← `WA_SEND_FAILED`، DEC-142) | `health_status`، `since`، أو `reason` (`display_phone_not_configured`) | `banner` دائم «واتساب متعطل» وبديل ورقي | warn · `wa_channel_down` (يرفعه مراقب صحة القناة، لا كل طلب) |
| `WA_SEND_FAILED` | يُخزَّن أساسًا في `notifications.last_error_code` ويظهر في S-02 و`GET /v1/reports/messages`؛ وكرد HTTP فقط من المسارات الإدارية التي تستدعي المزود متزامنًا (مثل `POST /v1/admin/whatsapp/templates/sync`) | `provider_error_code`، `notification_id` | الإدارة: `toast` والسجل؛ السائق: شارة على التذكرة | error · `wa_send_failed` |
| `WA_WEBHOOK_SIGNATURE_INVALID` | `POST /webhooks/whatsapp` بتوقيع مفقود أو خاطئ (§7) | — | — (المستهلك Meta)؛ لا يُخزن شيء | warn مع تحديد معدل السجل · تقني عند ارتفاع المعدل |
| `WA_WEBHOOK_VERIFY_FAILED` | `GET /webhooks/whatsapp` برمز تحقق لا يطابق | — | — | warn · — |

### 4.14 الوسائط

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `MEDIA_TOO_LARGE` | 413 | لا | الصورة كبيرة جدًا. أعد التصوير أو المحاولة. | The image is too large. |
| `MEDIA_TYPE_UNSUPPORTED` | 415 | لا | نوع الملف غير مدعوم. استخدم الكاميرا أو صورة JPG. | Unsupported file type. |
| `MEDIA_UPLOAD_INCOMPLETE` | 409 | لا | لم يكتمل رفع الصورة. أعد المحاولة. | The upload isn't complete. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `MEDIA_TOO_LARGE` | `POST /v1/tickets/{ticketId}/media` بحجم مُعلن فوق الحد؛ `POST /v1/media/{mediaId}/complete` إذا كان الحجم الفعلي فوق الحد (`MEDIA_MAX_BYTES` في الملف 05، افتراضي 10485760)، أو تجاوزت الصورة حد الفك 50 ميغابكسل أو حد المعالجة 15 ثانية (DEC-99) | `max_bytes` | الواجهة تضغط تلقائيًا (أطول ضلع 1600 بكسل، JPEG) وتعيد الرفع | info · — |
| `MEDIA_TYPE_UNSUPPORTED` | `media` بنوع خارج `image/jpeg` و`image/webp` و`image/heic` و`image/png`؛ و`complete` حين لا تُفك بايتات الكائن بالنوع المعلن نفسه (نص، GIF، SVG، AVIF، PNG معلن JPEG، ملف مقطوع)، ومنه HEIC لأن الخادم بلا فك HEVC (DEC-98، DEC-99) | `allowed_types` | `inline` على خانة الصورة | info · — |
| `MEDIA_UPLOAD_INCOMPLETE` | `complete` والكائن غير موجود في التخزين أو الحجم/البصمة لا تطابق؛ `GET /v1/media/{mediaId}/url` لوسائط ليست `uploaded` بعد فحص الوصول (DEC-105) | `media_id`، `upload_status` | إعادة رفع تلقائية مرة واحدة ثم `inline` | info · — |

### 4.15 المنصة

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `PAYLOAD_TOO_LARGE` | 413 | لا | البيانات المرسلة أكبر من المسموح. | The request body is too large. |
| `RATE_LIMITED` | 429 | نعم | طلبات كثيرة. انتظر قليلًا ثم حاول. | Too many requests. |
| `INTERNAL_ERROR` | 500 | نعم | حدث خطأ غير متوقع. أعد المحاولة. | An unexpected error occurred. |
| `SERVICE_UNAVAILABLE` | 503 | نعم | الخدمة غير متاحة مؤقتًا. سنعيد المحاولة تلقائيًا. | The service is temporarily unavailable. |
| `DEPENDENCY_TIMEOUT` | 504 | نعم | تأخر رد خدمة خارجية. أعد المحاولة. | An external service timed out. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `PAYLOAD_TOO_LARGE` | جسم غير الوسائط أكبر من الحد: JSON فوق 1 MB، أو Webhook خام فوق 3 MB (يُرفض قبل التوقيع ولا يُخزن) (DEC-130) | `max_bytes` | `toast` عام؛ لا يحدث في الاستخدام الطبيعي | warn · — |
| `RATE_LIMITED` | أي مسار عند تجاوز حد فئته في 07 §1.9 (`auth` لكل IP قبل الدخول، و`command`/`write`/`read`/`device`/`export` لكل مستخدم أو جهاز بعده)؛ و`POST /v1/telemetry` فوق 120 حدثًا في الدقيقة لكل مستخدم وجهاز (DEC-148)؛ و`POST /v1/tickets/{ticketId}/reveal-phone` فوق `security.reveal_phone_per_hour` في ساعة متحركة لكل مستخدم، و`Retry-After` حتى يخرج أقدم كشف من النافذة (DEC-248)؛ ولا يُحفظ 429 مع مفتاح التكرار | `retry_after_s` | `auto-retry` للقراءات؛ `toast` للأوامر | warn · — |
| `INTERNAL_ERROR` | استثناء غير مصنف؛ انتهاك قيد CHECK أو مرجع غير متوقع (§5)؛ خطأ إعداد في التخزين الكائني (الاعتماد أو الحاوية، DEC-107) | — | `auto-retry` مرة واحدة بنفس المفتاح للأوامر، ثم `toast` مع `request_id` | error · تقني عند تجاوز العتبة |
| `SERVICE_UNAVAILABLE` | صيانة أو قاعدة بيانات غير متاحة؛ استنفاد إعادة المعاملة بعد deadlock أو serialization (حتى 3 مرات، القاموس §14ب)؛ تجاوز مهلة القفل `lock_timeout` (`55P03`) على أي صف غير مفتاح التكرار (L0) — لا يُعاد على الخادم؛ تجاوز `statement_timeout` | — | `auto-retry` بتباعد، ثم `banner` إن استمر؛ وفي واجهة السائق: لقطة `GET /v1/me/home` ترد به ولا تنجح قراءة 10 ثوانٍ ← D-15 ح (الشاشة تحتها تحتفظ بحالتها)، وقبلها تبقى اللقطة «قديمة» (D-15 أ، 02 D-15 ح، DEC-454) | error · تقني |
| `DEPENDENCY_TIMEOUT` | استدعاء متزامن لمزود خارجي تجاوز مهلته أو تعذّر (التخزين الكائني عند `complete`: المهلة وخطأ الشبكة ورد 5xx من التخزين، DEC-107؛ وGraph API في المسارات الإدارية) | `dependency` (`object_storage` / `whatsapp`) | `auto-retry` مرة ثم `toast` | warn · تقني عند التكرار |

### 4.16 الأوامر التي تتطلب سببًا (`REASON_REQUIRED`)

| المسار | مصدر الإلزام |
|---|---|
| `POST /v1/tickets/{ticketId}/void` | القاموس §10 + `ck_tickets_voided_fields` |
| `POST /v1/tickets/{ticketId}/inspection-exception` | القاموس §10 |
| `PATCH /v1/tickets/{ticketId}/customer-phone` | القاموس §10 |
| `POST /v1/tickets/{ticketId}/reveal-phone` | القاموس §10 |
| `POST /v1/tickets/{ticketId}/custody-transfers` | القاموس §10 |
| `POST /v1/tickets/{ticketId}/manual-reconcile` | القاموس §10 (سبب + دليل) |
| `POST /v1/tickets/{ticketId}/retrievals` | القاموس §10 + `ck_cycles_staff_requester` |
| `POST /v1/retrieval-cycles/{cycleId}/cancel` | `retrieval_cycles.cancel_reason` |
| `POST /v1/tasks/{taskId}/reassign` | القاموس §10 |
| `POST /v1/tickets/{ticketId}/repark` | قرار المشرف بغياب العميل |
| `POST /v1/tickets/{ticketId}/handover-exception` | القاموس §10 |
| `POST /v1/payments/{paymentId}/reverse` | القاموس §10 + `ck_payments_reversal_fields` |
| `POST /v1/tickets/{ticketId}/payment-waiver` | القاموس §10 + `ck_tickets_waiver_fields` |
| `POST /v1/drivers/{driverId}/transfers` | `driver_transfers.reason NOT NULL` |
| `POST /v1/drivers/{driverId}/disable` | `users.disabled_reason` |
| `POST /v1/duty-sessions/{sessionId}/force-end` | تدقيق المشرف |
| `POST /v1/staff/{userId}/reset-mfa` | تدقيق المالك (`audit_log.reason`) |
| `POST /v1/events/{eventId}/cancel` | `events.cancel_reason` |
| `POST /v1/platform/venues/{venueId}/send-back` · `…/hide` · `…/unhide` | ملاحظة المراجع للمشغل (`platform_audit_log.reason`، V2-004، DEC-491) |

### 4.17 المنصة والمشغلون (الإصدار الثاني، `docs/v2`)

| الرمز | HTTP | إعادة | `message_ar` | `message_en` |
|---|---|---|---|---|
| `PLATFORM_AUTH_REQUIRED` | 401 | لا | سجّل الدخول إلى لوحة المنصة للمتابعة. | Sign in to the platform to continue. |
| `OPERATOR_SUSPENDED` | 409 | لا | حساب المشغّل معلّق من المنصة. لا يمكن تنفيذ هذا الإجراء الآن. | The operator is suspended. |

| الرمز | متى يُرفع | `details` | الواجهة | السجل · التنبيه |
|---|---|---|---|---|
| `PLATFORM_AUTH_REQUIRED` | أي مسار `/v1/platform/*` غير عام بلا كوكي المنصة (`PLATFORM_SESSION_COOKIE_NAME`، `__Host-point_psid`) أو برمز غير معروف أو بخطوة تحقق لم تكتمل — ومنه الطلب الذي يحمل كوكي جلسة الموظفين وحده: جلسة الموظف لا تُقرأ على مسار المنصة أبدًا، فلا يُرفع `AUTH_UNAUTHENTICATED` الذي يُخرج الموظف من تطبيقه (DEC-462). أما الجلسة المنصية المنتهية أو المبطلة أو الحساب المعطّل أو المقيد فبرموز 4.1 نفسها (`AUTH_SESSION_EXPIRED`، `AUTH_SESSION_REVOKED`، `AUTH_ACCOUNT_DISABLED`، `AUTH_SECRET_CHANGE_REQUIRED`، `AUTH_MFA_SETUP_REQUIRED` مع `allowed_paths` = مسارات `platform.self`)، ودخول المنصة بـ`AUTH_INVALID_CREDENTIALS`/`AUTH_ACCOUNT_LOCKED`/`AUTH_MFA_*` كدخول الموظفين | — | `/platform/login` (لوحة المنصة)؛ لا يمس جلسة الموظف في التبويب نفسه | info · — |
| `OPERATOR_SUSPENDED` | لمؤسسة `operator_status` فيها `suspended` أو `terminated` (V2-005، DEC-486): فتح حفل أو إعادة فتحه (`POST /v1/events/{eventId}/open`)، فتح وردية (`POST /v1/shifts/{shiftId}/open`)، بدء مناوبة (`POST /v1/me/duty/start`)، بدء استلام تذكرة (`POST /v1/tickets`). ما بدأ قبل التعليق يكتمل، والدخول والقراءة مسموحان | `operator_status` | `dialog` «تواصل مع المنصة» ثم `refetch`؛ وشريط المشغل المعلّق من `/v1/me` (`organization.operator_status`) | info · — |

---

## 5. ربط قيود قاعدة البيانات بالرموز

مرشّح الاستثناءات في الخادم يقرأ `err.code` (SQLSTATE) و`err.constraint` من `pg` ويطبق الجداول أدناه. أي قيد غير مذكور ← `INTERNAL_ERROR` مع تسجيل `error` يتضمن اسم القيد.

### 5.1 الفهارس الجزئية الفريدة (`uq_*`)

| القيد/الفهرس | الجدول | النتيجة |
|---|---|---|
| `uq_dispatch_pools_default` | `dispatch_pools` | `VALIDATION_FAILED` (حقل `is_default`) |
| `uq_role_scopes_org_active` / `uq_role_scopes_venue_active` | `role_scopes` | لا خطأ: الأمر متساوي القوة ويعيد النطاق القائم |
| `uq_devices_push_endpoint` | `devices` | لا خطأ: نقل الاشتراك للجهاز الحالي (upsert) مع سجل warn |
| `uq_driver_assignments_active` | `driver_assignments` | `ASSIGNMENT_CONFLICT` |
| `uq_driver_transfers_open` | `driver_transfers` | `TRANSFER_ALREADY_PENDING` |
| `uq_shifts_open_per_pool` | `shifts` | `SHIFT_ALREADY_OPEN` |
| `uq_duty_sessions_open` | `duty_sessions` | `DUTY_ALREADY_STARTED` |
| `uq_customers_wa_id` / `uq_customers_wa_user_id` | `customers` | داخلي: الربط بالعميل القائم بنفس المعرّف مع سجل warn (DEC-35) |
| `uq_tickets_paper_serial` | `tickets` | `PAPER_SERIAL_IN_USE` |
| `uq_tickets_key_tag_open` | `tickets` | `KEY_TAG_IN_USE` |
| `uq_spot_alloc_spot_active` | `spot_allocations` | `PARKING_SPOT_OCCUPIED` |
| `uq_spot_alloc_ticket_active` | `spot_allocations` | `INVALID_STATE_TRANSITION` (التذكرة لها موقف نشط) |
| `uq_key_alloc_slot_active` | `key_slot_allocations` | `KEY_SLOT_OCCUPIED` |
| `uq_key_alloc_ticket_active` | `key_slot_allocations` | `INVALID_STATE_TRANSITION` (المفتاح مودع بالفعل) |
| `uq_retrieval_cycles_open` | `retrieval_cycles` | `RETRIEVAL_ALREADY_ACTIVE` (طلب الموظف)؛ مسار واتساب: لا خطأ، يرد W-09 |
| `uq_tasks_open_per_ticket` | `tasks` | عند إنشاء مهمة إحضار: `RETRIEVAL_ALREADY_ACTIVE`؛ غير ذلك: `INVALID_STATE_TRANSITION` |
| `uq_tasks_active_movement_driver` | `tasks` | `POST /v1/tickets` و`key-pickup` و`start-retrieval` و`custody-transfers` ← `MOVEMENT_IN_PROGRESS`؛ `accept` ← لا يظهر للمستخدم (يُعاد تقييم القبول كحجز تالٍ داخل نفس المعاملة) |
| `uq_tasks_next_per_driver` | `tasks` | `NEXT_TASK_ALREADY_RESERVED` |
| `uq_task_offers_active` | `task_offers` | داخلي: سباق في تمريرة التوزيع رغم القفل؛ سجل error وإعادة التمريرة |
| `uq_whatsapp_channel_active` | `whatsapp_channel` | `INVALID_STATE_TRANSITION` (`reason = channel_already_active`) |
| `uq_whatsapp_messages_wamid` | `whatsapp_messages` | وارد مكرر: تجاهل ناجح؛ صادر: سجل error |
| `uq_link_codes_live_code` | `link_codes` | داخلي: توليد رمز جديد (حتى 5 مرات) ثم `INTERNAL_ERROR` |
| `uq_link_codes_live_ticket` | `link_codes` | `VERSION_CONFLICT` (الأمر يلغي الرمز الحي السابق قبل الإنشاء؛ الانتهاك يعني أمرين متزامنين) |
| `uq_claim_codes_live` | `claim_codes` | `VERSION_CONFLICT` (إعادة إرسال متزامنة) |
| `uq_payments_ticket_recorded` | `payments` | `PAYMENT_ALREADY_RECORDED` |
| `uq_alerts_live_dedupe` | `alerts` | لا خطأ: تحديث التنبيه القائم لنفس الموقع والمفتاح (`details`) بدل إنشاء جديد — التفرد على `(venue_id, dedupe_key)` (DEC-46) |
| `uq_outbox_dedupe_pending` | `outbox_events` | لا خطأ: `INSERT ... ON CONFLICT DO NOTHING` (المهمة معلّقة بالفعل) |

### 5.2 القيود الفريدة ذات الأسماء المولّدة تلقائيًا

| القيد | النتيجة |
|---|---|
| `tickets_event_id_display_number_key` | داخلي: سباق على العدّاد رغم قفل صف الحفل؛ إعادة المعاملة مرة ثم `INTERNAL_ERROR` |
| `retrieval_cycles_ticket_id_cycle_no_key` | داخلي: `cycle_no` يُحسب تحت قفل التذكرة؛ إعادة مرة ثم `INTERNAL_ERROR` |
| `task_offers_task_id_round_no_key` | داخلي: إعادة التمريرة |
| `tasks_seq_key` / `outbox_events_seq_key` | لا ينطبق (أعمدة identity) |
| `users_org_id_employee_code_key` | `VALIDATION_FAILED` (حقل `employee_code`) |
| `users_org_id_phone_e164_key` | `VALIDATION_FAILED` (حقل `phone`: «الرقم مستخدم لحساب آخر») |
| `venues_org_id_code_key` | `VALIDATION_FAILED` (حقل `code`) |
| `dispatch_pools_venue_id_name_key` | `VALIDATION_FAILED` (حقل `name`) |
| `parking_zones_venue_id_name_key` | `VALIDATION_FAILED` (حقل `name`) |
| `parking_spots_zone_id_label_key` | `VALIDATION_FAILED` (حقل `label`؛ في الإنشاء الجماعي تُذكر فهارس المكرر) |
| `key_boards_venue_id_name_key` | `VALIDATION_FAILED` (حقل `name`) |
| `key_slots_key_board_id_label_key` | `VALIDATION_FAILED` (حقل `label`) |
| `customers_org_id_phone_e164_key` | لا خطأ: upsert |
| `action_tokens_token_hash_key` / `auth_sessions_token_hash_key` / `media_assets_storage_key_key` | داخلي: توليد قيمة جديدة وإعادة |
| `notifications_dedupe_key_key` | لا خطأ: الإشعار موجود (متساوي القوة) |
| `notification_attempts_notification_id_attempt_no_key` | داخلي: خلل تأجير في العامل؛ سجل error وتخطٍّ |
| `whatsapp_inbound_events_body_sha256_key` | لا خطأ: تسليم Webhook مكرر يُرد 200 ويُتجاهل |
| `whatsapp_templates_org_id_name_language_key` | لا خطأ: upsert عند المزامنة |
| `idempotency_keys_pkey` | بروتوكول التكرار: إعادة الرد، أو `IDEMPOTENCY_KEY_REUSED`، أو `IDEMPOTENCY_IN_PROGRESS` |
| `offer_recipients_pkey` | لا خطأ: المستلم مضاف مسبقًا |

### 5.3 قيود CHECK المعروفة

| القيد | النتيجة |
|---|---|
| `users_phone_e164_check`، `customers_phone_e164_check` | `PHONE_INVALID` |
| `tickets_plate_digits_check` | `PLATE_INVALID` |
| `venues_code_check` | `VALIDATION_FAILED` (حقل `code`) |
| `ck_events_fee_zero_unless_per_vehicle`، `ck_events_per_vehicle_fee_positive`، `events_fee_halalas_check`، `ck_events_payment_methods` | `VALIDATION_FAILED` (حقول التسعير) |
| `ck_payments_no_pan` | `VALIDATION_FAILED` (حقل `pos_reference`: «أدخل رقم إيصال الجهاز فقط، لا رقم البطاقة») |
| `payments_amount_halalas_check` | `VALIDATION_FAILED` (حقل `amount_halalas`) |
| `ck_cycles_staff_requester`، `ck_tickets_voided_fields`، `ck_tickets_waiver_fields`، `ck_payments_reversal_fields` | `REASON_REQUIRED` |
| `ck_cash_handover_distinct_people` | `PERMISSION_DENIED` (`reason = self_handover`) |
| `ck_transfers_distinct_venues` | `VALIDATION_FAILED` (حقل `to_venue_id`) |
| `ck_users_can_drive_supervisor_only` | `VALIDATION_FAILED` (حقل `can_drive`) |
| بقية القيود (`ck_tasks_*`، `ck_offers_*`، `ck_tickets_delivered_fields`، `ck_tickets_paper_serial`، `ck_tickets_parked_holder`، `ck_tickets_fee_matches_payment_status`، `ck_duty_*`، `ck_claim_*`، `ck_cycles_closed_outcome`، `ck_cycles_whatsapp_requester`، `ck_customers_identifier`، `ck_users_secret_kind_by_role`، `ck_wa_messages_direction_status`، `link_codes_code_check`، ...) | `INTERNAL_ERROR`: يعني أن الكود سمح بحالة غير صالحة؛ سجل error باسم القيد |

القيود ذات المعنى التجاري تحمل أسماء صريحة `ck_*` و`uq_*` في `06_schema.sql`، أما قيود الأعمدة المفردة (`*_check`) والقيود الفريدة المضمنة (`*_key`) فأسماؤها مولّدة حتميًا من أسماء الجدول والأعمدة؛ أي ترحيل يغيّر تلك الأعمدة يجب أن يحافظ على الاسم أو يحدّث هذه الخريطة واختبارها في الوقت نفسه.

### 5.4 فئات SQLSTATE

| SQLSTATE | النتيجة |
|---|---|
| `23505` unique_violation | حسب اسم القيد (§5.1، §5.2)؛ غير المعروف ← `INTERNAL_ERROR` |
| `23514` check_violation | حسب §5.3 |
| `23503` foreign_key_violation | `RESOURCE_NOT_FOUND` (`details.resource`) إذا كان العمود من مدخلات الطلب (قيمة المفتاح في `detail` موجودة في معاملات المسار أو الاستعلام أو الجسم)؛ وإلا `INTERNAL_ERROR` (يُسجل خطأً باسم القيد) |
| `23502` not_null_violation | `INTERNAL_ERROR` (التحقق في zod فاته الحقل) |
| `40001` serialization_failure، `40P01` deadlock_detected | إعادة المعاملة كاملة تلقائيًا حتى 3 مرات بتأخير عشوائي 20–80 ms (القاموس §14ب)، ثم `SERVICE_UNAVAILABLE` (`retryable: true`) |
| `55P03` lock_not_available (`lock_timeout` = 3s) | لا يُعاد على الخادم: عند L0 (صف `idempotency_keys`) ← `IDEMPOTENCY_IN_PROGRESS`؛ غير ذلك ← `SERVICE_UNAVAILABLE` (`retryable: true`) |
| `57014` query_canceled (`statement_timeout` = 5s) | `SERVICE_UNAVAILABLE` |
| `08xxx` اتصال، `53xxx` موارد، `57P0x` إيقاف الخادم أو إنهاء الجلسة | `SERVICE_UNAVAILABLE` (`Retry-After: 2`) |
| قاعدة لا يمكن الوصول إليها بلا SQLSTATE: أخطاء المقبس التي ترفعها طبقة قاعدة البيانات (`ECONNREFUSED`، `ECONNRESET`، `EPIPE`…)، «Connection terminated unexpectedly»، مهلة الاتصال بالمجمّع (`DATABASE_CONNECT_TIMEOUT_MS`)، مهلة القراءة في العميل (مهلة الجملة + 2 ثانية)؛ و`55000` «not currently accepting connections» | `SERVICE_UNAVAILABLE` (`Retry-After: 2`) في الـHTTP ومصافحة `/ws` وإقرار النبضة؛ ورمز مقبس من خارج طبقة القاعدة (جسم طلب أُجهض) أو كائن خطأ HTTP ليس انقطاعًا لها (DEC-370، DEC-375) |

---

## 6. أخطاء مزود واتساب (Meta Cloud API)

الإرسال يتم في العامل (`job.wa_send`) لا في مسار الطلب، لذلك لا تظهر هذه الأخطاء غالبًا كردود HTTP بل كنتائج في `notification_attempts` و`notifications` و`whatsapp_messages`. الرموز في العمود الثاني **أمثلة** يجب مطابقتها مع مرجع أخطاء Meta الحالي وقت التنفيذ؛ الجدول التفصيلي وجدول التباعد وحدود الصلاحية الزمنية للرسائل في الملف 12.

| الفئة | أمثلة | `notification_attempts.outcome` | حالة الإشعار | الأثر | التنبيه |
|---|---|---|---|---|---|
| عابر من المزود | HTTP 5xx، مهلة شبكة، `1`، `2`، `131000`، `131016`، `133004` | `retryable_error` | `pending` مع `next_attempt_at` | لا شيء حتى استنفاد المحاولات، ثم `failed` | `wa_send_failed` بعد الاستنفاد |
| حدود المعدل العامة | HTTP 429، `4`، `80007`، `130429` | `retryable_error` | `pending` بتباعد أطول | إبطاء دلو الإرسال العام؛ استمرار طويل يجعل القناة `degraded` | تقني |
| حد الزوج (نفس العميل) | `131056` | `retryable_error` | `pending` بعد فاصل التباعد لكل مستلم | لا شيء | — |
| المستلم لا يمكن الوصول إليه | `131026` | `permanent_error` | `failed` | لـW-01: `tickets.wa_link_status = failed` وحدث `ticket.updated` يظهر في D-07 «تعذّر الإرسال — استخدم QR أو التذكرة الورقية»؛ لغيرها: قائمة الرسائل الفاشلة في S-02 | `wa_send_failed` |
| خارج نافذة الخدمة لرسالة جلسة | `131047` | `permanent_error` | `failed` | يخص ردود W-09 إلى W-12 فقط (الإشعارات كلها قوالب، DEC-10) | — |
| مشكلة قالب | `132000`، `132001`، `132005`، `132007`، `132012`، `132015` (موقوف)، `132016` (معطّل) | `permanent_error` | `failed` | تحديث حالة القالب بالمزامنة؛ `WA_TEMPLATE_NOT_APPROVED` في S-13 | `wa_send_failed` للإدارة |
| حمولة خاطئة (خلل برمجي) | `100`، `131008`، `131009`، `131051` | `permanent_error` | `failed` | سجل error مع اسم القالب والمعاملات (دون قيمها الحساسة) | تقني |
| مستوى الحساب/القناة | `190` (الرمز منتهٍ)، صلاحيات `10` و`200`–`299`، `368` (حظر سياسة)، `131031` (حساب مقفل)، `131042` (مشكلة دفع)، `133010` (رقم غير مسجل)؛ و`131048` (حد البلاغات) يجعلها `degraded` | — (لا تُستهلك محاولة) | تبقى `pending` | `whatsapp_channel.health_status = down` وإيقاف الإرسال؛ عند العودة يُعاد تقييم كل إشعار معلّق مقابل الحالة الحالية فيُرسل ما يعبر عن الحالة الآن فقط ويُعلَّم الباقي `skipped` (`superseded` أو `channel_down`) — المعمارية §14 | `wa_channel_down` (critical) للإدارة وكل المواقع |
| حدود التسويق | `131049`، `131050` | `permanent_error` | `failed` | يجب ألا تحدث مع قوالب UTILITY؛ حدوثها يستدعي مراجعة فئة القالب | تقني |

قواعد ملزمة:
1. لا يحوَّل أي خطأ مزود إلى إرسال من رقم آخر أو قناة أخرى (لا أرقام سائقين، المعمارية §5).
2. رسالة الجاهزية W-05 لا تُعاد بعد تجاوز `claim_codes.expires_at`؛ يُعرض للسائق إجراء «إرسال رمز جديد».
3. الحالة الأعلى رتبة (`status_rank`) لا تُخفَّض أبدًا عند وصول `sent` متأخر بعد `read`.

---

## 7. سلوك نقاط Webhook

| الحالة | الرد | الأثر |
|---|---|---|
| `GET /webhooks/whatsapp` و`hub.mode = subscribe` و`hub.verify_token` مطابق (مقارنة ثابتة الزمن) | 200 `text/plain` بقيمة `hub.challenge` | — |
| `GET` بغير ذلك | 403 `WA_WEBHOOK_VERIFY_FAILED` | سجل warn |
| `POST` جسم أكبر من 3 MB (يُقرأ خامًا، DEC-130) | 413 `PAYLOAD_TOO_LARGE` من محلل الجسم الخام قبل التوقيع | سجل warn؛ لا تخزين |
| `POST` دون `X-Hub-Signature-256` أو بتوقيع لا يطابق HMAC-SHA256 للجسم **الخام** بسر التطبيق | 401 `WA_WEBHOOK_SIGNATURE_INVALID` | لا يُخزن شيء؛ عدّاد مراقبة |
| `POST` بتوقيع صالح | `INSERT` في `whatsapp_inbound_events` (`ON CONFLICT (body_sha256) DO NOTHING`) ثم بعد الالتزام 200 بلا جسم (12 §6.2، DEC-130) — حتى للتسليم المكرر | جدولة `job.wa_process_inbound` |
| تعذّر الحفظ في قاعدة البيانات | 500 `INTERNAL_ERROR` أو 503 `SERVICE_UNAVAILABLE` — **لا 200 كاذب** (المعمارية §10)؛ Meta تعيد المحاولة | سجل error |

بعد الإقرار (ACK) لا تغيّر أخطاء المعالجة الرد: يعيد العامل المحاولة، وبعد الاستنفاد تصير الحالة `failed` مع تنبيه تقني. أما المحتوى غير الصالح تجاريًا فليس خطأ HTTP: رمز إجراء مجهول أو مرسل لا يطابق ← رد W-10 الإرشادي دون أي بيانات تذكرة؛ رمز مبطل أو منتهٍ أو بـ`link_version` قديم أو لتذكرة ملغاة ← W-09 (غير نشطة) دون إنشاء طلب؛ تذكرة مسلّمة للمالك الصحيح ← W-09 بالحالة فقط. زمن الإقرار المستهدف أقل من ثانية (تحقق التوقيع + إدراج واحد).

---

## 8. الانقطاع والبيانات القديمة وتعارض النسخ في الواجهة

1. **لا رد من الشبكة** ليس خطأ API: يظهر شريط D-15 «لا يوجد اتصال — آخر تحديث hh:mm» وتُعرض البيانات المخزنة كقديمة. أوامر تحتاج تأكيد الخادم (القبول، استلام المفتاح، بدء الإحضار، جاهزة، التسليم، التحصيل) تُعطَّل أثناء الانقطاع، ولا يُعرض نجاح متفائل أبدًا (المعمارية §14).
2. **مهلة أمر دون رد:** النتيجة مجهولة؛ يُعاد الطلب بنفس `Idempotency-Key` حتى 3 مرات (1 ثم 3 ثم 7 ثوانٍ). إن بقيت مجهولة: «تعذّر التأكد من التنفيذ» ثم `refetch` عند عودة الاتصال. لا يولَّد مفتاح جديد للفعل نفسه.
3. **إعادة الاتصال أو عودة التطبيق للواجهة أو حدث `sync.required`:** مزامنة كاملة عبر `GET /v1/me/home` قبل تمكين أي أمر.
4. **`VERSION_CONFLICT`:** في نموذج الاستلام تُجلب التذكرة وتبقى مدخلات المستخدم غير المحفوظة مع إبراز الحقول التي تغيرت، ثم يحفظ المستخدم بالنسخة الجديدة. في إجراءات المشرف يُجلب الكيان ويعيد المشرف بدء الإجراء بنفسه؛ لا تُعاد الأوامر تلقائيًا فوق عرض قديم.
5. **رموز العروض (`TASK_ALREADY_CLAIMED`، `OFFER_EXPIRED`، `OFFER_REVOKED`، `OFFER_NOT_FOUND`، `NOT_OFFER_RECIPIENT`، `NEXT_TASK_ALREADY_RESERVED`):** `remove-card` فورًا قبل أي رسالة، وأي خطأ على القبول يوقف الصوت.
6. **401:** `relogin`. **403:** `toast` ثم `refetch` لـ`GET /v1/me` لأن الصلاحيات أو التعيين قد تغيرت.
7. يظهر `request_id` تحت «تفاصيل» في كل رسالة خطأ لتسهيل الدعم.

---

## 9. التنفيذ

### 9.1 السجل المشترك

السجل نوع ثابت في الحزمة المشتركة `@point/shared` يُستخدم في الخادم (المرشّح) والواجهة (النصوص والمعالجة):

```ts
// packages/shared/src/errors/registry.ts
export type LogLevel = 'info' | 'warn' | 'error';
export interface ErrorDef { http: number; retryable: boolean; log: LogLevel; ar: string; en: string; alert?: AlertType }

export const ERRORS = {
  TASK_ALREADY_CLAIMED: { http: 409, retryable: false, log: 'info', ar: 'قبل الطلب سائق آخر.', en: 'Another driver accepted this request.' },
  HANDOVER_CODE_LOCKED: { http: 423, retryable: false, log: 'warn', ar: 'قُفل التحقق بعد محاولات خاطئة. اتصل بالمشرف.', en: 'Verification is locked after too many attempts.', alert: 'handover_code_locked' },
  // ... كل رموز §4 بلا استثناء
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof ERRORS;

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, public readonly details: Record<string, unknown> = {}) { super(code); }
}
```

### 9.2 مرشّح الاستثناءات (NestJS)

```ts
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest(); const res = host.switchToHttp().getResponse();
    const mapped = err instanceof DomainError ? err
      : isZodError(err) ? new DomainError('VALIDATION_FAILED', { fields: toFields(err) })
      : isPgError(err) ? mapPgError(err, req.route)          // جداول §5
      : new DomainError('INTERNAL_ERROR');
    const def = ERRORS[mapped.code];
    log(def.log, { request_id: req.id, code: mapped.code, http: def.http, user_id: req.actor?.userId, venue_id: req.actor?.dutyVenueId, route: req.route?.path });
    if (def.http === 429 || def.http === 503 || mapped.code === 'IDEMPOTENCY_IN_PROGRESS') res.setHeader('Retry-After', retryAfter(mapped));
    res.status(def.http).json({ error: { code: mapped.code, message: def.en, message_ar: def.ar, request_id: req.id, retryable: def.retryable, details: mapped.details } });
  }
}
```

### 9.3 الاتصال الفوري

رفض مصافحة `/ws` يرسل `connect_error` ببيانات `{ code }` من رموز الدخول (`AUTH_UNAUTHENTICATED`، `AUTH_SESSION_EXPIRED`، `AUTH_SESSION_REVOKED`)، أو `SERVICE_UNAVAILABLE` حين لا تُبلغ القاعدة (§5.4). ردود أحداث العميل (`client.heartbeat`، `client.offer_seen`) تستخدم الغلاف نفسه في دالة الإقرار، وإقرار النبضة أثناء انقطاع القاعدة `SERVICE_UNAVAILABLE`. إبطال الجلسة أثناء الاتصال يُرسل `session.revoked` بـ`reason` ثم يقطع الاتصال؛ ولا يُبطل جلسةَ مقبس إلا رفضٌ من رموز `AUTH_*`، فلا يقرأ الجهاز انقطاع القاعدة إبطالًا (DEC-370).

### 9.4 السجلات

سجلات منظمة (pino) بالحقول: `request_id`، `code`، `http`، `user_id`، `venue_id`، `route`، `duration_ms`. ممنوع تسجيل: أجسام الطلبات الكاملة، أرقام الجوال (تُجزّأ عند الحاجة)، رموز التسليم والربط والإجراء، كوكي الجلسة، روابط الصور الموقعة. أسماء Canon التي تصف رمزًا أو جوالًا دون أن تحمل قيمته (`code_expires_at`، `code_ttl_min`، `pin_length`، `reveal_phone_per_hour`، `action_token_ttl_h`) ليست رموزًا فلا تُنقَّح (05 §7.6، DEC-131).

---

## 10. قاعدة الاختبار

1. **لكل رمز اختبار واحد على الأقل** يصل إليه عبر مسار حقيقي (أو Webhook) ويتحقق من: حالة HTTP، `code`، `retryable`، مفاتيح `details`، وعدم وجود بيانات شخصية في الرد.
2. **اختبار عقد** يقارن السجل `ERRORS` بجدول القاموس §8: نفس المجموعة ونفس حالات HTTP، ويفشل البناء عند أي فرق.
3. **اختبار خريطة القيود**: لكل قيد في §5 حالة تطلقه (بالاستفادة من `06_schema_invariants_test.sql`) وتتحقق من الرمز الناتج.
4. **أخطاء المزود**: محاكي واتساب يعيد كل مثال في §6 ويُتحقق من `outcome` وحالة الإشعار والتنبيه وحالة القناة.
5. **اختبارات الواجهة** (Playwright على 360 و390 و430 بكسل): إزالة البطاقة وإيقاف الصوت عند `TASK_ALREADY_CLAIMED`، بقاء المدخلات عند `VERSION_CONFLICT` و`VALIDATION_FAILED`، إعادة التوجيه ومسح البيانات عند `AUTH_SESSION_REVOKED` بسبب النقل، النافذة الحاجبة عند `HANDOVER_CODE_LOCKED`.
6. **فحص التسريب**: مسح آلي لكل ردود الأخطاء في مجموعة الاختبارات للتأكد من خلوها من أرقام الجوال الكاملة ورموز التسليم والرموز المعتمة.
7. نصوص `message_ar` تُراجع لغويًا مرة قبل الإطلاق، وأي تعديل عليها يمر بمراجعة المنتج.

---

## 11. إضافات مقترحة للقاموس

| الاقتراح | السبب |
|---|---|
| رمز `PAYLOAD_TOO_LARGE` (413) | **اعتُمد** في Canon §8 وأضيف إلى §4.15 أعلاه |
| تسمية القيود الفريدة المضمنة صراحةً (`uq_*`) في `06_schema.sql` | **لم يُعتمد:** أسماء قيود `UNIQUE` المولّدة حتمية (`<الجدول>_<الأعمدة>_key`) ولا تتغير بترتيب الترحيل، فبقيت كما هي والخريطة في §5.2 صحيحة؛ أما قيود `CHECK` فصارت كلها بأسماء `ck_*` ثابتة في المخطط 1.2 |

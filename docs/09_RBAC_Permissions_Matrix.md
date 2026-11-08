# 09 — مصفوفة الصلاحيات والأمان (RBAC & Security)

الإصدار 1.0 — 27 أكتوبر 2026 — الحالة: معتمد للتنفيذ.

المرجع الملزم للأسماء: `00_Glossary_Canon.md` §4 (الأدوار)، §9 (المسارات)، §10 (الصلاحيات)، §12 (إعدادات الأمان). هذا الملف يفصّل شروط كل صلاحية، وربطها بكل مسار، والرؤية على مستوى الحقول، وغرف الاتصال الفوري، وخوارزمية التقييم، وسياسة الدخول والجلسات، وفصل المهام، والتدقيق، والخصوصية، ونموذج التهديدات، واختبارات الصلاحيات.

ملفات مرتبطة: `08_Error_Codes_Guide.md` (الرموز وترتيب الفحص)، `07_API_Contract.md`، `06_schema.sql`، `10_Dispatch_Engine_Spec.md` (ترتيب الأقفال)، `12_WhatsApp_Integration_Spec.md` (رموز الإجراء والربط)، `14_Notification_Matrix_Templates.md` (حمولات Push)، `DECISIONS.md` (DEC-09، DEC-22، DEC-23، DEC-29، DEC-35، DEC-36، DEC-38، DEC-39).

---

## 1. المبادئ

1. **الرفض افتراضيًا:** كل مسار يعلن صلاحية واحدة بالمزخرف `@RequirePermission(...)` أو يُعلَّم صراحةً `@Public()`؛ اختبار في CI يفشل إذا وُجد مسار بلا أي منهما.
2. **الخادم وحده يحكم:** إخفاء الأزرار في الواجهة تجربة استخدام لا حماية (المعمارية §3).
3. **أقل صلاحية وأقل بيانات:** كل دور يرى أقل الحقول اللازمة لعمله (§5).
4. **النطاق أولًا بالمؤسسة ثم بالموقع:** كل استعلام يقيّد `org_id` ومجموعة مواقع الفاعل الفعلية.
5. **عدم الكشف:** المورد خارج النطاق يُرد عليه بـ404 لا 403 (الملف 08 §1.3).
6. **إعادة التحقق داخل المعاملة:** شروط الفاعل تُعاد بعد أخذ الأقفال لتفادي TOCTOU (§8.4).
7. **كل إجراء حساس يُدقق بسبب** (§11)، وسجل التدقيق إلحاقي لا يُعدَّل.
8. **فصل المهام:** لا أحد يمنح نفسه صلاحية، والموافقة الذاتية مقيدة ومعلَّمة (§10).

---

## 2. الأدوار والنطاقات والفاعلون

| الدور | من هو | النطاق الفعلي | كيف يُنشأ | التحقق الثنائي |
|---|---|---|---|---|
| `owner` | المالك | المؤسسة كاملة (صف `role_scopes` بنوع `org` نشط) | أداة التهيئة عند التثبيت فقط، لا عبر الـAPI: `node api/dist/cli.js create-owner` (DEC-302) | إلزامي |
| `admin` | الإدارة | المؤسسة كاملة (صف `org` نشط) | المالك عبر `POST /v1/staff` | إلزامي |
| `supervisor` | المشرف | المواقع التي لديه عليها صفوف `role_scopes` بنوع `venue` نشطة | المالك أو الإدارة عبر `POST /v1/staff` ثم `POST /v1/staff/{userId}/scopes` | مفعّل افتراضيًا (`security.supervisor_mfa_required = true`) |
| `driver` | السائق | موقع تعيينه النشط فقط (`driver_assignments.status = active`) | الإدارة أو المالك عبر `POST /v1/drivers` | لا؛ رقم سري 6 أرقام |
| فاعل `system` | العامل والمؤقتات ومعالج Webhook | حسب الحدث | — | — |
| فاعل `customer` | صاحب المركبة على واتساب | تذكرته فقط عبر رمز إجراء مربوط بمعرّفه على واتساب (`wa_id` أو `wa_user_id`، DEC-35) | — | — |

قواعد:
1. المالك والإدارة لا يصلون إلى أي بيانات دون صف نطاق `org` نشط؛ سحبه يجمّد وصولهم دون حذف الحساب.
2. المشرف الذي `can_drive = true` يكتسب صلاحيات القيادة المعلّمة D* في القاموس §10 (`duty.self`، `ticket.intake`، `offer.accept`، `task.execute`، `handover.verify`، `payment.record`) **فقط** أثناء مناوبة مفتوحة في موقع ضمن نطاقه، ويدخل التوزيع كأي سائق (DEC-22).
3. فاعل `system` لا يمر عبر حراس HTTP، لكنه يستدعي نفس معالجات الأوامر بسياق صريح `actor_type = system` وقدرات داخلية محددة لكل مهمة، ويُسجل في التدقيق بنفس الطريقة.
4. فاعل `customer` لا يملك جلسة ولا يصل للـAPI؛ كل ما يستطيعه طلب سيارته عبر زر «طلب السيارة» (رمز إجراء صالح + معرّف واتساب مطابق + `link_version` حالي) واستلام الرسائل.

سياق الفاعل الذي تبنيه طبقة المصادقة لكل طلب:

```ts
interface ActorContext {
  userId: string; orgId: string; sessionId: string; deviceId?: string;
  role: 'owner' | 'admin' | 'supervisor' | 'driver';
  canDrive: boolean;                              // supervisors only
  orgScope: boolean;                              // owner/admin with an active org scope row
  venueIds: ReadonlySet<string>;                  // effective venues (see below)
  assignment?: { id: string; venueId: string };   // drivers: the single active assignment
  duty?: { sessionId: string; venueId: string; poolId: string; status: 'on_duty' | 'on_break' };
  mfaVerified: boolean;
}
```

مجموعة المواقع الفعلية `venueIds`: المالك والإدارة ← كل مواقع المؤسسة (بشرط `orgScope`)؛ المشرف ← نطاقاته النشطة؛ السائق ← موقع تعيينه النشط أو مجموعة فارغة. للمشرف القائد يجب أن يكون موقع مناوبته ضمن نطاقاته.

---

## 3. مصفوفة الصلاحيات الموسعة

الرموز: ✓ مسموح · — ممنوع · D* المشرف بشرط `can_drive` وأثناء مناوبته. الأعمدة الأربعة مطابقة حرفيًا للقاموس §10؛ عمود الشروط يفصّل ما يفحصه الخادم.

| الصلاحية | O | A | S | D | شرط النطاق والحالة (على الخادم) | التدقيق |
|---|---|---|---|---|---|---|
| `auth.self` | ✓ | ✓ | ✓ | ✓ | حسابه وجلسته وأجهزته فقط | أحداث الدخول والخروج وتغيير السر وMFA |
| `duty.self` | — | — | D* | ✓ | السائق: تعيين نشط؛ المشرف: `can_drive` + نطاق الموقع؛ الوردية `open` في مجموعة التوزيع شرط لبدء المناوبة وحده (`POST /v1/me/duty/start`)، والقراءة (`GET /v1/me/home`) تعمل دونها | بدء وإنهاء واستراحة |
| `ticket.intake` | — | — | D* | ✓ | مناوبة `on_duty` في موقع الحفل والحفل `open`؛ لمنشئ التذكرة فقط (مكلّف مهمة `park` الجارية): التعديل والإرسال في `received`، ورفع الصور في `received` أو `parking` (إكمال الناقص؛ وإتمام الرفع لرافعه في أي حالة، ومسارا الصور لا يفحصان المناوبة ولا الحفل المفتوح: DEC-103، DEC-104)، وتحويل القناة إلى ورقية في `parking` بـ`channel = paper` و`paper_serial` فقط والتذكرة غير مربوطة (DEC-40) | `ticket_events` |
| `ticket.read_minimal` | ✓ | ✓ | ✓ | ✓ | السائق: تذاكر موقع تعيينه **المفتوحة** فقط بحقول `TicketSummary`؛ المشرف: مواقع نطاقه بكل الحالات؛ المالك والإدارة: المؤسسة | — |
| `ticket.read_full` | ✓ | ✓ | ✓ | ✓ | السائق: المكلّف بمهمة مفتوحة على التذكرة، أو منشئها أثناء `received`/`parking` | — |
| `ticket.read_photos` | ✓ | ✓ | ✓ | ✓ | شرط `ticket.read_full` نفسه؛ روابط موقعة قصيرة (§6) | سجل تقني لإصدار الرابط |
| `ticket.reveal_phone` | ✓ | ✓ | ✓ | — | تذكرة ضمن النطاق + سبب إلزامي + حد معدل لكل مستخدم (§11) | تدقيق إلزامي دون قيمة الرقم |
| `ticket.change_phone` | — | ✓ | ✓ | ✓ | السائق: منشئ التذكرة أو المكلّف بمهمة مفتوحة عليها، أثناء المناوبة، مع إقرار «العميل أمامي» وسبب؛ يرفع `tickets.link_version` ويبطل رموز الإجراء السابقة | تدقيق (القيم مقنّعة) |
| `ticket.discard_empty_draft` | — | — | — | ✓ | مسودته `received` الخالية من أي بيانات مركبة أو عميل أو صور (DEC-20) | `ticket_events` |
| `ticket.void` | — | ✓ | ✓ | — | سبب؛ التذكرة `received` أو `parking` فقط (DEC-45؛ بعد `parked` تُصحَّح بالمطابقة اليدوية)؛ لا عهدة غير محسومة | تدقيق |
| `ticket.inspection_exception` | — | — | ✓ | — | `inspection_status = incomplete` + سبب | تدقيق |
| `ticket.repark` | — | — | ✓ | — | التذكرة `ready` + سبب (غياب العميل) | تدقيق |
| `ticket.custody_transfer` | — | — | ✓ | — | سبب + تحديد الحائز اللاحق (`to_holder_*`)؛ الحائز السابق يستنتجه الخادم من الحائز الحالي على التذكرة | تدقيق + `custody_events` |
| `ticket.manual_reconcile` | — | ✓ | ✓ | — | بعد انقطاع فقط؛ دليل (رقم السجل الورقي) + سبب؛ لا يشغّل أوامر مؤجلة ولا يرسل تنبيهات قديمة (المعمارية §14) | تدقيق |
| `wa.link` | — | — | ✓ | ✓ | السائق: مناوبة في موقع التذكرة؛ التذكرة غير مغلقة | `ticket_events` |
| `retrieval.request_on_behalf` | — | — | ✓ | ✓ | سبب إلزامي؛ تذكرة في موقع الفاعل بحالة `parked` فقط (DEC-25)؛ السائق أثناء المناوبة | تدقيق |
| `retrieval.cancel` | — | — | ✓ | ✓ | السائق: قبل الإسناد فقط (التذكرة `requested`)؛ المشرف: قبل بدء الحركة يُلغى الطلب وتعود التذكرة `parked`، وبعد بدء الحركة يطبَّق DEC-30 (تحويل إلى `reparking` مع السائق نفسه دون تحريره أو محو العهدة)؛ سبب؛ إن استُلم المفتاح قبل الحركة يلزم `release-custody` أولًا | تدقيق |
| `offer.accept` | — | — | D* | ✓ | مستلم في جولة العرض النشطة، أثناء المناوبة في مجموعة العرض؛ حارس الأولوية (الملف 10) | `offer_recipients` |
| `task.execute` | — | — | D* | ✓ | `tasks.assignee_id` = الفاعل؛ أثناء المناوبة | `ticket_events` |
| `task.release_custody` | — | — | ✓ | ✓ | السائق المكلّف (حائز المفتاح) أو مشرف الموقع | `custody_events` + تدقيق للمشرف |
| `task.reassign` | — | — | ✓ | — | سبب؛ قبل بدء الحركة؛ تحقق العهدة | تدقيق |
| `handover.verify` | — | — | D* | ✓ | المكلّف بمهمة الإحضار والتذكرة `ready` | `ticket_events` |
| `handover.resend_code` | — | — | ✓ | ✓ | المكلّف أو المشرف؛ التذكرة `ready` ومربوطة بواتساب؛ ضمن `handover.max_resends` | `ticket_events` |
| `handover.exception` | — | — | ✓ | — | التذكرة `ready`؛ طريقة تحقق الهوية الموثقة + سبب | تدقيق إلزامي |
| `payment.record` | — | — | D* | ✓ | المكلّف عند التسليم و`payment_status = due` | `payments` + تدقيق |
| `payment.reverse` | — | ✓ | ✓ | — | تحصيل `recorded` + سبب | تدقيق إلزامي |
| `payment.waive` | — | — | ✓ | — | `payment_status = due` + سبب | تدقيق إلزامي |
| `cash.handover_confirm` | — | ✓ | ✓ | — | المستلم هو الفاعل وليس السائق نفسه (`ck_cash_handover_distinct_people`)؛ حفل ضمن النطاق؛ الإدارة احتياطًا حين يكون المشرف الوحيد سائقًا | تدقيق |
| `event.manage` | ✓ | ✓ | ✓ | — | المشرف: مواقع نطاقه | تدقيق للفتح والإغلاق والإلغاء |
| `shift.manage` | ✓ | ✓ | ✓ | — | المشرف: مواقع نطاقه | تدقيق |
| `duty.force_end` | — | — | ✓ | — | سبب؛ يُرفض إذا كان بعهدة السائق مركبة أو مفتاح أو لديه مهمة `in_progress` أو مهمة صف/إعادة صف نشطة (DEC-32، لا تجاوز)؛ المهمة التالية المحجوزة ومهمة الإحضار المقبولة قبل استلام المفتاح تعودان للطابور بأولويتهما | تدقيق |
| `venue.read` | ✓ | ✓ | ✓ | — | المشرف: مواقع نطاقه | — |
| `venue.manage` | ✓ | ✓ | — | — | — | تدقيق |
| `venue.layout_read` | ✓ | ✓ | ✓ | ✓ | السائق: مناطق ومواقف ولوحات وخانات موقع تعيينه النشط مع حالة الإشغال فقط دون كشف التذكرة الشاغلة (لإتمام الصف D-08، DEC-33) | — |
| `driver.read` | ✓ | ✓ | ✓ | — | المشرف: السائقون المعيّنون أو المناوبون في مواقع نطاقه | — |
| `driver.manage` | ✓ | ✓ | — | — | إنشاء وتعديل وتعطيل وتفعيل وإعادة تعيين السر؛ التعطيل مرفوض إذا كان بعهدة السائق مركبة أو مفتاح أو لديه مهمة `in_progress` أو مهمة صف/إعادة صف نشطة (DEC-32، لا تجاوز)؛ المهمة التالية ومهمة الإحضار المقبولة قبل استلام المفتاح تعودان للطابور | تدقيق |
| `driver.assign` | ✓ | ✓ | ✓ | — | المشرف: الموقع الهدف ضمن نطاقه؛ للسائق بلا تعيين نشط | تدقيق |
| `driver.transfer` | ✓ | ✓ | ✓ | — | المشرف: نطاق الموقعين معًا (`TRANSFER_SCOPE_DENIED`)؛ لا مركبة ولا مفتاح ولا مهمة `in_progress` ولا مهمة صف/إعادة صف نشطة (DEC-32، لا تجاوز)؛ المهمة التالية المحجوزة ومهمة الإحضار المقبولة قبل استلام المفتاح لا تمنعان النقل وتعودان للطابور بأولويتهما؛ الفوري الممنوع يرد 409 دون إنشاء سجل، والمجدول يصبح `blocked` عند تفعيله مع تنبيه `transfer_blocked` | تدقيق إلزامي |
| `staff.manage` | ✓ | ✓ | — | — | الإدارة تدير المشرفين فقط؛ المالك يدير الإدارة والمشرفين؛ إعادة ضبط MFA (`POST /v1/staff/{userId}/reset-mfa`) للمالك فقط؛ لا أحد يعدّل نفسه | تدقيق |
| `alert.read` | ✓ | ✓ | ✓ | — | مواقع النطاق | — |
| `alert.manage` | ✓ | ✓ | ✓ | — | مواقع النطاق | من أقر ومن حل |
| `incident.read` | ✓ | ✓ | ✓ | — | مواقع النطاق | — |
| `incident.create` | — | ✓ | ✓ | ✓ | السائق: لتذاكر موقعه | تدقيق |
| `incident.manage` | — | ✓ | ✓ | — | مواقع النطاق | تدقيق |
| `report.read` | ✓ | ✓ | ✓ | — | مواقع النطاق؛ الجوالات مقنّعة دائمًا | — |
| `export.create` | ✓ | ✓ | ✓ | — | فلاتر ضمن النطاق؛ الجوالات مقنّعة؛ لا صور؛ حد صفوف 50 000 صف للملف وفئة المعدل `export` (5 في الساعة لكل مستخدم، 07 §1.9) (DEC-289، DEC-292)؛ النوع `audit` يتطلب `audit.read` أيضًا | تدقيق إلزامي للإنشاء والتنزيل |
| `audit.read` | ✓ | ✓ | — | — | المؤسسة | قراءة السجل نفسها تُسجل: صف تدقيق `audit.read` بالمرشحات والعدد (DEC-168) |
| `wa.channel_read` | ✓ | ✓ | — | — | مراجع الأسرار فقط، لا قيمها | — |
| `wa.channel_manage` | ✓ | — | — | — | قناة فعالة واحدة | تدقيق |
| `wa.templates_manage` | ✓ | ✓ | — | — | — | تدقيق |
| `outbox.manage` | ✓ | ✓ | — | — | الحمولات منقّحة؛ لا أسرار في `outbox_events` أصلًا (DEC-38) | تدقيق لإعادة المحاولة |
| `retention.manage` | ✓ | — | — | — | — | تدقيق |
| `org.settings_manage` | ✓ | — | — | — | إعدادات المؤسسة `security.*` و`heartbeat.*` فقط (DEC-39)؛ تُتحقق بمخطط zod؛ `security.pin_length` ثابت (6) وليس قابلًا للتعديل (DEC-09) | تدقيق إلزامي (قبل/بعد) |
| `telemetry.write` | ✓ | ✓ | ✓ | ✓ | بيانات قياس بلا معلومات شخصية؛ حد معدل (120 حدثًا في الدقيقة لكل مستخدم وجهاز، DEC-148)؛ ليس أمرًا: بلا `Idempotency-Key` (DEC-149) | — (بلا صف تدقيق، DEC-149) |

بيانات الإعداد التي يحتاجها السائق دون صلاحيات إدارة: تخطيط الموقع (المناطق والمواقف واللوحات والخانات مع الإشغال) عبر `venue.layout_read` لشاشة D-08، والحفلات المفتوحة لاختيار الحفل في D-05 ضمن الحقل `open_events` في رد `GET /v1/me/home` (الملف 07). لا يحصل السائق على `venue.read` ولا `event.manage`.

---

## 4. ربط المسارات بالصلاحيات

يغطي كل مسار في القاموس §9. عمود «الفحوص الإضافية» يُنفَّذ في المعالج بعد الحارس، وعمود «رمز الرفض الأبرز» هو أكثر رد متوقع عند فشل الشرط (القائمة الكاملة في الملف 08).

### 4.1 الدخول والجلسة والجهاز

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `POST /v1/auth/login` | عام | ترويسة CSRF؛ حد معدل لكل IP ولكل حساب؛ رد واحد لعدم وجود الحساب ولخطأ السر | `AUTH_INVALID_CREDENTIALS` |
| `POST /v1/auth/mfa/verify` | عام برمز `mfa_token` صالح 5 دقائق | يُحتسب في حد القفل | `AUTH_MFA_INVALID` |
| `POST /v1/auth/mfa/setup` | `auth.self` | مسموح لجلسة لم تُكمل MFA | — |
| `POST /v1/auth/mfa/confirm` | `auth.self` | رمز صحيح من السر الجديد | `AUTH_MFA_INVALID` |
| `POST /v1/auth/secret/change` | `auth.self` | السر الحالي أو المؤقت؛ قواعد السر (§9)؛ يبطل الجلسات الأخرى | `AUTH_INVALID_CREDENTIALS` |
| `POST /v1/auth/logout` | `auth.self` | يبطل الجلسة الحالية فقط | — |
| `GET /v1/me` | `auth.self` | — | — |
| `GET /v1/me/home` | `duty.self` | يعمل خارج المناوبة ويعيد `off_duty`، ولا يشترط وردية مفتوحة؛ يتطلب تعيينًا نشطًا (أو نطاقًا للمشرف القائد) | `ASSIGNMENT_REQUIRED` |
| `POST /v1/me/devices` | `auth.self` | يربط الجهاز بالمستخدم والجلسة | — |
| `PUT /v1/me/devices/{deviceId}` | `auth.self` | الجهاز ملك الفاعل وإلا 404 | `RESOURCE_NOT_FOUND` |
| `POST /v1/me/audio-test` | `auth.self` | — | — |
| `POST /v1/me/duty/start` | `duty.self` | تعيين نشط أو نطاق + وردية مفتوحة + لا مناوبة مفتوحة | `SHIFT_NOT_OPEN` |
| `POST /v1/me/duty/break` | `duty.self` | لا مهام ولا عهدة لبدء الاستراحة | `DRIVER_NOT_AVAILABLE` |
| `POST /v1/me/duty/end` | `duty.self` | لا عهدة ولا مهمة مفتوحة أو تالية ولا مسودة (أشد من الإنهاء القسري، DEC-32) | `DUTY_END_BLOCKED_CUSTODY` |
| `POST /v1/me/heartbeat` | `auth.self` | — | — |

### 4.2 الاستلام والتذاكر

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `POST /v1/tickets` | `ticket.intake` | الحفل `open` في موقع المناوبة؛ السائق بلا حركة نشطة تحت قفل المجموعة | `MOVEMENT_IN_PROGRESS` |
| `POST /v1/tickets/intake-pass` | `ticket.intake` | الإصدار الثاني (O-01، V2-013، DEC-500): نطاق `POST /v1/tickets` نفسه (مناوبة في الموقع، المشغل غير معلّق)، ومسودته `received` التي أنشأها هو إن سمّاها؛ بطاقة دخول صالحة لحساب نشط | `PASS_INVALID` |
| `PATCH /v1/tickets/{ticketId}/intake` | `ticket.intake` | منشئ التذكرة؛ الحالة `received` (كل الحقول) أو `parking` بـ`channel = paper` و`paper_serial` فقط والتذكرة غير مربوطة (DEC-40)؛ `expected_version` | `PERMISSION_DENIED` |
| `POST /v1/tickets/{ticketId}/media` | `ticket.intake` | منشئ التذكرة؛ الحالة `received` أو `parking` (إكمال الصور الناقصة) | `PERMISSION_DENIED` |
| `POST /v1/media/{mediaId}/complete` | `ticket.intake` | رافع الوسائط نفسه | `RESOURCE_NOT_FOUND` |
| `GET /v1/media/{mediaId}/url` | `ticket.read_photos` | شرط `ticket.read_full` على تذكرة الوسائط | `RESOURCE_NOT_FOUND` |
| `POST /v1/tickets/{ticketId}/submit-intake` | `ticket.intake` | منشئ المسودة؛ الحالة `received` | `INTAKE_INCOMPLETE` |
| `POST /v1/tickets/{ticketId}/discard-draft` | `ticket.discard_empty_draft` | منشئها؛ المسودة فارغة | `DRAFT_HAS_DATA` |
| `POST /v1/tickets/{ticketId}/void` | `ticket.void` | النطاق؛ سبب؛ التذكرة `received` أو `parking` (DEC-45)؛ العهدة محسومة | `CUSTODY_OPEN` |
| `POST /v1/tickets/{ticketId}/inspection-exception` | `ticket.inspection_exception` | `inspection_status = incomplete`؛ سبب | `INVALID_STATE_TRANSITION` |
| `POST /v1/tickets/{ticketId}/whatsapp-link` | `wa.link` | مناوبة في موقع التذكرة؛ القناة سليمة؛ موافقة للإرسال المباشر | `WA_CHANNEL_UNAVAILABLE` |
| `POST /v1/tickets/{ticketId}/whatsapp-link/confirm` | `wa.link` | رمز ربط بانتظار التأكيد؛ نفس السائق المنشئ أو مشرف الموقع | `WA_LINK_CODE_EXPIRED` |
| `PATCH /v1/tickets/{ticketId}/customer-phone` | `ticket.change_phone` | السائق منشئ أو مكلّف؛ سبب؛ `expected_version` | `PERMISSION_DENIED` |
| `POST /v1/tickets/{ticketId}/reveal-phone` | `ticket.reveal_phone` | النطاق؛ سبب؛ حد المعدل | `REASON_REQUIRED` |
| `GET /v1/tickets` | `ticket.read_minimal` | السائق: موقعه وتذاكره المفتوحة فقط ولا يقبل `venue_id` آخر | `SCOPE_VENUE_DENIED` |
| `GET /v1/tickets/{ticketId}` | `ticket.read_minimal` (+ `ticket.read_full` للحقول) | الحقول حسب §5 | `TICKET_NOT_FOUND` |
| `GET /v1/tickets/{ticketId}/timeline` | `ticket.read_full` | السائق: خطوات مهمته فقط دون رسائل العميل | `TICKET_NOT_FOUND` |

### 4.3 الصف والاسترجاع والتسليم

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `POST /v1/tasks/{taskId}/complete-parking` | `task.execute` | المكلّف؛ مهمة `park` أو `repark` بحالة `in_progress`؛ الحائز | `NOT_TASK_ASSIGNEE` |
| `POST /v1/tickets/{ticketId}/retrievals` | `retrieval.request_on_behalf` | التذكرة `parked` (DEC-25)؛ لا دورة مفتوحة؛ سبب؛ السائق أثناء المناوبة | `TICKET_NOT_PARKED` / `RETRIEVAL_ALREADY_ACTIVE` |
| `POST /v1/retrieval-cycles/{cycleId}/cancel` | `retrieval.cancel` | السائق قبل الإسناد فقط؛ المشرف قبل الحركة، وبعدها يُطبَّق DEC-30؛ سبب؛ المفتاح المستلَم يُعاد أولًا | `CUSTODY_RELEASE_REQUIRED` |
| `POST /v1/task-offers/{offerId}/accept` | `offer.accept` | مستلم؛ جولة نشطة؛ مناوبة في مجموعة العرض؛ حارس الأولوية | `TASK_ALREADY_CLAIMED` |
| `POST /v1/tasks/{taskId}/key-pickup` | `task.execute` | المكلّف؛ المهمة `accepted` | `TASK_NOT_STARTABLE` |
| `POST /v1/tasks/{taskId}/start-retrieval` | `task.execute` | المكلّف؛ المفتاح بعهدته | `KEY_NOT_PICKED_UP` |
| `POST /v1/tasks/{taskId}/ready` | `task.execute` | المكلّف؛ المهمة `in_progress` | `INVALID_STATE_TRANSITION` |
| `POST /v1/tickets/{ticketId}/handover` | `handover.verify` | المكلّف؛ التذكرة `ready`؛ الرمز أو الكعب؛ التحصيل | `HANDOVER_CODE_INVALID` |
| `POST /v1/tickets/{ticketId}/handover-code/resend` | `handover.resend_code` | المكلّف أو المشرف؛ `ready`؛ مربوطة بواتساب | `RESEND_LIMIT_REACHED` |
| `POST /v1/tickets/{ticketId}/handover-exception` | `handover.exception` | مشرف النطاق؛ `ready`؛ تحقق هوية + سبب | `HANDOVER_NOT_READY` |
| `POST /v1/tasks/{taskId}/reassign` | `task.reassign` | قبل الحركة؛ تحقق العهدة؛ سبب | `REASSIGN_BLOCKED_MOVEMENT` |
| `POST /v1/tasks/{taskId}/release-custody` | `task.release_custody` | المكلّف حائز المفتاح أو المشرف | `CUSTODY_HOLDER_MISMATCH` |
| `POST /v1/tickets/{ticketId}/repark` | `ticket.repark` | التذكرة `ready`؛ سبب | `INVALID_STATE_TRANSITION` |
| `POST /v1/tickets/{ticketId}/custody-transfers` | `ticket.custody_transfer` | سبب؛ الجسم يحدد الحائز الجديد فقط والمصدر هو الحائز الحالي على التذكرة (يستنتجه الخادم)؛ الحائز الجديد غير الحالي | `CUSTODY_HOLDER_MISMATCH` |
| `POST /v1/tickets/{ticketId}/manual-reconcile` | `ticket.manual_reconcile` | سبب + دليل | `REASON_REQUIRED` |

### 4.4 التحصيل

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `POST /v1/tickets/{ticketId}/payments` | `payment.record` | المكلّف؛ `payment_status = due`؛ المبلغ والوسيلة | `PAYMENT_AMOUNT_MISMATCH` |
| `POST /v1/payments/{paymentId}/reverse` | `payment.reverse` | النطاق؛ سبب | `PAYMENT_ALREADY_REVERSED` |
| `POST /v1/tickets/{ticketId}/payment-waiver` | `payment.waive` | `payment_status = due`؛ سبب | `PAYMENT_ALREADY_RECORDED` |
| `POST /v1/cash-handovers` | `cash.handover_confirm` | المستلم ≠ السائق؛ الحفل ضمن النطاق | `PERMISSION_DENIED` |
| `GET /v1/events/{eventId}/settlement` | `report.read` | النطاق | `RESOURCE_NOT_FOUND` |

### 4.5 المواقع والحفلات والورديات

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `GET /v1/venues` | `venue.read` | يعيد مواقع النطاق فقط | — |
| `POST /v1/venues` | `venue.manage` | — | `VALIDATION_FAILED` |
| `GET /v1/venues/{venueId}` | `venue.read` | النطاق | `SCOPE_VENUE_DENIED` |
| `PATCH /v1/venues/{venueId}` | `venue.manage` | `expected_version` | `VERSION_CONFLICT` |
| `GET /v1/venues/{venueId}/settings` | `venue.read` | النطاق | `SCOPE_VENUE_DENIED` |
| `PUT /v1/venues/{venueId}/settings` | `venue.manage` | تحقق zod لمفاتيح القاموس §12 | `VALIDATION_FAILED` |
| `GET /v1/venues/{venueId}/public-profile` | `venue.manage` | موقع من المؤسسة (نطاق المؤسسة)؛ غيره كغير الموجود | `RESOURCE_NOT_FOUND` |
| `PUT /v1/venues/{venueId}/public-profile` | `venue.manage` | موقع من المؤسسة، `expected_version`، ليس مخفيًا من المنصة | `VERSION_CONFLICT` |
| `POST /v1/venues/{venueId}/public-profile/photos` | `venue.manage` | موقع من المؤسسة | `RESOURCE_NOT_FOUND` |
| `POST /v1/venues/{venueId}/public-profile/submit` | `venue.manage` | موقع من المؤسسة، `draft` مكتمل | `INVALID_STATE_TRANSITION` |
| `GET /v1/venues/{venueId}/dispatch-pools` | `venue.read` | النطاق | — |
| `POST /v1/venues/{venueId}/dispatch-pools` | `venue.manage` | مجموعة افتراضية واحدة | `VALIDATION_FAILED` |
| `PATCH /v1/dispatch-pools/{poolId}` | `venue.manage` | — | `VALIDATION_FAILED` |
| `GET /v1/venues/{venueId}/parking-zones` | `venue.layout_read` | النطاق؛ السائق: موقع تعيينه النشط فقط | `SCOPE_VENUE_DENIED` |
| `POST /v1/venues/{venueId}/parking-zones` | `venue.manage` | — | `VALIDATION_FAILED` |
| `PATCH /v1/parking-zones/{zoneId}` | `venue.manage` | — | `VALIDATION_FAILED` |
| `GET /v1/venues/{venueId}/parking-spots` | `venue.layout_read` | النطاق؛ السائق: موقع تعيينه فقط، مع الإشغال دون كشف التذكرة الشاغلة | `SCOPE_VENUE_DENIED` |
| `POST /v1/venues/{venueId}/parking-spots` | `venue.manage` | الإنشاء الجماعي يرفض المكرر | `VALIDATION_FAILED` |
| `PATCH /v1/parking-spots/{spotId}` | `venue.manage` | لا يُعطَّل موقف مشغول | `PARKING_SPOT_OCCUPIED` |
| `GET /v1/venues/{venueId}/key-boards` | `venue.layout_read` | النطاق؛ السائق: موقع تعيينه فقط، الخانات مع الإشغال | `SCOPE_VENUE_DENIED` |
| `POST /v1/venues/{venueId}/key-boards` | `venue.manage` | — | `VALIDATION_FAILED` |
| `POST /v1/key-boards/{boardId}/slots` | `venue.manage` | — | `VALIDATION_FAILED` |
| `PATCH /v1/key-slots/{slotId}` | `venue.manage` | لا تُعطَّل خانة مشغولة | `KEY_SLOT_OCCUPIED` |
| `GET /v1/venues/{venueId}/events` | `event.manage` | النطاق (السائق يأخذ الحفلات المفتوحة من `GET /v1/me/home`) | `SCOPE_VENUE_DENIED` |
| `POST /v1/venues/{venueId}/events` | `event.manage` | الموقع ضمن النطاق | `SCOPE_VENUE_DENIED` |
| `GET /v1/events/{eventId}` | `event.manage` | النطاق | `RESOURCE_NOT_FOUND` |
| `PATCH /v1/events/{eventId}` | `event.manage` | `expected_version`؛ غير مغلق | `EVENT_ALREADY_CLOSED` |
| `POST /v1/events/{eventId}/open` | `event.manage` | الحالة `draft`، أو `closing` لإعادة الفتح؛ مجموعة التوزيع نشطة (DEC-117) | `INVALID_STATE_TRANSITION` |
| `POST /v1/events/{eventId}/start-closing` | `event.manage` | الحالة `open` | `INVALID_STATE_TRANSITION` |
| `GET /v1/events/{eventId}/reconciliation` | `event.manage` | النطاق | — |
| `POST /v1/events/{eventId}/close` | `event.manage` | لا عناصر مفتوحة | `EVENT_CLOSE_BLOCKED` |
| `POST /v1/events/{eventId}/cancel` | `event.manage` | سبب؛ الحالة `draft` أو `open` ولا تذاكر فيه غير الملغاة (`voided`) | `INVALID_STATE_TRANSITION` |
| `GET /v1/events/{eventId}/operations` | `alert.read` | النطاق | `RESOURCE_NOT_FOUND` |
| `GET /v1/venues/{venueId}/shifts` | `shift.manage` | النطاق | — |
| `POST /v1/venues/{venueId}/shifts` | `shift.manage` | النطاق | `SCOPE_VENUE_DENIED` |
| `POST /v1/shifts/{shiftId}/open` | `shift.manage` | وردية مفتوحة واحدة لكل مجموعة | `SHIFT_ALREADY_OPEN` |
| `POST /v1/shifts/{shiftId}/close` | `shift.manage` | لا سائق في الوردية بعهدته مركبة أو مفتاح أو لديه مهمة مفتوحة (`details.blocking_drivers`)؛ بقية المناوبات المفتوحة تُنهى آليًا (`end_reason = shift_closed`) | `SHIFT_CLOSE_BLOCKED` |

### 4.6 السائقون والموظفون

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `GET /v1/drivers` | `driver.read` | المشرف: سائقو مواقعه | — |
| `POST /v1/drivers` | `driver.manage` | جوال ورمز موظف فريدان | `VALIDATION_FAILED` |
| `GET /v1/drivers/{driverId}` | `driver.read` | النطاق | `RESOURCE_NOT_FOUND` |
| `PATCH /v1/drivers/{driverId}` | `driver.manage` | `expected_version` | `VERSION_CONFLICT` |
| `POST /v1/drivers/{driverId}/disable` | `driver.manage` | سبب؛ لا مركبة ولا مفتاح ولا مهمة `in_progress` أو صف/إعادة صف نشطة (DEC-32، لا تجاوز؛ المهمة التالية ومهمة الإحضار المقبولة قبل استلام المفتاح تعودان للطابور)؛ يبطل كل الجلسات واشتراكات Push | `CUSTODY_OPEN` |
| `POST /v1/drivers/{driverId}/enable` | `driver.manage` | — | `INVALID_STATE_TRANSITION` |
| `POST /v1/drivers/{driverId}/reset-secret` | `driver.manage` | يبطل الجلسات؛ سر مؤقت يُعرض مرة واحدة للإدارة | `DRIVER_DISABLED` |
| `GET /v1/drivers/{driverId}/assignments` | `driver.read` | المشرف: سجلات مواقع نطاقه؛ الإدارة: السجل كاملًا | `RESOURCE_NOT_FOUND` |
| `POST /v1/drivers/{driverId}/assignments` | `driver.assign` | لا تعيين نشط؛ الموقع ضمن النطاق | `ASSIGNMENT_CONFLICT` |
| `POST /v1/drivers/{driverId}/transfers` | `driver.transfer` | نطاق الموقعين؛ لا مركبة ولا مفتاح ولا مهمة `in_progress` أو صف/إعادة صف نشطة (DEC-32، لا تجاوز؛ المهمة التالية ومهمة الإحضار المقبولة قبل استلام المفتاح تعودان للطابور)؛ الفوري الممنوع يرد 409 دون إنشاء سجل نقل؛ لا طلب مفتوح؛ سبب | `TRANSFER_BLOCKED_CUSTODY` |
| `POST /v1/transfers/{transferId}/cancel` | `driver.transfer` | الطلب `pending` أو `blocked` | `INVALID_STATE_TRANSITION` |
| `POST /v1/duty-sessions/{sessionId}/force-end` | `duty.force_end` | النطاق؛ سبب؛ لا مركبة ولا مفتاح ولا مهمة `in_progress` أو صف/إعادة صف نشطة (DEC-32، لا تجاوز؛ المهمة التالية ومهمة الإحضار المقبولة قبل استلام المفتاح تعودان للطابور) | `DUTY_END_BLOCKED_CUSTODY` |
| `GET /v1/staff` | `staff.manage` | الإدارة ترى المشرفين؛ المالك يرى الجميع | — |
| `POST /v1/staff` | `staff.manage` | الإدارة تنشئ مشرفين فقط | `PERMISSION_DENIED` |
| `PATCH /v1/staff/{userId}` | `staff.manage` | نفس القيد؛ لا يعدّل الفاعل نفسه | `PERMISSION_DENIED` |
| `POST /v1/staff/{userId}/scopes` | `staff.manage` | منح أو سحب نطاق موقع لمشرف؛ لا يمنح الفاعل نفسه | `PERMISSION_DENIED` |
| `POST /v1/staff/{userId}/reset-mfa` | `staff.manage` | المالك فقط (الإدارة ← `PERMISSION_DENIED`)؛ الهدف `admin` أو `supervisor`؛ سبب؛ يمسح MFA ويبطل جلسات الهدف (`admin`) ويفرض الإعداد عند الدخول التالي (§9.1) | `PERMISSION_DENIED` |

### 4.7 التنبيهات والوقائع والتقارير والإدارة

| المسار | الصلاحية | الفحوص الإضافية | رمز الرفض الأبرز |
|---|---|---|---|
| `GET /v1/alerts` | `alert.read` | مواقع النطاق | — |
| `POST /v1/alerts/{alertId}/acknowledge` | `alert.manage` | النطاق | `RESOURCE_NOT_FOUND` |
| `POST /v1/alerts/{alertId}/resolve` | `alert.manage` | النطاق | `RESOURCE_NOT_FOUND` |
| `GET /v1/incidents` | `incident.read` | النطاق | — |
| `POST /v1/incidents` | `incident.create` | السائق: تذكرة في موقعه | `TICKET_NOT_FOUND` |
| `GET /v1/incidents/{incidentId}` | `incident.read` | النطاق | `RESOURCE_NOT_FOUND` |
| `PATCH /v1/incidents/{incidentId}` | `incident.manage` | `expected_version` | `VERSION_CONFLICT` |
| `GET /v1/reports/events/{eventId}/summary` | `report.read` | النطاق | `RESOURCE_NOT_FOUND` |
| `GET /v1/reports/drivers` | `report.read` | النطاق | `SCOPE_VENUE_DENIED` |
| `GET /v1/reports/payments` | `report.read` | النطاق | `SCOPE_VENUE_DENIED` |
| `GET /v1/reports/messages` | `report.read` | النطاق؛ الأجسام منقّحة | `SCOPE_VENUE_DENIED` |
| `POST /v1/exports` | `export.create` | فلاتر ضمن النطاق؛ حد صفوف (50 000، DEC-289)؛ `audit` يتطلب `audit.read` (`PERMISSION_DENIED` بـ`audit_read_required`) | `SCOPE_VENUE_DENIED`، `RESOURCE_NOT_FOUND` (حفل المرشح خارج النطاق) |
| `GET /v1/exports/{exportId}` | `export.create` | صاحب الطلب فقط؛ رابط تنزيل قصير | `RESOURCE_NOT_FOUND` |
| `GET /v1/admin/whatsapp/channel` | `wa.channel_read` | مراجع الأسرار فقط | — |
| `PUT /v1/admin/whatsapp/channel` | `wa.channel_manage` | قناة فعالة واحدة | `INVALID_STATE_TRANSITION` |
| `GET /v1/admin/whatsapp/templates` | `wa.channel_read` | — | — |
| `POST /v1/admin/whatsapp/templates/sync` | `wa.templates_manage` | — | `DEPENDENCY_TIMEOUT` |
| `GET /v1/admin/outbox` | `outbox.manage` | حمولات منقّحة | — |
| `POST /v1/admin/outbox/{outboxId}/retry` | `outbox.manage` | الحالة `failed` أو `dead` | `INVALID_STATE_TRANSITION` |
| `GET /v1/admin/audit-log` | `audit.read` | المؤسسة | — |
| `GET /v1/admin/retention-policy` | `audit.read` | — | — |
| `PUT /v1/admin/retention-policy` | `retention.manage` | — | `VALIDATION_FAILED` |
| `GET /v1/admin/org-settings` | `org.settings_manage` | المالك فقط (DEC-39) | `PERMISSION_DENIED` |
| `PUT /v1/admin/org-settings` | `org.settings_manage` | مفاتيح `security.*` و`heartbeat.*` فقط؛ تحقق zod؛ تدقيق قبل/بعد | `VALIDATION_FAILED` |
| `POST /v1/telemetry` | `telemetry.write` | بلا معلومات شخصية؛ حد معدل | `RATE_LIMITED` |

### 4.8 Webhooks والصحة والاتصال الفوري

| المسار | الحماية | ملاحظات | رمز الرفض |
|---|---|---|---|
| `GET /webhooks/whatsapp` | `hub.verify_token` بمقارنة ثابتة الزمن | — | `WA_WEBHOOK_VERIFY_FAILED` |
| `POST /webhooks/whatsapp` | `X-Hub-Signature-256` على الجسم الخام | التفاصيل في الملف 08 §7 | `WA_WEBHOOK_SIGNATURE_INVALID` |
| `GET /health/live` · `GET /health/ready` | عام | بلا أي بيانات | — |
| `GET /metrics` | الشبكة الداخلية فقط | لا يُنشر للإنترنت | — |
| `/ws` | جلسة صالحة + `Origin` ضمن القائمة المسموحة | الغرف في §7 | `AUTH_UNAUTHENTICATED` |

---

## 5. الرؤية على مستوى الحقول

### 5.1 التذكرة

نموذجان للرد: `TicketSummary` للقوائم والبحث، و`TicketDetail` الذي يحمل `projection: full` لمن يحق له و`projection: minimal` لغيره (07 §1.10). يبني الخادم الرد من قائمة حقول مسموحة لكل فئة (allow‑list)، ولا يحذف الحقول من كائن كامل.

| الحقل | سائق (ملخص) | سائق مكلّف/منشئ (تفصيل) | مشرف | إدارة/مالك |
|---|---|---|---|---|
| `id`، `display_number`، اسم الحفل، اسم الموقع، `status` | ✓ | ✓ | ✓ | ✓ |
| اللوحة (`plate_digits`، `plate_letters_ar`، `plate_letters_en`، `plate_raw`) | ✓ | ✓ | ✓ | ✓ |
| `vehicle_make`، `vehicle_model`، `vehicle_color`، `vehicle_type` | ✓ | ✓ | ✓ | ✓ |
| `created_at`، `parked_at`، `last_requested_at`، `pending_retrieval_at` | ✓ | ✓ | ✓ | ✓ |
| حالة المهمة المفتوحة ونوعها | ✓ | ✓ | ✓ | ✓ |
| اسم المكلّف بالمهمة | — | نفسه | ✓ | ✓ |
| `channel`، `wa_link_status` (تشغيلية لا شخصية) | ✓ | ✓ | ✓ | ✓ |
| `key_tag` | — | ✓ | ✓ | ✓ |
| الموقف الحالي (`current_spot_id` وملصقه، `current_spot_note`) | — | ✓ | ✓ | ✓ |
| خانة المفتاح (`current_key_slot_id` وملصقها) | — | ✓ | ✓ | ✓ |
| حائزو العهدة (`vehicle_holder_*`، `key_holder_*`) | — | عهدته فقط | ✓ | ✓ |
| `inspection_status`، الملاحظات وعلامات الضرر | — | ✓ | ✓ | ✓ |
| الصور (معرّفات؛ الروابط عبر §6) | — | ✓ | ✓ | ✓ |
| جوال العميل | — | مقنّع `05•••••123`؛ كامل لمنشئ المسودة أثناء `received` فقط (هو من أدخله) | مقنّع + `reveal-phone` المدقق | مقنّع + `reveal-phone` المدقق |
| `customers.wa_id`، `customers.wa_user_id` | — | — | — | — |
| سجل الموافقة (الطريقة والوقت والملتقط) | — | — | ✓ | ✓ |
| `paper_serial` | — | لمنشئه أثناء الاستلام فقط؛ **لا يُعرض لمكلّف الإحضار** لأن الخادم يطابقه عند التسليم | ✓ | ✓ |
| `payment_status` (تشغيلية لا شخصية) | ✓ | ✓ | ✓ | ✓ |
| `fee_halalas` | — | ✓ (لمكلّف التسليم وحده، لا لمنشئ المسودة أثناء الاستلام، DEC-185) | ✓ | ✓ |
| تفاصيل التحصيل (الوسيلة، مرجع الجهاز، المحصّل) | — | تحصيله فقط | ✓ | ✓ |
| بيانات الإعفاء | — | — | ✓ | ✓ |
| `created_by`، `parked_by`، `retrieved_by`، `delivered_by` | — | — | ✓ | ✓ |
| الخط الزمني `ticket_events` | — | خطوات مهمته فقط، دون رسائل العميل: مكلّف المهمة المفتوحة أو المنشئ أثناء الاستلام وحدهما (وإلا `TICKET_NOT_FOUND`)، أحداثه أو أحداث مهامه ودوراته وعهدته بلا `wa.*`، والعهدة التي تخصه وتحصيلاته، بلا وقائع (DEC-246) | ✓ مع معاينة رسائل العميل المنقّحة | ✓ |
| رسائل واتساب (الحالة والجسم المنقّح) | — | حالة W-01 وW-05 فقط (مرسلة/فشلت) بلا نص | ✓ (الوارد يُخفى فيه كل 6 أرقام فأكثر وكل ما يشبه رمز الربط، DEC-247) | ✓ |
| رمز التسليم (نصًا أو هاشًا) | — | — | — | — |
| رمز الإجراء | — | — | — | — |
| رمز الربط | — | للسائق الطالب فقط داخل رد `POST /v1/tickets/{ticketId}/whatsapp-link` بطريقة QR طالما هو `active` | — | — |

قواعد:
1. **رمز التسليم غير قابل للقراءة لأي أحد عبر أي مسار:** لا في الـAPI ولا `/ws` ولا Push ولا الخط الزمني ولا التدقيق ولا التصدير ولا عرض Outbox الإداري. يُخزن هاش HMAC، ونسخة مشفرة مؤقتة تُمسح بعد قبول المزود للرسالة أو انتهاء الرمز (DEC-15، DEC-38)، والجسم المحفوظ للرسالة يُقنّع الرمز.
2. الجوال الكامل لا يظهر بعد إرسال الاستلام إلا عبر `reveal-phone` لمن يملك `ticket.reveal_phone`، والرد يحمل `Cache-Control: no-store`. الحد `security.reveal_phone_per_hour` يعد صفوف تدقيق `ticket.reveal_phone` للمستخدم في ساعة متحركة؛ والرد المحفوظ مع مفتاح التكرار يُعاد كتابته مقنّعًا قبل الالتزام فلا تبقى نسخة كاملة في القاعدة؛ وتذكرة بلا جوال ← `RESOURCE_NOT_FOUND` (`resource: customer`) (DEC-248).
3. التصدير والتقارير تحمل الجوال مقنّعًا دائمًا في الإصدار الأول، ولا تتضمن صورًا.

### 5.2 كيانات أخرى

| الكيان | السائق | المشرف | الإدارة/المالك |
|---|---|---|---|
| ملف السائق | ملفه فقط | سائقو نطاقه: الاسم، الرمز، الحالة، جوال التواصل التشغيلي، سجل التعيين ضمن نطاقه | الكل مع السجل التاريخي الكامل |
| التحصيلات والتسوية | ما حصّله بنفسه ونقده المستحق | الحفلات ضمن النطاق | الكل |
| التنبيهات | لا قائمة | ضمن النطاق | الكل |
| الوقائع | ما أنشأه في رد الإنشاء فقط | ضمن النطاق | الكل |
| سجل التدقيق | — | — (يرى الخط الزمني للتذكرة فقط) | ✓ |
| العملاء | لا دليل عملاء في الإصدار الأول؛ الوصول للجوال عبر سياق التذكرة فقط | كذلك | كذلك |

---

## 6. الصور والروابط الموقعة

1. حاوية التخزين خاصة بالكامل؛ لا وصول عام ولا روابط دائمة. المفاتيح غير قابلة للتخمين: `org/{orgId}/tickets/{ticketId}/{mediaId}.{ext}`. التخزين المستضاف ذاتيًا يُخدم على أصل التطبيق (`/{S3_BUCKET_MEDIA}` عبر Caddy، بلا CORS) بمستخدم تطبيق مقصور على Get وPut وDelete؛ ومع S3 مُدار يُسمح بأصله في CSP (`STORAGE_ORIGIN`) ويحتاج الدلو CORS لأصل التطبيق (DEC-300).
2. **الرفع:** رابط PUT موقّع صالح 5 دقائق يُصدر لمنشئ التذكرة فقط أثناء `received` أو `parking` (إكمال الصور الناقصة)، مقيد بنوع المحتوى المعلن والحجم. بعد الرفع يتحقق `complete` من وجود الكائن ومطابقة حجمه وبصمته (`sha256`) للمُعلن على الأصل المرفوع، ثم يزيل بيانات EXIF والموقع (DEC-36) ويحفظ النسخة المنقّاة بحجمها وبصمتها الجديدين، ولا يبقى الأصل غير المنقّى، قبل `upload_status = uploaded`.
3. **العرض:** رابط GET موقّع صالح 300 ثانية كحد أقصى يُصدر لكل طلب بعد فحص `ticket.read_photos`، مع `Cache-Control: private, no-store`. لا تُخزَّن الروابط ولا تُسجَّل ولا توضع في Push أو واتساب أو التصدير.
4. تُزال بيانات EXIF والموقع من كل صورة على الخادم قبل حفظها النهائي (DEC-36)، ولا معاينات مصغّرة عامة؛ أي معالجة للصور تتم داخل الحاوية الخاصة نفسها.
5. الحذف بالاحتفاظ (`retention.photos_days`) يحذف الكائن ويضبط `upload_status = deleted` و`delete_reason = retention`، مع حجز صور التذاكر التي لها واقعة مفتوحة. الكائن يُحذف دون معاملة مفتوحة، ثم يُعلَّم السطر في معاملة قصيرة إن زال كائنه فقط، ويُعاد ما فشل في التشغيل التالي (DEC-151).

---

## 7. الاتصال الفوري: الغرف والتحقق والإخراج القسري

| الغرفة | من ينضم | متى يُضاف | متى يُخرج | ما يُبث فيها |
|---|---|---|---|---|
| `user:{userId}` | المستخدم نفسه | عند الاتصال بجلسة صالحة | الخروج، التعطيل، إبطال الجلسة | العروض الشخصية `task.offered` و`task.broadcast` و`offer.reminder`، تحديثات مهامه، `session.revoked` |
| `pool:{poolId}:drivers` | من لديه مناوبة مفتوحة في المجموعة | بدء المناوبة أو الاتصال أثناءها | إنهاء المناوبة، النقل، التعطيل، الإنهاء القسري | تحديثات الطابور بمستوى `TicketSummary`، `task.claimed`، `offer.closed`، `channel.status` |
| `venue:{venueId}:supervisors` | المشرفون ذوو نطاق نشط على الموقع | الاتصال أو منح النطاق | سحب النطاق، التعطيل | `alert.raised`، `alert.updated`، `ticket.updated` بمستوى المشرف، `driver.state_changed`، `channel.status` |
| `org:{orgId}:admins` | المالك والإدارة بنطاق `org` | الاتصال | التعطيل أو سحب النطاق | أنواع التنبيه التي تمس أكثر من موقع: `wa_channel_down`، `outbox_lag`، `wa_webhook_silent`، `transfer_blocked` (DEC-46) |

قواعد:
1. الخادم وحده يقرر الانضمام بعد التحقق؛ العميل لا يرسل طلب انضمام (القاموس §7.3).
2. المصافحة تتحقق من كوكي الجلسة ومن ترويسة `Origin` مقابل قائمة النطاقات المسموحة؛ ومصافحة بلا `Origin` (طلب GET للاستطلاع الطويل من الأصل نفسه، لا يرسل المتصفح فيه `Origin`) تُقبل فقط مع `Sec-Fetch-Site: same-origin`، والجلسة يتحقق منها وسيط Socket.IO على المصافحة نفسها فيُرفض الاتصال برمز `AUTH_*` (07 §4.1)؛ ولا يُقبل اتصال WebSocket جديد بلا `Origin` مطابقة، وترقية جلسة استطلاع قائمة مربوطة بـ`sid` تلك الجلسة.
3. **العروض لا تُبث في غرفة المجموعة:** تُرسل لغرف `user:{id}` لمستلمي الجولة فقط؛ أما `task.claimed` و`offer.closed` فتُرسل لمستلمي الجولة ولغرفة المجموعة لإزالة البطاقات.
4. الحمولة تُفلتر حسب الغرفة عند الإرسال: غرفة المجموعة لا تحمل موضع مفتاح ولا موقفًا ولا جوالًا.
5. **الإخراج القسري:** عند نقل السائق أو تعطيله أو إعادة تعيين سره، يُبطل الخادم جلساته، ويرسل `session.revoked` بالسبب إلى `user:{id}`، ثم يقطع كل اتصالاته ويزيله من كل الغرف. سحب نطاق مشرف يعيد تقييم غرفه فورًا دون قطع الجلسة.
6. إعادة التحقق من صلاحية الجلسة كل 60 ثانية لكل اتصال، وفورًا عند أحداث الإبطال.
7. بعد إعادة الاتصال لا تُستأنف الأوامر قبل مزامنة كاملة عبر `GET /v1/me/home`.
8. إشعارات Push لا تحمل إلا رقم التذكرة، ولا تحمل رمزًا قابلًا للتنفيذ؛ أي قبول يمر بالجلسة وبفحص الخادم الكامل. عند الحجز يُستبدل الإشعار بإشعار هادئ بنفس الوسم (DEC-23).

---

## 8. خوارزمية التقييم (حراس NestJS)

### 8.1 خط المعالجة

1. `RateLimitGuard` — أول الحراس: حسب IP قبل الدخول (فئتا `auth` و`webhook` وكل طلب بلا كوكي جلسة؛ IPv6 بـ/64)، وحد المستخدم أو الجهاز في `UserRateLimitGuard` بعد البند 4 (فئات 07 §1.9؛ DEC-294، DEC-295).
2. `CsrfGuard` — لكل طريقة غير آمنة عدا `/webhooks/whatsapp`: `X-Requested-With: point-web` و`Origin` = `APP_BASE_URL`، وإلا `PERMISSION_DENIED` (`reason = csrf`).
3. `SessionAuthGuard` — يقرأ الكوكي `__Host-point_sid`، يحسب `sha256` ويطابق `auth_sessions.token_hash`، يرفض المنتهية والمبطلة والمعطلة، ويفرض على الجلسة المقيدة لأي مسار خارج `auth.self` تغيير السر المؤقت أولًا (`AUTH_SECRET_CHANGE_REQUIRED`) ثم إعداد MFA (`AUTH_MFA_SETUP_REQUIRED`)، ثم يبني `ActorContext`.
4. `PermissionGuard` — يقرأ الصلاحية المعلنة على المسار ويطابقها بمصفوفة الدور (+ D* للمشرف القائد).
5. `ZodValidationPipe` — شكل المدخلات.
6. المعالج: حجز مفتاح التكرار للمسارات ✓ (L0) ← تحميل المورد ضمن النطاق ← سياسة الفاعل على المورد ← أقفال L1–L9 بترتيب القاموس §14ب ← إعادة فحص السياسة والحالة والنسخة ← التنفيذ ← الإلحاقيات وOutbox (L10) ← الرد.

### 8.2 الشيفرة المرجعية

```ts
// guards/permission.guard.ts
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.get<boolean>('public', ctx.getHandler())) return true;
    const perm = this.reflector.get<Permission>('permission', ctx.getHandler());
    if (!perm) throw new Error(`Route without @RequirePermission: ${ctx.getHandler().name}`); // CI catches this too
    const actor: ActorContext = ctx.switchToHttp().getRequest().actor;
    if (!hasPermission(actor, perm)) throw new DomainError('PERMISSION_DENIED', { permission: perm });
    return true;
  }
}

// rbac/matrix.ts — generated from §3 and checked against canon §10 by a contract test
const DRIVE_PERMISSIONS = new Set<Permission>(['duty.self', 'ticket.intake', 'offer.accept', 'task.execute', 'handover.verify', 'payment.record']);
export function hasPermission(a: ActorContext, p: Permission): boolean {
  if (ROLE_MATRIX[a.role].has(p)) return true;
  return a.role === 'supervisor' && a.canDrive && DRIVE_PERMISSIONS.has(p); // D* — duty checked later
}
```

```ts
// repositories/tickets.repo.ts — scope is part of the query, never a post-filter
async findTicketForActor(tx: Tx, a: ActorContext, ticketId: string, lock?: 'update' | 'share') {
  const row = await tx.query.tickets.findFirst({
    where: and(eq(tickets.id, ticketId), eq(tickets.orgId, a.orgId), inArray(tickets.venueId, [...a.venueIds])),
    ...(lock ? { for: lock } : {}),
  });
  if (!row) throw new DomainError('TICKET_NOT_FOUND');
  if (a.role === 'driver' && (row.status === 'delivered' || row.status === 'voided')) throw new DomainError('TICKET_NOT_FOUND');
  return row;
}
```

```ts
// rbac/policies.ts — actor-on-resource rules (called before AND inside the transaction)
export const policies = {
  'task.execute': (a: ActorContext, t: Task) =>
    t.assigneeId === a.userId ? requireDuty(a, t.dispatchPoolId) : deny('NOT_TASK_ASSIGNEE', { task_id: t.id }),
  'offer.accept': (a: ActorContext, o: Offer, recipients: Set<string>) => {
    const duty = requireDuty(a, o.dispatchPoolId);      // binding order (file 10 §5.2): duty/break/assignment, then recipient
    if (!duty.allowed) return duty;
    return recipients.has(a.userId) ? allow() : deny('NOT_OFFER_RECIPIENT');
  },
  'retrieval.cancel': (a: ActorContext, c: Cycle, t: Task) => {
    const unassigned = t.status === 'queued' || t.status === 'offered' || t.status === 'broadcast';
    if (a.role === 'driver' && !unassigned) return deny('INVALID_STATE_TRANSITION', { reason: 'driver_cancel_after_assignment' });
    if (t.status === 'accepted' && t.keyPickedUpAt) return deny('CUSTODY_RELEASE_REQUIRED', { task_id: t.id });
    return allow(); // supervisor after start: the handler converts to reparking with the same driver (DEC-30)
  },
  'driver.transfer': (a: ActorContext, fromVenueId: string, toVenueId: string) =>
    a.venueIds.has(fromVenueId) && a.venueIds.has(toVenueId) ? allow() : deny('TRANSFER_SCOPE_DENIED', { missing_venue_id: a.venueIds.has(fromVenueId) ? toVenueId : fromVenueId }),
};
function requireDuty(a: ActorContext, poolId: string) {
  if (!a.duty) return deny('DUTY_REQUIRED');
  if (a.duty.status === 'on_break') return deny('DRIVER_ON_BREAK');
  return a.duty.poolId === poolId ? allow() : deny('DUTY_REQUIRED');   // not on duty in this pool (SCOPE_VENUE_DENIED only for an explicitly chosen venue)
}
```

### 8.3 تحميل سياق الفاعل

يُحمَّل لكل طلب باستعلامات صغيرة (الجلسة والمستخدم، النطاقات، التعيين النشط، المناوبة المفتوحة) ولا يُخزَّن مؤقتًا بين الطلبات، حتى يسري أثر النقل والتعطيل وسحب النطاق فورًا.

### 8.4 إعادة التحقق داخل المعاملة (TOCTOU)

بعد أخذ أقفال الأمر بالترتيب الملزم L0–L10 (القاموس §14ب، نمط `FOR NO KEY UPDATE`)، يعيد المعالج قراءة صف مناوبة الفاعل (L8) والتعيين النشط، ويطبّق السياسة نفسها مرة ثانية. إذا تغيّر شيء منذ الحارس (نقل، إنهاء مناوبة، إعادة إسناد) يُرفض الأمر بالرمز المناسب (`ASSIGNMENT_REQUIRED`، `DUTY_REQUIRED`، `NOT_TASK_ASSIGNEE`) دون أثر. النقل والتعطيل يأخذان قفل مجموعة التوزيع (L1، مجموعتا الموقعين تصاعديًا بالمعرّف) قبل L3، وكل أمر يمس الطابور يأخذ L1 أيضًا، فيتسلسلان: لا يمكن أن ينجح قبول مهمة لسائق بعد اكتمال نقله، ولا أن يكتمل النقل وسط قبول جارٍ.

---

## 9. سياسة الدخول والجلسات وبيانات الاعتماد

### 9.1 بيانات الاعتماد

| البند | السائق | المشرف/الإدارة/المالك |
|---|---|---|
| المعرّف | الجوال `phone_e164` | الجوال `phone_e164` |
| السر | رقم سري من 6 أرقام بالضبط (`security.pin_length` = 6 ثابت في الإصدار الأول وغير قابل للتعديل، DEC-09) | كلمة مرور 12 حرفًا على الأقل، تُرفض الشائعة من قائمة محلية، دون قواعد تركيب أو تدوير دوري |
| التخزين | argon2id (ذاكرة 19 MiB على الأقل، تكراران، توازي 1) مع pepper من مدير الأسرار قبل الاشتقاق | نفسه |
| قيود إضافية | يُرفض: الأرقام المتطابقة، التسلسل الصاعد/الهابط، آخر 6 أرقام من جواله، أرقام رمز الموظف | — |
| السر الأول وإعادة التعيين | سر مؤقت عشوائي يُعرض مرة واحدة للإدارة، و`must_change_secret = true` | نفسه |
| التحقق الثنائي | لا | TOTP (RFC 6238، 6 أرقام، 30 ثانية، نافذة ±1)؛ إلزامي للمالك والإدارة، ومفعّل افتراضيًا للمشرف |

- سر TOTP يُولَّد 160 بت ويُخزن مشفرًا (`users.mfa_secret_enc`، AES‑256‑GCM)، ويُعرض مرة واحدة كرمز QR بصيغة `otpauth` باسم المُصدِر «POINT».
- منع إعادة استخدام رمز TOTP نفسه داخل نافذته (`users.mfa_last_step`).
- استعادة MFA: المالك وحده يعيد ضبط MFA لحسابات الإدارة والمشرفين عبر `POST /v1/staff/{userId}/reset-mfa` (`staff.manage`، بسبب إلزامي): يمسح السر (`mfa_enabled = false`، `mfa_secret_enc = NULL`)، ويُبطل جلساتهم (`revoked_reason = admin`)، ويفرض الإعداد عند الدخول التالي. استعادة المالك إجراء طوارئ موثق خارج النظام بإشراف وتدقيق.

### 9.2 القفل والحد

- بعد 5 إخفاقات متتالية (`security.max_login_attempts`) في السر أو رمز MFA: `locked_until = now() + 15 دقيقة` ويُرد `AUTH_ACCOUNT_LOCKED`. يُصفَّر العدّاد عند النجاح.
- حدود المعدل حسب فئات 07 §1.9: فئة `auth` (10 طلبات في الدقيقة لكل IP) تحد من استهداف حسابات متعددة، وفئة `command` تشمل `reveal-phone` و`handover`، مع حد الكشف الإضافي المقترح في §11.
- رسالة واحدة لعدم وجود الحساب ولخطأ السر؛ حالة التعطيل لا تُكشف إلا بعد صحة البيانات.

### 9.3 الجلسات والكوكي

- رمز جلسة معتم 256 بت في الكوكي `__Host-point_sid` بخصائص `HttpOnly; Secure; SameSite=Lax; Path=/` ودون `Domain` (DEC-29)؛ يُخزن هاشه فقط في `auth_sessions.token_hash`. لا رموز في `localStorage`. يرفض الإقلاع في `staging` و`production` كوكيًا لا يبدأ بـ`__Host-` أو بلا Secure، و`APP_BASE_URL` غير https، و`API_BASE_URL` من أصل آخر؛ وكوكي `__Host-` بلا Secure في كل بيئة (DEC-298).
- التطبيق والـAPI من أصل واحد في الإنتاج (DEC-29)، وCORS مقيد بـ`APP_BASE_URL` وحده مع الاعتمادات ودون نجمة (07 §1.3).
- العمر المطلق: 14 ساعة للسائق (`security.driver_session_hours`) و12 للموظفين (`security.staff_session_hours`)؛ يُحدَّث `last_seen_at` مع الاستخدام.
- رمز جديد عند الدخول وعند إكمال MFA وعند تغيير السر (منع تثبيت الجلسة).
- **CSRF:** كل `POST/PUT/PATCH/DELETE` عدا `/webhooks/whatsapp` — ومنها مسار الدخول لمنع login CSRF — يتطلب الترويسة `X-Requested-With: point-web` وترويسة `Origin` مطابقة لـ`APP_BASE_URL`، وإلا `403 PERMISSION_DENIED` (`reason = csrf`). الأوامر تقبل `application/json` فقط.
- CSP صارمة في تطبيق الويب (لا سكربتات مضمنة ولا أطراف ثالثة) لتقليل أثر XSS على الجلسة. يضعها الخادم أو الوكيل العكسي ترويسةً `Content-Security-Policy` للتطبيق المبني، لا `<meta>` في `index.html` (خادم Vite للتطوير يحقن سكربتات مضمنة): `script-src 'self'`، و`style-src 'self'` مع `style-src-elem 'self' 'unsafe-inline'` (عناصر `<style>` المضمنة وحدها، لقفل التمرير الذي يحقنه Radix في النوافذ والأوراق؛ سمات `style` تبقى محجوبة، DEC-192)، و`img-src 'self' data:` ومضيف التخزين للروابط الموقعة للصور، و`connect-src 'self'` و`wss://` للنطاق ومضيف التخزين للرفع المباشر، و`object-src 'none'`، مع `Referrer-Policy: no-referrer` و`X-Frame-Options: DENY` وCOOP وCORP بقيمة `same-origin`؛ وللـAPI سياسة `default-src 'none'`؛ القيمة الكاملة في 05 §14.1 (DEC-94، DEC-299).

### 9.4 أسباب الإبطال

| المحفز | النطاق | `auth_sessions.revoked_reason` |
|---|---|---|
| تسجيل الخروج | الجلسة الحالية | `logout` |
| تغيير السر من صاحبه | كل الجلسات الأخرى | `secret_reset` |
| إعادة تعيين السر من الإدارة | كل الجلسات | `secret_reset` |
| تعطيل الحساب | كل الجلسات + حذف اشتراكات Push | `disabled` |
| اكتمال نقل السائق | كل جلسات السائق | `transfer` |
| إجراء إداري (إعادة ضبط MFA، اشتباه) | جلسة أو كل الجلسات | `admin` |
| انتهاء العمر | تنظيف دوري | `expired_cleanup` |

تغيير الدور أو النطاق لا يُبطل الجلسة؛ أثره فوري لأن السياق يُحمّل في كل طلب، وغرف الاتصال الفوري يعاد تقييمها فورًا.

### 9.5 الأجهزة

كل دخول يربط سجلًا في `devices` (المنصة، وضع العرض، إذن الإشعارات، اختبار الصوت، اشتراك Push). و`GET /v1/me` يسمّي جهاز الجلسة في `session.device_id` (أو `null`، DEC-376)، فيسجل عليه المستخدم اختبار الصوت وإذنه واشتراكه ويمكنه إلغاء اشتراك Push عبر `PUT /v1/me/devices/{deviceId}`؛ والجهاز الجديد لكل دخول بلا اشتراك، فترسل الواجهة الاشتراك الذي يحمله المتصفح إلى جهاز الجلسة دون طلب إذن (DEC-397). لا مشاركة لحساب بين سائقين (المعمارية §1)؛ الجهاز المشترك يحتاج تسجيل خروج بين المستخدمين، واشتراك Push المكرر يُنقل للجهاز الحالي (`uq_devices_push_endpoint`). لا يُدفع Push لجهاز إلا وله جلسة `auth_sessions` حية للمستخدم نفسه مربوطة به (`device_id`) وصاحبه نشط، فبعد الخروج لا يصل المستخدمَ التالي لمتصفح مشترك شيءٌ من إشعارات السابق (DEC-256، 14 §6.1).

---

## 10. فصل المهام

| الدور | يستطيع | لا يستطيع |
|---|---|---|
| المالك | إدارة الإدارة والمشرفين والسائقين، قناة واتساب، القوالب، الاحتفاظ، إعدادات المؤسسة (DEC-39)، قراءة التدقيق | حذف أو تعديل سجل التدقيق؛ إنشاء مالك آخر عبر الـAPI |
| الإدارة | إنشاء وتعطيل السائقين وإعادة أسرارهم، إنشاء المشرفين ومنح نطاقاتهم، المواقع، مزامنة القوالب، إعادة محاولة Outbox، تأكيد استلام النقد احتياطًا حين يكون المشرف الوحيد سائقًا | إنشاء أو تعديل حسابات إدارة أو مالك؛ تغيير إعداد قناة واتساب؛ تغيير الاحتفاظ أو إعدادات المؤسسة؛ الاستثناءات التشغيلية (`handover.exception`، `payment.waive`، `ticket.inspection_exception`) |
| المشرف | التعيين والنقل داخل نطاقه، الحفلات والورديات، الاستثناءات التشغيلية، التنبيهات والوقائع | إنشاء الحسابات أو تعطيلها أو إعادة أسرارها؛ تعديل نطاقه أو دوره؛ إعدادات الموقع؛ قراءة التدقيق |
| السائق | مناوبته ومسودته ومهامه المسندة وطلب نيابة وإلغاء قبل الإسناد | أي إجراء على مهمة غيره؛ الإلغاء النهائي للتذاكر؛ إعادة الإسناد؛ الاستثناءات |

قواعد:
1. **لا تعديل للنفس:** لا يغيّر أي مستخدم دوره أو نطاقاته أو حالة حسابه بنفسه (`PERMISSION_DENIED` بـ`reason = self_modification`).
2. **الموافقة الذاتية مقيدة ومعلَّمة:** إذا نفّذ مشرف قائد استثناءً على عمل نفّذه بنفسه (`handover.exception` على مهمة هو مكلّفها، `payment.reverse` لتحصيل حصّله، `payment.waive` على تذكرة يسلّمها، `ticket.inspection_exception` لتذكرة أنشأها)، يُسمح فقط بسبب إلزامي وتُعلَّم `audit_log.metadata.self_approved = true` وتظهر في تقرير الحفل لمراجعة الإدارة.
3. **ممنوع مطلقًا:** أن يؤكد المشرف استلام نقده بنفسه: `403 PERMISSION_DENIED` (`reason = self_handover`) قبل أي قفل، والقيد `ck_cash_handover_distinct_people` احتياطي (DEC-275).
4. حساب المالك الأول يُنشأ بأداة التهيئة عند التثبيت (`node api/dist/cli.js create-owner`: المؤسسة إن لم توجد، والمالك `O-0001` بنطاق `org` نشط، وكلمة مرور مؤقتة من 16 محرفًا تُعرض مرة مع `must_change_secret` وبلا TOTP، وتدقيق `owner.bootstrap` بفاعل `system`؛ ترفض إن وُجد مالك، DEC-302)؛ لا يوجد مسار API لإنشاء مالك.

---

## 11. متطلبات التدقيق للإجراءات الحساسة

كل صف في `audit_log` يحمل: `actor_type`، `actor_id`، `action` (اسم الصلاحية؛ ولفاعل النظام نوع المهمة `job.*`، DEC-145، DEC-152؛ وأداة تهيئة المالك `owner.bootstrap`، DEC-302)، `entity_type`، `entity_id`، `venue_id`، `request_id`، `ip`، `user_agent`، `occurred_at`. الجدول يحدد الإضافات الإلزامية.

| الإجراء | حقول إضافية إلزامية | ممنوع تسجيله |
|---|---|---|
| `ticket.reveal_phone` | `reason`؛ عدّاد الكشف للمستخدم (حد 20 في الساعة مقترح، §15) | قيمة الرقم |
| `ticket.change_phone` | `reason`، الجوال قبل/بعد مقنّعًا، `link_version` قبل/بعد، إقرار حضور العميل | الأرقام الكاملة |
| `handover.exception` | `reason`، طريقة تحقق الهوية وملاحظاتها، `cycle_id`، `self_approved` | أي رمز |
| `payment.reverse` / `payment.waive` | `reason`، `amount_halalas`، `payment_id` أو `ticket_id`، `self_approved` | — |
| `ticket.manual_reconcile` | `reason`، مرجع الدليل (رقم السجل الورقي)، الحالة قبل/بعد | — |
| `export.create` | `kind`، الفلاتر، `row_count`، وكل تنزيل بوقته | محتوى الملف |
| `driver.transfer` | `reason`، الموقع من/إلى، `scheduled_at`، نتيجة فحص العهدة، المهمة التالية المعادة | — |
| `ticket.void` | `reason`، الحالة السابقة، حسم العهدة | — |
| `task.reassign` / `retrieval.cancel` | `reason`، المهمة، السائق السابق، الوجهة (الطابور أو سائق)، حالة العهدة | — |
| `ticket.custody_transfer` / `task.release_custody` (للمشرف) | `reason`، الموضوع، الحائز من/إلى | — |
| `ticket.inspection_exception` | `reason`، الصور الناقصة، `self_approved` | — |
| `duty.force_end` | `reason`، المناوبة | — |
| `driver.manage` / `staff.manage` | الهدف، التغيير (دور، نطاق، حالة)، `reason` للتعطيل | الأسرار المؤقتة وكلمات المرور |
| `venue.manage` / `event.manage` / `shift.manage` | `metadata.command` (عملية Canon §9.5)، before/after للحقول المتغيرة فقط، `metadata.noop = true` لـ`PATCH` لا يغيّر شيئًا (ولا يرتفع `version`)، رمز الموقع باسم `venue_code` لأن منقّح التدقيق يحجب كل مفتاح يحوي `code`، و`reason` لإلغاء الحفل (DEC-125) | — |
| أحداث الدخول | النجاح/الفشل، القفل، إعداد MFA أو إعادة ضبطه، تغيير السر — الجوال مجزّأ للحساب غير المعروف | الأسرار والرموز |
| `wa.channel_manage` / `wa.templates_manage` / `retention.manage` / `org.settings_manage` / `outbox.manage` | الإعداد قبل/بعد (مراجع الأسرار فقط)؛ و`wa.templates_manage` للمزامنة (DEC-145)؛ ولـ`outbox.manage` نتيجة الإعادة `requeued` أو `canceled_stale` أو `canceled_superseded` (DEC-150) | الرموز والأسرار |
| `audit.read` | المرشحات وعدد الصفوف المعادة (DEC-168) | محتوى الصفوف |
| `job.wa_process_inbound` / `job.wa_send` (فاعل النظام) | الإيقاف وحالة الربط من الوارد / صحة القناة ونتيجة W-01 من المرسل (DEC-145) | الجوال الكامل و`wa_id` ونص الرسائل والرموز |
| `job.retention_purge` (فاعل النظام) | صف لكل دفعة: `entity_type` = الجدول، ومعرّف التشغيل والخطوة والأعداد والكائنات المحذوفة والفاشلة؛ وصف ملخص لكل تشغيل (`entity_type = organization`، السياسة وكل خطوة)؛ والتشغيل التجريبي يكتب الملخص وحده (DEC-152) | محتوى الصفوف المحذوفة |

يُحتفظ بالسجل وفق `retention.audit_months` (مقترح 60 شهرًا)، ولا يملك دور التطبيق في قاعدة البيانات صلاحية `UPDATE` أو `DELETE` عليه (`06_schema.sql` §17)؛ الحذف بانتهاء المدة بدور `point_retention` وحده (الترحيل `0004`، DEC-153). تقرير شهري للإدارة يعرض كشوف الجوال والتصديرات والموافقات الذاتية والاستثناءات.

---

## 12. ضوابط الخصوصية

هذه ضوابط تقنية صُممت مع مراعاة نظام حماية البيانات الشخصية في المملكة العربية السعودية؛ تقييم الامتثال القانوني ومدد الاحتفاظ النهائية يقرّها مستشار مختص قبل الإطلاق (Q-06).

1. **الموافقة والشفافية:** تُسجل موافقة العميل على واتساب في `customer_consents` (الطريقة، الوقت، من التقطها، أو رسالة العميل نفسها في ربط QR). الرسالة الأولى W-01 تعرّف بالمرسل «مصاف» وبالغرض. كلمات الإيقاف تُفعّل `wa_opted_out_at` وترد W-12، ولا تُرسل بعدها رسائل للعميل حتى يستأنف بنفسه: ضغطه زر «طلب السيارة» أو إرساله رسالة ربط QR يعيد موافقته (الإيقاف لا يبطل رموز الإجراء؛ الملف 12).
2. **تقليل البيانات:** هوية العميل جوال أو معرّف واتساب (BSUID) لمستخدمي أسماء واتساب دون رقم ظاهر (DEC-35) فقط؛ لا أسماء ولا هويات. اللوحة والوصف والصور لأغراض الخدمة وإثبات حالة المركبة فقط. أحداث القياس بلا جوالات ولا لوحات ولا رموز.
3. **حصر الغرض:** الجوال يستخدم لإشعارات التذكرة فقط؛ القوالب كلها من فئة UTILITY ولا تسويق في الإصدار الأول.
4. **التحكم بالوصول والإقناع:** كما في §3 و§5؛ الكشف الكامل للجوال مدقق ومحدود المعدل.
5. **الاحتفاظ والحذف:** مهمة `job.retention_purge` تطبق `retention.photos_days` و`retention.wa_messages_days` و`retention.wa_raw_days` (الأجسام الخام لطلبات Webhook) و`retention.tickets_months` و`retention.audit_months` و`retention.analytics_months` (قيم مقترحة يعتمدها المالك)، مع حجز السجلات المرتبطة بواقعة مفتوحة أو نزاع تحصيل (والنزاع واقعة `payment_discrepancy`؛ قواعد الحجز في `06_ERD_Database_Schema.md` §8.2، DEC-156).
6. **سجلات الوصول:** التدقيق في §11 والمراجعة الشهرية.
7. **طلبات أصحاب البيانات** (الاطلاع، التصحيح، الحذف، الاعتراض): إجراء موثق تستقبله الشركة عبر قناة رسمية وليس عبر محادثة واتساب الآلية؛ يتحقق المنفّذ من الهوية بمطابقة الجوال والتذكرة، وينفّذ المالك أو الإدارة الطلب بإجراءات مدققة، ويُسجَّل الرد ووقته. الحذف يخضع لالتزامات الاحتفاظ بالسجلات المالية والوقائع؛ المهل النظامية يحددها المستشار.
8. **مكان البيانات والمعالجون:** قرار منطقة الاستضافة مفتوح (Q-02). رسائل واتساب تمر عبر Meta، وإشعارات Push عبر خدمات المتصفحات؛ يُوثّق ذلك في سجل أنشطة المعالجة ولا يُدّعى إقامة كاملة للبيانات (المعمارية §13).
9. **أمن المعالجة:** TLS في كل اتصال، تشفير التخزين لدى المزود، الأسرار في مدير أسرار، أدوار قاعدة بيانات بأقل صلاحية، نسخ احتياطية مشفرة، وإجراء موثق للاستجابة لحوادث تسرب البيانات يتضمن تقييم وجوب الإبلاغ مع المستشار.

---

## 13. نموذج التهديدات (STRIDE)

| # | التهديد | الفئة | المسار | الضوابط | التحقق |
|---|---|---|---|---|---|
| 1 | زر «طلب السيارة» محوّل أو مضغوط من رقم آخر | S | Webhook ← طلب الإحضار | رمز إجراء عشوائي 128 بت مخزن كهاش، مربوط بـ`customer_id` وبالتذكرة؛ مطابقة `wa_id` المرسل؛ الرفض يرد W-10 دون بيانات | AC-02 |
| 2 | إعادة استخدام رمز إجراء بعد تغيير الجوال | S / E | Webhook | `link_version` يرتفع ويُبطل الرموز السابقة (`action_tokens.revoked_at`) | AC-02 |
| 3 | طلب المركبة الخطأ لعميل له تذكرتان | T | Webhook | كل رمز مربوط بتذكرته؛ لا استنتاج «آخر مركبة»؛ المسار ← `ticket_id` ← `venue_id` | AC-03، AC-20 |
| 4 | تخمين رمز التسليم | S | `POST /v1/tickets/{ticketId}/handover` | 6 أرقام، 5 محاولات ثم قفل، صلاحية 30 دقيقة، للمكلّف فقط، حد معدل، تنبيه `handover_code_locked` | AC-09 |
| 5 | تسريب رمز التسليم للسائق أو في السجلات | I | الـAPI، `/ws`، Push، Outbox، السجلات | هاش HMAC؛ نسخة مشفرة تُمسح بعد الإرسال؛ تقنيع في الأجسام؛ مسح آلي في الاختبارات | AC-09 |
| 6 | قبول عرض قديم من إشعار Push أو بعد النقل | E / T | `POST /v1/task-offers/{offerId}/accept` | الإشعار بلا رمز قابل للتنفيذ؛ الخادم يتحقق داخل المعاملة من العرض النشط والمستلم والمناوبة والتعيين | AC-04، AC-10، AC-16 |
| 7 | قبولان متزامنان للمهمة نفسها | T | القبول | قفل المجموعة + `uq_task_offers_active` + `uq_tasks_next_per_driver` + `uq_tasks_active_movement_driver` | AC-04، AC-14 |
| 8 | تزوير Webhook | S | `POST /webhooks/whatsapp` | HMAC-SHA256 على الجسم الخام بسر التطبيق ومقارنة ثابتة الزمن قبل أي تخزين | AC-01 |
| 9 | إعادة تشغيل Webhook أو تكراره | T / R | Webhook | `body_sha256` فريد، `wa_message_id` فريد، رتبة الحالة لا تنخفض، الطلب متساوي القوة | AC-01 |
| 10 | سرقة الجلسة | S / I | كل الـAPI | كوكي `__Host-point_sid` (`HttpOnly`، `Secure`، `SameSite=Lax`)، CSP صارمة، عمر مطلق، إبطال على الخادم، تدوير الرمز | — |
| 11 | تزوير طلب عبر موقع آخر (CSRF) | T | الأوامر ومسار الدخول | ترويسة `X-Requested-With: point-web` + فحص `Origin` + JSON فقط + `SameSite=Lax` (DEC-29) | — |
| 12 | سوء استخدام داخلي (تصفح الجوالات واللوحات) | I / R | القوائم والتفاصيل | حقول دنيا للسائق، تقنيع، كشف مدقق بحد معدل، تقرير مراجعة شهري | — |
| 13 | تجاوز الصلاحية بطلب مسارات مخفية أو معرفات أخرى (IDOR) | E / I | كل الـAPI | حراس الصلاحية، النطاق داخل الاستعلام، 404 لعدم الكشف، اختبار المصفوفة | AC-10 |
| 14 | تسريب عبر التصدير | I | `POST /v1/exports` | نطاق، جوالات مقنّعة، بلا صور، حد صفوف، رابط قصير لصاحب الطلب، تدقيق الإنشاء والتنزيل | — |
| 15 | تسريب على شاشة القفل | I | Web Push | رقم التذكرة فقط؛ لا لوحة ولا جوال ولا موضع مفتاح ولا رمز (DEC-23) | AC-08 |
| 16 | اختطاف ربط QR (شخص آخر يرسل الرمز أولًا) | S | ربط واتساب | السائق يؤكد الرقم الوارد المقنّع مع العميل الحاضر؛ صلاحية 10 دقائق؛ رمز حي واحد للتذكرة؛ الرفض يبطل الرمز | — |
| 17 | تخمين الرقم السري | S / D | الدخول | قفل 5/15 دقيقة، حد IP، رسالة موحدة، argon2id مع pepper | — |
| 18 | إغراق الخدمة | D | الـAPI وWebhook | حدود معدل، حدود حجم الجسم، إقرار سريع ومعالجة بالطابور | — |
| 19 | إنكار استثناءات المشرف | R | الاستثناءات | تدقيق إلحاقي بسبب، `ticket_events`، `custody_events` | — |
| 20 | العبث بسجل التدقيق | T | قاعدة البيانات | لا `UPDATE`/`DELETE` لدور التطبيق؛ فصل الأدوار؛ نسخ احتياطية | — |

---

## 14. حالات اختبار الصلاحيات

### 14.1 AC-02 — «لا يمكن لرقم مختلف استعمال زر محول إليه لطلب مركبة ليست له»

1. عميل ب (رقم مختلف) يضغط زر W-01 الخاص بالعميل أ: لا تُنشأ `retrieval_cycles` ولا `ticket_events`، ويصل لـب رد W-10 دون أي بيانات تذكرة، وتُخزن الرسالة الواردة.
2. بعد `PATCH /v1/tickets/{ticketId}/customer-phone`: ضغط الرقم القديم على الرسالة القديمة يُرفض (`link_version` قديم)، والرقم الجديد يعمل برسالته الجديدة.
3. رمز مجهول ← W-10 دون بيانات؛ رمز مبطل أو منتهٍ ← W-09 (غير نشطة) دون إنشاء طلب.
4. المالك الصحيح يضغط زر تذكرة مسلّمة ← W-09 بالحالة فقط ولا طلب جديد.
5. الرمز المعتم لا يظهر في أي رد API أو حمولة `/ws` أو Push أو سجل (مسح آلي).

### 14.2 AC-09 — «لا تسليم دون تحقق أو استثناء مشرف موثق، ولا إعادة استخدام للرمز، ولا تسريب له إلى السائق»

1. تسليم دون رمز أو كعب ← `VALIDATION_FAILED`.
2. رمز خاطئ 5 مرات: أربع ردود `HANDOVER_CODE_INVALID` بـ`attempts_left` من 4 إلى 1، ثم `HANDOVER_CODE_LOCKED`؛ العدّاد محفوظ رغم فشل الطلبات؛ تنبيه `handover_code_locked` مرفوع.
3. تسليم ثانٍ بعد النجاح: بنفس مفتاح التكرار يُعاد رد 200 المحفوظ، وبطلب جديد ← `TICKET_CLOSED` (لا إعادة استخدام للرمز)؛ رمز منتهٍ ← `HANDOVER_CODE_EXPIRED`.
4. سائق غير مكلّف ← `NOT_TASK_ASSIGNEE`؛ سائق يستدعي `handover-exception` ← `PERMISSION_DENIED`.
5. استثناء المشرف دون سبب ← `REASON_REQUIRED`؛ مع السبب ← `delivered` وصف تدقيق بطريقة التحقق.
6. فحص التسريب: `GET /v1/tickets/{ticketId}`، الخط الزمني، `GET /v1/me/home`، حمولات `/ws` وPush، عرض Outbox الإداري، السجلات، التصدير — لا رمز نصي؛ و`claim_codes.code_ciphertext` فارغ بعد قبول المزود.

### 14.3 AC-10 — «سائق ريماس لا يصل لطلبات ليلتي؛ بعد نقله ينقطع وصوله الحي للموقع القديم مع بقاء سجله التاريخي لدى الإدارة»

1. سائق ريماس: `GET /v1/tickets?venue_id=<ليلتي>` ← `SCOPE_VENUE_DENIED`؛ `GET /v1/tickets/{ticketId}` لتذكرة ليلتي ← `TICKET_NOT_FOUND`؛ قبول عرض ليلتي ← `OFFER_NOT_FOUND`.
2. اتصال سائق ريماس لا ينضم أبدًا إلى `pool:{poolId}:drivers` لليلتي ولا يستلم بثها.
3. نقل ريماس ← ليلتي وبعهدته مفتاح ← `TRANSFER_BLOCKED_CUSTODY`؛ بعد الإعادة الرسمية للمفتاح ينجح النقل، وتُبطل كل جلساته (`AUTH_SESSION_REVOKED`، `reason = transfer`)، ويصل `session.revoked` ويُقطع الاتصال، ويفشل قبول إشعار قديم، وتعود مهمته التالية المحجوزة لطابور ريماس.
4. التذاكر التي أنشأها أو صفّها في ريماس تبقى بـ`created_by` و`parked_by` و`venue_id` الأصلية، يراها مشرف ريماس والإدارة، ولا يراها السائق بعد نقله.
5. مشرف بنطاق ريماس فقط يحاول النقل إلى ليلتي ← `TRANSFER_SCOPE_DENIED`.

### 14.4 اختبار المصفوفة الشامل

اختبار مولّد من §3 و§4: لكل مسار ولكل فاعل من (مالك، إدارة، مشرف، مشرف قائد في مناوبة، سائق في مناوبة، سائق خارج المناوبة، سائق موقع آخر، جلسة منتهية) يتحقق من فئة الرد المتوقعة: سماح (2xx أو رفض عمل 4xx)، أو `401`، أو `403`، أو `404`. يُضاف إليه: اختبار عقد يطابق `ROLE_MATRIX` مع القاموس §10، واختبار يفشل عند وجود مسار دون صلاحية معلنة، ولقطات (snapshot) لردود `TicketSummary` و`TicketDetail` لكل دور تتأكد من غياب الحقول الممنوعة.

---

## 15. إضافات مقترحة للقاموس

| الاقتراح | السبب |
|---|---|
| مواءمة نص شرط `retrieval.cancel` في القاموس §10 («المشرف: قبل بدء الحركة») مع DEC-30 | **اعتُمد:** Canon §10 يطابق DEC-30 |
| عمود `users.mfa_last_step` | **اعتُمد** في المخطط 1.2: منع إعادة استخدام رمز TOTP داخل نافذته |
| مفتاح إعداد `security.admin_idle_minutes` (30) | **اعتُمد** في Canon §12: مهلة خمول لجلسات المالك والإدارة إضافة للعمر المطلق |
| مفتاح إعداد `security.reveal_phone_per_hour` (20) | **اعتُمد** في Canon §12: حد كشف الجوال لكل مستخدم في §11 |
| رمز `PAYLOAD_TOO_LARGE` (413) | **اعتُمد** في Canon §8 والملف 08 §4.15 |

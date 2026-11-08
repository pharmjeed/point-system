# 00 — القاموس الموحّد والمعرّفات المعتمدة (Canon)

الإصدار 1.0 — 27 أكتوبر 2026 — مبني على «مصاف — معمارية نظام الفاليت للقاعات» الإصدار 1.2 (`00_Source_Architecture_v1.2_AR.md`).

هذا الملف هو **المرجع الملزم** لكل ملفات الحزمة وللكود. كل اسم جدول أو حالة أو حدث أو رمز خطأ أو مسار API أو صلاحية أو قالب واتساب أو معرّف شاشة أو مفتاح إعداد يجب أن يطابق ما هنا حرفيًا. أي إضافة أو تعديل يبدأ هنا أولًا ثم ينعكس في الملف المختص. عند التعارض بين ملفين، هذا الملف يحكم في **الأسماء**، والملف المختص يحكم في **التفاصيل**.

---

## 1. هوية المنتج (Brand architecture)

| السطح | الاسم الظاهر | أين يظهر |
|---|---|---|
| نظام الموظفين | **بوينت · POINT** — Valet & Parking | موقع/تطبيق الويب للسائق والمشرف والإدارة: الشعار، عنوان الصفحة، أيقونة الشاشة الرئيسية (PWA)، شاشة الدخول، عنوان إشعارات Web Push |
| قناة العميل | **بوينت · POINT** منذ الإصدار الثاني (V2-D01، DEC-470)؛ كانت **مصاف · MASAF** في الإصدار الأول | واتساب: اسم العرض لحساب واتساب للأعمال، صورة الحساب، نص كل رسالة وقالب، التذكرة الورقية البديلة، لوحة QR التي يديرها السائق نحو العميل (D-07)؛ وفي الإصدار الثاني تطبيق العميل والفواتير (`docs/v2/`) |

> **الإصدار الثاني (V2-D01، V2-D02؛ DEC-460، DEC-470):** العلامة التي يراها العميل صارت «بوينت · POINT»، الشركة التي تبيع للعميل، و«مصاف» صارت **مشغّلًا** يستخدم المنصة (اسم مؤسسة من قاعدة البيانات لا علامة). ورقم واتساب واحد لبوينت لكل المشغلين، والرسالة تذكر اسم الموقع. التطبيق كله عبر الإعداد: `BRAND_CUSTOMER_NAME_AR/EN` قيمته الافتراضية الآن `بوينت`/`POINT`، فالقاعدة 1 أدناه (منع «بوينت» عن العميل) **أُبطلت** بالقرار DEC-470 وتبقى للتاريخ، وتبقى القاعدة 2 قائمة بمعنى «اسم علامة العميل يظهر في واجهة الموظفين في المواضع المسماة فقط»، وتبقى القاعدة 4 (الأسماء من الإعدادات) كما هي. ونشر بعلامة عميل مختلفة عن علامة الموظفين ما زال ممكنًا بالإعداد، وتنطبق عليه القاعدتان 1 و2 كما في الإصدار الأول.

قواعد:
1. ~~العميل لا يرى «بوينت» إطلاقًا: لا في القوالب ولا الردود ولا صورة الحساب ولا التذكرة الورقية.~~ (الإصدار الأول؛ أبطلها DEC-470: العميل يرى علامة العميل المضبوطة وحدها، وهي «بوينت» افتراضيًا. وتبقى القاعدة لكل نشر تختلف فيه علامة العميل عن علامة الموظفين: لا يرى العميل علامة الموظفين.)
2. واجهة الموظفين تحمل «بوينت». يظهر اسم علامة العميل (كان «مصاف»؛ DEC-470) فيها فقط في: لوحة QR الموجهة للعميل (D-07، ونفسها في «إعادة الربط بواتساب» في S-03؛ القرار DEC-420)، سؤال الموافقة الذي يقرؤه السائق للعميل في D-05 (تسمية النشاط شرط لموافقة Meta، 12 F-17؛ القرار DEC-410)، معاينة رسائل العميل في سجل التذكرة (S-03)، إعدادات قناة واتساب (S-13).
3. اسم الكود: `point` (monorepo)، نطاق الحزم `@point/*`، قاعدة البيانات `point`.
4. أسماء العلامتين تُقرأ من الإعدادات ولا تُكتب صلبًا في الكود:
   `BRAND_STAFF_NAME_AR=بوينت` · `BRAND_STAFF_NAME_EN=POINT` · `BRAND_CUSTOMER_NAME_AR=بوينت` · `BRAND_CUSTOMER_NAME_EN=POINT` (كانت `مصاف`/`MASAF` في الإصدار الأول؛ DEC-470).
   نصوص قوالب واتساب تُكتب في الكود برمز `{brand}` ويملؤه الإعداد (DEC-470)؛ ونص القالب المعتمد لدى Meta ثابت بطبيعته ويحمل العلامة المضبوطة وقت إنشائه، فتغيير العلامة بعد الاعتماد يتطلب نسخًا جديدة `_v2` من القوالب.

---

## 2. ثوابت لا تُكسر (Non‑negotiables)

1. الخادم وقاعدة البيانات مصدر الحقيقة؛ لا الإشعار ولا حالة الشاشة.
2. واتساب واجهة العميل الوحيدة، بزر واحد فقط «طلب السيارة». لا صفحة ويب للعميل، لا نقطة استلام، لا مساعدة، لا حالة، لا إلغاء، لا تقييم كأزرار.
3. رقم واتساب إنتاج واحد (`phone_number_id` واحد) لكل المواقع. لا رقم لكل قاعة أو سائق، ولا قروبات، ولا إرسال من أرقام السائقين.
4. لا تطبيق أصلي ولا نشر في المتاجر؛ موقع ويب متجاوب واحد (PWA اختياري) بواجهات حسب الدور.
5. لا ذكاء اصطناعي، لا GPS (وتُزال بيانات EXIF/الموقع من الصور المرفوعة على الخادم)، لا معالجة بيانات بطاقات، لا اشتراكات في الإصدار الأول.
6. الأولوية لأقدم `requested_at`، والإسناد للأطول تفرغًا. هوية من سجّل المركبة لا تمنح أولوية.
7. أول قبول يؤكده الخادم يفوز. السائق المشغول يحجز مهمة تالية واحدة فقط ولا يبدأ حركة ثانية قبل إنهاء الأولى.
8. كل أمر يتحقق على الخادم من: المؤسسة، الموقع، الوردية، الدور، التكليف الحالي، الحالة السابقة، `version`، ومفتاح التكرار. إخفاء الأزرار ليس حماية.
9. تغيير الحالة والحدث الصادر (Outbox) في معاملة واحدة؛ الإرسال لاحقًا بعامل مع إعادة محاولة محدودة.
10. رمز التسليم لا يُخزن نصًا صريحًا ولا يُعرض للسائق، ويُستهلك مرة واحدة.
11. لا بيانات عميل ولا رمز تسليم ولا موضع مفتاح في إشعار شاشة القفل.
12. لا حذف صامت: إلغاء/تصحيح/عكس مع سبب وسجل تدقيق.
13. الأوقات UTC داخليًا (`timestamptz`) والعرض بتوقيت `Asia/Riyadh`.
14. العربية أولًا من اليمين لليسار؛ الأرقام لاتينية `0-9` في الواجهة والرسائل.

---

## 3. المصطلحات (Glossary)

| العربي | المعرّف في الكود | التعريف |
|---|---|---|
| المؤسسة | `organization` | شركة الفاليت المشغّلة (مؤسسة واحدة في الإصدار الأول، والمخطط جاهز لأكثر) |
| الموقع / القاعة | `venue` | موقع تشغيل فعلي (مثال: قاعة ريماس، قاعة ليلتي) له رمز قصير `code` مثل `RMS` |
| مجموعة التوزيع | `dispatch_pool` | مجموعة السائقين والطلبات التي يتم التوزيع داخلها؛ افتراضيًا واحدة لكل موقع |
| الحفل | `event` | مناسبة في موقع بتاريخ؛ أرقام التذاكر فريدة داخله. في TypeScript يسمى النوع `VenueEvent` لتجنب تعارض `Event` |
| الوردية | `shift` | نافذة تشغيل للموقع يفتحها المشرف |
| مناوبة السائق | `duty_session` | فترة عمل السائق الفعلية داخل وردية («ورديتي»): متاح/استراحة/منتهية |
| السائق | `driver` | مستخدم بدور `driver`؛ يستلم ويصف ويحضر ويسلّم |
| المشرف | `supervisor` | مستخدم بدور `supervisor` بنطاق مواقع محددة؛ قد يُسمح له بالقيادة `can_drive` |
| الإدارة | `admin` | إدارة المؤسسة: الحسابات والمواقع والتقارير |
| المالك | `owner` | أعلى صلاحية: إدارة المدراء وقناة واتساب وسياسة الاحتفاظ |
| العميل | `customer` | صاحب المركبة؛ يُعرّف بجواله و`wa_id` |
| التذكرة | `ticket` | سجل المركبة داخل الحفل؛ رقمها الظاهر `display_number` |
| دورة الاسترجاع | `retrieval_cycle` | طلب إحضار واحد من لحظة الطلب حتى التسليم/الإلغاء/إعادة الصف |
| المهمة | `task` | عمل حركة: `park` صف، `retrieve` إحضار، `repark` إعادة صف |
| العرض | `task_offer` | جولة عرض للمهمة: `single` فردي أو `broadcast` بث |
| مستلم العرض | `offer_recipient` | سائق وصله عرض ضمن جولة |
| المهمة التالية | next task | مهمة إحضار محجوزة لسائق مشغول: `tasks.status = assigned_waiting` |
| العهدة | `custody` | من يحوز المركبة `vehicle` أو المفتاح `key` الآن |
| حدث عهدة | `custody_event` | انتقال عهدة من حائز إلى حائز مع السبب والوقت |
| لوحة المفاتيح / خانة المفتاح | `key_board` / `key_slot` | مكان إيداع المفاتيح المرقّم |
| المنطقة / الموقف | `parking_zone` / `parking_spot` | أماكن الوقوف؛ يمكن الصف بموقف محدد أو بملاحظة نصية |
| علاقة المفتاح | `key_tag` | الرقم المادي المعلّق على المفتاح |
| رمز التسليم | `claim_code` | رمز 6 أرقام يصل العميل عند الجاهزية؛ يدخله السائق للتحقق |
| رمز الربط | `link_code` | رمز قصير الصلاحية داخل QR يربط محادثة العميل بالتذكرة |
| رمز الإجراء | `action_token` | قيمة `payload` المعتمة في زر «طلب السيارة» مربوطة بالعميل والتذكرة |
| الموافقة | `customer_consent` | موافقة العميل على رسائل واتساب ومصدرها |
| الواقعة | `incident` | حدث تشغيلي داخلي يعالجه المشرف (مفتاح، ضرر، غياب...) |
| تنبيه المشرف | `alert` | تنبيه آلي يحتاج انتباه المشرف (طلب غير مقبول، فشل رسالة...) |
| صندوق الأحداث | `outbox_event` | سجل دائم للأحداث والمهام المؤجلة والمؤقتات |
| التحصيل | `payment` | تحصيل نقدي أو بنقاط بيع خارجية عند التسليم |
| تسليم النقد | `cash_handover` | تسليم السائق نقده للمشرف عند نهاية الحفل |
| التذكرة الورقية | `paper_serial` | رقم دفتر التذاكر المطبوع مسبقًا للعميل الذي لا يستخدم واتساب |
| سجل التذكرة | `ticket_event` | خط زمني إلحاقي لكل ما حدث للتذكرة |

---

## 4. الأدوار والفاعلون والنطاقات

- الأدوار `users.role`: `owner` · `admin` · `supervisor` · `driver`.
- نوع الفاعل في التدقيق `actor_type`: `user` · `customer` · `system`.
- نوع النطاق `role_scopes.scope_type`: `org` · `venue`.
- السائق يعمل في الموقع الذي لديه فيه تعيين نشط `driver_assignments.status = active` (تعيين نشط واحد فقط).
- المشرف يعمل في المواقع التي لديه عليها `role_scopes` بنوع `venue`. إذا `users.can_drive = true` يمكنه بدء مناوبة والدخول في التوزيع كسائق داخل نطاقه.

---

## 5. قوائم الحالات (Enums) — القيم الحرفية

### 5.1 حالة التذكرة `tickets.status`

| القيمة | العربية | ملاحظة |
|---|---|---|
| `received` | مستلمة | التسجيل جارٍ (مسودة)؛ السائق مشغول بالتسجيل |
| `parking` | جارٍ الصف | التسجيل اكتمل والسائق يقود للموقف |
| `parked` | متوقفة | المركبة في الموقف والمفتاح في خانته |
| `requested` | مطلوبة | دورة استرجاع مفتوحة، المهمة في الطابور/معروضة |
| `assigned` | مُسندة | قبلها سائق متاح ولم تبدأ الحركة |
| `assigned_waiting` | محجوزة تالية | حجزها سائق مشغول كمهمة تالية |
| `retrieving` | جارٍ الإحضار | بدأت الحركة فعليًا |
| `ready` | جاهزة | عند نقطة التسليم، رمز التسليم أُصدر |
| `delivered` | مُسلّمة | نهائية |
| `reparking` | جارٍ إعادة الصف | غياب العميل بقرار المشرف، أو إلغاء المشرف للطلب بعد بدء الحركة (DEC-30) |
| `voided` | ملغاة | نهائية؛ مسودة خاطئة أو مهجورة، أو تسجيل خاطئ قبل الصف (`received` أو `parking`) باعتماد مشرف (DEC-45)؛ ما بعد الصف يُصحح بالمطابقة اليدوية |

الحالات النهائية: `delivered`، `voided`. «مفتوحة» = أي حالة غير نهائية.

### 5.2 حقول حالة أخرى على التذكرة

> في الإصدار الثاني `app` تذكرة استلمها السائق بمسح بطاقة الدخول من تطبيق العميل (O-01، V2-013، DEC-501)، و`entitlement` أهلية الزيارة تُحدَّد عند الاستلام (V2-014، DEC-502؛ `docs/v2/04` §2).

- `tickets.channel`: `whatsapp` · `paper` · `app`
- `tickets.entitlement`: `none` · `subscription` · `app_paid` · `event_included`
- `tickets.wa_link_status`: `none` · `pending_send` · `pending_confirmation` · `linked` · `failed` · `opted_out`
- `tickets.inspection_status`: `pending` · `complete` · `incomplete` · `exception_approved`
- `tickets.payment_status`: `not_required` · `due` · `collected` · `waived`
- `tickets.vehicle_holder_type`: `customer` · `driver` · `spot` · `supervisor` · `unknown`
- `tickets.key_holder_type`: `customer` · `driver` · `key_slot` · `supervisor` · `unknown`

### 5.3 دورة الاسترجاع `retrieval_cycles`

- `request_source`: `whatsapp` · `staff` · `app`

> في الإصدار الثاني `app` طلب العميل من تطبيقه (`C-12`، V2-015، DEC-516): أمر زر «طلب السيارة» نفسه بفاعل العميل ومصدر مختلف.

- `outcome` (عند الإغلاق): `delivered` · `canceled` · `reparked`
- الدورة مفتوحة طالما `closed_at IS NULL` (دورة مفتوحة واحدة لكل تذكرة).

### 5.4 المهمة `tasks`

- `type`: `park` · `retrieve` · `repark`
- `status`: `queued` · `offered` · `broadcast` · `assigned_waiting` · `accepted` · `in_progress` · `completed` · `canceled`
- مهام `park` و`repark` تُنشأ مباشرة `in_progress` باسم السائق (دون عرض).
- «مهمة حركة نشطة» = `accepted` أو `in_progress`. «مهمة مفتوحة» = غير `completed`/`canceled`.
- توضيح على الوثيقة الأصلية: `expired` حالة **لجولة العرض** وليست للمهمة (انظر DEC-11).

### 5.5 العرض

- `task_offers.mode`: `single` · `broadcast`
- `task_offers.status`: `active` · `accepted` · `expired` · `revoked`
- `task_offers.close_reason`: `accepted` · `expired` · `claimed_elsewhere` · `task_canceled` · `reassigned` · `recipient_unavailable` · `converted_to_broadcast` · `converted_to_single` · `transfer`
- `offer_recipients.eligible_as`: `accept` · `reserve_next` · `view_only`
- `offer_recipients.response`: `accepted` · `rejected_late` (محاولة قبول بعد أن حجزها غيره، أي عند `TASK_ALREADY_CLAIMED` فقط — للتحليل)

### 5.6 حالة السائق المشتقة `driver_state` (تُحسب ولا تُخزن)

| القيمة | العربية | الشرط |
|---|---|---|
| `off_duty` | خارج الوردية | لا مناوبة مفتوحة |
| `on_break` | استراحة | `duty_sessions.status = on_break` |
| `available` | متاح | مناوبة `on_duty` ولا مهمة حركة نشطة ولا مهمة تالية |
| `intake_parking` | يسجل/يصف | لديه مهمة `park` أو `repark` بحالة `in_progress` |
| `retrieving` | يحضر/يسلّم | لديه مهمة `retrieve` بحالة `accepted` أو `in_progress` |
| `busy_with_next` | مشغول ولديه مهمة تالية | لديه مهمة حركة نشطة + مهمة `assigned_waiting` |

مؤشر الاتصال منفصل `duty_sessions.connection_state`: `online` · `uncertain` · `offline`. الاتصال لا يغيّر التوفر ولا يسحب المهام.

### 5.7 الكيانات التشغيلية الأخرى

- `events.status`: `draft` · `open` · `closing` · `closed` · `canceled`
- `events.pricing_mode`: `included` (خدمة مشمولة على القاعة/المضيف) · `per_vehicle` (رسوم تُحصّل عند التسليم)
- `shifts.status`: `scheduled` · `open` · `closed`
- `duty_sessions.status`: `on_duty` · `on_break` · `ended`
- `users.status`: `active` · `disabled` — `users.secret_kind`: `pin` (السائق) · `password` (المشرف/الإدارة/المالك)
- `driver_assignments.status`: `scheduled` · `active` · `ended`
- `driver_transfers.status`: `pending` · `blocked` · `completed` · `canceled`
- `link_codes.status`: `active` · `pending_confirmation` · `consumed` · `expired` · `revoked`
- `payments.method`: `cash` · `pos` — `payments.status`: `recorded` · `reversed`
- `incidents.type`: `key_missing` · `vehicle_damage` · `customer_absent` · `manual_verification` · `lost_ticket` · `payment_discrepancy` · `inspection_incomplete` · `wrong_vehicle` · `custody_mismatch` · `other`
- `incidents.status`: `open` · `in_review` · `resolved` · `closed` — `incidents.severity`: `low` · `medium` · `high`
- `alerts.status`: `open` · `acknowledged` · `resolved` — `alerts.severity`: `info` · `warning` · `critical`
- `alerts.type`: `no_drivers_on_duty` · `request_unaccepted` · `next_task_waiting_long` · `idle_driver_while_next_waiting` · `ready_not_collected` · `wa_send_failed` · `wa_channel_down` · `driver_connection_lost_with_custody` · `handover_code_locked` · `inspection_incomplete` · `draft_abandoned` · `transfer_blocked` · `outbox_lag` · `push_failed_repeatedly` · `task_stuck` · `wa_webhook_silent`
- `customer_consents.method`: `verbal_staff_confirmed` (موافقة شفهية أكدها الموظف) · `customer_initiated` (العميل أرسل رسالة الربط بنفسه)
- `customer_consents.revoke_source`: `customer_opt_out` · `staff` · `admin`
- `custody_events.subject`: `vehicle` · `key`
- `custody_events.reason`: `intake` · `parked` · `key_deposited` · `key_pickup` · `retrieval_start` · `handover` · `repark` · `official_transfer` · `withdrawal_release` · `manual_reconcile` · `correction`
- `media_assets.kind`: `photo_front` · `photo_rear` · `photo_left` · `photo_right` · `photo_extra` · `photo_damage`
- `media_assets.upload_status`: `pending` · `uploaded` · `failed` · `deleted`
- `whatsapp_messages.direction`: `outbound` · `inbound`
- `whatsapp_messages.status`: `queued` · `sent` · `delivered` · `read` · `failed` · `skipped` · `received` — الرتبة `status_rank`: queued=0, sent=1, delivered=2, read=3 (لا تُخفَّض الرتبة أبدًا؛ `failed` و`skipped` نهائيتان للرسالة الصادرة)
- `notifications.channel`: `whatsapp` · `push` — `notifications.status`: `pending` · `sent` · `failed` · `skipped`
- `outbox_events.status`: `pending` · `processing` · `done` · `failed` · `dead` · `canceled`
- `devices.notification_permission`: `default` · `granted` · `denied` · `unsupported`
- `devices.display_mode`: `browser` · `standalone`
- `devices.audio_test_result`: `heard` · `not_heard` · `blocked`
- `devices.platform`: `ios` · `android` · `desktop` · `other`
- `auth_sessions.revoked_reason` (يُرسل في `session.revoked`): `logout` · `transfer` · `disabled` · `secret_reset` · `admin` · `expired_cleanup`
- `duty_sessions.end_reason`: `self` · `forced` · `transfer` · `disabled` · `shift_closed`
- `tickets.vehicle_type`: `sedan` · `suv` · `pickup` · `van` · `other`
- `media_assets.content_type`: `image/jpeg` · `image/webp` · `image/heic` · `image/png`
- حالة كيانات الإعداد (`venues`، `dispatch_pools`، `parking_zones`، `parking_spots`، `key_boards`، `key_slots`): `active` · `inactive`
- `tasks.cancel_reason`: `customer_field_cancel` · `supervisor_cancel` · `repark_customer_absent` · `manual_reconcile` · `draft_discarded` · `ticket_voided`
- `retrieval_cycles.handover_method`: `code` · `paper_stub` · `supervisor_exception` · `manual_reconcile`
- `link_codes.revoke_reason`: `driver_rejected_match` · `regenerated` · `linked_direct` · `ticket_voided` · `channel_paper`
- `claim_codes.revoke_reason`: `resend` · `reparked` · `canceled` · `exception_handover` · `expired_cleanup`
- `spot_allocations.release_reason`: `retrieval_start` · `repark` · `correction` · `manual_reconcile` · `void` · `official_transfer` — `key_slot_allocations.release_reason`: `key_pickup` · `correction` · `manual_reconcile` · `void` · `official_transfer`
- `whatsapp_channel.mode`: `live` · `simulator` — `whatsapp_channel.health_status`: `healthy` · `degraded` · `down`
- `whatsapp_templates.category`: `UTILITY` · `MARKETING` · `AUTHENTICATION` — `whatsapp_templates.status`: `draft` · `pending` · `approved` · `rejected` · `paused` · `disabled`
- `whatsapp_messages.kind`: `template` · `session_text` · `inbound_text` · `inbound_button` · `inbound_interactive` · `inbound_other`
- `exports.kind`: `event_summary` · `tickets` · `payments` · `drivers` · `messages` · `audit` — `exports.status`: `pending` · `running` · `ready` · `failed` · `expired`
- أنواع إشعار Push للموظفين = معرّفات الأصوات (§13): `offer` · `broadcast` · `reminder` · `next_due` · `escalation`، إضافة إلى `closed` (إشعار هادئ بنفس الوسم يستبدل إشعار الطلب عند حجزه أو انتهائه أو سحبه أو إلغائه أو إعادة إسناده، DEC-23). لا أنواع غيرها.

قوائم مغلقة إضافية من المخطط (ملزمة كذلك):

- `notifications.skipped_reason`: `superseded` · `opted_out` · `no_consent` · `channel_down` · `stale` · `no_subscription`
- `notification_attempts.outcome`: `success` · `retryable_error` · `permanent_error`
- `media_assets.delete_reason`: `retention` · `correction` · `admin`
- `vehicle_inspections.kind`: `intake` · `handover` · `incident`
- `whatsapp_inbound_events.status`: `pending` · `processed` · `failed` · `ignored`
- `tickets.pending_retrieval_source`: `whatsapp` · `app` (الطلب المبكر من العميل فقط، DEC-25: زر واتساب، أو تطبيق العميل منذ V2-015، DEC-516)
- `analytics_events.source`: `server` · `client`
- `idempotency_keys.status`: `in_progress` · `completed`
- `action_tokens.action`: `request_retrieval`
- `customer_consents.channel`: `whatsapp`

قيم على مستوى الـAPI (ليست أعمدة):
- جسم `POST /v1/tickets/{ticketId}/whatsapp-link`: `method` = `direct` · `qr`
- جسم `POST /v1/tickets/{ticketId}/handover`: `verification.method` = `code` · `paper_stub`
- `TicketDetail.projection`: `minimal` · `full`
- جسم `POST /v1/tickets/{ticketId}/manual-reconcile`: `target_status` = `parked` · `delivered` · `voided`
- جسم `POST /v1/tickets/{ticketId}/submit-intake`: `acknowledge_incomplete_inspection` (boolean، DEC-31)
- جسم `POST /v1/staff`: `role` = `admin` · `supervisor` (المالك يُنشأ بالبذرة فقط)

توضيحات:
- `events.status`: يجوز الرجوع من `closing` إلى `open` بالأمر `POST /v1/events/{eventId}/open` إن وصلت مركبات بعد بدء الإقفال.
- `task_offers.close_reason`: `claimed_elsewhere` إصلاح دفاعي لجولة بقيت نشطة بعد حجز المهمة بطريق آخر؛ `converted_to_broadcast` و`converted_to_single` عند تحويل نوع الجولة (DEC-34).
- العملاء: `phone_e164` أو `wa_user_id` (أحدهما إلزامي) — مستخدمو أسماء واتساب قد يصلون بمعرّف BSUID دون رقم ظاهر (DEC-35).

---

## 6. الجداول (Tables)

التعريف الكامل بالقيود والفهارس في `06_schema.sql`، وشرحه في `06_ERD_Database_Schema.md`. الاصطلاحات: `snake_case`، مفاتيح `uuid`، أوقات `timestamptz`، القيم المحدودة `text + CHECK`، المبالغ بالهللة `*_halalas bigint`، عمود `version int` للتزامن المتفائل.

| # | الجدول | الغرض |
|---|---|---|
| 1 | `organizations` | المؤسسة وإعداداتها العامة `settings` |
| 2 | `venues` | المواقع/القاعات وإعداداتها `settings` (المؤقتات، التسعير الافتراضي، الفحص) |
| 3 | `dispatch_pools` | مجموعات التوزيع؛ واحدة افتراضية لكل موقع |
| 4 | `users` | الحسابات الدائمة لكل الأدوار، بيانات الدخول المشفرة، MFA |
| 5 | `role_scopes` | نطاقات المشرف/الإدارة على المواقع |
| 6 | `devices` | أجهزة المستخدم: اشتراك Web Push، إذن الإشعارات، اختبار الصوت، وضع العرض |
| 7 | `auth_sessions` | جلسات الدخول على الخادم (قابلة للإبطال فورًا) |
| 8 | `driver_assignments` | تعيينات السائق المؤرخة على المواقع؛ تعيين نشط واحد |
| 9 | `driver_transfers` | طلبات نقل السائق بين المواقع ونتيجتها |
| 10 | `events` | الحفلات وحالتها وتسعيرها وعداد أرقام التذاكر `next_display_number` |
| 11 | `shifts` | ورديات الموقع |
| 12 | `duty_sessions` | مناوبة السائق: الحالة، `available_since`، آخر نبضة، حالة الاتصال |
| 13 | `customers` | العملاء: الجوال المطبّع E.164، `wa_id`، آخر رسالة واردة، إلغاء الاشتراك |
| 14 | `customer_consents` | الموافقات على واتساب ومصدرها |
| 15 | `parking_zones` | مناطق الوقوف |
| 16 | `parking_spots` | المواقف المرقّمة |
| 17 | `key_boards` | لوحات المفاتيح |
| 18 | `key_slots` | خانات المفاتيح |
| 19 | `tickets` | التذاكر: المركبة، الحالة، الربط، العهدة الحالية، الدفع، الفاعلون |
| 20 | `ticket_events` | الخط الزمني الإلحاقي للتذكرة |
| 21 | `vehicle_inspections` | فحوص المركبة (عند الاستلام/التسليم/واقعة) |
| 22 | `media_assets` | صور خاصة في تخزين كائنات |
| 23 | `spot_allocations` | تخصيص المواقف (تخصيص نشط واحد للموقف وللتذكرة) |
| 24 | `key_slot_allocations` | تخصيص خانات المفاتيح (تخصيص نشط واحد للخانة وللتذكرة) |
| 25 | `custody_events` | سلسلة العهدة للمركبة والمفتاح |
| 26 | `retrieval_cycles` | دورات الاسترجاع وأزمنتها وفاعلوها |
| 27 | `tasks` | المهام وحالاتها؛ قيود الحركة الواحدة والمهمة التالية الواحدة |
| 28 | `task_offers` | جولات العرض؛ جولة نشطة واحدة للمهمة |
| 29 | `offer_recipients` | مستلمو كل جولة |
| 30 | `claim_codes` | رموز التسليم (هاش + نسخة مشفرة مؤقتة) |
| 31 | `link_codes` | رموز ربط QR |
| 32 | `action_tokens` | رموز زر «طلب السيارة» |
| 33 | `whatsapp_channel` | إعداد القناة الوحيد الفعّال (مراجع الأسرار فقط) |
| 34 | `whatsapp_templates` | القوالب وحالة اعتمادها |
| 35 | `whatsapp_messages` | كل رسالة صادرة/واردة وحالتها لدى المزود |
| 36 | `whatsapp_inbound_events` | الطلبات الخام الواردة للـWebhook قبل المعالجة |
| 37 | `notifications` | كل إشعار مقصود لمستلم على قناة (whatsapp/push) |
| 38 | `notification_attempts` | محاولات الإرسال وأخطاء المزود |
| 39 | `payments` | التحصيلات وعكسها |
| 40 | `cash_handovers` | تسليم نقد السائق للمشرف |
| 41 | `incidents` | الوقائع الداخلية |
| 42 | `alerts` | تنبيهات المشرف |
| 43 | `outbox_events` | الأحداث والمهام المؤجلة والمؤقتات (مصدر عمل العامل) |
| 44 | `idempotency_keys` | مفاتيح منع التكرار ونتائجها المحفوظة |
| 45 | `audit_log` | سجل التدقيق الإلحاقي لكل أمر |
| 46 | `analytics_events` | أحداث القياس (خادم + عميل) |
| 47 | `exports` | ملفات التصدير المؤقتة |

---

## 7. الأحداث (Domain events) وأنواع المهام المؤجلة

غلاف الحدث (Outbox وWebSocket):

```json
{
  "id": "uuid",
  "type": "task.claimed",
  "occurred_at": "2026-10-27T19:20:00.000Z",
  "org_id": "uuid", "venue_id": "uuid", "dispatch_pool_id": "uuid", "event_id": "uuid",
  "aggregate": { "type": "task", "id": "uuid", "version": 4 },
  "actor": { "type": "user", "id": "uuid" },
  "payload": {}
}
```

### 7.1 أحداث النطاق (تُكتب في `outbox_events` بنفس معاملة التغيير)

- التذكرة: `ticket.created` · `ticket.intake_submitted` · `ticket.parked` · `ticket.retrieval_requested` · `ticket.retrieval_requested_early` · `ticket.assigned` · `ticket.assigned_waiting` · `ticket.retrieving` · `ticket.ready` · `ticket.delivered` · `ticket.reparking` · `ticket.retrieval_canceled` · `ticket.voided` · `ticket.customer_phone_changed` · `ticket.wa_link_changed` · `ticket.inspection_completed` · `ticket.inspection_exception_approved` · `ticket.manually_reconciled`
- المهمة: `task.created` · `task.offered` · `task.broadcast_opened` · `task.broadcast_extended` · `task.claimed` · `task.promoted` · `task.key_picked_up` · `task.started` · `task.completed` · `task.canceled` · `task.withdrawn` · `task.reassigned` · `task.escalated`
- العرض: `offer.reminded` · `offer.expired` · `offer.revoked`
- السائق: `driver.duty_started` · `driver.break_started` · `driver.break_ended` · `driver.duty_ended` · `driver.availability_changed` · `driver.connection_changed` · `driver.transfer_requested` · `driver.transfer_blocked` · `driver.transferred` · `driver.disabled` · `driver.enabled`
- العهدة: `custody.changed`
- التسليم: `handover.code_issued` · `handover.code_attempt_failed` · `handover.code_locked` · `handover.completed` · `handover.exception_approved`
- الدفع: `payment.recorded` · `payment.reversed` · `payment.waived` · `cash.handover_recorded` · `payment.online_paid` · `payment.online_refunded`
- التنبيهات والوقائع: `alert.raised` · `alert.acknowledged` · `alert.resolved` · `incident.opened` · `incident.updated` · `incident.resolved`
- الحفل والوردية: `event.opened` · `event.closing_started` · `event.closed` · `shift.opened` · `shift.closed` (إلغاء حفل `draft` تدقيق فقط بلا حدث نطاقي)
- واتساب: `wa.inbound_received` · `wa.button_pressed` · `wa.message_status_changed` · `wa.channel_health_changed` · `wa.customer_opted_out`

### 7.2 أنواع المهام المؤجلة (Jobs) في `outbox_events.type`

`job.dispatch_pass` · `job.dispatch_sweep` · `job.offer_remind` · `job.offer_expire` · `job.broadcast_remind` · `job.escalate_unaccepted` · `job.next_task_wait_check` · `job.ready_uncollected_check` · `job.claim_code_expire` · `job.link_code_expire` · `job.transfer_activate` · `job.wa_send` · `job.wa_process_inbound` · `job.push_send` · `job.ws_publish` · `job.heartbeat_sweep` · `job.retention_purge` · `job.export_generate` · `job.customer_otp_send` · `job.payment_webhook_process` · `job.payment_refund_send` · `job.payments_reconcile` · `job.customer_push_send` · `job.customer_push_receipts` · `job.payment_method_token_delete`

> الإصدار الثاني (V2-010، DEC-496): `job.customer_otp_send` يرسل رمز دخول تطبيق العميل بقالب المصادقة على رقم بوينت بعد COMMIT (المعاملة تكتب الرمز مجزأً ونسخته المشفرة الوحيدة وصف outbox فقط).

> الإصدار الثاني (V2-021، DEC-512 … DEC-514): `job.payment_webhook_process` يعالج تسليم Webhook بوابة الدفع المخزَّن مرة واحدة (يقرأ الدفعة من البوابة خارج أي معاملة ثم يطبقها)؛ `job.payment_refund_send` يرسل الاسترداد للبوابة بعد COMMIT؛ `job.payments_reconcile` المطابقة اليومية مع البوابة (`PAYMENTS_RECONCILE_CRON_UTC`).

> الإصدار الثاني (V2-016، DEC-519): `job.customer_push_send` يرسل إشعار تطبيق العميل بعد COMMIT (المعاملة تكتب صف `customer_push_messages` بالمعرّفات فقط)؛ `job.customer_push_receipts` يقرأ إيصالات التسليم من المزود لاحقًا ويُسقط رمز الجهاز غير المسجل.
> الإصدار الثاني (V2-022/V2-023، DEC-522، DEC-524): `payment.online_paid` دفعة إلكترونية لزيارة صارت `paid` فصارت التذكرة `collected` بأهلية `app_paid` (في معاملة انتقال الدفعة نفسها، يكتبها العامل بعد قراءة البوابة أو رد إنشاء بلا 3-D Secure)؛ `payment.online_refunded` استرداد كامل لتلك الدفعة قبل التسليم أعاد التذكرة `due` بأهلية `none`. `job.payment_method_token_delete` يحذف رمز بطاقة محفوظة لدى البوابة بعد COMMIT إزالتها (C-18 أو حذف الحساب).

كل مؤقت يحمل `version` الكيان وقت الجدولة؛ عند التنفيذ يُعاد التحقق، وإن تغيّر الكيان يُنهى المؤقت دون أثر.

### 7.3 الاتصال الفوري (WebSocket عبر Socket.IO على المسار `/ws`)

الغرف (يقرر الخادم الانضمام إليها بعد التحقق، والعميل لا يختار):
`user:{userId}` · `pool:{poolId}:drivers` · `venue:{venueId}:supervisors` · `org:{orgId}:admins`

من الخادم إلى العميل:
`task.offered` · `task.broadcast` · `task.claimed` · `task.updated` · `offer.reminder` · `offer.closed` · `ticket.updated` · `driver.state_changed` · `alert.raised` · `alert.updated` · `incident.updated` · `channel.status` · `sync.required` · `session.revoked`

من العميل إلى الخادم:
`client.heartbeat` (الحمولة: `visible: boolean`، `audio_unlocked: boolean`، `last_event_id`، `app_version`؛ والبديل HTTP `POST /v1/me/heartbeat` بالحقول نفسها مع `ws_connected`) · `client.offer_seen`

---

## 8. رموز الأخطاء (Error codes)

الغلاف الموحد:

```json
{ "error": { "code": "TASK_ALREADY_CLAIMED", "message": "Task already claimed", "message_ar": "تم قبول الطلب من سائق آخر", "request_id": "req_01J...", "retryable": false, "details": {} } }
```

| الرمز | HTTP | المعنى |
|---|---|---|
| `AUTH_UNAUTHENTICATED` | 401 | لا توجد جلسة |
| `AUTH_INVALID_CREDENTIALS` | 401 | بيانات الدخول غير صحيحة |
| `AUTH_ACCOUNT_DISABLED` | 403 | الحساب معطّل |
| `AUTH_ACCOUNT_LOCKED` | 423 | مقفل مؤقتًا لكثرة المحاولات |
| `AUTH_MFA_REQUIRED` | 401 | خطوة التحقق الثنائي انتهت أو غير صالحة (`mfa_token` منتهٍ/مستخدم)؛ أعد الدخول |
| `AUTH_MFA_INVALID` | 401 | رمز التحقق الثنائي غير صحيح |
| `AUTH_MFA_SETUP_REQUIRED` | 403 | يجب إعداد التحقق الثنائي أولًا |
| `AUTH_SECRET_CHANGE_REQUIRED` | 403 | يجب تغيير الرقم السري/كلمة المرور |
| `AUTH_SESSION_EXPIRED` | 401 | انتهت الجلسة |
| `AUTH_SESSION_REVOKED` | 401 | أُنهيت الجلسة (نقل/تعطيل/خروج) |
| `PERMISSION_DENIED` | 403 | لا تملك الصلاحية |
| `SCOPE_VENUE_DENIED` | 403 | المورد خارج نطاق موقعك |
| `ASSIGNMENT_REQUIRED` | 403 | لا يوجد تعيين نشط لك على هذا الموقع |
| `DUTY_REQUIRED` | 409 | ابدأ ورديتك أولًا |
| `NOT_TASK_ASSIGNEE` | 403 | المهمة ليست مسندة إليك |
| `NOT_OFFER_RECIPIENT` | 403 | العرض لم يُرسل إليك |
| `RESOURCE_NOT_FOUND` | 404 | المورد غير موجود (تفاصيل `resource`) |
| `TICKET_NOT_FOUND` | 404 | التذكرة غير موجودة |
| `OFFER_NOT_FOUND` | 404 | العرض غير موجود |
| `VALIDATION_FAILED` | 422 | مدخلات غير صالحة (تفاصيل `fields`) |
| `PHONE_INVALID` | 422 | رقم الجوال غير صالح |
| `PLATE_INVALID` | 422 | رقم اللوحة غير صالح |
| `CONSENT_REQUIRED` | 422 | لا يُرسل واتساب دون موافقة العميل |
| `REASON_REQUIRED` | 422 | هذا الإجراء يتطلب سببًا |
| `PAGINATION_CURSOR_INVALID` | 400 | مؤشر الصفحات غير صالح |
| `VERSION_CONFLICT` | 409 | السجل تغيّر؛ حدّث الشاشة |
| `IDEMPOTENCY_KEY_REQUIRED` | 428 | مفتاح التكرار مطلوب |
| `IDEMPOTENCY_KEY_REUSED` | 422 | نفس المفتاح بمحتوى مختلف |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | الطلب نفسه ما زال قيد التنفيذ |
| `INVALID_STATE_TRANSITION` | 409 | الإجراء غير مسموح في الحالة الحالية |
| `DRIVER_NOT_AVAILABLE` | 409 | لديك مهمة جارية |
| `DRIVER_ON_BREAK` | 409 | أنت في استراحة |
| `DUTY_ALREADY_STARTED` | 409 | ورديتك بدأت بالفعل |
| `DUTY_END_BLOCKED_CUSTODY` | 409 | لا يمكن إنهاء الوردية وبعهدتك مركبة أو مفتاح أو مهمة |
| `SHIFT_NOT_OPEN` | 409 | لا توجد وردية مفتوحة في الموقع |
| `EVENT_NOT_OPEN` | 409 | الحفل غير مفتوح |
| `OFFER_EXPIRED` | 410 | انتهى العرض |
| `OFFER_REVOKED` | 410 | سُحب العرض |
| `TASK_ALREADY_CLAIMED` | 409 | قبل الطلب سائق آخر |
| `OLDER_REQUEST_PENDING` | 409 | يوجد طلب أقدم يجب قبوله أولًا (تفاصيل `older_task_id`) |
| `NEXT_TASK_ALREADY_RESERVED` | 409 | لديك مهمة تالية محجوزة |
| `MOVEMENT_IN_PROGRESS` | 409 | لا يمكن بدء حركة ثانية قبل إنهاء الحالية |
| `TASK_NOT_STARTABLE` | 409 | المهمة غير قابلة للبدء الآن |
| `REASSIGN_BLOCKED_MOVEMENT` | 409 | بدأت الحركة؛ لا إعادة إسناد آلية |
| `CUSTODY_RELEASE_REQUIRED` | 409 | يلزم إقرار إعادة المفتاح قبل السحب |
| `RETRIEVAL_ALREADY_ACTIVE` | 409 | يوجد طلب إحضار نشط لهذه التذكرة |
| `TICKET_NOT_PARKED` | 409 | المركبة ليست متوقفة |
| `TICKET_CLOSED` | 409 | التذكرة مغلقة (مسلّمة أو ملغاة) |
| `INTAKE_INCOMPLETE` | 422 | بيانات الاستلام ناقصة (تفاصيل `missing`) |
| `INSPECTION_INCOMPLETE` | 409 | الفحص غير مكتمل؛ يلزم اعتماد مشرف |
| `DRAFT_HAS_DATA` | 409 | المسودة فيها بيانات؛ يلزم إلغاء بمشرف |
| `PAPER_SERIAL_IN_USE` | 409 | رقم التذكرة الورقية مستخدم في هذا الحفل |
| `KEY_TAG_IN_USE` | 409 | رقم علاقة المفتاح مستخدم لتذكرة مفتوحة |
| `KEY_SLOT_OCCUPIED` | 409 | خانة المفتاح مشغولة |
| `PARKING_SPOT_OCCUPIED` | 409 | الموقف مشغول |
| `KEY_NOT_PICKED_UP` | 409 | أكّد استلام المفتاح أولًا |
| `CUSTODY_HOLDER_MISMATCH` | 409 | العهدة ليست لديك |
| `CUSTODY_OPEN` | 409 | توجد عهدة مفتوحة (تفاصيل `items`) |
| `HANDOVER_NOT_READY` | 409 | المركبة ليست في حالة جاهزة |
| `HANDOVER_CODE_INVALID` | 422 | رمز التسليم غير صحيح (تفاصيل `attempts_left`) |
| `HANDOVER_CODE_EXPIRED` | 410 | انتهت صلاحية رمز التسليم |
| `HANDOVER_CODE_LOCKED` | 423 | تجاوزت المحاولات؛ يلزم المشرف |
| `HANDOVER_CODE_CONSUMED` | 409 | الرمز استُخدم سابقًا |
| `PAPER_STUB_MISMATCH` | 422 | رقم كعب التذكرة الورقية لا يطابق |
| `RESEND_LIMIT_REACHED` | 429 | تجاوزت حد إعادة إرسال الرمز |
| `PAYMENT_PENDING` | 409 | سجّل التحصيل قبل التسليم |
| `PAYMENT_AMOUNT_MISMATCH` | 422 | المبلغ لا يطابق رسوم الحفل |
| `PAYMENT_METHOD_NOT_ALLOWED` | 422 | وسيلة التحصيل غير مسموحة في هذا الحفل |
| `PAYMENT_ALREADY_RECORDED` | 409 | التحصيل مسجّل مسبقًا |
| `PAYMENT_ALREADY_REVERSED` | 409 | التحصيل معكوس مسبقًا |
| `TRANSFER_BLOCKED_CUSTODY` | 409 | لا يُنقل السائق وبعهدته مركبة أو مفتاح أو مهمة جارية |
| `TRANSFER_SCOPE_DENIED` | 403 | النقل يحتاج صلاحية على الموقعين |
| `TRANSFER_ALREADY_PENDING` | 409 | يوجد طلب نقل مفتوح لهذا السائق |
| `ASSIGNMENT_CONFLICT` | 409 | يوجد تعيين نشط آخر |
| `DRIVER_DISABLED` | 409 | حساب السائق معطّل |
| `EVENT_CLOSE_BLOCKED` | 409 | لا يُغلق الحفل وفيه عهدة/طلبات/تحصيل مفتوح (تفاصيل) |
| `EVENT_ALREADY_CLOSED` | 409 | الحفل مغلق |
| `SHIFT_CLOSE_BLOCKED` | 409 | سائقون بعهدتهم عناصر أو لديهم مهام مفتوحة (بقية المناوبات تُنهى آليًا) |
| `SHIFT_ALREADY_OPEN` | 409 | توجد وردية مفتوحة لمجموعة التوزيع نفسها |
| `WA_CONSENT_MISSING` | 409 | لا توجد موافقة سارية للعميل |
| `WA_NOT_LINKED` | 409 | التذكرة غير مربوطة بواتساب |
| `WA_LINK_CODE_EXPIRED` | 410 | انتهت صلاحية رمز الربط |
| `WA_CUSTOMER_OPTED_OUT` | 409 | العميل أوقف رسائل واتساب |
| `WA_TEMPLATE_NOT_APPROVED` | 409 | القالب غير معتمد |
| `WA_CHANNEL_UNAVAILABLE` | 503 | قناة واتساب متعطلة حاليًا |
| `WA_SEND_FAILED` | 502 | فشل الإرسال لدى المزود |
| `WA_WEBHOOK_SIGNATURE_INVALID` | 401 | توقيع Webhook غير صالح |
| `WA_WEBHOOK_VERIFY_FAILED` | 403 | فشل تحقق إعداد Webhook |
| `MEDIA_TOO_LARGE` | 413 | الصورة أكبر من الحد |
| `MEDIA_TYPE_UNSUPPORTED` | 415 | نوع الملف غير مدعوم |
| `MEDIA_UPLOAD_INCOMPLETE` | 409 | لم يكتمل رفع الصورة |
| `PAYLOAD_TOO_LARGE` | 413 | جسم الطلب أكبر من الحد المسموح |
| `RATE_LIMITED` | 429 | طلبات كثيرة؛ حاول بعد قليل |
| `INTERNAL_ERROR` | 500 | خطأ غير متوقع |
| `SERVICE_UNAVAILABLE` | 503 | الخدمة غير متاحة مؤقتًا |
| `DEPENDENCY_TIMEOUT` | 504 | انتهت مهلة خدمة خارجية |
| `PLATFORM_AUTH_REQUIRED` | 401 | الإصدار الثاني: لا توجد جلسة منصة صالحة لمسار `/v1/platform/*` (لا كوكي منصة، أو كوكي موظفين فقط)؛ جلسة الموظف لا تفتح مسار المنصة ولا العكس (DEC-462) |
| `OPERATOR_SUSPENDED` | 409 | الإصدار الثاني: المشغّل (المؤسسة) معلّق أو منتهٍ من المنصة، فلا يُفتح حفل ولا وردية ولا مناوبة ولا استلام جديد (02 §4 في `docs/v2`، V2-005، DEC-466، DEC-486) |
| `PAYMENT_FAILED` | 402 | الإصدار الثاني: رفضت بوابة الدفع العملية أو لم تقبل وسيلة الدفع؛ حالة الدفعة `failed` محفوظة (V2-020، DEC-512) |
| `PAYMENT_NOT_REFUNDABLE` | 409 | الإصدار الثاني: الدفعة الإلكترونية ليست `paid` ولا `partially_refunded` فلا تُسترد (V2-021، DEC-513) |
| `REFUND_AMOUNT_EXCEEDS_PAID` | 409 | الإصدار الثاني: الاسترداد مع ما سبقه وما ينتظر أكبر من المدفوع (V2-021، DEC-513) |
| `PAYMENT_WEBHOOK_SIGNATURE_INVALID` | 401 | سر Webhook بوابة الدفع غير صالح |
| `PASS_INVALID` | 422 | الإصدار الثاني: بطاقة الدخول الممسوحة ليست بطاقة بوينت صالحة (صيغة أو توقيع أو حساب غير نشط)، `POST /v1/tickets/intake-pass` (O-01، V2-013، DEC-500) |
| `PASS_EXPIRED` | 410 | الإصدار الثاني: بطاقة الدخول خارج نافذة الخطوة الحالية ± 1 (30 ث) أو استُعملت خطوتها لاستلام سابق (DEC-500) |

---

## 9. مسارات API

الأساس `/v1`. الجلسة عبر كوكي `httpOnly` آمن. `Idempotency-Key` إلزامي (✓) لكل أمر تشغيلي؛ اختياري للباقي. الصلاحيات من §10.

### 9.1 الدخول والجلسة والجهاز

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| POST | `/v1/auth/login` | عام | — |
| POST | `/v1/auth/mfa/verify` | عام (رمز MFA مؤقت) | — |
| POST | `/v1/auth/mfa/setup` | `auth.self` | — |
| POST | `/v1/auth/mfa/confirm` | `auth.self` | — |
| POST | `/v1/auth/secret/change` | `auth.self` | — |
| POST | `/v1/auth/logout` | `auth.self` | — |
| GET | `/v1/me` | `auth.self` | — |
| GET | `/v1/me/home` | `duty.self` | — |
| POST | `/v1/me/devices` | `auth.self` | — |
| PUT | `/v1/me/devices/{deviceId}` | `auth.self` | — |
| POST | `/v1/me/audio-test` | `auth.self` | — |
| POST | `/v1/me/duty/start` | `duty.self` | ✓ |
| POST | `/v1/me/duty/break` | `duty.self` | ✓ |
| POST | `/v1/me/duty/end` | `duty.self` | ✓ |
| POST | `/v1/me/heartbeat` | `auth.self` | — |

### 9.2 الاستلام والتذاكر

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| POST | `/v1/tickets` | `ticket.intake` | ✓ |
| POST | `/v1/tickets/intake-pass` | `ticket.intake` | ✓ |
| PATCH | `/v1/tickets/{ticketId}/intake` | `ticket.intake` | ✓ |
| POST | `/v1/tickets/{ticketId}/media` | `ticket.intake` | ✓ |
| POST | `/v1/media/{mediaId}/complete` | `ticket.intake` | ✓ |
| GET | `/v1/media/{mediaId}/url` | `ticket.read_photos` | — |
| POST | `/v1/tickets/{ticketId}/submit-intake` | `ticket.intake` | ✓ |
| POST | `/v1/tickets/{ticketId}/discard-draft` | `ticket.discard_empty_draft` | ✓ |
| POST | `/v1/tickets/{ticketId}/void` | `ticket.void` | ✓ |
| POST | `/v1/tickets/{ticketId}/inspection-exception` | `ticket.inspection_exception` | ✓ |
| POST | `/v1/tickets/{ticketId}/whatsapp-link` | `wa.link` | ✓ |
| POST | `/v1/tickets/{ticketId}/whatsapp-link/confirm` | `wa.link` | ✓ |
| PATCH | `/v1/tickets/{ticketId}/customer-phone` | `ticket.change_phone` | ✓ |
| POST | `/v1/tickets/{ticketId}/reveal-phone` | `ticket.reveal_phone` | ✓ |
| GET | `/v1/tickets` | `ticket.read_minimal` | — |
| GET | `/v1/tickets/{ticketId}` | `ticket.read_minimal` (+ حقول حسب `ticket.read_full`) | — |
| GET | `/v1/tickets/{ticketId}/timeline` | `ticket.read_full` | — |

### 9.3 الصف والاسترجاع والتسليم

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| POST | `/v1/tasks/{taskId}/complete-parking` | `task.execute` | ✓ |
| POST | `/v1/tickets/{ticketId}/retrievals` | `retrieval.request_on_behalf` | ✓ |
| POST | `/v1/retrieval-cycles/{cycleId}/cancel` | `retrieval.cancel` | ✓ |
| POST | `/v1/task-offers/{offerId}/accept` | `offer.accept` | ✓ |
| POST | `/v1/tasks/{taskId}/key-pickup` | `task.execute` | ✓ |
| POST | `/v1/tasks/{taskId}/start-retrieval` | `task.execute` | ✓ |
| POST | `/v1/tasks/{taskId}/ready` | `task.execute` | ✓ |
| POST | `/v1/tickets/{ticketId}/handover` | `handover.verify` | ✓ |
| POST | `/v1/tickets/{ticketId}/handover-code/resend` | `handover.resend_code` | ✓ |
| POST | `/v1/tickets/{ticketId}/handover-exception` | `handover.exception` | ✓ |
| POST | `/v1/tasks/{taskId}/reassign` | `task.reassign` | ✓ |
| POST | `/v1/tasks/{taskId}/release-custody` | `task.release_custody` | ✓ |
| POST | `/v1/tickets/{ticketId}/repark` | `ticket.repark` | ✓ |
| POST | `/v1/tickets/{ticketId}/custody-transfers` | `ticket.custody_transfer` | ✓ |
| POST | `/v1/tickets/{ticketId}/manual-reconcile` | `ticket.manual_reconcile` | ✓ |

### 9.4 التحصيل

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| POST | `/v1/tickets/{ticketId}/payments` | `payment.record` | ✓ |
| POST | `/v1/payments/{paymentId}/reverse` | `payment.reverse` | ✓ |
| POST | `/v1/tickets/{ticketId}/payment-waiver` | `payment.waive` | ✓ |
| POST | `/v1/cash-handovers` | `cash.handover_confirm` | ✓ |
| GET | `/v1/events/{eventId}/settlement` | `report.read` | — |

### 9.5 المواقع والحفلات والورديات

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| GET / POST | `/v1/venues` | `venue.read` / `venue.manage` | ✓ (POST) |
| GET / PATCH | `/v1/venues/{venueId}` | `venue.read` / `venue.manage` | ✓ (PATCH) |
| GET / PUT | `/v1/venues/{venueId}/settings` | `venue.read` / `venue.manage` | ✓ (PUT) |
| GET / PUT | `/v1/venues/{venueId}/public-profile` | `venue.manage` | ✓ (PUT) |
| POST | `/v1/venues/{venueId}/public-profile/photos` | `venue.manage` | ✓ |
| POST | `/v1/venues/{venueId}/public-profile/submit` | `venue.manage` | ✓ |
| GET / POST | `/v1/venues/{venueId}/dispatch-pools` | `venue.read` / `venue.manage` | ✓ (POST) |
| PATCH | `/v1/dispatch-pools/{poolId}` | `venue.manage` | ✓ |
| GET / POST | `/v1/venues/{venueId}/parking-zones` | `venue.layout_read` / `venue.manage` | ✓ (POST) |
| PATCH | `/v1/parking-zones/{zoneId}` | `venue.manage` | ✓ |
| GET / POST | `/v1/venues/{venueId}/parking-spots` | `venue.layout_read` / `venue.manage` | ✓ (POST، يدعم الإنشاء الجماعي) |
| PATCH | `/v1/parking-spots/{spotId}` | `venue.manage` | ✓ |
| GET / POST | `/v1/venues/{venueId}/key-boards` | `venue.layout_read` / `venue.manage` | ✓ (POST) |
| POST | `/v1/key-boards/{boardId}/slots` | `venue.manage` | ✓ |
| PATCH | `/v1/key-slots/{slotId}` | `venue.manage` | ✓ |
| GET / POST | `/v1/venues/{venueId}/events` | `event.manage` | ✓ (POST) |
| GET / PATCH | `/v1/events/{eventId}` | `event.manage` | ✓ (PATCH) |
| POST | `/v1/events/{eventId}/open` | `event.manage` | ✓ |
| POST | `/v1/events/{eventId}/start-closing` | `event.manage` | ✓ |
| GET | `/v1/events/{eventId}/reconciliation` | `event.manage` | — |
| POST | `/v1/events/{eventId}/close` | `event.manage` | ✓ |
| POST | `/v1/events/{eventId}/cancel` | `event.manage` | ✓ |
| GET | `/v1/events/{eventId}/operations` | `alert.read` | — |
| GET / POST | `/v1/venues/{venueId}/shifts` | `shift.manage` | ✓ (POST) |
| POST | `/v1/shifts/{shiftId}/open` | `shift.manage` | ✓ |
| POST | `/v1/shifts/{shiftId}/close` | `shift.manage` | ✓ |

### 9.6 السائقون والموظفون

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| GET | `/v1/drivers` | `driver.read` | — |
| POST | `/v1/drivers` | `driver.manage` | ✓ |
| GET / PATCH | `/v1/drivers/{driverId}` | `driver.read` / `driver.manage` | ✓ (PATCH) |
| POST | `/v1/drivers/{driverId}/disable` | `driver.manage` | ✓ |
| POST | `/v1/drivers/{driverId}/enable` | `driver.manage` | ✓ |
| POST | `/v1/drivers/{driverId}/reset-secret` | `driver.manage` | ✓ |
| GET | `/v1/drivers/{driverId}/assignments` | `driver.read` | — |
| POST | `/v1/drivers/{driverId}/assignments` | `driver.assign` | ✓ |
| POST | `/v1/drivers/{driverId}/transfers` | `driver.transfer` | ✓ |
| POST | `/v1/transfers/{transferId}/cancel` | `driver.transfer` | ✓ |
| POST | `/v1/duty-sessions/{sessionId}/force-end` | `duty.force_end` | ✓ |
| GET / POST | `/v1/staff` | `staff.manage` | ✓ (POST) |
| PATCH | `/v1/staff/{userId}` | `staff.manage` | ✓ |
| POST | `/v1/staff/{userId}/scopes` | `staff.manage` | ✓ |
| POST | `/v1/staff/{userId}/reset-mfa` | `staff.manage` | ✓ |

### 9.7 التنبيهات والوقائع والتقارير والإدارة

| الطريقة | المسار | الصلاحية | تكرار |
|---|---|---|---|
| GET | `/v1/alerts` | `alert.read` | — |
| POST | `/v1/alerts/{alertId}/acknowledge` | `alert.manage` | ✓ |
| POST | `/v1/alerts/{alertId}/resolve` | `alert.manage` | ✓ |
| GET / POST | `/v1/incidents` | `incident.read` / `incident.create` | ✓ (POST) |
| GET / PATCH | `/v1/incidents/{incidentId}` | `incident.read` / `incident.manage` | ✓ (PATCH) |
| GET | `/v1/reports/events/{eventId}/summary` | `report.read` | — |
| GET | `/v1/reports/drivers` | `report.read` | — |
| GET | `/v1/reports/payments` | `report.read` | — |
| GET | `/v1/reports/messages` | `report.read` | — |
| POST | `/v1/exports` | `export.create` | ✓ |
| GET | `/v1/exports/{exportId}` | `export.create` | — |
| GET | `/v1/admin/whatsapp/channel` | `wa.channel_read` | — |
| PUT | `/v1/admin/whatsapp/channel` | `wa.channel_manage` | ✓ |
| GET | `/v1/admin/whatsapp/templates` | `wa.channel_read` | — |
| POST | `/v1/admin/whatsapp/templates/sync` | `wa.templates_manage` | ✓ |
| GET | `/v1/admin/outbox` | `outbox.manage` | — |
| POST | `/v1/admin/outbox/{outboxId}/retry` | `outbox.manage` | ✓ |
| GET | `/v1/admin/audit-log` | `audit.read` | — |
| GET / PUT | `/v1/admin/retention-policy` | `audit.read` / `retention.manage` | ✓ (PUT) |
| GET / PUT | `/v1/admin/org-settings` | `org.settings_manage` | ✓ (PUT) |
| POST | `/v1/telemetry` | `telemetry.write` | — |

### 9.8 Webhooks والصحة

| الطريقة | المسار | الحماية |
|---|---|---|
| GET | `/webhooks/whatsapp` | تحقق `hub.verify_token` |
| POST | `/webhooks/whatsapp` | توقيع `X-Hub-Signature-256` على الجسم الخام |
| POST | `/webhooks/payments/moyasar` | الإصدار الثاني (V2-021، DEC-511): سر الـWebhook المشترك (`secret_token`) في الجسم الخام، بمقارنة زمن ثابت |
| GET | `/health/live` · `/health/ready` | عام (بلا بيانات) |
| GET | `/metrics` | شبكة داخلية فقط |

الجلسة: كوكي `__Host-point_sid` (`HttpOnly; Secure; SameSite=Lax; Path=/`) والتطبيق والـAPI من أصل واحد في الإنتاج؛ كل طريقة غير آمنة (POST/PUT/PATCH/DELETE) تحمل الترويسة `X-Requested-With: point-web` (حماية CSRF).

اصطلاحات الطلب/الرد: `{ "data": ..., "meta": { "request_id", "server_time", "next_cursor"? } }` · ترقيم بالمؤشر `?limit=&cursor=` · الأوامر على تذكرة/مهمة تقبل `expected_version`، وهو إلزامي في `PATCH` للكيانات ذات عمود `version` (التذاكر، الحفلات، الورديات، المستخدمون، الوقائع، إعدادات الموقع)؛ كيانات التخطيط (مجموعات التوزيع، المناطق، المواقف، الخانات) بلا `version` · الأوقات ISO‑8601 UTC.

---

## 10. الصلاحيات (Permissions)

الرموز: O مالك · A إدارة · S مشرف (ضمن مواقع نطاقه) · D سائق (موقع تعيينه النشط، وغالبًا أثناء المناوبة). «D*» = السائق أو المشرف الذي `can_drive = true` أثناء مناوبته.

| الصلاحية | O | A | S | D | الشرط الإضافي |
|---|---|---|---|---|---|
| `auth.self` | ✓ | ✓ | ✓ | ✓ | حسابه فقط |
| `duty.self` | — | — | D* | ✓ | تعيين نشط (أو نطاق للمشرف)؛ بدء المناوبة وحده يشترط وردية مفتوحة، والقراءة (`GET /v1/me/home`) تعمل دونها |
| `ticket.intake` | — | — | D* | ✓ | أثناء المناوبة، حفل مفتوح في موقعه؛ تعديل المسودة لمنشئها في `received`، ورفع الصور له في `received` أو `parking` (مسارا الصور بلا فحص مناوبة أو حفل، وإتمام الرفع لرافعه في أي حالة: DEC-103، DEC-104)، وتحويل القناة إلى ورقية له في `parking` (DEC-40) |
| `ticket.read_minimal` | ✓ | ✓ | ✓ | ✓ | السائق: تذاكر موقعه المفتوحة فقط وحقول دنيا |
| `ticket.read_full` | ✓ | ✓ | ✓ | ✓ | السائق: فقط المكلّف بمهمة مفتوحة على التذكرة أو منشئها أثناء التسجيل |
| `ticket.read_photos` | ✓ | ✓ | ✓ | ✓ | كشرط `ticket.read_full` |
| `ticket.reveal_phone` | ✓ | ✓ | ✓ | — | سبب إلزامي + تدقيق |
| `ticket.change_phone` | — | ✓ | ✓ | ✓ | السائق: منشئ التذكرة أو المكلّف، بتحقق ميداني وسبب؛ يبطل الرموز السابقة |
| `ticket.discard_empty_draft` | — | — | — | ✓ | مسودته الخالية من البيانات فقط |
| `ticket.void` | — | ✓ | ✓ | — | سبب إلزامي؛ التذكرة `received` أو `parking` فقط (DEC-45) |
| `ticket.inspection_exception` | — | — | ✓ | — | سبب إلزامي |
| `ticket.repark` | — | — | ✓ | — | التذكرة `ready` |
| `ticket.custody_transfer` | — | — | ✓ | — | سبب إلزامي |
| `ticket.manual_reconcile` | — | ✓ | ✓ | — | بعد انقطاع؛ دليل وسبب |
| `wa.link` | — | — | ✓ | ✓ | السائق أثناء المناوبة في موقع التذكرة |
| `retrieval.request_on_behalf` | — | — | ✓ | ✓ | سبب إلزامي؛ التذكرة `parked` فقط (DEC-25) |
| `retrieval.cancel` | — | — | ✓ | ✓ | السائق: قبل الإسناد فقط؛ المشرف: في أي حالة قبل التسليم، وبعد بدء الحركة يتحول الطلب إلى إعادة صف مع السائق نفسه (DEC-30) |
| `offer.accept` | — | — | D* | ✓ | مستلم العرض وأثناء المناوبة |
| `task.execute` | — | — | D* | ✓ | المكلّف بالمهمة |
| `task.release_custody` | — | — | ✓ | ✓ | السائق المكلّف أو المشرف |
| `task.reassign` | — | — | ✓ | — | سبب + تحقق العهدة |
| `handover.verify` | — | — | D* | ✓ | المكلّف بمهمة الإحضار |
| `handover.resend_code` | — | — | ✓ | ✓ | المكلّف أو المشرف؛ ضمن الحد |
| `handover.exception` | — | — | ✓ | — | تحقق هوية موثق + سبب |
| `payment.record` | — | — | D* | ✓ | المكلّف عند التسليم |
| `payment.reverse` | — | ✓ | ✓ | — | سبب إلزامي |
| `payment.waive` | — | — | ✓ | — | سبب إلزامي |
| `cash.handover_confirm` | — | ✓ | ✓ | — | المشرف المستلم (الإدارة احتياطًا عندما يكون المشرف الوحيد سائقًا) |
| `event.manage` | ✓ | ✓ | ✓ | — | |
| `shift.manage` | ✓ | ✓ | ✓ | — | |
| `duty.force_end` | — | — | ✓ | — | بعد التحقق من العهدة |
| `venue.read` | ✓ | ✓ | ✓ | — | |
| `venue.manage` | ✓ | ✓ | — | — | |
| `venue.layout_read` | ✓ | ✓ | ✓ | ✓ | السائق: مناطق ومواقف ولوحات وخانات موقع تعيينه النشط مع حالة الإشغال فقط (لإتمام الصف D-08) |
| `driver.read` | ✓ | ✓ | ✓ | — | المشرف: سائقو مواقعه |
| `driver.manage` | ✓ | ✓ | — | — | إنشاء/تعديل/تعطيل/تفعيل/إعادة تعيين السر |
| `driver.assign` | ✓ | ✓ | ✓ | — | المشرف: داخل نطاقه |
| `driver.transfer` | ✓ | ✓ | ✓ | — | المشرف: يجب أن يملك نطاق الموقعين |
| `staff.manage` | ✓ | ✓ | — | — | الإدارة تدير المشرفين فقط؛ المالك يدير الإدارة؛ إعادة ضبط MFA للمالك فقط |
| `alert.read` | ✓ | ✓ | ✓ | — | |
| `alert.manage` | ✓ | ✓ | ✓ | — | |
| `incident.read` | ✓ | ✓ | ✓ | — | |
| `incident.create` | — | ✓ | ✓ | ✓ | السائق: لتذاكر موقعه |
| `incident.manage` | — | ✓ | ✓ | — | |
| `report.read` | ✓ | ✓ | ✓ | — | |
| `export.create` | ✓ | ✓ | ✓ | — | تدقيق إلزامي |
| `audit.read` | ✓ | ✓ | — | — | |
| `wa.channel_read` | ✓ | ✓ | — | — | |
| `wa.channel_manage` | ✓ | — | — | — | |
| `wa.templates_manage` | ✓ | ✓ | — | — | |
| `outbox.manage` | ✓ | ✓ | — | — | |
| `retention.manage` | ✓ | — | — | — | |
| `org.settings_manage` | ✓ | — | — | — | إعدادات المؤسسة `security.*` و`heartbeat.*` |
| `telemetry.write` | ✓ | ✓ | ✓ | ✓ | |

---

## 11. رسائل واتساب (علامة العميل: «بوينت» منذ DEC-470، «مصاف» في الإصدار الأول)

أسماء القوالب `masaf_*_v1` معرّفات لدى Meta لا يراها العميل، وتبقى كما هي في الإصدار الثاني (DEC-470).

كل إشعار للعميل يُرسل **قالبًا معتمدًا من فئة UTILITY** بالعربية (يعمل داخل نافذة الخدمة وخارجها). رسائل الجلسة الحرة تُستخدم فقط للرد على رسالة واردة من العميل. الزر الوحيد في كل المحادثة هو «طلب السيارة» في W-01.

| المعرف | الاسم | النوع | الغرض | المتغيرات | الزر |
|---|---|---|---|---|---|
| W-01 | `masaf_ticket_issued_v1` | قالب | إصدار التذكرة | 1 اسم الموقع، 2 رقم التذكرة، 3 وصف المركبة | QUICK_REPLY «طلب السيارة» (payload = action token) |
| W-02 | `masaf_request_received_v1` | قالب | تم تسجيل الطلب | 1 رقم التذكرة | — |
| W-03 | `masaf_request_reserved_v1` | قالب | حجز سائق مشغول | 1 رقم التذكرة | — |
| W-04 | `masaf_retrieval_started_v1` | قالب | بدء الإحضار الفعلي | 1 رقم التذكرة | — |
| W-05 | `masaf_vehicle_ready_v1` | قالب | الجاهزية ورمز التسليم | 1 رقم التذكرة، 2 الرمز | — |
| W-06 | `masaf_vehicle_delivered_v1` | قالب | تم التسليم | 1 رقم التذكرة | — |
| W-07 | `masaf_request_canceled_v1` | قالب | إلغاء الطلب ميدانيًا | 1 رقم التذكرة | — |
| W-08 | `masaf_returned_to_parking_v1` | قالب | إعادة الصف لغياب العميل | 1 رقم التذكرة | — |
| W-09 | `reply_current_status` | جلسة | رد على ضغط مكرر للزر | الحالة الحالية | — |
| W-10 | `reply_free_text_guidance` | جلسة | رد على رسالة حرة | — | — |
| W-11 | `reply_link_received` | جلسة | استلام رسالة ربط QR | — | — |
| W-12 | `reply_opted_out` | جلسة | تأكيد إيقاف الرسائل | — | — |

---

## 12. الإعدادات والمؤقتات (القيم الافتراضية)

إعدادات الموقع `venues.settings` (قابلة للتعديل، تُتحقق بـzod):

| المفتاح | الافتراضي | المعنى |
|---|---|---|
| `dispatch.single_offer_reminder_s` | 15 | تذكير العرض الفردي |
| `dispatch.single_offer_ttl_s` | 30 | انتهاء العرض الفردي |
| `dispatch.broadcast_reminder_s` | 30 | تذكير واحد للبث المفتوح |
| `dispatch.unaccepted_escalation_s` | 60 | تصعيد للمشرف من وقت دخول الطابور دون قبول |
| `dispatch.next_task_wait_alert_s` | 300 | تنبيه مهمة تالية تنتظر طويلًا |
| `dispatch.idle_driver_alert` | true | تنبيه المشرف بوجود متاح بينما الأقدم محجوز تالٍ |
| `dispatch.accept_grace_ms` | 1500 | سماحية وصول القبول بعد `expires_at` بسبب تأخر الشبكة |
| `dispatch.offline_drivers_last` | false | تأخير السائقين ذوي الاتصال غير المؤكد في ترتيب العرض الفردي |
| `handover.code_ttl_min` | 30 | صلاحية رمز التسليم من الجاهزية |
| `handover.max_attempts` | 5 | محاولات الرمز قبل القفل |
| `handover.max_resends` | 3 | حد إعادة الإرسال |
| `ready.uncollected_alert_min` | 10 | تنبيه مركبة جاهزة لم تُستلم |
| `intake.draft_abandoned_alert_min` | 10 | تنبيه مسودة استلام متروكة دون إرسال |
| `inspection.required_photos` | `["photo_front","photo_rear","photo_left","photo_right"]` | صور الفحص الإلزامية |
| `inspection.max_extra_photos` | 8 | صور إضافية |
| `link.qr_ttl_min` | 10 | صلاحية رمز ربط QR |
| `parking.mode` | `mixed` | `assigned_spots` · `free_text` · `mixed` |
| `keys.require_slot` | true | إلزام خانة مفتاح عند الصف |
| `pricing.default_mode` | `included` | الافتراضي للحفلات الجديدة |
| `pricing.default_fee_halalas` | 0 | الرسوم الافتراضية |
| `pricing.allowed_methods` | `["cash","pos"]` | وسائل التحصيل |

إعدادات المؤسسة `organizations.settings`:

| المفتاح | الافتراضي |
|---|---|
| `security.supervisor_mfa_required` | true (الإدارة والمالك إلزامي دائمًا) |
| `security.driver_session_hours` | 14 |
| `security.staff_session_hours` | 12 |
| `security.pin_length` | 6 — ثابت في الإصدار الأول (DEC-09)؛ ليس قابلًا للتعديل من الواجهة |
| `security.max_login_attempts` | 5 (ثم قفل 15 دقيقة) |
| `security.admin_idle_minutes` | 30 — خمول جلسة المالك والإدارة |
| `security.reveal_phone_per_hour` | 20 — حد كشف الجوال الكامل لكل مستخدم |
| `heartbeat.interval_s` | 15 |
| `heartbeat.uncertain_after_s` | 45 |
| `heartbeat.offline_after_s` | 120 |
| `retention.photos_days` | 90 (مقترح — يعتمده المالك) |
| `retention.wa_messages_days` | 180 (مقترح) |
| `retention.tickets_months` | 36 (مقترح) |
| `retention.audit_months` | 60 (مقترح) |
| `retention.wa_raw_days` | 7 (مقترح) — الجسم الخام لطلبات Webhook بعد معالجتها |
| `retention.analytics_months` | 24 (مقترح) |
| `ops.outbox_lag_alert_s` | 30 — عمر أقدم حدث معلّق قبل تنبيه `outbox_lag` |
| `alerts.escalation_repeat_s` | 60 — تكرار صوت التصعيد للمشرف |
| `alerts.escalation_max_repeats` | 3 |
| `push.max_consecutive_failures` | 3 — قبل تنبيه `push_failed_repeatedly` |
| `wa.global_mps` | 60 — سقف الإرسال للرقم (أقل من حد المزود) |
| `wa.pair_bucket_capacity` | 6 — دلو الرسائل لكل مستلم |
| `wa.pair_refill_s` | 6 — إعادة ملء الدلو لكل مستلم |
| `wa.ordering_gate_max_wait_s` | 8 — انتظار `delivered` للرسالة السابقة في التذكرة نفسها |
| `wa.send_max_attempts` | 5 |
| `wa.status_reply_throttle_s` | 20 — خنق رد الحالة W-09 |
| `wa.guidance_reply_throttle_min` | 10 — خنق رد التوجيه W-10 |
| `wa.action_token_ttl_h` | 72 — صلاحية رمز زر «طلب السيارة» من الإنشاء |

مفاتيح `retention.*` تُعتمد بـ`PUT /v1/admin/retention-policy` (المالك): الستة كلها إلزامية، أعداد صحيحة موجبة حتى 36,500 يوم أو 1,200 شهر دون حد أدنى يفرضه الخادم، والحفظ يضبط `approved_by_owner = true` (Q-06، DEC-154).

---

## 13. الأصوات

| المعرف | الملف | متى |
|---|---|---|
| `offer` | `brand/sounds/point-offer.mp3` | عرض فردي |
| `broadcast` | `brand/sounds/point-broadcast.mp3` | بث لجميع سائقي الموقع |
| `reminder` | `brand/sounds/point-reminder.mp3` | تذكير عرض/بث |
| `next_due` | `brand/sounds/point-next-due.mp3` | ترقية المهمة التالية بعد إنهاء الحالية |
| `escalation` | `brand/sounds/point-escalation.mp3` | تصعيد للمشرف |
| `test` | `brand/sounds/point-test.mp3` | زر «تفعيل واختبار الصوت» |

`task.claimed` يوقف أي صوت للبطاقة فورًا ولا يصدر صوتًا.

---

## 14. معرّفات الشاشات

السائق (بوينت): `D-01` الدخول · `D-02` تغيير الرقم السري · `D-03` بدء الوردية واختبار الصوت · `D-04` الرئيسية · `D-05` استلام مركبة (1): المركبة والعميل · `D-06` استلام مركبة (2): المفتاح والصور · `D-07` ربط واتساب (لوحة QR موجهة للعميل بعلامة مصاف) · `D-08` إتمام الصف · `D-09` بطاقة العرض/البث · `D-10` المهمة الحالية (الإحضار) · `D-11` التسليم والتحصيل · `D-12` المركبات · `D-13` تفاصيل المركبة · `D-14` حسابي · `D-15` حالات النظام (انقطاع، جلسة منتهية، صوت محجوب، تحديث)

المشرف والإدارة (بوينت): `S-01` الدخول وMFA · `S-02` لوحة التشغيل · `S-03` تفاصيل التذكرة وسجلها · `S-04` مركز التنبيهات · `S-05` السائقون · `S-06` ملف السائق · `S-07` نقل سائق · `S-08` المواقع والحفلات · `S-09` إعداد الموقع · `S-10` إغلاق الحفل والمطابقة · `S-11` التقارير والتصدير · `S-12` الوقائع · `S-13` الإدارة (الموظفون، قناة واتساب، القوالب، التدقيق، الاحتفاظ)

العميل (علامة العميل — واتساب؛ «بوينت» منذ DEC-470): `W-01` … `W-12` كما في §11.

---

## 14ب. ترتيب الأقفال ونمطها (ملزم لكل معاملة)

نمط القفل للصفوف: `SELECT … FOR NO KEY UPDATE` (لا يحجب إدراجات المفاتيح الأجنبية)، و`FOR SHARE` حيث يكفي منع التغيير (مثل صف الحفل عند التحصيل). العامل يؤجر صفوف `outbox_events` بـ`FOR UPDATE SKIP LOCKED`. كل معاملة تأخذ ما تحتاجه **بهذا الترتيب فقط** ولا تقفل مستوى أعلى بعد مستوى أدنى:

| المستوى | الصفوف | ملاحظة |
|---|---|---|
| L0 | حجز `idempotency_keys` | أول جملة في أي أمر معلّم ✓ |
| L1 | `dispatch_pools` | كل ما يمس طابور المجموعة أو توفر سائقيها؛ مجموعتان (النقل) تصاعديًا بالمعرف |
| L2 | `events` | عداد أرقام التذاكر وفتح/إغلاق الحفل (`FOR NO KEY UPDATE`)؛ التحصيل وتسليم النقد (`FOR SHARE`) |
| L3 | `driver_transfers` ← `driver_assignments` ← `users` | النقل والتعيين والتعطيل فقط |
| L4 | `tasks` | تصاعديًا بالمعرف عند التعدد |
| L5 | `tickets` | تصاعديًا بالمعرف عند التعدد |
| L6 | `retrieval_cycles` | |
| L7 | `task_offers` (ومستلموها) | تصاعديًا بالمعرف |
| L8 | `duty_sessions` | تصاعديًا بالمعرف |
| L9 | `spot_allocations` · `key_slot_allocations` · `claim_codes` · `link_codes` · `action_tokens` · `payments` · `cash_handovers` · `alerts` · `notifications` | تحرسها الفهارس الفريدة |
| L10 | الإلحاقيات: `custody_events` · `ticket_events` · `outbox_events` · `audit_log` · `analytics_events` | آخر المعاملة، ثم إكمال `idempotency_keys` |

المعاملات التي لا تحتاج قفل المجموعة (تعديل مسودة الاستلام وإرسالها، رفع الصور، رموز الربط، تغيير الجوال) تبدأ من L5، وأوامر تقدم الحركة (`key-pickup`، `start-retrieval`، `ready`) تبدأ من L4؛ ولا تطلب أي منها مستوى أصغر بعد ذلك. لا اتصال شبكي داخل أي معاملة.

**استثناء واحد مسموح:** معاملة تحمل L1 يجوز لها، بعد أن أخذت أقفال أمرها، أن تقفل صفوفًا إضافية من L4–L8 **لنفس المجموعة** لتمريرة التوزيع ولتسوية السائق بعد مهمته (`settleDriverAfterTask`). هذا آمن لأن كل من يقفل صفوف الطابور والعروض والمناوبات يحمل L1 أولًا، وأوامر تقدم الحركة لا تقفل إلا صفوف حركة نشطة (`accepted`/`in_progress` وتذكرتها ودورتها) لا تقفلها التمريرة. إعادة المحاولة: المعاملة كلها تُعاد حتى 3 مرات عند `40001`/`40P01` بتأخير عشوائي 20–80 ms؛ تجاوز `lock_timeout` (`55P03`) لا يُعاد على الخادم ويرد `IDEMPOTENCY_IN_PROGRESS` إن حدث عند L0 وإلا `SERVICE_UNAVAILABLE` (`retryable: true`).

**صف المؤسسة (الإصدار الثاني، DEC-487):** الأوامر التي يمنعها تعليق المشغل (فتح الحفل والوردية، بدء المناوبة، بدء الاستلام) تقرأ صف `organizations` بـ`FOR SHARE` أول قفل لها قبل L1؛ وأوامر المنصة وإعدادات المؤسسة تقفله `FOR NO KEY UPDATE` وحده دون أي صف من L1–L10.

**جداول الإعداد خارج L0–L10 (DEC-121):** صفوف `venues` و`parking_zones` و`parking_spots` و`key_slots` و`shifts` ليست في الجدول؛ يُقفل كل منها `FOR NO KEY UPDATE` وحده في أمر الإعداد الخاص به، أو (صف الوردية) بعد L1 لمجموعتها مباشرة، ولا يُقفل للتعديل بعد أي مستوى من L2 إلى L10. والأوامر التي تستعمل موقفًا أو خانة تقرأ الموقف ومنطقته (أو الخانة ولوحتها) `FOR SHARE` بعد أقفالها وتشترط أن يكونا نشطين، فيتسلسل التعطيل مع التخصيص.

## 15. اصطلاحات المعرّفات في الوثائق

- المتطلبات الوظيفية `FR-<AREA>-nn` حيث AREA ∈ `ACC` الحسابات، `ORG` المواقع والحفلات، `DUTY` المناوبة، `INT` الاستلام، `WA` واتساب، `DSP` التوزيع، `RET` الإحضار والتسليم، `CUS` العهدة، `PAY` التحصيل، `SUP` الإشراف، `NTF` التنبيهات، `RPT` التقارير، `AUD` التدقيق والأمان، `ADM` الإدارة.
- غير الوظيفية `NFR-<CAT>-nn` حيث CAT ∈ `PERF` `REL` `SEC` `PRIV` `UX` `A11Y` `OPS` `COMP`.
- معايير القبول `AC-01` … `AC-22` = البنود 1–22 في القسم 16 من الوثيقة الأصلية بالترتيب نفسه.
- تذاكر التطوير `PNT-###`، الملاحم `EP-##`، القرارات `DEC-##` (في `DECISIONS.md`؛ كانت `D-##` في المسودات وتختلط بمعرّفات شاشات السائق، فأعيدت تسميتها).
- أفعال `audit_log.action`: أسماء الصلاحيات (§10) وأوامرها، إضافة إلى `dispatch.priority_override` · `wa.button_sender_mismatch` · `wa.button_context_mismatch` · `ticket.reveal_phone` · `owner.bootstrap` (أداة تهيئة المالك بفاعل `system`، DEC-302).
- أنواع `ticket_events.type`: أحداث النطاق الخاصة بالتذكرة (§7.1، التفصيل في 11 §1.6)، إضافة إلى `ticket.photo_uploaded` عند اكتمال رفع صورة، وهو سطر خط زمني فقط لا حدث نطاقي: لا يُكتب في `outbox_events` ولا يُنشر فوريًا (DEC-95).
- رقم التذكرة الظاهر: عدد صحيح يبدأ من 1 لكل حفل. يظهر للموظف `#125` مع اسم الحفل، وللعميل «تذكرة 125» مع اسم الموقع.
- الجوال يُخزن E.164 (`+9665XXXXXXXX`) ويُعرض مقنّعًا `05•••••123`.
- اللوحة السعودية: `plate_digits` (حتى 4 أرقام) + `plate_letters_ar` (3 أحرف) + `plate_letters_en` (المقابل اللاتيني) + `plate_raw` للوحات الأخرى.

---

## 16. خريطة الملفات

| الملف | المحتوى |
|---|---|
| `00_Glossary_Canon.md` | هذا الملف |
| `00_Source_Architecture_v1.2_AR.md` | الوثيقة الأصلية كما هي (مرجع) |
| `DECISIONS.md` | سجل القرارات والأسئلة المفتوحة |
| `01_PRD.md` | متطلبات المنتج |
| `02_Wireframes_Spec.md` | مواصفات الشاشات |
| `03_Design_System.md` | نظام التصميم |
| `04_Architecture_Flow.md` | المعمارية والتدفقات |
| `05_Tech_Stack_Environment.md` | التقنيات والبيئات |
| `06_ERD_Database_Schema.md` + `06_schema.sql` | قاعدة البيانات |
| `07_API_Contract.md` + `07_openapi.yaml` | عقد الـAPI |
| `08_Error_Codes_Guide.md` | دليل رموز الأخطاء |
| `09_RBAC_Permissions_Matrix.md` | الصلاحيات والأمان |
| `10_Dispatch_Engine_Spec.md` | محرك التوزيع (بديل AI Pipeline) |
| `11_State_Machines_Domain_Events.md` | آلات الحالة والأحداث (بديل AI Output Schema) |
| `12_WhatsApp_Integration_Spec.md` | تكامل واتساب (بديل Prompt Library) |
| `13_Payments_Settlement_Spec.md` | التحصيل والتسويات (بديل Billing & Plans) |
| `14_Notification_Matrix_Templates.md` | مصفوفة الإشعارات والقوالب |
| `15_Event_Tracking_Plan.md` | خطة تتبّع الأحداث والقياس |
| `16_Dev_Tickets_Sprint_Plan.md` | تذاكر التطوير والسبرنتات |
| `17_Test_Acceptance_Plan.md` | خطة الاختبارات ومعايير القبول |
| `../brand/` | ملفات الهوية (بوينت + مصاف) |

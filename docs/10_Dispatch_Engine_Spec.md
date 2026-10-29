# 10 — محرك التوزيع (Dispatch Engine Spec)

الإصدار 1.0 — 27 أكتوبر 2026 — الحالة: معتمد للتنفيذ.
يشغل هذا الملف خانة «AI Pipeline Spec» في الحزمة القياسية (DEC-02): هو «قلب» النظام الذي يقرر من يحضر أي مركبة ومتى.

المراجع الملزمة: `00_Source_Architecture_v1.2_AR.md` (§1، §4أ–§4ح، §6، §7، §10، §14، §16) · `00_Glossary_Canon.md` · `06_schema.sql` · `DECISIONS.md` (DEC-07، DEC-08، DEC-11، DEC-12، DEC-13، DEC-20، DEC-21، DEC-22، DEC-25، DEC-26، DEC-27، DEC-30، DEC-32، DEC-34، DEC-42، DEC-45، DEC-46، DEC-47).
ملفات مرتبطة: `11_State_Machines_Domain_Events.md` (الحالات والأحداث) · `12_WhatsApp_Integration_Spec.md` (دخول طلب العميل) · `14_Notification_Matrix_Templates.md` (نصوص الرسائل والأصوات) · `07_API_Contract.md` (العقود) · `08_Error_Codes_Guide.md` (الأخطاء) · `17_Test_Acceptance_Plan.md` (الاختبارات).

كل SQL في هذا الملف كُتب على المخطط `06_schema.sql` وجُرّب على PostgreSQL 16.15 (انظر §15).

---

## 0. الخلاصة في عشرة أسطر

1. كل قرار توزيع داخل موقع يتم وهو يحمل قفل صف مجموعة التوزيع `dispatch_pools` (`SELECT … FOR NO KEY UPDATE`)؛ هذا يجعل القرارات متسلسلة داخل المجموعة ومتوازية بين المجموعات.
2. «تمريرة التوزيع» تعمل داخل نفس المعاملة التي غيّرت حالة المجموعة (DEC-08)، وتعيدها تمريرة تأمينية كل 5 ثوانٍ.
3. الطابور مرتب بـ`(priority_at, seq)` = أقدم طلب أولًا.
4. عند وجود سائق متاح: عرض فردي `single` لأقدم طلب على الأطول تفرغًا `MIN(available_since)`، تذكير عند 15 ثانية، انتهاء عند 30 ثانية (يعرضها العداد) ثم مهلة سماح `dispatch.accept_grace_ms` قبل الإغلاق الفعلي (DEC-47).
5. إن لم يبقَ متاح لم يُجرَّب لهذا الطلب: بث `broadcast` لكل سائقي المجموعة المناوبين عدا المستريح.
6. إن صار سائق متاحًا والبث قائم: يتحول أقدم طلب مبثوث إلى عرض فردي له.
7. أول قبول يؤكده الخادم يفوز: المتاح يأخذ المهمة `accepted`، والمشغول بلا مهمة تالية يحجزها `assigned_waiting`، وصاحب المهمة التالية لا يقبل ثانية.
8. لا يقبل سائق طلبًا أحدث وهناك طلب أقدم قابل للتصرف له (حارس الأولوية).
9. إنهاء المهمة الحالية يرقّي المهمة التالية في المعاملة نفسها، فلا يظهر السائق متاحًا بينهما.
10. المؤقتات دائمة في `outbox_events` وتعيد التحقق من نسخة الكيان قبل أي أثر؛ والاتصال لا يسحب مهمة ولا يغيّر التوفر.

---

## 1. الغرض والنطاق والضمانات

### 1.1 الغرض

تحويل «طلب السيارة» إلى مهمة إحضار يقبلها سائق واحد بأسرع وقت ممكن مع الحفاظ على: الأولوية لأقدم طلب، العدالة بين السائقين (الأطول تفرغًا)، استحالة الإسناد المزدوج، عدم بدء حركة ثانية قبل إنهاء الأولى، وتصعيد للمشرف دون أي إعادة إسناد صامتة.

### 1.2 النطاق

داخل النطاق: طابور مهام الإحضار `retrieve`، جولات العرض الفردي والبث، القبول وحجز المهمة التالية، الترقية بعد الإنهاء، تحويل البث إلى عرض فردي، المؤقتات والتصعيد، أثر الاستراحة/الاستلام/النقل/التعطيل/الإنهاء القسري على التوزيع، عمليات المشرف على المهام (سحب، إعادة إسناد، إلغاء، إعادة صف)، سباق «بدء الاستلام» مع «القبول»، تحويل الطلب المبكر (DEC-13).

خارج النطاق (موصوفة في ملفاتها): تفاصيل رسائل واتساب ونصوصها (12، 14)، تحقق رمز التسليم والتحصيل (11، 13)، سلسلة العهدة بالتفصيل (11)، صلاحيات الحقول (09).

مهام `park` و`repark` لا تمر بالتوزيع: تُنشأ `in_progress` باسم السائق مباشرة (Canon §5.4)، لكنها تؤثر عليه لأنها تجعل السائق مشغولًا.

### 1.3 الضمانات (Invariants)

كل ضمان له آلية أساسية (القفل + الفحص في الكود) وحاجز أخير في قاعدة البيانات يمنع الخطأ حتى لو أخطأ الكود.

| # | الضمان | الآلية الأساسية | الحاجز في قاعدة البيانات | الخطأ الظاهر |
|---|---|---|---|---|
| I-01 | مهمة مفتوحة واحدة لكل تذكرة (حركة واحدة للمركبة) | فحص الحالة تحت قفل المجموعة | `uq_tasks_open_per_ticket` | `RETRIEVAL_ALREADY_ACTIVE` / `INVALID_STATE_TRANSITION` |
| I-02 | مهمة حركة نشطة واحدة للسائق (`accepted`/`in_progress`) | حساب `driver_state` تحت القفل | `uq_tasks_active_movement_driver` | `DRIVER_NOT_AVAILABLE` / `MOVEMENT_IN_PROGRESS` |
| I-03 | مهمة تالية محجوزة واحدة للسائق | فحص `busy_with_next` | `uq_tasks_next_per_driver` | `NEXT_TASK_ALREADY_RESERVED` |
| I-04 | جولة عرض نشطة واحدة للمهمة | التمريرة تنشئ جولة فقط لمهمة بلا جولة | `uq_task_offers_active` | داخلي: سجل `error` وإعادة التمريرة |
| I-05 | دورة استرجاع مفتوحة واحدة للتذكرة | فرع «طلب قائم» في دخول الطلب | `uq_retrieval_cycles_open` | `RETRIEVAL_ALREADY_ACTIVE` (للموظف) / W-09 (للعميل) |
| I-06 | مناوبة مفتوحة واحدة للمستخدم | فحص عند البدء | `uq_duty_sessions_open` | `DUTY_ALREADY_STARTED` |
| I-07 | تعيين موقع نشط واحد للسائق | معاملة النقل | `uq_driver_assignments_active` | `ASSIGNMENT_CONFLICT` |
| I-08 | وردية مفتوحة واحدة لكل مجموعة | فحص عند الفتح | `uq_shifts_open_per_pool` | `SHIFT_ALREADY_OPEN` |
| I-09 | أول قبول مؤكد يفوز ولا يوجد سائقان للمهمة | قفل المجموعة + تحديث مشروط `WHERE status IN ('offered','broadcast') AND version = $v` | I-02 وI-03 + `uq_task_offers_active` | `TASK_ALREADY_CLAIMED` |
| I-10 | الأقدم أولًا داخل مجموعة السائقين | حارس الأولوية (§5.4) | — (منطق تحت القفل) | `OLDER_REQUEST_PENDING` |
| I-11 | لا توزيع خارج الموقع | المستلمون من مناوبات المجموعة فقط؛ لا نقل للطلب بين المواقع | `tasks.dispatch_pool_id` NOT NULL + فحص §14 (I-F) | — |
| I-12 | لا رسالة «جارٍ الإحضار» (W-04) قبل البدء الفعلي، وW-03 فقط عند الحجز التالي | إصدار الرسائل من أحداث بعينها | `notifications.dedupe_key` | — |
| I-13 | الاتصال لا يغيّر التوفر ولا يسحب مهمة | `job.heartbeat_sweep` يلمس `connection_state` فقط | — | — |
| I-14 | تمريرة واحدة معلّقة لكل مجموعة في Outbox | مفتاح منع التكرار `dispatch_pass:<pool_id>` | `uq_outbox_dedupe_pending` | — |
| I-15 | خانة المفتاح والموقف لتذكرة واحدة | فحص عند الصف | `uq_key_alloc_slot_active`، `uq_key_alloc_ticket_active`، `uq_spot_alloc_spot_active`، `uq_spot_alloc_ticket_active` | `KEY_SLOT_OCCUPIED` / `PARKING_SPOT_OCCUPIED` |

---

## 2. التعريفات

### 2.1 مجموعة التوزيع وقفلها

- كل حفل `events.dispatch_pool_id` وكل تذكرة `tickets.dispatch_pool_id` وكل مهمة `tasks.dispatch_pool_id` وكل مناوبة `duty_sessions.dispatch_pool_id` تنتمي لمجموعة واحدة. الافتراضي مجموعة واحدة لكل موقع `is_default = true` (DEC-21).
- صف `dispatch_pools` هو **القفل**. لا يوجد قفل استشاري ولا Redis في هذا المسار.
- ترتيب الأقفال (يمنع الاختناق المتبادل Deadlock) هو **ترتيب Canon §14ب نفسه** (DEC-27) ولا يُعرَّف هنا ترتيب آخر: L0 مفتاح التكرار ← L1 `dispatch_pools` ← L2 `events` ← L3 النقل/التعيين/المستخدم ← L4 `tasks` ← L5 `tickets` ← L6 `retrieval_cycles` ← L7 `task_offers` ← L8 `duty_sessions` ← L9 التخصيصات والرموز والدفعات والتنبيهات ← L10 الإلحاقيات. تطبيقه على التوزيع:
  - كل معاملة تُنشئ مهمة أو تُنهيها أو تُسندها أو تعيدها للطابور، أو تمس `task_offers`/`offer_recipients`، أو تفتح/تغلق `retrieval_cycles`، أو تغيّر حالة/توفر `duty_sessions`، **تبدأ** بقفل صف المجموعة (L1) بعد حجز مفتاح التكرار (L0). أوامر تقدم الحركة التي لا تغيّر مدخلات التوزيع (`key-pickup`، `start-retrieval`، `ready`) تبدأ من L4، وإرسال مسودة الاستلام من L5 (الملف 04 §5.3).
  - داخل المستوى الواحد تُقفل الصفوف تصاعديًا بالمعرف، ومجموعتان (النقل) تُقفلان تصاعديًا بالمعرف.
  - المعاملات التي لا تحتاج قفل المجموعة (تعديل حقول مسودة الاستلام، رفع الصور، رموز الربط، تغيير الجوال) تبدأ من L5 ولا تطلب L1–L4 بعدها أبدًا.
  - **الاستثناء الوحيد (Canon §14ب):** معاملة تحمل L1 يجوز لها، بعد أن أخذت أقفال أمرها، أن تقفل صفوفًا إضافية من L4–L8 **لنفس المجموعة** لتمريرة التوزيع ولـ`settleDriverAfterTask` (مثل مهمة تالية تُرقّى، أو جولة فردية تُسحب ومهمتها تعود للطابور). هذا آمن لأن كل من يقفل صفوف الطابور والعروض والمناوبات يحمل L1 أولًا، وأوامر تقدم الحركة لا تقفل إلا صفوف حركة نشطة لا تقفلها التمريرة.
  - **جداول الإعداد (Canon §14ب، DEC-121):** صف الوردية يُقفل بعد L1 لمجموعتها مباشرة (فتح الوردية وإغلاقها: L1 ← الوردية ← L8)؛ وأوامر التخصيص (`complete-parking`، إعادة المفتاح إلى خانته، نقل العهدة إلى خانة) تقرأ الموقف ومنطقته أو الخانة ولوحتها `FOR SHARE` بعد أقفالها وتشترط النشاط قبل إدراج التخصيص (L9).
  - نمط القفل `FOR NO KEY UPDATE` (لا يحجب فحوص المفاتيح الأجنبية للإدراجات المتزامنة)؛ `FOR UPDATE SKIP LOCKED` للعامل على `outbox_events` فقط.
  - كل معاملة تضبط `SET LOCAL lock_timeout = '3s'` و`SET LOCAL statement_timeout = '5s'`. إعادة المحاولة حسب Canon §14ب: المعاملة كلها تُعاد حتى 3 مرات عند `40001`/`40P01` بتأخير عشوائي 20–80 ms؛ أما تجاوز `lock_timeout` (`55P03`) فلا يُعاد على الخادم: يرد `IDEMPOTENCY_IN_PROGRESS` إن حدث عند L0 (صف مفتاح التكرار) وإلا `SERVICE_UNAVAILABLE` (`retryable: true`، يعيده العميل بنفس مفتاح التكرار) بدل تعليق الطلب.
- مستوى العزل: `READ COMMITTED` (الافتراضي). كل جملة بعد الحصول على القفل ترى ما التزمه حامل القفل السابق. لا يُستخدم `SERIALIZABLE` في هذا المسار.

### 2.2 حالة السائق والأهلية

`driver_state` مشتقة (Canon §5.6، والعرض المرجعي `v_driver_state`):

| driver_state | مرشح لعرض فردي؟ | مستلم للبث؟ | `eligible_as` في البث |
|---|---|---|---|
| `available` | نعم (إن لم يحمل عرضًا فرديًا حيًا) | نعم | `accept` |
| `intake_parking` | لا | نعم | `reserve_next` |
| `retrieving` | لا | نعم | `reserve_next` |
| `busy_with_next` | لا | نعم (يرى التنبيه ولا يتصرف) | `view_only` |
| `on_break` | لا | لا | — |
| `off_duty` | لا | لا | — |

- الأهلية العامة للمشاركة: مستخدم `status = active`، مناوبة مفتوحة في **هذه** المجموعة، وتعيين نشط على الموقع (السائق) أو نطاق موقع مع `can_drive = true` (المشرف، DEC-22).
- `eligible_as` المخزن في `offer_recipients` لحظة إنشاء الجولة للعرض فقط؛ عند القبول يُعاد حساب الحالة الفعلية دائمًا.
- `connection_state` لا يدخل في الأهلية. الإعداد `dispatch.offline_drivers_last` (افتراضي `false`، §10) يؤخر فقط ذوي الاتصال غير المؤكد في ترتيب العرض الفردي عند تفعيله.

### 2.3 «الأطول تفرغًا» وصيانة `available_since`

الترتيب: `ORDER BY available_since ASC, user_id ASC`. القيمة تُضبط داخل معاملات الحالة فقط:

| الحدث | `available_since` |
|---|---|
| بدء المناوبة | `now()` |
| انتهاء الاستراحة | `now()` |
| إنهاء المهمة الحالية دون مهمة تالية | `now()` |
| انتهاء عرض فردي دون قبول (تدوير) | `now()` إن بقي متاحًا — ينتقل لآخر الصف كي لا يحتكر الطلبات الجديدة وهو لا يستجيب |
| قبول مهمة كمتاح، بدء الاستلام، بدء الاستراحة، إنهاء المناوبة | `NULL` |
| حجز مهمة تالية وهو مشغول | تبقى `NULL` |
| ترقية المهمة التالية بعد الإنهاء | تبقى `NULL` (لا يمر السائق بحالة متاح) |

قيد في المخطط: `CHECK (status = 'on_duty' OR available_since IS NULL)`. ضمان مختبر (§14): `driver_state = 'available'` ⟺ `available_since IS NOT NULL`.

### 2.4 ترتيب الطابور

- `priority_at` لمهمة الإحضار = `retrieval_cycles.requested_at`. للطلب المبكر (DEC-13) = وقت الطلب الأصلي `tickets.pending_retrieval_at`.
- `seq` هوية تصاعدية ثابتة لكسر التعادل.
- الطابور المفتوح = مهام `retrieve` بحالة `queued` أو `offered` أو `broadcast` في المجموعة، مرتبة `(priority_at, seq)`. العرض المرجعي `v_pool_queue`.
- تجاوز الترتيب يدويًا ممكن فقط للمشرف بسبب مكتوب ويُسجل في التدقيق بالفعل `dispatch.priority_override` (§9.1).

### 2.5 «نوبة الطلب» (requested episode) والمجرَّبون

- النوبة تبدأ عندما تدخل المهمة الطابور (`queued_at` = لحظة الإنشاء أو إعادة الإدخال للطابور) وتنتهي بالحجز (`accepted`/`assigned_waiting`) أو الإلغاء.
- إعادة المهمة للطابور (سحب، نقل، إعادة إسناد للطابور) تبدأ نوبة جديدة: `queued_at = now()` مع **بقاء** `priority_at`.
- مؤقت التصعيد يقاس من `queued_at` للنوبة الحالية.
- **المجرَّبون للمهمة** = من وصلهم عرض فردي لها في النوبة الحالية ∪ كل من قبلها سابقًا في أي نوبة. لا يتلقى المجرَّب عرضًا فرديًا آخر لنفس المهمة في النوبة، لكنه يبقى مستلمًا للبث.

```sql
-- tried set (validated): single recipients this episode ∪ previous acceptors
SELECT r.user_id
FROM task_offers o
JOIN offer_recipients r ON r.offer_id = o.id
JOIN tasks t ON t.id = o.task_id
WHERE o.task_id = $1 AND o.mode = 'single' AND o.created_at >= t.queued_at
UNION
SELECT o.accepted_by
FROM task_offers o
WHERE o.task_id = $1 AND o.status = 'accepted';
```

ملاحظة: الجزء الثاني يستخدم `accepted_by` وليس مستلمي الجولة المقبولة، لأن جولة البث المقبولة تضم كل السائقين.

### 2.6 «قابل للتصرف» وبطاقة الرأس

- الجولة الحية `R` لمهمة `T` **قابلة للتصرف** للسائق `D` إذا: `D` مستلم في `R`، و`R.status = 'active'`، و(`R.mode = 'broadcast'` أو `R.expires_at + dispatch.accept_grace_ms > now()`)، وحالة `D` الآن ليست `busy_with_next`.
- **بطاقة الرأس** في الرئيسية (D-04/D-09) = أقدم جولة حية يكون السائق مستلمًا فيها، مرتبة `(priority_at, seq)`. يظهر زرها فقط إن كانت قابلة للتصرف: «قبول الطلب» إن كان متاحًا، «حجز كمهمة تالية» إن كان مشغولًا بلا تالية، وبدون زر مع نص «لديك مهمة تالية محجوزة» إن كان `busy_with_next`.

```sql
-- head card for driver $1 in pool $2 (part of GET /v1/me/home)
SELECT o.id AS offer_id, o.mode, o.expires_at, o.reminder_at, t.id AS task_id, t.ticket_id, t.priority_at
FROM task_offers o
JOIN offer_recipients r ON r.offer_id = o.id AND r.user_id = $1
JOIN tasks t ON t.id = o.task_id
WHERE o.status = 'active' AND t.dispatch_pool_id = $2
ORDER BY t.priority_at, t.seq
LIMIT 1;
```

### 2.7 ثوابت التنفيذ

| الثابت | القيمة | الملاحظة |
|---|---|---|
| `cfg.acceptGraceMs` (ليس ثابتًا) | إعداد الموقع `dispatch.accept_grace_ms`، الافتراضي 1500 ms (§10) | سماح شبكي (DEC-47): يُقبل العرض الفردي ما دام `now() < expires_at + dispatch.accept_grace_ms`، ويُجدول `job.offer_expire` عند `expires_at + dispatch.accept_grace_ms`؛ لا قيمة ثابتة في الكود |
| `SWEEP_INTERVAL` | 5 s | `job.dispatch_sweep` |
| `LOCK_TIMEOUT` | 3 s | `SET LOCAL lock_timeout` |
| `STATEMENT_TIMEOUT` | 5 s | `SET LOCAL statement_timeout` |
| `TX_RETRY` | 3 محاولات مع تأخير عشوائي 20–80 ms | فقط عند `40001` أو `40P01`؛ `55P03` لا يُعاد على الخادم (§2.1، Canon §14ب) |

**تعليقات لا ترفع `version`:** حقول وصفية لا تمثل حالة ولا ترفع `version` ولا تبطل المؤقتات: `task_offers.reminded_at`، `offer_recipients.notified_ws_at/notified_push_at/seen_at`، `duty_sessions.last_heartbeat_at/connection_state`، `tasks.escalated_at`، `dispatch_pools.last_pass_at/pass_count`، وعداد `events.next_display_number`. كل ما عداها يرفع `version`. يسري ذلك على كل كاتب لـ`connection_state`: `job.heartbeat_sweep`، ونبضة الهوية (`POST /v1/me/heartbeat` و`client.heartbeat`) حين تعيده `online` (DEC-218).

---

## 3. المشغّلات (Triggers)

التمريرة تعمل **داخل** المعاملة التي غيّرت حالة المجموعة وهي تحمل القفل (DEC-08). إن احتاج أمر تمريرة لمجموعة أخرى لا يحمل قفلها، يكتب `job.dispatch_pass` بمفتاح `dispatch_pass:<pool_id>`.

| المشغّل | الأمر/المهمة | التمريرة |
|---|---|---|
| طلب إحضار جديد (واتساب) | `job.wa_process_inbound` ← أمر `requestRetrieval` | داخل المعاملة |
| طلب نيابة عن العميل | `POST /v1/tickets/{ticketId}/retrievals` | داخل المعاملة |
| تحويل طلب مبكر عند الصف | `POST /v1/tasks/{taskId}/complete-parking` | داخل المعاملة |
| إعادة مهمة للطابور | `POST /v1/tasks/{taskId}/reassign` (`target_driver_id = null`)، النقل، التعطيل، الإنهاء القسري | داخل المعاملة |
| سائق صار متاحًا | `POST /v1/me/duty/start`، `POST /v1/me/duty/break` (إنهاء)، الإنهاء دون مهمة تالية (`handover`، `complete-parking`)، نقل العهدة الرسمي `POST /v1/tickets/{ticketId}/custody-transfers` والمطابقة اليدوية `POST /v1/tickets/{ticketId}/manual-reconcile` (كلاهما تحت L1 مع `settleDriverAfterTask` وتمريرة، §6.3). `release-custody` لا يحرر سائقًا أبدًا | داخل المعاملة |
| انتهاء عرض فردي | `job.offer_expire` | داخل معاملة المهمة |
| قبول عرض | `POST /v1/task-offers/{offerId}/accept` | داخل المعاملة (لإكمال المهام الأحدث) |
| إلغاء/سحب مهمة | `POST /v1/retrieval-cycles/{cycleId}/cancel`، `reassign`، إلغاء التذكرة، المطابقة اليدوية | داخل المعاملة |
| سائق صار غير متاح وهو يحمل عرضًا فرديًا | بدء الاستلام `POST /v1/tickets`، قبول عرض آخر `POST /v1/task-offers/{offerId}/accept` (§5.3)، بدء الاستراحة، إنهاء المناوبة، الإنهاء القسري، النقل، التعطيل | داخل المعاملة |
| شبكة أمان | `job.dispatch_sweep` كل 5 ثوانٍ لكل مجموعة لها طلب مفتوح أو جولة حية أو مهمة تالية | معاملة مستقلة لكل مجموعة |

---

## 4. خوارزمية تمريرة التوزيع

### 4.1 الشيفرة المرجعية

```ts
type PassReason =
  | 'request_created' | 'requeued' | 'driver_available' | 'offer_expired' | 'offer_accepted'
  | 'task_canceled' | 'recipient_unavailable' | 'transfer' | 'sweep';

async function runDispatchPass(tx: Tx, poolId: UUID, reason: PassReason): Promise<PassResult> {
  const pool = await lockPool(tx, poolId);                    // SELECT … FROM dispatch_pools … FOR NO KEY UPDATE
  const now = await tx.now();                                 // transaction timestamp (UTC)
  const cfg = await loadDispatchSettings(tx, pool.venueId);   // venues.settings merged with canon §12 defaults (zod)

  // A. defensive expiry (same body as job.offer_expire) — protects against a lagging worker
  for (const o of await findOverdueSingleRounds(tx, poolId, now, cfg.acceptGraceMs)) {   // expires_at + dispatch.accept_grace_ms <= now
    await expireSingleRound(tx, o, now);                      // offer→expired, task→queued, rotate recipient
  }

  // B. snapshot under the lock
  const demand  = await loadOpenDemand(tx, poolId);           // retrieve tasks queued|offered|broadcast, oldest first
  const drivers = await loadPoolDrivers(tx, poolId);          // open duty sessions + driver_state + live single offer id
  const onDuty  = drivers.filter(d => d.dutyStatus === 'on_duty');

  // C. nobody can serve this pool (all off duty or on break)
  if (demand.length > 0 && onDuty.length === 0) {
    await raiseAlert(tx, { type: 'no_drivers_on_duty', severity: 'critical', poolId,
                           dedupeKey: `no_drivers_on_duty:${poolId}`,
                           details: { reason: drivers.length ? 'all_on_break' : 'none_on_duty', open_requests: demand.length } });
    return finishPass(tx, pool, now, reason);                 // tasks keep their status (a broadcast stays a broadcast); never routed to another venue
  }
  if (onDuty.length > 0) await autoResolveAlert(tx, `no_drivers_on_duty:${poolId}`);

  // D. pairing oldest task ↔ longest idle driver
  const idle = onDuty
    .filter(d => d.state === 'available' && !d.liveSingleOfferId)
    .sort((a, b) => (cfg.offlineDriversLast ? cmp(a.connectionState !== 'online', b.connectionState !== 'online') : 0)
                    || cmp(a.availableSince, b.availableSince) || cmp(a.userId, b.userId));
  const blocked = new Set<UUID>(onDuty.filter(d => d.liveSingleOfferId).map(d => d.userId));

  for (const task of demand) {                                // (priority_at, seq) ascending
    if (task.status === 'offered') continue;                  // its single recipient is already in `blocked`

    const tried = await loadTriedSet(tx, task.id);            // §2.5
    const cand = idle.find(d => !tried.has(d.userId) && !blocked.has(d.userId));

    if (cand) {
      if (task.status === 'broadcast') {
        await revokeRound(tx, task.liveOfferId, 'converted_to_single', now);   // cards vanish for others
      }
      await createSingleRound(tx, task, cand, now, cfg);      // task→offered + timers + ws/push
      idle.splice(idle.indexOf(cand), 1);
      blocked.add(cand.userId);
      continue;
    }

    // no untried idle driver may take it
    const canAct = onDuty.filter(d => d.state !== 'busy_with_next');
    if (task.status === 'queued') {
      if (canAct.length > 0 && canAct.every(d => blocked.has(d.userId))) continue;   // R-3: held by an older live round: stay queued
      await openBroadcast(tx, task, onDuty, now, cfg);        // task→broadcast + reminder timer + ws/push; all view_only when everyone is busy_with_next (DEC-213)
    } else {
      await extendBroadcast(tx, task, onDuty);                // add drivers who came on duty since it opened
    }
    for (const d of onDuty) if (d.state !== 'busy_with_next') blocked.add(d.userId);
  }

  // E. advisory alerts (never reassign silently)
  await checkIdleDriverWhileNextWaiting(tx, poolId, cfg, idle);
  return finishPass(tx, pool, now, reason);                   // last_pass_at, pass_count, metrics
}
```

قواعد مستنتجة من الشيفرة يجب أن تبقى صحيحة عند أي تعديل:

- **R-1** أقدم طلب يُعالج أولًا دائمًا، والأطول تفرغًا يأخذ أقدم طلب (المعمارية §4و.1–2).
- **R-2** العرض الفردي يذهب فقط لمتاح لا يحمل عرضًا فرديًا حيًا ولم يُجرَّب لهذا الطلب في النوبة.
- **R-3** إذا لم يوجد مرشح فردي يُفتح البث، إلا إذا كان كل من يمكنه التصرف محجوبًا بجولة أقدم؛ عندها يبقى الطلب `queued` غير مرئي حتى تُحجز الجولة الأقدم (لأن حارس الأولوية سيمنع أي أحد من أخذه قبل الأقدم على أي حال). وإن لم يوجد من يمكنه التصرف أصلًا (كل المناوبين غير المستريحين `busy_with_next`) يُفتح البث ومستلموه كلهم `view_only`، فيظهر الطلب منتظرًا ويتحول فرديًا حين يتفرغ أحد (المثال الثالث في §4.8، DEC-213).
- **R-4** الطلب المعروض حصريًا على سائق ليس متاحًا للبقية، فيجوز توزيع الطلب التالي عليهم (المعمارية §4و.6).
- **R-5** تحويل البث إلى فردي يحدث فقط لمتاح لم يُجرَّب لنفس الطلب، فلا تحدث حلقة «فردي ← انتهاء ← بث ← فردي لنفس السائق».
- **R-6** البث يشمل كل المناوبين في المجموعة عدا المستريحين، بما فيهم `busy_with_next` (يرون التنبيه ولا يقبلون — المعمارية §4و.3).

ملاحظة S2 (DEC-178): قبل PNT-052 وPNT-053 لا بث (`BroadcastPolicy` يبقي المهمة `queued`)؛ الطلب الذي استنفد مرشحيه غير المجرَّبين يبقى `queued` حتى يظهر متاح جديد (مناوبة جديدة، مهمة منتهية، نهاية استراحة)، ولا يُصفَّر المجرَّبون إلا بنوبة جديدة (§2.5).

### 4.2 قراءة الطابور والسائقين (SQL مُجرّب)

```sql
SET LOCAL lock_timeout = '3s';

-- 1) pool lock
SELECT id, org_id, venue_id, status FROM dispatch_pools WHERE id = $1 FOR NO KEY UPDATE;

-- 2) open demand, oldest first (locks task rows; the outer-joined side is not locked)
SELECT t.id, t.status, t.priority_at, t.seq, t.queued_at, t.ticket_id, t.cycle_id, t.version,
       o.id AS live_offer_id, o.mode AS live_offer_mode, o.expires_at
FROM tasks t
LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
WHERE t.dispatch_pool_id = $1
  AND t.type = 'retrieve'
  AND t.status IN ('queued','offered','broadcast')
ORDER BY t.priority_at, t.seq
FOR NO KEY UPDATE OF t;

-- 3) pool drivers with derived state and live single offer
SELECT s.duty_session_id, s.user_id, s.duty_status, s.driver_state, s.available_since, s.connection_state,
       (SELECT o.id
          FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
         WHERE r.user_id = s.user_id AND o.status = 'active' AND o.mode = 'single'
         LIMIT 1) AS live_single_offer_id
FROM v_driver_state s
JOIN users u ON u.id = s.user_id AND u.status = 'active'
JOIN duty_sessions d ON d.id = s.duty_session_id
JOIN shifts sh ON sh.id = d.shift_id AND sh.status = 'open'   -- DEC-189: a closing shift's sessions are skipped
WHERE s.dispatch_pool_id = $1                  -- on_duty + on_break (ended excluded by the view)
ORDER BY s.available_since NULLS LAST, s.user_id;
```

### 4.3 إنشاء عرض فردي

```sql
-- inside the pass, pool already locked
INSERT INTO task_offers (org_id, task_id, dispatch_pool_id, mode, round_no, status, reminder_at, expires_at)
VALUES ($org, $task, $pool, 'single',
        COALESCE((SELECT max(round_no) FROM task_offers WHERE task_id = $task), 0) + 1,
        'active',
        now() + make_interval(secs => $reminder_s),     -- dispatch.single_offer_reminder_s (15)
        now() + make_interval(secs => $ttl_s))          -- dispatch.single_offer_ttl_s (30)
RETURNING id, version, expires_at;

INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as)
VALUES ($offer, $driver, $duty_session, 'accept');

UPDATE tasks
   SET status = 'offered', first_offered_at = COALESCE(first_offered_at, now()), version = version + 1
 WHERE id = $task AND status IN ('queued','broadcast') AND version = $task_version;   -- 0 rows ⇒ bug: abort

INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id, available_at, dedupe_key, payload)
VALUES ($org, 'task.offered',      'task_offer', $offer, $offer_version, $venue, now(), NULL,
          jsonb_build_object('task_id', $task, 'recipient', $driver)),
       ($org, 'job.offer_remind',  'task_offer', $offer, $offer_version, $venue, now() + make_interval(secs => $reminder_s),
          'offer_remind:' || $offer, '{}'::jsonb),
       ($org, 'job.offer_expire',  'task_offer', $offer, $offer_version, $venue,
          now() + make_interval(secs => $ttl_s) + $grace_ms * interval '1 millisecond',   -- expires_at + dispatch.accept_grace_ms (DEC-47)
          'offer_expire:' || $offer, '{}'::jsonb);
```

مخرجات بعد الالتزام: `task.offered` إلى `user:{driverId}` مع الصوت `offer` (منشور بـ`pg_notify` داخل المعاملة نفسها، DEC-48)، وإشعار Web Push برقم التذكرة فقط عبر `job.push_send` في العامل (DEC-23)، وتحديث لوحة المشرف `venue:{venueId}:supervisors`.

### 4.4 فتح البث وتمديده

```sql
INSERT INTO task_offers (org_id, task_id, dispatch_pool_id, mode, round_no, status, reminder_at, expires_at)
VALUES ($org, $task, $pool, 'broadcast',
        COALESCE((SELECT max(round_no) FROM task_offers WHERE task_id = $task), 0) + 1,
        'active', now() + make_interval(secs => $broadcast_reminder_s), NULL)   -- dispatch.broadcast_reminder_s (30)
RETURNING id, version;

-- recipients = every on-duty driver of the pool (break excluded); used verbatim for extension too
INSERT INTO offer_recipients (offer_id, user_id, duty_session_id, eligible_as)
SELECT $offer, s.user_id, s.duty_session_id,
       CASE s.driver_state
         WHEN 'available'      THEN 'accept'
         WHEN 'intake_parking' THEN 'reserve_next'
         WHEN 'retrieving'     THEN 'reserve_next'
         ELSE 'view_only' END
FROM v_driver_state s
JOIN users u ON u.id = s.user_id AND u.status = 'active'
WHERE s.dispatch_pool_id = $pool AND s.duty_status = 'on_duty'
ON CONFLICT (offer_id, user_id) DO NOTHING
RETURNING user_id, eligible_as;                 -- RETURNING rows = newly added recipients to notify

UPDATE tasks SET status = 'broadcast', broadcast_at = COALESCE(broadcast_at, now()), version = version + 1
 WHERE id = $task AND status = 'queued' AND version = $task_version;
```

- الأحداث: `task.broadcast_opened` (أو `task.broadcast_extended` عند إضافة مستلمين جدد)؛ ws `task.broadcast` يُرسل لكل مستلم جديد على غرفته `user:{userId}` مع `eligible_as` لأن الأهلية تختلف من سائق لآخر؛ الصوت `broadcast` لكل المستلمين (المعمارية §7 «إشعار صوتي لجميع سائقي الموقع داخل الوردية عدا المستريح وخارج الوردية»)؛ Push بنفس قاعدة DEC-23.
- يُجدول `job.broadcast_remind` عند `+30s` بمفتاح `broadcast_remind:<offer_id>`.
- البث لا ينتهي بالوقت (`expires_at = NULL`)؛ ينتهي بالقبول أو التحويل إلى فردي أو الإلغاء.

### 4.5 تحويل البث إلى عرض فردي

عندما يصبح سائق متاحًا (بدء مناوبة، انتهاء استراحة، إنهاء مهمة دون تالية) والبث قائم، تجد التمريرة في الخطوة D أن أقدم طلب مبثوث له مرشح فردي لم يُجرَّب، فتنفذ في المعاملة نفسها:

```sql
UPDATE task_offers
   SET status = 'revoked', closed_at = now(), close_reason = 'converted_to_single', version = version + 1
 WHERE id = $broadcast_offer AND status = 'active';
-- ثم §4.3 لنفس المهمة (UPDATE tasks … WHERE status IN ('queued','broadcast') يقبل 'broadcast')
```

- `offer.revoked` + ws `offer.closed` إلى مستلمي البث (تختفي البطاقة ويتوقف الصوت)؛ أي محاولة قبول متأخرة على جولة البث تعود `OFFER_REVOKED` (410).
- مؤقت التصعيد لا يُعاد ضبطه بالتحويل (النوبة نفسها).

### 4.6 لا يوجد من يخدم المجموعة

- إذا وجد طلب مفتوح ولا يوجد أي سائق مناوب (أو الجميع في استراحة): تنبيه `no_drivers_on_duty` بشدة `critical` ومفتاح `no_drivers_on_duty:<pool_id>`، صوت `escalation` لمشرفي الموقع، والطلب يبقى في الطابور. **لا يُرسل لموقع آخر أبدًا** (المعمارية §7).
- يُحل التنبيه آليًا (`resolved_by = NULL`) في أول تمريرة يوجد فيها مناوب.

### 4.7 تنبيه «سائق متاح والطلب الأقدم محجوز تاليًا»

في نهاية كل تمريرة، إذا `dispatch.idle_driver_alert = true` ووُجد سائق متاح لا يحمل عرضًا فرديًا ووُجدت مهمة `assigned_waiting` في المجموعة: تنبيه `idle_driver_while_next_waiting` بشدة `warning` (الملف 14 §8) لأقدم مهمة محجوزة، مفتاح `idle_driver_while_next_waiting:<task_id>`، وتفاصيل `{ idle_driver_ids, reserved_by, waiting_since }` — تنبيه واحد للمجموعة، وتُحل تنبيهاتها الأخرى من النوع نفسه بالسبب `no_idle_driver` (DEC-231). يُحل آليًا عند ترقية المهمة أو سحبها أو اختفاء المتاح. **لا إعادة إسناد صامتة**؛ المشرف يقرر عبر §9.1 (المعمارية §4و.7).

### 4.8 أمثلة زمنية

| السيناريو | ما يحدث |
|---|---|
| ثلاثة متاحين A (الأطول تفرغًا) ثم B ثم C، وصل T1 | T1 ← عرض فردي إلى A. |
| وصل T1 وT2 وT3 معًا ومتاحان A وB، وC وD مشغولان | T1 ← A فردي، T2 ← B فردي، T3 ← بث (C وD يستطيعان الحجز كتالية؛ A وB يريان بطاقتيهما الأقدم فقط). |
| الجميع مشغولون، وصل T1 | بث فوري. B المشغول يحجزه ← `assigned_waiting` وW-03 للعميل. T2 يصل ← بث ← C يحجزه. T3 يصل والكل `busy_with_next` ← بث `view_only`؛ عند 60 ثانية تصعيد للمشرف. A يبدأ مناوبته ← T3 يتحول فرديًا إلى A. |
| A متاح ويتجاهل | T1 ← A فردي 30 ثانية ← انتهاء، تدوير A لآخر الصف ← لا مرشح آخر ← بث (A مستلم بـ`accept`) ← تذكير عند +30 ثانية من فتح البث ← تصعيد عند 60 ثانية من `queued_at`. |
| T1 مبثوث وA (مُجرَّب له) متاح، وصل T2 | T2 يبقى `queued` (A محجوب بالأقدم، وكل من يتصرف مستلم لـT1). حين يُحجز T1 ← T2 فردي إلى A ← إن تجاهل ← بث. |

---

## 5. أمر قبول العرض

### 5.1 العقد

`POST /v1/task-offers/{offerId}/accept` — الصلاحية `offer.accept` — `Idempotency-Key` إلزامي — بلا جسم (الخادم يقرر بين القبول والحجز التالي حسب الحالة الفعلية؛ المعمارية §4و.4).

الرد الناجح `200`:

```json
{
  "data": {
    "result": "accepted",
    "task":   { "id": "…", "status": "accepted", "version": 5, "ticket_id": "…", "priority_at": "…" },
    "ticket": { "id": "…", "display_number": 125, "status": "assigned", "version": 9 },
    "driver_state": "retrieving"
  },
  "meta": { "request_id": "req_…", "server_time": "2026-10-27T19:20:00.000Z" }
}
```

`result ∈ {accepted, assigned_waiting}` (الشكل الكامل في `07_openapi.yaml`). إذا كانت المهمة محجوزة مسبقًا لنفس السائق (جهاز ثانٍ) يعود `200` بالنتيجة الحالية نفسها، وليس خطأ.

### 5.2 تسلسل المعاملة

| # | الخطوة | SQL / المنطق |
|---|---|---|
| 0 | مفتاح التكرار ونقطة حفظ | §13.3: إدخال `idempotency_keys` ثم `SAVEPOINT cmd` |
| 1 | تحميل العرض ضمن النطاق دون قفل | `SELECT o.task_id, o.dispatch_pool_id FROM task_offers o JOIN dispatch_pools p ON p.id = o.dispatch_pool_id WHERE o.id = $offer AND p.venue_id = ANY($actor_venue_ids)` (موقع التعيين النشط للسائق، أو مواقع نطاق المشرف `can_drive`) ← لا صف (غير موجود أو في موقع خارج نطاق الفاعل): `OFFER_NOT_FOUND` (404) دون إفصاح |
| 2 | قفل المجموعة (L1) | `SELECT … FROM dispatch_pools WHERE id = $pool FOR NO KEY UPDATE` |
| 3 | قفل المهمة (L4) | `SELECT t.* FROM tasks t JOIN task_offers o ON o.task_id = t.id WHERE o.id = $offer FOR NO KEY UPDATE OF t` |
| 4 | قفل التذكرة (L5) | `SELECT * FROM tickets WHERE id = $ticket FOR NO KEY UPDATE` |
| 5 | قفل الدورة (L6) | `SELECT * FROM retrieval_cycles WHERE id = $cycle FOR NO KEY UPDATE` |
| 6 | قفل الجولة (L7) | `SELECT * FROM task_offers WHERE id = $offer FOR NO KEY UPDATE` |
| 7 | قفل مناوبة القابل (L8) | `SELECT * FROM duty_sessions WHERE user_id = $actor AND status <> 'ended' FOR NO KEY UPDATE` |
| 8 | فحوص المناوبة والتعيين | مناوبة في هذه المجموعة وإلا `DUTY_REQUIRED`؛ استراحة ← `DRIVER_ON_BREAK`؛ تعيين نشط على الموقع (أو نطاق + `can_drive`) وإلا `ASSIGNMENT_REQUIRED` |
| 9 | مستلم؟ | `offer_recipients(offer_id, user_id)` غير موجود ← `NOT_OFFER_RECIPIENT` (403) |
| 10 | محجوزة؟ | المهمة `accepted/assigned_waiting/in_progress/completed`: إن كان المكلّف هو القابل ← `200` بالحالة الحالية؛ وإلا تسجيل `offer_recipients.response = 'rejected_late'` و`TASK_ALREADY_CLAIMED` (409) |
| 11 | مسحوبة/ملغاة؟ | المهمة `canceled` أو الجولة `revoked` ← `OFFER_REVOKED` (410) |
| 12 | منتهية؟ | الجولة `expired`، أو فردية و`now() >= expires_at + dispatch.accept_grace_ms` ← `OFFER_EXPIRED` (410) |
| 13 | حالة القابل | `busy_with_next` ← `NEXT_TASK_ALREADY_RESERVED`؛ جولة فردية والقابل غير متاح ← `DRIVER_NOT_AVAILABLE` |
| 14 | حارس الأولوية | §5.4 ← `OLDER_REQUEST_PENDING` (409) مع `details.older_task_id` |
| 15 | التطبيق | §5.3 |
| 16 | التمريرة | `runDispatchPass(tx, pool, 'offer_accepted')` لإكمال الطلبات الأحدث |
| 17 | إغلاق | تحديث سجل التكرار بالرد، `COMMIT` |

ترتيب الفحوص (الخطوة 1 ثم 8–14) ملزم: يحدد الخطأ الذي يراه السائق عند تعدد الأسباب (مثلًا: «قبله سائق آخر» أوضح للسائق من «انتهى العرض» حين يكونان صحيحين معًا).

عند أي خطأ نطاقي في الخطوة 1 أو الخطوات 8–14: `ROLLBACK TO SAVEPOINT cmd`، ثم يُكتب `rejected_late` (مع `TASK_ALREADY_CLAIMED` فقط) وسجل التكرار بالرد الخاطئ، ثم `COMMIT` — كي تعيد إعادة الإرسال بنفس المفتاح الرد ذاته.

### 5.3 التطبيق (SQL مُجرّب)

```sql
-- outcome := 'accepted' if actor has no active movement, else 'assigned_waiting'
UPDATE task_offers
   SET status = 'accepted', closed_at = now(), close_reason = 'accepted', accepted_by = $actor, version = version + 1
 WHERE id = $offer AND status = 'active';

UPDATE offer_recipients SET response = 'accepted', responded_at = now()
 WHERE offer_id = $offer AND user_id = $actor;

UPDATE tasks
   SET status = $outcome, assignee_id = $actor, claimed_at = now(),
       accepted_at         = CASE WHEN $outcome = 'accepted'         THEN now() END,
       assigned_waiting_at = CASE WHEN $outcome = 'assigned_waiting' THEN now() END,
       version = version + 1
 WHERE id = $task AND status IN ('offered','broadcast') AND version = $task_version;
-- ROW_COUNT must be 1; 0 ⇒ abort (cannot happen under the pool lock; guard kept as a backstop)

UPDATE retrieval_cycles
   SET accepted_by = $actor,
       assigned_at         = CASE WHEN $outcome = 'accepted'         THEN now() ELSE assigned_at END,
       assigned_waiting_at = CASE WHEN $outcome = 'assigned_waiting' THEN now() ELSE assigned_waiting_at END
 WHERE id = $cycle;

UPDATE tickets
   SET status = CASE WHEN $outcome = 'accepted' THEN 'assigned' ELSE 'assigned_waiting' END, version = version + 1
 WHERE id = $ticket AND version = $ticket_version;

-- only when accepted as available
UPDATE duty_sessions SET available_since = NULL, version = version + 1 WHERE id = $actor_duty_session;

INSERT INTO ticket_events (org_id, venue_id, ticket_id, type, actor_type, actor_id, ticket_version, data)
VALUES ($org, $venue, $ticket,
        CASE WHEN $outcome = 'accepted' THEN 'ticket.assigned' ELSE 'ticket.assigned_waiting' END,
        'user', $actor::text, $ticket_version + 1, jsonb_build_object('task_id', $task, 'offer_id', $offer));
```

ثم في المعاملة نفسها:

- إن كان القابل يحمل عرضًا فرديًا حيًا آخر (لمهمة أحدث؛ الأقدم يمنعه حارس الأولوية §5.4): تُقفل تلك المهمة (L4) وجولتها (L7) بموجب استثناء Canon §14ب (§2.1)، وتُسحب الجولة (`close_reason = 'recipient_unavailable'`) وتعود مهمتها `queued` في النوبة نفسها (يبقى القابل مُجرَّبًا لها §2.5)، وذلك **قبل** التمريرة (الخطوة 16)؛ فيبقى الثابت I-D (العرض الفردي الحي لا يحمله إلا متاح، §14.1) صحيحًا.
- `outbox_events`: `task.claimed` (ws إلى `pool:{poolId}:drivers` و`venue:{venueId}:supervisors`: كل الأجهزة المتصلة تحذف البطاقة وتوقف الصوت)، و`ticket.assigned` أو `ticket.assigned_waiting`.
- إن كانت النتيجة `assigned_waiting`: إشعار عميل W-03 (`masaf_request_reserved_v1`) يخططه `NotificationPlanner` في المعاملة نفسها بمفتاح منع تكرار على مستوى الدورة `wa:W-03:{cycle_id}` (صيغة الملف 12)، وجدولة `job.next_task_wait_check` عند `+dispatch.next_task_wait_alert_s` بمفتاح `next_task_wait:<task_id>:<assigned_waiting_at>`.
- إن كانت `accepted`: لا رسالة للعميل (W-04 فقط عند «بدء الإحضار»).
- Push «هادئ» بنفس الوسم `tag = task:<task_id>` لبقية المستلمين يستبدل إشعار الطلب (DEC-23).
- حل التنبيه `request_unaccepted:<task_id>` إن كان مفتوحًا.
- `audit_log` بالفعل `offer.accept`. أما حدث القياس (§12) فلا يُكتب داخل معاملة الأمر؛ يكتبه `AnalyticsProjector` في العامل من حدث النطاق في Outbox.

### 5.4 حارس الأولوية (SQL مُجرّب)

```sql
-- any OLDER live round in this pool on which the actor is a recipient blocks the accept
SELECT t2.id AS older_task_id, o2.id AS older_offer_id
FROM tasks t2
JOIN task_offers o2      ON o2.task_id = t2.id AND o2.status = 'active'
JOIN offer_recipients r2 ON r2.offer_id = o2.id AND r2.user_id = $actor
WHERE t2.dispatch_pool_id = $pool
  AND t2.status IN ('offered','broadcast')
  AND t2.id <> $task
  AND (t2.priority_at, t2.seq) < ($task_priority_at, $task_seq)
  AND (o2.mode = 'broadcast' OR o2.expires_at + $grace_ms * interval '1 millisecond' > now())   -- dispatch.accept_grace_ms
ORDER BY t2.priority_at, t2.seq
LIMIT 1;
```

- الطلب الأقدم الذي ما زال `queued` (بلا جولة) **لا** يحجب، لأنه ليس متاحًا لأحد بعد (المعمارية §4و.6).
- الطلب الأقدم المعروض حصريًا على سائق آخر لا يحجب غيره.
- التجاوز: فقط المشرف عبر §9.1 مع `override_priority = true` وسبب.

### 5.5 الخاسرون والأجهزة غير المتصلة

- كل قبول متزامن ينتظر على قفل المجموعة؛ بعد التزام الفائز يرى المهمة محجوزة فيعود `TASK_ALREADY_CLAIMED` (409). العرض المنتهي يعود `OFFER_EXPIRED` (410)، والمسحوب `OFFER_REVOKED` (410).
- الجهاز غير المتصل قد يُبقي إشعارًا قديمًا؛ عند فتحه يجلب `GET /v1/me/home` الحالة الحالية، والخادم يرفض أي قبول مهما بقي ظاهرًا (المعمارية §7).

### 5.6 الحواجز الأخيرة مع تعدد الأجهزة

| الحالة | ما يمنع الخطأ |
|---|---|
| جهازان لنفس السائق يقبلان نفس العرض | الثاني يجد المهمة محجوزة له ← `200` بنفس النتيجة |
| جهازان لنفس السائق يقبلان مهمتين مختلفتين بالتوازي | التسلسل على القفل: الأولى `accepted` والثانية تُحجز تالية أو تُرفض بالحارس؛ ولو تجاوز الكود الفحص يرفض `uq_tasks_active_movement_driver` أو `uq_tasks_next_per_driver` |
| خلل يتجاوز قفل المجموعة | `UPDATE … WHERE status IN ('offered','broadcast') AND version = $v` يعيد 0 صفوف للثاني |
| تمريرتان متزامنتان (أمر + تمريرة تأمينية) | القفل يسلسلهما؛ و`uq_task_offers_active` يمنع جولتين حيتين لنفس المهمة |

### 5.7 دليل التحقق

جُرّب على PostgreSQL 16: جولة بث لـ12 سائقًا (10 بأهلية `accept` و2 بـ`reserve_next`) و12 طلب قبول متوازٍ عبر 12 اتصالًا مستقلًا: فائز واحد `accepted`، و11 نتيجة `TASK_ALREADY_CLAIMED`، وحدث `task.claimed` واحد في `outbox_events`، والجولة `accepted_by` = الفائز. وجُرّب الحارس: سائق يحمل عرضًا فرديًا لطلب أقدم حاول قبول بث أحدث ← `OLDER_REQUEST_PENDING`.

---

## 6. الإنهاء والترقية

### 6.1 الإجراء المشترك

```ts
// called with the pool lock held, AFTER the caller has completed/canceled the driver's current task
async function settleDriverAfterTask(tx: Tx, poolId: UUID, driverId: UUID, now: Date): Promise<'promoted' | 'available' | 'off'> {
  const next = await tx.maybeOne(sql`
    SELECT * FROM tasks WHERE assignee_id = ${driverId} AND status = 'assigned_waiting' FOR NO KEY UPDATE`);
  if (next) {
    await promoteNextTask(tx, next, now);          // assigned_waiting → accepted, ticket → assigned
    return 'promoted';                              // available_since stays NULL: never "available" in between
  }
  const ds = await lockOpenDutySession(tx, driverId);
  if (ds?.status === 'on_duty') {
    await tx.query(sql`UPDATE duty_sessions SET available_since = now(), version = version + 1 WHERE id = ${ds.id}`);
    await emit(tx, 'driver.availability_changed', { driverId, state: 'available' });
    return 'available';
  }
  return 'off';
}
```

ثم يستدعي المتصل `runDispatchPass(tx, poolId, 'driver_available')` في المعاملة نفسها.

### 6.2 الترقية (SQL مُجرّب)

```sql
-- order is mandatory: the current task must leave accepted/in_progress first,
-- otherwise uq_tasks_active_movement_driver rejects the promotion (verified).
UPDATE tasks SET status = 'completed', completed_at = now(), version = version + 1
 WHERE id = $current_task AND status = 'in_progress';

UPDATE tasks SET status = 'accepted', accepted_at = now(), version = version + 1
 WHERE assignee_id = $driver AND status = 'assigned_waiting'
RETURNING id, ticket_id, cycle_id;

UPDATE tickets SET status = 'assigned', version = version + 1
 WHERE id = $next_ticket AND status = 'assigned_waiting';

UPDATE retrieval_cycles SET assigned_at = now() WHERE id = $next_cycle;
```

- الأحداث: `task.promoted` ← ws `task.updated` إلى `user:{driverId}` مع الصوت `next_due`، وPush «مهمتك التالية جاهزة» (رقم التذكرة فقط).
- **لا** رسالة للعميل عند الترقية؛ العميل استلم W-03 عند الحجز، وW-04 تصل فقط عند «بدء الإحضار».
- تُحل تنبيهات `next_task_waiting_long:<task_id>` و`idle_driver_while_next_waiting:<task_id>`.
- السائق يبدأ المهمة المرقّاة من الخطوة الأولى: تأكيد استلام المفتاح ثم «بدء الإحضار».

### 6.3 من يستدعي الإجراء

| الأمر | المهمة المنتهية | ملاحظة |
|---|---|---|
| `POST /v1/tickets/{ticketId}/handover` | `retrieve` ← `completed` | بعد التحقق من الرمز والتحصيل ونقل العهدة للعميل |
| `POST /v1/tickets/{ticketId}/handover-exception` | `retrieve` ← `completed` | تسليم باستثناء مشرف موثق |
| `POST /v1/tasks/{taskId}/complete-parking` | `park`/`repark` ← `completed` | بعد تخصيص الموقف والخانة؛ ويشمل تحويل الطلب المبكر §7.3 |
| `POST /v1/retrieval-cycles/{cycleId}/cancel` قبل البدء | `retrieve` ← `canceled` | إن كانت المهمة الحالية للسائق |
| `POST /v1/tasks/{taskId}/reassign` | مهمة السائق السابق أُخذت منه | يستدعى للسائق السابق |
| `POST /v1/tickets/{ticketId}/custody-transfers` (العهدة إلى سائق آخر) | مهمة السائق السابق `accepted`/`in_progress` تنتقل بحالتها للحائز الجديد (`task.reassigned`، `trigger = custody_transfer`) | يستدعى للسائق السابق تحت L1 ثم تمريرة؛ إن كان للحائز الجديد حركة نشطة ← `MOVEMENT_IN_PROGRESS` ولا نقل |
| `POST /v1/tickets/{ticketId}/manual-reconcile` | المهام المفتوحة للتذكرة ← `canceled` (`cancel_reason = 'manual_reconcile'`) | يستدعى لكل سائق مكلّف تحت L1 ثم تمريرة |
| `POST /v1/tickets/{ticketId}/void` (التذكرة `received` أو `parking`، باعتماد المشرف) | `park` ← `canceled` (`cancel_reason = 'ticket_voided'`) | DEC-20، DEC-45: عهدة المركبة والمفتاح من السائق إلى العميل بسبب `correction` |

«جاهزة» `POST /v1/tasks/{taskId}/ready` **لا** تحرر السائق؛ يبقى مشغولًا حتى التسليم أو نقل العهدة رسميًا (المعمارية §4ز).

---

## 7. الاستلام ودخول الطلب والطلب المبكر

### 7.1 سباق «بدء الاستلام» مع «القبول»

`POST /v1/tickets` (بدء الاستلام) يأخذ قفل مجموعة الحفل أولًا، مثل القبول تمامًا، فيتسلسلان:

1. قفل المجموعة (L1)، ثم صف الحفل (L2) `FOR NO KEY UPDATE` مع التحقق أنه `open` (وإلا `EVENT_NOT_OPEN`).
2. قراءة `driver_state` من `v_driver_state` (لا تتغير تحت قفل المجموعة). يُسمح فقط إذا `driver_state = 'available'`. غير ذلك: لا مناوبة ← `DUTY_REQUIRED`؛ استراحة ← `DRIVER_ON_BREAK`؛ أي مهمة حركة نشطة (`accepted`/`in_progress` من أي نوع، بما فيها مهمة تالية رُقّيت) ← `MOVEMENT_IN_PROGRESS`.
3. إن كان يحمل عرضًا فرديًا حيًا: تُقفل مهمته (L4) ثم الجولة (L7)، وتُسحب الجولة (`close_reason = 'recipient_unavailable'`) وتعود المهمة `queued` (يبقى مُجرَّبًا لها في النوبة).
4. تخصيص رقم التذكرة على صف الحفل المقفول في الخطوة 1 (لا يرفع `version` الحفل):

```sql
UPDATE events SET next_display_number = next_display_number + 1
 WHERE id = $event AND status = 'open'
RETURNING next_display_number - 1 AS display_number;     -- 0 rows ⇒ EVENT_NOT_OPEN
```

5. إنشاء التذكرة `received` ومهمة `park` بحالة `in_progress` باسمه (إدراجات جديدة)، ثم قفل مناوبته (L8) وضبط `available_since = NULL`.
6. تمريرة توزيع (لإعادة عرض ما سُحب منه)، ثم الإلحاقيات (L10).

إذا التزم القبول أولًا: السائق صار مشغولًا ⇒ الاستلام يُرفض (`MOVEMENT_IN_PROGRESS`). إذا التزم الاستلام أولًا: القبول على عرض فردي يعود `OFFER_REVOKED`، وعلى بث يصبح حجزًا تاليًا. السائق المتاح المستلم لبث قائم يجوز له بدء الاستلام؛ تتغير أهليته في البث إلى `reserve_next`.

### 7.2 دخول طلب الإحضار (`requestRetrieval`)

نقطة دخول واحدة لطلب العميل (زر واتساب بعد التحقق من رمز الإجراء — الملف 12) وطلب الموظف نيابة عنه. المعاملة: قفل المجموعة ← قفل التذكرة ← تفرع بحسب الحالة. ضغطة الزر تأخذ L1 قبل L5 دائمًا ولو انتهت بلا دورة، لأن النتيجة المقروءة تحت L5 قد تفتح دورة؛ و`requested_at` لها = الأصغر من طابع الرسالة و`now()`؛ وحارس «الحفل مفتوح أو قيد الإغلاق» (TT-06 أ) لازم من التذكرة المفتوحة فلا يُعاد قراءته (DEC-203):

| حالة التذكرة | من واتساب | من الموظف (`POST /v1/tickets/{ticketId}/retrievals`) |
|---|---|---|
| `parked` | دورة جديدة + مهمة `queued` + التذكرة `requested` + W-02 + تمريرة | نفس الشيء مع `request_source = 'staff'` وسبب إلزامي (`REASON_REQUIRED`)؛ W-02 إن كانت مربوطة |
| `received`، `parking`، `reparking` | طلب مبكر معلّق §7.3 + W-02 | `TICKET_NOT_PARKED` (409) |
| `requested`، `assigned`، `assigned_waiting`، `retrieving`، `ready` | لا تغيير؛ رد الحالة الحالية W-09 | `RETRIEVAL_ALREADY_ACTIVE` (409) مع `details.cycle_id` |
| `delivered`، `voided` | رد W-09 بالحالة | `TICKET_CLOSED` (409) |

إنشاء الدورة والمهمة:

```sql
INSERT INTO retrieval_cycles (org_id, venue_id, ticket_id, cycle_no, requested_at, request_source,
                              requested_by_customer_id, requested_by_user_id, request_reason, requested_early)
VALUES ($org, $venue, $ticket,
        COALESCE((SELECT max(cycle_no) FROM retrieval_cycles WHERE ticket_id = $ticket), 0) + 1,
        $requested_at, $source, $customer_id, $user_id, $reason, $early)
RETURNING id, requested_at;                       -- uq_retrieval_cycles_open backs the "one open request" rule

INSERT INTO tasks (org_id, venue_id, dispatch_pool_id, event_id, ticket_id, cycle_id, type, status, priority_at, queued_at)
VALUES ($org, $venue, $pool, $event, $ticket, $cycle, 'retrieve', 'queued', $requested_at, now())
RETURNING id, version;

UPDATE tickets SET status = 'requested', active_cycle_id = $cycle, last_requested_at = $requested_at, version = version + 1
 WHERE id = $ticket AND status = 'parked';
```

ثم: `ticket.retrieval_requested` و`task.created`، إشعار W-02 (`masaf_request_received_v1`) بعد الحفظ الفعلي فقط (المعمارية §4هـ)، جدولة `job.escalate_unaccepted` عند `queued_at + dispatch.unaccepted_escalation_s` بمفتاح `escalate_unaccepted:<task_id>:<queued_at>`، ثم التمريرة.

الضغط المتكرر من العميل لا ينشئ طلبًا ثانيًا: الفرع «طلب قائم» + `uq_retrieval_cycles_open` + منع تكرار `wa_message_id` في الملف 12.

### 7.3 الطلب المبكر (DEC-13)

- نتائج نقطة الدخول للعميل (`requestRetrievalForCustomer`): `created` (دورة جديدة لتذكرة `parked`)، `pending_early` (أول طلب مبكر)، `already_pending` (ضغطة مكررة أثناء الصف تُبقي الوقت الأول ولا تصدر شيئًا)، `already_active` (دورة مفتوحة)، `closed` (DEC-227).
- عند الطلب والتذكرة `received`/`parking`/`reparking`: إن كان `pending_retrieval_at IS NULL` يُضبط `pending_retrieval_at = now()` و`pending_retrieval_source = 'whatsapp'` (تكرار الضغط لا يغيّر الوقت)، والحدث `ticket.retrieval_requested_early` يحمل `status_at_request` و`parking_task_assignee_id`. حدث `ticket.retrieval_requested_early`، W-02 للعميل، وws `ticket.updated` إلى السائق القائم على المركبة (لافتة «العميل طلب سيارته — أكمل الصف وستُعرض للإحضار») وإلى مشرفي الموقع. **لا** تُنشأ مهمة؛ لا حركتان متزامنتان (المعمارية §4هـ).
- عند `complete-parking` (في المعاملة نفسها، بعد تخصيص الموقف والخانة والعهدة):

```sql
-- after the ticket becomes 'parked' in this TX
SELECT pending_retrieval_at, pending_retrieval_source, customer_id FROM tickets WHERE id = $ticket;  -- locked earlier
-- if pending_retrieval_at IS NOT NULL: §7.2 insert with requested_at = pending_retrieval_at, requested_early = true,
--   request_source = 'whatsapp', requested_by_customer_id = tickets.customer_id
UPDATE tickets SET pending_retrieval_at = NULL, pending_retrieval_source = NULL, version = version + 1 WHERE id = $ticket;
```

- تُكتب أحداث `ticket.parked` ثم `ticket.retrieval_requested`، ولا تُرسل W-02 مرة ثانية (أُرسلت عند الطلب المبكر). `priority_at` = وقت الطلب الأصلي؛ `queued_at` = الآن (التصعيد يقاس من دخول الطابور).
- سائق الصف نفسه يعود متاحًا أو تُرقّى مهمته التالية (§6) ثم التمريرة؛ لا أولوية له على الطلب لأنه سجّل المركبة.

### 7.4 المسودة المهجورة (DEC-20)

- `POST /v1/tickets/{ticketId}/discard-draft` (مسودة فارغة فقط): مهمة `park` ← `canceled`، التذكرة ← `voided`، ثم §6.1 (يعود متاحًا) وتمريرة.
- مسودة فيها بيانات: `DRAFT_HAS_DATA`؛ السائق يبقى مشغولًا حتى يعتمد المشرف `POST /v1/tickets/{ticketId}/void` بعد التحقق من العهدة، فتُنفذ الخطوات نفسها، مع تنبيه `draft_abandoned` حين تتجاوز المسودة حدًا زمنيًا (يحدده الملف 14).

---

## 8. المؤقتات والمهام المؤجلة

### 8.1 النمط العام لمعالج المؤقت

```ts
async function handleTimer(job: OutboxJob): Promise<void> {
  await withSystemTx(async (tx) => {
    const poolId = await resolvePoolId(tx, job);              // read without lock
    if (!poolId) return markDone(job, 'aggregate_gone');
    await lockPool(tx, poolId);                               // L1
    const agg = await lockAggregate(tx, job);                 // L4 → L5 → L6 → L7 → L8 as needed (canon §14ب)
    if (!stillApplies(agg, job)) return markDone(job, 'stale');   // version/state/episode re-check
    if (firedEarly(agg, job, now)) return reschedule(job, dueAt(agg));
    await apply(tx, agg, job);                                // state change + outbox + (pass when relevant)
  });
}
```

- «لا يزال ينطبق» يعني: `aggregate_version` المخزن يساوي النسخة الحالية **أو** (للمؤقتات المرتبطة بالنوبة) أن قيمة الحلقة المخزنة في `payload` (`queued_at` / `assigned_waiting_at` / `ready_at`) ما زالت هي نفسها. تغيّر النسخة بسبب حقل وصفي (§2.7) لا يبطل المؤقت لأن تلك الحقول لا ترفعها.
- المؤقت الذي يُنفذ متأخرًا لا يُنتج أثرًا خاطئًا؛ تأخره يظهر في القياس `timer_lag`.

### 8.2 جدول المؤقتات

| المهمة | تُجدول عند | `available_at` | فحص «لا يزال ينطبق» | الأثر | `dedupe_key` |
|---|---|---|---|---|---|
| `job.offer_remind` | إنشاء جولة فردية | `+single_offer_reminder_s` (15) | الجولة `active` و`version` كما هي و`reminded_at IS NULL` | ws `offer.reminder` + صوت `reminder` + Push بنفس الوسم؛ ضبط `reminded_at` (وصفي) | `offer_remind:<offer_id>` |
| `job.offer_expire` | إنشاء جولة فردية | `expires_at + dispatch.accept_grace_ms` (DEC-47) | الجولة `active` و`version` كما هي | الجولة `expired`، المهمة `queued`، تدوير المستلم §2.3، ws `offer.closed`، تمريرة | `offer_expire:<offer_id>` |
| `job.broadcast_remind` | فتح بث | `+broadcast_reminder_s` (30) | الجولة `active` و`reminded_at IS NULL` | تذكير **واحد** للمستلمين القادرين على التصرف الآن (`accept`/`reserve_next`) فقط | `broadcast_remind:<offer_id>` |
| `job.escalate_unaccepted` | دخول المهمة الطابور (إنشاء أو إعادة) | `queued_at + unaccepted_escalation_s` (60) | المهمة `queued/offered/broadcast` و`queued_at` = قيمة `payload` | تنبيه `request_unaccepted` (critical) + صوت `escalation` للمشرفين + `tasks.escalated_at` + `task.escalated`؛ الطلب لا يسقط من الطابور | `escalate_unaccepted:<task_id>:<queued_at>` |
| `job.next_task_wait_check` | حجز مهمة تالية | `assigned_waiting_at + next_task_wait_alert_s` (300) | المهمة `assigned_waiting` و`assigned_waiting_at` = قيمة `payload` | تنبيه `next_task_waiting_long` (warning)؛ **لا** إعادة إسناد | `next_task_wait:<task_id>:<assigned_waiting_at>` |
| `job.ready_uncollected_check` | `POST /v1/tasks/{taskId}/ready` | `ready_at + ready.uncollected_alert_min` (10 د) | التذكرة `ready` و`active_cycle_id` = الدورة و`ready_at` = قيمة `payload` (`{ticket_id, cycle_id, ready_at}`، الكيان `retrieval_cycle`)؛ الانطلاق المبكر يعيد الجدولة (DEC-255) | تنبيه `ready_not_collected` (warning) بفاعل النظام في التدقيق؛ المشرف يقرر إعادة الصف §9.4 | `ready_uncollected:<cycle_id>` |
| `job.claim_code_expire` | إصدار رمز التسليم | `claim_codes.expires_at` | الرمز حي (غير مستهلك ولا ملغى) | مسح `code_ciphertext`، `revoked_at`، `revoke_reason = 'expired_cleanup'`؛ التحقق بعده يعيد `HANDOVER_CODE_EXPIRED` | `claim_code_expire:<claim_code_id>` |
| `job.transfer_activate` | إنشاء نقل مجدول، أو إنهاء مهمة سائق لديه نقل `blocked` | `scheduled_at` أو الآن | النقل `pending`/`blocked` | §9.7 | `transfer_activate:<transfer_id>` |
| `job.heartbeat_sweep` | متكرر كل `heartbeat.interval_s` (15 ث): سلسلة عامة واحدة يبذرها بدء المناوبة (DEC-232) | — | — | `connection_state`: `uncertain` بعد 45 ث، `offline` بعد 120 ث، لكل مناوبة في معاملتها (L8 وحده، بلا رفع إصدار)؛ تنبيه `driver_connection_lost_with_custody` عند الانتقال إلى `offline` وهو يحوز عهدة أو مهمة (DEC-219)؛ **لا** يغيّر التوفر ولا يسحب مهمة | `heartbeat_sweep` |
| `job.dispatch_sweep` | متكرر كل 5 ثوانٍ: سلسلة عامة واحدة تجدول تاليتها دائمًا، ويبذرها عند الحاجة كل أمر ينشئ طلبًا أو جولة بقراءة عادية أولًا (DEC-179) | — | — | تمريرة لكل مجموعة لها طلب مفتوح أو جولة حية أو مهمة تالية، كلٌّ في معاملة، فلا توقف مجموعة فاشلة غيرها | `dispatch_sweep` |
| `job.dispatch_pass` | أمر يحتاج تمريرة لمجموعة لا يحمل قفلها | الآن | — | `runDispatchPass(…, reason)` | `dispatch_pass:<pool_id>` |

`job.link_code_expire` يملكه محوّل واتساب (الملف 12) ولا يمس التوزيع.

### 8.3 انتهاء العرض الفردي (SQL مُجرّب)

```sql
-- pool locked (L1); task row (L4) locked before the offer (L7) — canon §14ب
UPDATE task_offers
   SET status = 'expired', closed_at = now(), close_reason = 'expired', version = version + 1
 WHERE id = $offer AND status = 'active' AND version = $job_aggregate_version
   AND expires_at + $grace_ms * interval '1 millisecond' <= now()   -- dispatch.accept_grace_ms (DEC-47)
RETURNING id;                                                  -- 0 rows ⇒ stale or accepted: no-op

UPDATE tasks SET status = 'queued', version = version + 1 WHERE id = $task AND status = 'offered';

-- rotation: the silent recipient moves to the back of the idle order (still available)
UPDATE duty_sessions SET available_since = now(), version = version + 1
 WHERE user_id = $recipient AND status = 'on_duty' AND available_since IS NOT NULL;
```

ثم `offer.expired` (ws `offer.closed` للمستلم + Push هادئ بنفس الوسم) وتمريرة: إن وُجد متاح آخر لم يُجرَّب ← عرض فردي له؛ وإلا ← بث (المعمارية §7: «إنهاء العرض وعرضه على المتاح التالي؛ إن أصبح الجميع مشغولين ينتقل للبث»).

### 8.4 حل التنبيهات آليًا

| مفتاح التنبيه | يُحل عند |
|---|---|
| `request_unaccepted:<task_id>` | حجز المهمة أو إلغائها |
| `no_drivers_on_duty:<pool_id>` | أول تمريرة بوجود مناوب |
| `next_task_waiting_long:<task_id>` | ترقية المهمة أو سحبها أو إلغائها |
| `idle_driver_while_next_waiting:<task_id>` | ترقية المهمة أو سحبها أو اختفاء المتاح |
| `ready_not_collected:<cycle_id>` | التسليم أو إعادة الصف أو الإلغاء |
| `transfer_blocked:<transfer_id>` | اكتمال النقل أو إلغاؤه |
| `driver_connection_lost_with_custody:<duty_session_id>` | عودة الاتصال `online` أو زوال العهدة والمهمة أو انتهاء المناوبة (DEC-219) |

الحل الآلي يضبط `status = 'resolved'`، `resolved_at = now()`، `resolved_by = NULL`، و`resolution_note` بالسبب، ويرسل ws `alert.updated`.

---

## 9. عمليات المشرف وأثرها على التوزيع

### 9.1 السحب وإعادة الإسناد

`POST /v1/tasks/{taskId}/reassign` — الصلاحية `task.reassign` — الجسم:

```json
{ "target_driver_id": null, "reason": "السائق متأخر", "expected_version": 7 }

{ "target_driver_id": "…", "reason": "أقرب للموقف", "override_priority": false, "expected_version": 7 }
```

`target_driver_id = null` يعني «إلى الطابور» (الشكل الملزم في `07_openapi.yaml`).

| حالة المهمة | مسموح؟ | الشرط |
|---|---|---|
| `queued` / `offered` / `broadcast` | لسائق محدد فقط | تُحجز باسمه وتُسحب الجولة الحية (`close_reason = 'reassigned'`)؛ لا «إعادة للطابور» لأنها فيه أصلًا: `target_driver_id = null` ← `INVALID_STATE_TRANSITION` (`reason = already_in_queue`)، ولا انتقال `broadcast` ← `queued` (DEC-214) |
| `accepted` قبل استلام المفتاح | نعم | — |
| `accepted` بعد استلام المفتاح (`key_picked_up_at IS NOT NULL`) | بعد إقرار تحرير العهدة فقط | وإلا `CUSTODY_RELEASE_REQUIRED` — يلزم `POST /v1/tasks/{taskId}/release-custody` أولًا (إعادة المفتاح لخانته) أو نقل عهدة رسمي `POST /v1/tickets/{ticketId}/custody-transfers` للسائق الجديد |
| `assigned_waiting` | نعم | — |
| `in_progress` | لا | `REASSIGN_BLOCKED_MOVEMENT` (المعمارية §6: بعد بدء الحركة لا يُعاد الإسناد آليًا) |

الآثار:

- **إلى الطابور:** المهمة `queued`، `assignee_id = NULL`، `claimed_at/accepted_at/assigned_waiting_at = NULL`، `queued_at = now()` (نوبة جديدة، `priority_at` كما هو)؛ التذكرة `requested`؛ الدورة `accepted_by` و`assigned_at` و`assigned_waiting_at` = `NULL` (تنتظر من جديد، DEC-180)؛ جدولة تصعيد جديد؛ تمريرة تستثني السائق السابق (DEC-216). السائق السابق الذي قبلها بجولة لا يتلقى عرضًا فرديًا لها لاحقًا (ضمن المجرَّبين §2.5) ويبقى مستلمًا للبث؛ أما من أسندها إليه المشرف فليس ضمن المجرَّبين، فتستثنيه تمريرة معاملة السحب وحدها ويجوز للتمريرات اللاحقة عرضها عليه.
- **إلى سائق محدد:** يجب أن يكون مناوبًا في نفس المجموعة (`DUTY_REQUIRED`)؛ هدف لا يستطيع أخذ المهمة (مثل الاستراحة) ← `DRIVER_NOT_AVAILABLE`؛ إن كان `busy_with_next` ← `NEXT_TASK_ALREADY_RESERVED`؛ متاح ← `accepted`؛ مشغول بلا تالية ← `assigned_waiting` (W-03 فقط إن لم تُرسل في هذه الدورة). حارس الأولوية يُطبق على السائق الهدف إلا مع `override_priority = true` وسبب ← سجل تدقيق إضافي بالفعل `dispatch.priority_override`. صوت `offer` وws `task.updated` للهدف.
- **السائق السابق:** ws `task.updated` (إزالة البطاقة + رسالة «سحب المشرف المهمة»)؛ إن كانت مهمته الحالية ⇒ §6.1 (تُرقّى تاليته أو يصبح متاحًا).
- الأحداث: `task.withdrawn` (للطابور) أو `task.reassigned` (لسائق: `trigger = reassign`، `target = driver`، `from_status`، `result_status`) مع `ticket.assigned` أو `ticket.assigned_waiting` بـ`via = supervisor` ولا `task.claimed` (DEC-215)، `audit_log` بالفعل `task.reassign` مع السبب. الإسناد للمكلّف نفسه ← `INVALID_STATE_TRANSITION` (`reason = same_assignee`، DEC-214).

### 9.2 إقرار تحرير العهدة

`POST /v1/tasks/{taskId}/release-custody` (المكلّف أو المشرف): يتطلب مهمة `accepted` مع `key_picked_up_at IS NOT NULL` وعدم بدء الحركة؛ الاستدعاء الثاني (المفتاح أعيد) ← `INVALID_STATE_TRANSITION` (`reason = key_not_picked_up`). يكتب `custody_events` (`subject = 'key'`, من `driver` إلى `key_slot`, `reason = 'withdrawal_release'`)، يخصص الخانة المطلوبة (`key_slot_allocations`؛ مشغولة ← `KEY_SLOT_OCCUPIED`، والخانة ولوحتها نشطتان تُقرآن `FOR SHARE`)، يضبط `tasks.key_picked_up_at = NULL`. لا يحرر السائق ولا يسوّيه ولا يغيّر توفره (تبقى المهمة `accepted` باسمه، DEC-230)؛ بعدها يمكن السحب §9.1 أو الإلغاء §9.3.

### 9.3 إلغاء الطلب ميدانيًا

`POST /v1/retrieval-cycles/{cycleId}/cancel` مع سبب إلزامي:

| حالة التذكرة | من يلغي | الأثر |
|---|---|---|
| `requested` | السائق المناوب في الموقع أو المشرف | سحب الجولة (`task_canceled`)، المهمة `canceled`، الدورة `outcome = 'canceled'`، التذكرة `parked`، W-07، حل التنبيهات، تمريرة |
| `assigned` / `assigned_waiting` | المشرف فقط | كما سبق؛ وإن كان المفتاح مع السائق ⇒ `CUSTODY_RELEASE_REQUIRED` حتى §9.2؛ السائق المكلّف ⇒ §6.1 |
| `retrieving` / `ready` | المشرف فقط | **لا** يعود السائق متاحًا ولا تُمحى العهدة (AC-11): مهمة `retrieve` ← `canceled` (`cancel_reason = 'supervisor_cancel'`)، إنشاء مهمة `repark` بحالة `in_progress` لنفس السائق الحائز، التذكرة `reparking` (حدث `ticket.reparking` بـ`cause = 'supervisor_cancel'`)، الدورة `outcome = 'canceled'`، إلغاء رمز التسليم الحي (`revoke_reason = 'canceled'`)، W-07 فقط (لا W-08، DEC-42). يعود السائق متاحًا فقط عند `complete-parking` ولا رسالة للعميل عندها |

ملاحظة للملف 11: الانتقال `retrieving ← reparking` (عبر الإلغاء بعد البدء) يضاف لآلة حالة التذكرة لتحقيق AC-11 (§16).

### 9.4 إعادة الصف لغياب العميل

`POST /v1/tickets/{ticketId}/repark` (المشرف، التذكرة `ready`): مهمة `retrieve` ← `canceled` (`cancel_reason = 'repark_customer_absent'`)، إلغاء رمز التسليم (`revoke_reason = 'reparked'`)، الدورة `outcome = 'reparked'` و`reparked_at`، مهمة `repark` بحالة `in_progress` للسائق الحائز للمركبة والمفتاح، التذكرة `reparking` (حدث `ticket.reparking` بـ`cause = 'customer_absent'`)، W-08 (الموضع الوحيد الذي تُرسل فيه، DEC-42)، حل `ready_not_collected`. إتمام إعادة الصف لاحقًا لا يرسل شيئًا للعميل. طلب العميل التالي يفتح دورة جديدة `cycle_no + 1` (المعمارية §6: لا خلط لأزمنة الدورتين في التقارير). طلب يصل أثناء `reparking` يصبح طلبًا مبكرًا §7.3.

### 9.5 الإنهاء القسري للمناوبة

`POST /v1/duty-sessions/{sessionId}/force-end` (المشرف) لسائق انقطع أو غادر — قاعدة DEC-32 الموحدة مع النقل والتعطيل:

- يُفحص المنع أولًا: يحوز عهدة (مفتاح أو مركبة) أو لديه مهمة `in_progress` (تشمل `park/repark` الجارية) ← `DUTY_END_BLOCKED_CUSTODY` دون أي تغيير ولا تجاوز، حتى يُنقل ما بعهدته رسميًا `POST /v1/tickets/{ticketId}/custody-transfers`.
- عرض فردي حي ← يُسحب (`recipient_unavailable`) وتعود مهمته للطابور.
- مهمة تالية `assigned_waiting` ← تعود للطابور بأولويتها الأصلية (نوبة جديدة، `task.withdrawn`).
- مهمة إحضار `accepted` قبل استلام المفتاح ← تعود للطابور بأولويتها الأصلية (`task.withdrawn`).
- ثم `duty_sessions.status = 'ended'`، `end_reason = 'forced'`، `available_since = NULL`، ws `sync.required` للسائق، تمريرة. صفوف مستلمي البث القائمة تبقى لكنه لا يستطيع القبول (`DUTY_REQUIRED`) وتختفي بطاقته بالمزامنة.
- الإجراء المشترك `releaseDriverWork` (DEC-32) لهذه المسارات (والتعطيل وإغلاق الوردية) يُبقي صفوف مستلمي البث للسائق ويستثنيه من التمريرة التي يشغّلها، ولا ينهي المناوبة بنفسه (DEC-180).

### 9.6 الاستراحة وإنهاء المناوبة الذاتي

| الأمر | الشرط | الأثر على التوزيع |
|---|---|---|
| بدء استراحة `POST /v1/me/duty/break {active: true}` | `driver_state = 'available'` ولا عهدة: مهمة نشطة أو تالية ← `DRIVER_NOT_AVAILABLE`؛ عهدة (مركبة أو مفتاح) دون مهمة ← `CUSTODY_OPEN` | سحب العرض الفردي الحي، `available_since = NULL`، تمريرة؛ يخرج من مستلمي البث الجديد |
| إنهاء الاستراحة `{active: false}` | الحالة `on_break` | `available_since = now()`، تمريرة (قد يتحول إليه أقدم بث §4.5) |
| إنهاء المناوبة `POST /v1/me/duty/end` | أشد من الإنهاء القسري (DEC-32): لا عهدة ولا أي مهمة مفتوحة ولا تالية، وإلا `DUTY_END_BLOCKED_CUSTODY` | سحب العرض الفردي، `ended`، تمريرة |

صفوف المستلمين في جولات البث القائمة تبقى للتاريخ؛ من لم يعد مناوبًا لا يستطيع القبول (`DUTY_REQUIRED`) وتُمسح بطاقته عبر ws (`session.revoked` أو `sync.required`).

### 9.7 النقل بين المواقع

ينفذ فورًا إن كان `scheduled_at <= now()` أو عبر `job.transfer_activate`. المعاملة:

1. قفل كل مجموعات توزيع الموقعين تصاعديًا بالمعرف (L1، DEC-225)، ثم `driver_transfers` ← `driver_assignments` ← `users` (L3)، ثم ما يلزم من المهام (L4) والتذاكر (L5) والجولات (L7) والمناوبة (L8) بترتيب Canon §14ب. قواعد النقل وأخطاؤه (نطاق الموقعين للإنشاء والإلغاء، الهدف هو الموقع الحالي، تعطيل السائق قبل التفعيل، تغيّر التعيين المتزامن ← `ASSIGNMENT_CONFLICT` بـ`reason = assignment_changed`) في DEC-224.
2. فحص المنع (DEC-32، لا تجاوز): أي تذكرة مفتوحة `vehicle_holder_type = 'driver'` أو `key_holder_type = 'driver'` بمعرفه، أو مهمة `in_progress` (تشمل `park/repark`) ⇒ ممنوع: النقل الفوري يعود `TRANSFER_BLOCKED_CUSTODY` (409) دون إنشاء سجل نقل ولا تنبيه؛ والمجدول عند تفعيله يصبح `blocked` مع `blocked_details` وتنبيه `transfer_blocked` بصف لكل من الموقعين (DEC-46)، ويعاد تقييمه آليًا عند انتهاء مهمته (جدولة `job.transfer_activate`). مهمة الإحضار `accepted` قبل استلام المفتاح لا تمنع النقل (الخطوة 4).
3. سحب كل عرض فردي حي له (`close_reason = 'transfer'`) وإعادة مهامها للطابور.
4. مهمته التالية `assigned_waiting` ومهمة الإحضار `accepted` قبل استلام المفتاح ⇒ تعودان لطابور الموقع القديم بأولويتهما الأصلية (نوبة جديدة، `task.withdrawn`) — المعمارية §4أ.
5. إنهاء المناوبة (`end_reason = 'transfer'`)، إنهاء التعيين القديم (`ended`)، تفعيل التعيين الجديد (`active`, `transfer_id`) — `uq_driver_assignments_active` يضمن تعيينًا واحدًا.
6. إبطال كل جلسات الدخول (`auth_sessions.revoked_reason = 'transfer'`) وإرسال ws `session.revoked`: الجهاز يمسح بياناته المؤقتة للموقع القديم ويخرج من الغرف؛ أي إشعار قديم يُضغط لاحقًا يُرفض على الخادم.
7. `driver_transfers.status = 'completed'`، أحداث `driver.transferred`، تدقيق، تمريرة للمجموعة القديمة.

السجلات التاريخية (التذاكر والمهام والدورات) تحتفظ بالموقع والسائق الأصليين ولا تُعاد كتابتها.

النقل حالة استخدام في `use-cases` (يعبر الهوية والتوزيع والمواقع). إعادة تقييم النقل المحجوب يتولاها مخطِّط معاملة (TxPlanner) يجدول `job.transfer_activate` فورًا حين تنهي معاملة مهمة السائق أو تنقل العهدة منه (`task.completed`، `task.canceled`، `task.reassigned`، `custody.changed`)، فلا يحتاج نقل العهدة الرسمي ولا المطابقة اليدوية كودًا خاصًا بالنقل؛ والمانع الذي يزول دون حدث (تصحيح بيانات) ينتظر أول أمر يمس السائق (DEC-223). سائق عُطّل قبل التفعيل ← النقل `canceled`.

### 9.8 تعطيل السائق

`POST /v1/drivers/{driverId}/disable`: يُفحص المنع أولًا بقاعدة DEC-32 نفسها: إن كان يحوز عهدة (مركبة أو مفتاح) أو لديه مهمة `in_progress` (تشمل `park/repark`) ⇒ `CUSTODY_OPEN` (409) مع تفاصيل العناصر ولا تجاوز، حتى تُغلق أو تُنقل رسميًا (المعمارية §4ح). وإلا تُنفذ خطوات النقل 3 و4 و6 (سحب عروضه الفردية الحية بـ`close_reason = 'recipient_unavailable'` لا `transfer`، إعادة التالية والمقبولة قبل استلام المفتاح للطابور بأولويتهما مع `task.withdrawn` بـ`trigger = disabled`، إبطال الجلسات بـ`revoked_reason = 'disabled'`) مع إنهاء المناوبة (`end_reason = 'disabled'`) ثم تمريرة. لا تُغلق تذاكره ولا تُمحى مسؤولياته السابقة.

---

## 10. الإعدادات

تُقرأ من `venues.settings` في بداية كل تمريرة/معالج (لا تخزين مؤقت عابر للمعاملات) وتُدمج مع افتراضيات Canon §12 وتُتحقق بـzod:

| المفتاح | الافتراضي | المدى المقبول | يُطبق على |
|---|---|---|---|
| `dispatch.single_offer_reminder_s` | 15 | 5 – (ttl − 5) | الجولات الفردية الجديدة |
| `dispatch.single_offer_ttl_s` | 30 | 10 – 120 | الجولات الفردية الجديدة |
| `dispatch.broadcast_reminder_s` | 30 | 10 – 300 | جولات البث الجديدة |
| `dispatch.unaccepted_escalation_s` | 60 | 20 – 900 | النوبات الجديدة |
| `dispatch.next_task_wait_alert_s` | 300 | 60 – 3600 | الحجوزات الجديدة |
| `dispatch.idle_driver_alert` | true | true/false | التمريرة التالية |
| `dispatch.accept_grace_ms` | 1500 | 0 – 5000 | الجولات الفردية الجديدة: مهلة سماح القبول ومؤقت الانتهاء عند `expires_at + dispatch.accept_grace_ms` (DEC-47) |
| `dispatch.offline_drivers_last` | false | true/false | التمريرة التالية: تأخير ذوي الاتصال غير المؤكد في ترتيب العرض الفردي |
| `ready.uncollected_alert_min` | 10 | 2 – 60 | الجاهزيات الجديدة |

قواعد التغيير أثناء الحفل:

- الجولة الحية تحتفظ بـ`reminder_at` و`expires_at` المحسوبة عند إنشائها؛ المؤقتات المجدولة لا تُعدّل.
- القيم الجديدة تسري على الجولات والنوبات والحجوزات التي تبدأ بعد الحفظ.
- `PUT /v1/venues/{venueId}/settings` يرفض قيمة خارج المدى بـ`VALIDATION_FAILED`، ويُسجل في التدقيق.

---

## 11. حالات الحافة

| # | الحالة | السلوك المتوقع |
|---|---|---|
| EC-01 | ضغط مزدوج على «قبول الطلب» من نفس الجهاز (نفس `Idempotency-Key`) | الطلب الثاني ينتظر التزام الأول ثم يعيد الرد المحفوظ نفسه؛ لا أثر ثانٍ |
| EC-02 | جهازان لنفس السائق يقبلان نفس العرض بمفتاحين مختلفين | الأول يفوز؛ الثاني `200` بنفس النتيجة («المهمة لك») |
| EC-03 | جهازان لنفس السائق يقبلان مهمتين مختلفتين معًا | تسلسل على القفل؛ الأولى `accepted`، الثانية `assigned_waiting` أو `OLDER_REQUEST_PENDING`؛ لا حركتان نشطتان أبدًا (`uq_tasks_active_movement_driver`) |
| EC-04 | إشعار قديم يُضغط بعد أن قبل غيره | يفتح التطبيق ويجلب `/v1/me/home`؛ إن أُرسل قبول ⇒ `TASK_ALREADY_CLAIMED`؛ الإشعار نفسه استُبدل بإشعار هادئ إن وصل الجهاز Push |
| EC-05 | قبول يصل في نفس الملي ثانية مع انتهاء المهلة | القفل يسلسل؛ إن نُفذ الانتهاء أولًا ⇒ `OFFER_EXPIRED`؛ وإلا قبول ناجح؛ ضمن مهلة السماح `dispatch.accept_grace_ms` (1500 ms افتراضيًا) بعد `expires_at` يُقبل |
| EC-06 | قبول بعد `expires_at + dispatch.accept_grace_ms` والعامل متأخر | `OFFER_EXPIRED` بفحص الوقت حتى لو الجولة ما زالت `active`؛ التمريرة الدفاعية أو المؤقت يغلقها |
| EC-07 | السائق المستلم للعرض الفردي صفحته مغلقة | Push إن وُجد اشتراك؛ بعد 30 ث ومهلة السماح انتهاء وتدوير وعرض على التالي |
| EC-08 | كل المناوبين في استراحة | لا مستلمين؛ تنبيه `no_drivers_on_duty` بتفصيل `all_on_break`؛ الطلب في الطابور؛ أول إنهاء استراحة يطلق التمريرة |
| EC-09 | لا أحد مناوب في الموقع | تنبيه فوري للمشرف؛ لا إرسال لموقع آخر؛ أول بدء مناوبة يطلق التمريرة |
| EC-10 | سائق واحد متاح ويتجاهل | فردي 30 ث (+ مهلة السماح) ← بث له وحده ← تذكير بعد 30 ث ← تصعيد عند 60 ث من `queued_at`؛ يظل قادرًا على القبول |
| EC-11 | السائق يبدأ استراحة وهو يحمل عرضًا فرديًا | مسموح (هو متاح)؛ العرض يُسحب `recipient_unavailable` ويعاد التوزيع فورًا |
| EC-12 | السائق يبدأ استلام مركبة وهو يحمل عرضًا فرديًا | مسموح؛ العرض يُسحب؛ أي قبول لاحق عليه `OFFER_REVOKED` |
| EC-13 | السائق يبدأ استلامًا وهو مستلم لبث قائم | مسموح؛ أهليته تصبح `reserve_next` عند القبول |
| EC-14 | محاولة إلغاء تذكرة (`void`) وطلبها في الطابور | مرفوض: الإلغاء في `received` أو `parking` فقط (DEC-45) ← `INVALID_STATE_TRANSITION`. بعد `parked` يصحح المشرف بالمطابقة اليدوية `POST /v1/tickets/{ticketId}/manual-reconcile` (`target_status = 'voided'`): الجولة الحية تُسحب `task_canceled`، المهمة `canceled` (`cancel_reason = 'manual_reconcile'`)، الدورة `canceled`، ws `offer.closed` للمستلمين، حل التنبيهات، تمريرة، ولا رسالة للعميل |
| EC-15 | ضغط العميل والمركبة `parking` | طلب مبكر معلّق؛ W-02؛ إشعار سائق الصف والمشرف؛ عند `parked` دورة بوقت الطلب الأصلي |
| EC-16 | ضغطتان سريعتان من العميل (رسالتان واردتان) | دورة واحدة؛ الثانية ترد W-09 بالحالة |
| EC-17 | نفس Webhook مكرر 10 مرات | منع التكرار بـ`wa_message_id` و`body_sha256`؛ طلب واحد (AC-01) |
| EC-18 | العميل يضغط زر تذكرة في موقع آخر | الرمز يقود للتذكرة ثم لمجموعتها؛ التوزيع في ذلك الموقع فقط (AC-20) |
| EC-19 | للعميل تذكرتان في نفس الموقع | كل زر يقود لتذكرته فقط؛ لا اختيار تلقائي للأحدث (AC-03) |
| EC-20 | العميل يضغط بعد التسليم | W-09 «تم تسليم سيارتك»؛ لا دورة |
| EC-21 | طلب أثناء `reparking` | طلب مبكر معلّق؛ يتحول عند `parked` |
| EC-22 | موقع بمجموعتي توزيع | قفل وطابور مستقل لكل مجموعة؛ مناوبة السائق في مجموعة واحدة؛ لا عروض بين المجموعتين |
| EC-23 | نقل سائق يحمل عرضًا فرديًا | يُسحب العرض `transfer` ويعاد التوزيع؛ جلساته تُبطل؛ أي قبول قديم يُرفض |
| EC-24 | نقل سائق لديه مهمة تالية محجوزة | تعود لطابور الموقع القديم بأولويتها؛ تصعيد جديد يُجدول |
| EC-25 | نقل والسائق يحوز مفتاحًا | فوري ⇒ `TRANSFER_BLOCKED_CUSTODY` دون سجل نقل ولا تنبيه؛ مجدول ⇒ `blocked` + تنبيه `transfer_blocked` للموقعين، ويعاد التقييم آليًا عند إنهاء مهمته |
| EC-26 | سحب مهمة مقبولة بعد استلام المفتاح | `CUSTODY_RELEASE_REQUIRED` حتى إقرار إعادة المفتاح أو نقل عهدة رسمي |
| EC-27 | سحب بعد «بدء الإحضار» | `REASSIGN_BLOCKED_MOVEMENT` |
| EC-28 | إسناد مباشر لسائق لديه مهمة تالية | `NEXT_TASK_ALREADY_RESERVED` |
| EC-29 | إسناد مباشر لطلب أحدث والأقدم قابل للتصرف للهدف | `OLDER_REQUEST_PENDING` إلا مع `override_priority` وسبب ويُدقق |
| EC-30 | المهمة التالية تنتظر أكثر من 300 ث | تنبيه `next_task_waiting_long`؛ لا إعادة إسناد آلية |
| EC-31 | صار سائق متاحًا والأقدم محجوز تاليًا لغيره | تنبيه `idle_driver_while_next_waiting`؛ القرار للمشرف |
| EC-32 | المشرف يلغي مهمة السائق الحالية قبل البدء ولديه تالية | التالية تُرقّى في المعاملة نفسها مع صوت `next_due` |
| EC-33 | تسليم ينتهي والبث قائم والسائق بلا تالية | يصبح متاحًا؛ التمريرة تحول أقدم بث فرديًا إليه إن لم يُجرَّب له، وإلا يبقى مستلمًا بـ`accept` |
| EC-34 | انقطعت الشبكة بعد إرسال القبول ولم يصل الرد | إعادة بنفس المفتاح تعيد الرد المحفوظ؛ أو `/v1/me/home` يظهر المهمة له |
| EC-35 | العامل سقط بعد الالتزام وقبل نشر ws | تأجير Outbox ينتهي ويستأنف عامل آخر؛ العملاء يعيدون المزامنة عند الاتصال؛ القاعدة هي الحكم |
| EC-36 | تأخر المؤقتات بسبب ضغط العامل | التمريرة الدفاعية تغلق الجولات المنتهية؛ قياس `timer_lag` ينبه |
| EC-37 | ساعة الجوال غير مضبوطة | العد التنازلي يُحسب من فرق `server_time`؛ الخادم وحده يقرر الانتهاء |
| EC-38 | تغيير الإعدادات أثناء الحفل | يسري على الجديد فقط §10 |
| EC-39 | الحفل `closing` | الاستلام الجديد `EVENT_NOT_OPEN`؛ الإحضار والتوزيع يستمران حتى التسليم |
| EC-40 | مستلم بث أُنهيت مناوبته قسرًا | لا يستطيع القبول (`DUTY_REQUIRED`)؛ لا يُضاف لجولات جديدة |
| EC-41 | مهمة أقدم أُعيدت للطابور بينما سائق يحمل عرضًا فرديًا لطلب أحدث | انعكاس أولوية محدود ومقبول: الأقدم `queued` لا يحجب؛ يُوزع في التمريرة التالية بعد حسم العرض الأحدث |
| EC-42 | تمريرتان متزامنتان (أمر + تأمينية) | القفل يسلسل؛ الثانية ترى نتائج الأولى؛ `uq_task_offers_active` يمنع جولة ثانية |
| EC-43 | `job.dispatch_pass` يُكتب مرتين | `dispatch_pass:<pool_id>` يمنع التكرار ما دام معلقًا |
| EC-44 | إلغاء بعد بدء الحركة | تحويل لإعادة صف بنفس الحائز؛ لا تحرر للسائق ولا محو للعهدة (AC-11) |
| EC-45 | سائق فاز بعرض فردي ثم انقطع قبل استلام المفتاح | يبقى مكلّفًا (الاتصال لا يسحب مهمة)؛ إن طال الأمر يسحبها المشرف §9.1 |

---

## 12. القياس والسجلات

### 12.1 أحداث القياس (`analytics_events`، المصدر `server`)

يكتبها `AnalyticsProjector` في العامل من أحداث النطاق في Outbox، ولا تُكتب داخل معاملة الأمر. الأسماء أدناه عامة ويجب مواءمتها حرفيًا مع `15_Event_Tracking_Plan.md` قبل التنفيذ (لا تُضاف لـCanon من هنا):

| الاسم المقترح | متى | خصائص (بلا بيانات شخصية) |
|---|---|---|
| `retrieval_requested` | إنشاء دورة | `source`, `requested_early`, `queue_depth` |
| `offer_created` | جولة جديدة | `mode`, `round_no`, `recipients_count` |
| `offer_reminded` | تذكير | `mode` |
| `offer_expired` | انتهاء فردي | `round_no` |
| `offer_revoked` | سحب جولة | `close_reason` |
| `broadcast_converted_to_single` | تحويل §4.5 | `broadcast_age_ms` |
| `offer_accepted` | قبول ناجح | `mode`, `outcome`, `time_to_claim_ms` (`claimed_at − queued_at`), `round_no` |
| `offer_accept_rejected` | رفض قبول | `error_code`, `mode` |
| `next_task_promoted` | ترقية | `wait_ms` (`accepted_at − assigned_waiting_at`) |
| `request_escalated` | تصعيد | `age_ms`, `on_duty_count`, `available_count` |
| `task_reassigned` | سحب/إسناد مشرف | `target_type`, `override_priority`, `from_status` |
| `retrieval_canceled` | إلغاء دورة | `stage` (`requested`/`assigned`/`after_start`) |

### 12.2 مقاييس التشغيل (Prometheus)

جزء التوزيع من الكتالوج الملزم في `05_Tech_Stack_Environment.md` §12.2:

- `point_dispatch_pass_duration_seconds{reason}` (Histogram) — الهدف p95 أقل من 50 ms عند حمل الاختبار.
- `point_dispatch_pool_lock_wait_seconds` (Histogram).
- `point_dispatch_offers_total{mode,outcome}` (Counter).
- `point_dispatch_accept_rejections_total{code}` (Counter).
- `point_dispatch_time_to_claim_seconds` (Histogram) — المؤشر الأهم (المعمارية §15: «مؤشر قبول المهمة أهم من مؤشر إرسال التنبيه»).
- `point_dispatch_open_tasks{pool}` و`point_dispatch_broadcast_open{pool}` (Gauge).
- `point_timer_lag_seconds{job}` = وقت التنفيذ − `available_at` (Histogram؛ تنبيه نظام إذا p95 > 2 ث).
- `point_dispatch_escalations_total` (Counter).

### 12.3 السجلات

JSON عبر pino، حقول ثابتة: `request_id`, `actor_id`, `venue_id`, `pool_id`, `task_id`, `offer_id`, `ticket_id`, `from_status`, `to_status`, `outcome`, `error_code`, `pass_reason`, `offers_created`, `lock_wait_ms`, `duration_ms`. ممنوع تسجيل: الجوال، اللوحة، رمز التسليم، موضع المفتاح، رمز الإجراء.

---

## 13. البنية المرجعية في NestJS

### 13.1 التوزيع على الوحدات

```
apps/api/src/modules/dispatch/
  dispatch.module.ts
  dispatch.service.ts          # runDispatchPass, requestRetrieval, onDriverAvailable
  offer.service.ts             # accept, createSingleRound, openBroadcast, extendBroadcast, revokeRound, expireSingleRound, remind
  task-lifecycle.service.ts    # settleDriverAfterTask, promoteNextTask, requeue, reassign, cancelCycle, repark, releaseCustody
  duty.service.ts              # start, startBreak, endBreak, end, forceEnd
  transfer.service.ts          # requestTransfer, activateTransfer
  priority-guard.ts            # findOlderActionable(tx, pool, actor, task)
  dispatch.repo.ts             # SQL of §4.2, §2.5, §2.6 (raw SQL via Drizzle `sql` template)
  dispatch.settings.ts         # zod schema + defaults (canon §12)
  controllers/                 # thin HTTP layer → services; no business logic
apps/worker/src/timers/
  offer-remind.handler.ts  offer-expire.handler.ts  broadcast-remind.handler.ts
  escalate-unaccepted.handler.ts  next-task-wait.handler.ts  ready-uncollected.handler.ts
  claim-code-expire.handler.ts  transfer-activate.handler.ts  heartbeat-sweep.handler.ts
  dispatch-sweep.handler.ts  dispatch-pass.handler.ts
packages/db/src/tx.ts          # withCommandTx / withSystemTx (§13.3)
packages/db/src/locks.ts       # lockPool, lockPoolsOrdered
```

قاعدة: لا يستورد أي module آخر جداول التوزيع مباشرة؛ يمر عبر `DispatchService`/`TaskLifecycleService`.

### 13.2 التواقيع

```ts
export interface DispatchSettings {
  singleOfferReminderS: number; singleOfferTtlS: number; broadcastReminderS: number;
  unacceptedEscalationS: number; nextTaskWaitAlertS: number; idleDriverAlert: boolean; readyUncollectedAlertMin: number;
  acceptGraceMs: number;          // dispatch.accept_grace_ms (1500) — DEC-47
  offlineDriversLast: boolean;    // dispatch.offline_drivers_last (false)
}

export class DispatchService {
  runDispatchPass(tx: Tx, poolId: UUID, reason: PassReason): Promise<PassResult>;
  requestRetrieval(tx: Tx, cmd: { ticketId: UUID; source: 'whatsapp' | 'staff'; customerId?: UUID; userId?: UUID; reason?: string })
    : Promise<{ kind: 'created' | 'pending_early' | 'already_active' | 'closed'; cycleId?: UUID; ticketStatus: TicketStatus }>;
}

export class OfferService {
  accept(ctx: CommandContext, offerId: UUID): Promise<{ outcome: 'accepted' | 'assigned_waiting'; taskId: UUID; ticketId: UUID }>;
  createSingleRound(tx: Tx, task: QueueTask, driver: PoolDriver, now: Date, cfg: DispatchSettings): Promise<UUID>;
  openBroadcast(tx: Tx, task: QueueTask, onDuty: PoolDriver[], now: Date, cfg: DispatchSettings): Promise<UUID>;
  extendBroadcast(tx: Tx, task: QueueTask, onDuty: PoolDriver[]): Promise<UUID[]>;          // newly added recipients
  revokeRound(tx: Tx, offerId: UUID, reason: OfferCloseReason, now: Date): Promise<void>;
  expireSingleRound(tx: Tx, offer: LiveOffer, now: Date): Promise<void>;
}

export class TaskLifecycleService {
  settleDriverAfterTask(tx: Tx, poolId: UUID, driverId: UUID, now: Date): Promise<'promoted' | 'available' | 'off'>;
  reassign(ctx: CommandContext, taskId: UUID, body: ReassignBody): Promise<TaskView>;
  releaseCustody(ctx: CommandContext, taskId: UUID): Promise<TaskView>;
  cancelCycle(ctx: CommandContext, cycleId: UUID, reason: string): Promise<TicketView>;
  repark(ctx: CommandContext, ticketId: UUID, reason: string): Promise<TicketView>;
}
```

### 13.3 مساعد المعاملة ومفتاح التكرار

```ts
export async function withCommandTx<T>(ctx: CommandContext, fn: (tx: Tx) => Promise<T>): Promise<CommandResult<T>> {
  // canon §14ب: whole TX retried up to 3 attempts on 40001/40P01 with 20–80 ms jitter; 55P03 is never retried here
  return retryOn(['40001', '40P01'], { attempts: 3, jitterMs: [20, 80] }, async () => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    // L0 = first statement: a concurrent duplicate waits here until the first TX commits (then replays) or rolls back
    const claimed = await mapLockTimeout('IDEMPOTENCY_IN_PROGRESS', () => tx.execute(sql`
      INSERT INTO idempotency_keys (user_id, key, operation, request_hash)
      VALUES (${ctx.userId}, ${ctx.idempotencyKey}, ${ctx.operation}, ${ctx.requestHash})
      ON CONFLICT (user_id, key) DO NOTHING RETURNING key`));  // 55P03 here ⇒ IDEMPOTENCY_IN_PROGRESS; later ⇒ SERVICE_UNAVAILABLE
    if (claimed.rowCount === 0) {
      const prev = await tx.one(sql`SELECT * FROM idempotency_keys WHERE user_id = ${ctx.userId} AND key = ${ctx.idempotencyKey}`);
      if (prev.request_hash !== ctx.requestHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
      return replay(prev);                                     // same status + body as the first call
    }
    await tx.execute(sql`SAVEPOINT cmd`);
    let result: CommandResult<T>;
    try {
      result = ok(await fn(tx));
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;                // unexpected ⇒ whole TX rolls back, key freed
      await tx.execute(sql`ROLLBACK TO SAVEPOINT cmd`);
      await e.afterRollback?.(tx);                             // e.g. offer_recipients.response = 'rejected_late'
      result = fail(e);
    }
    await tx.execute(sql`
      UPDATE idempotency_keys SET status = 'completed', response_status = ${result.http}, response_body = ${result.body}, completed_at = now()
      WHERE user_id = ${ctx.userId} AND key = ${ctx.idempotencyKey}`);
    return result;
  }));
}
```

الطلب المكرر بنفس المفتاح أثناء تنفيذ الأول ينتظر على المفتاح الأساسي ثم يعيد الرد المحفوظ؛ ولا يُرد `IDEMPOTENCY_IN_PROGRESS` إلا إن تجاوز هذا الانتظار `lock_timeout` عند L0. تُحفظ ردود 2xx وكل خطأ 4xx حتمي (منها 403/404/409/410/422/423)؛ ولا تُحفظ 401/429/5xx (تتراجع المعاملة فلا يبقى صف للمفتاح وتجوز الإعادة). تنتهي المفاتيح بعد 24 ساعة. `withSystemTx` نفس الشيء بلا مفتاح تكرار (للمؤقتات والعامل).

### 13.4 تحويل قيود قاعدة البيانات إلى أخطاء (الجزء الخاص بالتوزيع)

| اسم القيد | الخطأ |
|---|---|
| `uq_tasks_active_movement_driver` | `MOVEMENT_IN_PROGRESS` |
| `uq_tasks_next_per_driver` | `NEXT_TASK_ALREADY_RESERVED` |
| `uq_tasks_open_per_ticket`، `uq_retrieval_cycles_open` | `RETRIEVAL_ALREADY_ACTIVE` |
| `uq_duty_sessions_open` | `DUTY_ALREADY_STARTED` |
| `uq_driver_assignments_active` | `ASSIGNMENT_CONFLICT` |
| `uq_key_alloc_slot_active` / `uq_spot_alloc_spot_active` | `KEY_SLOT_OCCUPIED` / `PARKING_SPOT_OCCUPIED` |
| `uq_task_offers_active` | داخلي لا يظهر للمستخدم: سجل `error` وإعادة التمريرة (يعني سباقًا رغم القفل) |

الجدول الكامل والمرجع الملزم لهذا الربط في `08_Error_Codes_Guide.md` §5.

---

## 14. قائمة الاختبارات

### 14.1 مدقق الثوابت (يُشغّل بعد كل خطوة في اختبارات التوزيع العشوائية)

كل استعلام يجب أن يعيد صفر صفوف (جُرّبت على بيانات حقيقية والتقطت خللًا مزروعًا):

```sql
-- I-A available ⟺ available_since IS NOT NULL
SELECT s.user_id FROM v_driver_state s
 WHERE s.duty_status = 'on_duty' AND ((s.driver_state = 'available') <> (s.available_since IS NOT NULL));
-- I-B offered ⟺ one live single round; broadcast ⟺ one live broadcast round; no live round otherwise
SELECT t.id FROM tasks t LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
 WHERE t.type = 'retrieve' AND ((t.status = 'offered' AND (o.id IS NULL OR o.mode <> 'single'))
    OR (t.status = 'broadcast' AND (o.id IS NULL OR o.mode <> 'broadcast'))
    OR (t.status NOT IN ('offered','broadcast') AND o.id IS NOT NULL));
-- I-C ticket status mirrors its open retrieve task
SELECT k.id FROM tickets k JOIN tasks t ON t.ticket_id = k.id AND t.type = 'retrieve' AND t.status NOT IN ('completed','canceled')
 WHERE NOT ((k.status = 'requested' AND t.status IN ('queued','offered','broadcast'))
         OR (k.status = 'assigned' AND t.status = 'accepted')
         OR (k.status = 'assigned_waiting' AND t.status = 'assigned_waiting')
         OR (k.status IN ('retrieving','ready') AND t.status = 'in_progress'));
-- I-D live single offers are held by available drivers only
SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id JOIN v_driver_state s ON s.user_id = r.user_id
 WHERE o.status = 'active' AND o.mode = 'single' AND s.driver_state <> 'available';
-- I-E at most one live single offer per driver
SELECT r.user_id FROM task_offers o JOIN offer_recipients r ON r.offer_id = o.id
 WHERE o.status = 'active' AND o.mode = 'single' GROUP BY r.user_id HAVING count(*) > 1;
-- I-F rounds and recipients never cross pools
SELECT o.id FROM task_offers o JOIN tasks t ON t.id = o.task_id JOIN offer_recipients r ON r.offer_id = o.id
 LEFT JOIN duty_sessions ds ON ds.id = r.duty_session_id
 WHERE o.status = 'active' AND (o.dispatch_pool_id <> t.dispatch_pool_id OR ds.dispatch_pool_id <> o.dispatch_pool_id);
```

### 14.2 ربط معايير القبول

| المعيار | الاختبارات |
|---|---|
| AC-04 (قبول متزامن أو ضغط قديم لا يخلق سائقين) | N=12 قبول متوازٍ على بث ⇒ 200 واحد و11 `TASK_ALREADY_CLAIMED`، تكرار 200 مرة؛ قبول على عرض منتهٍ ⇒ `OFFER_EXPIRED`؛ قبول على بث محوّل ⇒ `OFFER_REVOKED`؛ مدقق §14.1 بعد كل جولة |
| AC-05 (طلب أثناء الصف ⇒ معلّق بلا حركة متعارضة) | ضغط زر أثناء `parking` ⇒ لا مهمة `retrieve`، `pending_retrieval_at` مضبوط، W-02 مرة واحدة؛ عند `complete-parking` ⇒ دورة بـ`requested_at` = الوقت الأصلي و`requested_early = true` |
| AC-14 (الجميع مشغولون ⇒ بث للمجموعة الصحيحة، أول قبول يحجز، البطاقة تختفي، الخادم يرفض اللاحق) | مجموعتان في موقعين: البث يصل مناوبي مجموعة التذكرة فقط؛ ws `task.claimed` يصل كل الأجهزة المتصلة في الغرفة؛ القبول اللاحق 409 |
| AC-15 (مهمة تالية واحدة، لا بدء قبل التحرير، لا W-04 قبل البدء) | سائق مشغول يحجز ⇒ `assigned_waiting` + W-03؛ محاولة حجز ثانية ⇒ `NEXT_TASK_ALREADY_RESERVED`؛ `start-retrieval` على التالية قبل إنهاء الحالية ⇒ `TASK_NOT_STARTABLE`؛ لا إشعار W-04 حتى `start-retrieval` بعد الترقية؛ الترقية في المعاملة نفسها دون مرور بـ`available` (فحص `available_since` بقي NULL) |
| AC-16 (إضافة حساب ونقل يحافظان على المعرف والتاريخ؛ النقل يرفض العهدة ويعيد التالية ويمنع إشعارًا قديمًا) | نقل فوري مع مفتاح ⇒ `TRANSFER_BLOCKED_CUSTODY` دون سجل نقل ولا تنبيه؛ نقل مجدول مع مفتاح ⇒ `blocked` وتنبيه `transfer_blocked`؛ نقل مع تالية أو مع إحضار مقبول قبل استلام المفتاح ⇒ تعود للطابور القديم بنفس `priority_at`؛ قبول بجلسة قديمة بعد النقل ⇒ `AUTH_SESSION_REVOKED`؛ السجلات القديمة لم تتغير |
| AC-17 (الأقدم يوزع أولًا، محاولات متزامنة على الأحدث لا تتجاوزه) | سائق مستلم لبث أقدم يحاول قبول أحدث ⇒ `OLDER_REQUEST_PENDING`؛ 20 محاولة متوازية على الأحدث مع وجود الأقدم ⇒ لا قبول للأحدث؛ إسناد مشرف للأحدث بلا `override_priority` ⇒ مرفوض، ومعه ⇒ مقبول ومُدقق |
| AC-19 (سائق يسجل وآخر يقبل ويحضر ويسلم، وكل فعل بفاعله) | `created_by`/`parked_by` للأول، `accepted_by`/`retrieved_by`/`delivered_by` للثاني في `tickets` و`retrieval_cycles`، وسلسلة `custody_events` صحيحة |

### 14.3 تصميم اختبارات التزامن

- **القبول المتوازي:** Testcontainers PostgreSQL 16 + API حقيقي؛ N سائقين بجلسات مستقلة؛ `Promise.all` لـN طلب قبول بمفاتيح مختلفة على نفس الجولة؛ يُتحقق: رد 200 واحد، صف `task.claimed` واحد في Outbox، `accepted_by` = الفائز، مدقق §14.1. يُكرر 200 مرة مع تأخير عشوائي 0–20 ms.
- **استلام مقابل قبول لنفس السائق:** طلبان متوازيان؛ يُتحقق أن واحدًا فقط نجح أو أن القبول أصبح حجزًا تاليًا، ولا يوجد للسائق مهمتا حركة.
- **انتهاء مقابل قبول:** ساعة مزيفة للعامل؛ تُطلق `job.offer_expire` والقبول في نفس اللحظة عبر حاجز اختبار؛ النتيجة إما قبول أو `OFFER_EXPIRED` ولا حالة ثالثة. لرؤية `OFFER_EXPIRED` تُقدَّم الساعة 32 ثانية على الأقل من إنشاء الجولة (بعد `expires_at + dispatch.accept_grace_ms` بالقيم الافتراضية).
- **سقوط العامل:** إنهاء العامل بالقوة بعد التزام القبول وقبل نشر ws؛ عامل جديد يكمل بعد انتهاء التأجير؛ لا تكرار للأثر (AC-06).
- **اختبار عشوائي بالخصائص:** 2 مجموعة × 8 سائقين × 500 أمر عشوائي (طلب، قبول، بدء، جاهزة، تسليم، استراحة، سحب، إلغاء، نقل، انتهاء مؤقت) مع تشغيل مدقق §14.1 بعد كل أمر.

---

## 15. ملاحظات التحقق

جُرّب على PostgreSQL 16.15 في قاعدة مؤقتة محمّلة بـ`06_schema.sql`:

1. استعلامات §4.2 (قفل المجموعة، الطابور مع `FOR NO KEY UPDATE OF t` على طرف الربط غير الاختياري، السائقون مع العرض الفردي الحي) — نجحت.
2. إنشاء عرض فردي وبث مع اشتقاق `eligible_as` من `v_driver_state` — نجح (10 `accept` و2 `reserve_next`).
3. القبول بتسلسل §5.2/§5.3 كدالة اختبار — النتائج: `accepted`، `TASK_ALREADY_CLAIMED` للمتأخر، «المهمة لك» للجهاز الثاني، `OLDER_REQUEST_PENDING` للحارس، `OFFER_EXPIRED` بعد المهلة، `assigned_waiting` للمشغول.
4. 12 قبولًا متوازيًا على بث واحد ⇒ فائز واحد وحدث `task.claimed` واحد.
5. ترقية المهمة التالية قبل إنهاء الحالية ⇒ رفض من `uq_tasks_active_movement_driver`؛ بالترتيب الصحيح ⇒ نجحت و`available_since` بقي NULL.
6. تخصيص رقم التذكرة، معالج الانتهاء، استعلام المجرَّبين (المصحح لاستخدام `accepted_by`)، إعادة المهمة للطابور مع بقاء `priority_at`، ومدقق الثوابت §14.1 — نجحت.
7. قيمة `close_reason = 'converted_to_single'`: رفضها قيد المسودة الأولى، فأُضيفت في المخطط 1.2 وصار القيد `task_offers_close_reason_check` يقبلها.

---

## 16. إضافات مقترحة للقاموس

| الإضافة | السبب | أين تُعكس | الحالة |
|---|---|---|---|
| القيمة `converted_to_single` في `task_offers.close_reason` | تحويل البث إلى عرض فردي §4.5؛ القيد الحالي يرفضها | `06_schema.sql` (CHECK)، Canon §5.5، الملف 11 | اعتُمدت: المخطط 1.2، Canon §5.5، DEC-34 |
| مفتاح الإعداد `dispatch.accept_grace_ms` (افتراضي 1500) | سماح شبكي للقبول قرب نهاية المهلة §2.7 | Canon §12 | اعتُمد: Canon §12، DEC-47 |
| مفتاح الإعداد `dispatch.offline_drivers_last` (افتراضي false) | خيار لتأخير السائقين `offline` في ترتيب العرض الفردي بعد قياس التجربة؛ الافتراضي يطابق المعمارية (الأطول تفرغًا فقط) | Canon §12 | اعتُمد: Canon §12 |
| انتقال التذكرة `retrieving → reparking` عبر الإلغاء بعد البدء | تحقيق AC-11 دون تحرير السائق أو محو العهدة §9.3 | الملف 11 (آلة حالة التذكرة)، Canon §5.1 (ملاحظة) | اعتُمد: DEC-30، الملف 11 TT-20b |
| قرار: «تدوير» السائق الذي ينتهي عرضه دون رد إلى آخر ترتيب التفرغ §2.3 | منع احتكار سائق لا يستجيب لكل الطلبات الجديدة | `DECISIONS.md` (قرار جديد) | اعتُمد: DEC-26 |
| قرار: طلب الموظف نيابة عن العميل يتطلب `parked`؛ الطلب المبكر من زر واتساب فقط فلا قيمة `staff` في `tickets.pending_retrieval_source` | عدم وجود أعمدة لحفظ الموظف والسبب حتى التحويل | `DECISIONS.md`، `06_schema.sql` (CHECK بالقيمة `whatsapp` وحدها) | اعتُمد: DEC-25، Canon §5.7 |
| قيمة فعل التدقيق `dispatch.priority_override` في `audit_log.action` | تمييز تجاوز الأولوية اليدوي عن `task.reassign` العادي §9.1 | الملف 09 (متطلبات التدقيق) | اعتُمدت: Canon §15 |
| أسماء أحداث القياس في §12.1 | تحتاج مواءمة حرفية مع الملف 15 | الملف 15 | مواءمة مع الملف 15 (الأسماء هناك هي المرجع) |

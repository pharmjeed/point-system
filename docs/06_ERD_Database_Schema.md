# 06 — قاعدة البيانات: المخطط والعلاقات والقيود (ERD & Database Schema)

الإصدار 1.0 — 27 أكتوبر 2026 — الحالة: معتمد للتنفيذ.

| الملف | الدور |
|---|---|
| `06_schema.sql` | **المرجع الملزم** للمخطط (47 جدولًا + عرضان مشتقان + مشغّل `updated_at`)؛ تم تحميله والتحقق منه على PostgreSQL 16 |
| `06_schema_invariants_test.sql` | إثبات تنفيذي لثوابت العمل: 21 محاولة مخالفة يجب أن ترفضها قاعدة البيانات |
| `00_Glossary_Canon.md` | الأسماء والقيم الحرفية لكل الحالات والجداول ورموز الأخطاء |
| `10_Dispatch_Engine_Spec.md` · `11_State_Machines_Domain_Events.md` | منطق التوزيع وآلات الحالة التي تكتب في هذه الجداول |

هذا الملف يشرح المخطط ولا يكرره حرفيًا: عند أي اختلاف بين هذا الشرح و`06_schema.sql`، الملف `06_schema.sql` هو الصحيح ويُصحَّح هذا الشرح.

---

## 1. نظرة عامة والاصطلاحات

### 1.1 المبادئ

1. **قاعدة البيانات تحرس الثوابت.** كل ثابت في المعمارية §9 («قيود قاعدة البيانات») مفروض بقيد `UNIQUE` جزئي أو `CHECK` حقيقي، وليس بفحص في الواجهة أو الكود وحده. الكود يفحص أولًا ليعطي رسالة واضحة، والقيد هو خط الدفاع الأخير عند السباق.
2. **مصدر الحقيقة واحد:** PostgreSQL. لا Redis ولا حالة الشاشة ولا الإشعار يقرر حالة مركبة أو عهدة أو قبول.
3. **التغيير والحدث في معاملة واحدة:** كل أمر يكتب التغيير + سطر `ticket_events` + سطر `audit_log` + أحداث `outbox_events` في معاملة واحدة، ولا اتصال شبكي خارجي داخل المعاملة.
4. **لا حذف صامت:** السجلات التشغيلية لا تُحذف؛ تُلغى أو تُعكس أو تُغلق بعمود حالة وسبب. الحذف الفعلي فقط بمهمة الاحتفاظ (§8) ولجداول محددة.
5. **الخصوصية بالتصميم:** لا يُخزن رمز تسليم أو رمز زر أو كلمة سر نصًا صريحًا؛ تُخزن بصمات (hash) فقط، والنسخة المشفرة المؤقتة لرمز التسليم تُمسح بعد الإرسال (DEC-15).

### 1.2 الاصطلاحات

| البند | القاعدة |
|---|---|
| المعرّفات | `uuid` لكل الجداول. التطبيق يولّد **UUIDv7** (مرتبة زمنيًا لتحسين محلية الفهارس)؛ الافتراضي في القاعدة `gen_random_uuid()` (v4، مدمجة منذ PostgreSQL 13، لا إضافات مطلوبة). PostgreSQL 16 لا يملك `uuidv7()` مدمجة، لذلك يولدها التطبيق |
| الاستثناءات | `bigint GENERATED ALWAYS AS IDENTITY` للجداول الإلحاقية كثيرة السطور: `ticket_events`، `audit_log`، `analytics_events`؛ و`tasks.seq` كمفتاح ثانوي ثابت لترتيب الطابور |
| الوقت | `timestamptz` بتوقيت UTC دائمًا؛ العرض بتوقيت `Asia/Riyadh`. `events.event_date` من نوع `date` ويمثل التاريخ المحلي للحفل. تنبيه: `now()` = وقت بداية المعاملة (كل سطور المعاملة تشترك فيه)؛ للترتيب داخل المعاملة استخدم `seq` أو UUIDv7 |
| القيم المحدودة | `text + CHECK` بالقيم الحرفية من Canon §5 (أسهل في التطوير من `ENUM`). إضافة قيمة = ترحيل يوسّع `CHECK` قبل نشر كود يكتبها (§9.2) |
| المال | `*_halalas bigint` بالهللة، والعملة `SAR` فقط (`payments.currency`) |
| التزامن المتفائل | عمود `version int` في الكيانات القابلة للتعديل (`venues`، `users`، `driver_transfers`، `events`، `shifts`، `duty_sessions`، `tickets`، `tasks`، `task_offers`، `whatsapp_templates`، `incidents`). كل تحديث: `SET version = version + 1 ... WHERE id = $id AND version = $expected_version` |
| `updated_at` | يحدّثه المشغّل `set_updated_at()` تلقائيًا في 22 جدولًا (القائمة في القسم 16 من `06_schema.sql`) |
| الإعدادات | `organizations.settings` و`venues.settings` من نوع `jsonb`؛ المفاتيح والقيم الافتراضية في Canon §12 ويتحقق منها التطبيق بـzod، والقيم الغائبة تُكمل من الافتراضيات |
| تسمية الفهارس | `uq_*` فهرس فريد (غالبًا جزئي) يحرس ثابتًا · `ix_*` فهرس أداء · `fk_*` مفتاح أجنبي مسمى · القيود المولدة آليًا بأسماء مثل `ck_tickets_parked_holder` (انظر §11 لاقتراح أسماء ثابتة) |
| المراجع اللينة | `audit_log.entity_id` و`analytics_events.*_id` و`notifications.source_outbox_id` مراجع بلا `FOREIGN KEY` عمدًا، حتى لا يمنع الاحتفاظ والحذف أو يربط السجلات بدورة حياة الكيان |

### 1.3 التحميل والتشغيل (PostgreSQL 16)

```bash
# قاعدة محلية للتطوير
docker run --name point-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=point -p 5432:5432 -d postgres:16
psql "postgresql://postgres:dev@localhost:5432/point" -v ON_ERROR_STOP=1 -f docs/06_schema.sql

# اختبار الثوابت: على قاعدة فارغة منفصلة دائمًا (السكربت يُدخل بيانات بمعرّفات ثابتة)
createdb -h localhost -U postgres point_test
psql -h localhost -U postgres -d point_test -v ON_ERROR_STOP=1 \
     -f docs/06_schema.sql -f docs/06_schema_invariants_test.sql
```

النتيجة المتوقعة: 21 سطرًا تبدأ بـ `ok (rejected)` ثم السطر `ALL INVARIANT TESTS PASSED`. أي سطر `NOT REJECTED` يعني أن ثابتًا كُسر في ترحيل ما، ويجب أن يفشل CI عنده.

### 1.4 خريطة المجالات

| المجال | الجداول |
|---|---|
| المؤسسة والهوية | `organizations` `venues` `dispatch_pools` `users` `role_scopes` `devices` `auth_sessions` `driver_assignments` `driver_transfers` |
| الحفلات والمناوبة وتجهيز الموقع | `events` `shifts` `duty_sessions` `parking_zones` `parking_spots` `key_boards` `key_slots` |
| التذاكر والعهدة | `tickets` `ticket_events` `vehicle_inspections` `media_assets` `spot_allocations` `key_slot_allocations` `custody_events` |
| الاسترجاع والتوزيع | `retrieval_cycles` `tasks` `task_offers` `offer_recipients` |
| العملاء وواتساب والإشعارات | `customers` `customer_consents` `action_tokens` `link_codes` `claim_codes` `whatsapp_channel` `whatsapp_templates` `whatsapp_messages` `whatsapp_inbound_events` `notifications` `notification_attempts` |
| المال والتشغيل والنظام | `payments` `cash_handovers` `incidents` `alerts` `outbox_events` `idempotency_keys` `audit_log` `analytics_events` `exports` |
| عروض مشتقة | `v_driver_state` (حالة السائق المشتقة، Canon §5.6) · `v_pool_queue` (طابور الإحضار الأقدم أولًا) |

---

## 2. مخططات العلاقات (ERD)

المخططات تعرض المفاتيح والأعمدة المفتاحية فقط لتبقى مقروءة؛ الأعمدة الكاملة في §3 وفي `06_schema.sql`. الرمز `|o--o{` يعني علاقة اختيارية (مفتاح أجنبي يقبل `NULL`).

### 2.أ المؤسسة والهوية والصلاحيات والتعيينات

```mermaid
erDiagram
  organizations ||--o{ venues : "has"
  organizations ||--o{ users : "employs"
  venues ||--o{ dispatch_pools : "has"
  users ||--o{ role_scopes : "granted"
  venues |o--o{ role_scopes : "scope (venue)"
  users ||--o{ devices : "owns"
  users ||--o{ auth_sessions : "logs in"
  devices |o--o{ auth_sessions : "from"
  users ||--o{ driver_assignments : "driver_id"
  venues ||--o{ driver_assignments : "venue_id"
  users ||--o{ driver_transfers : "driver_id"
  venues ||--o{ driver_transfers : "to_venue_id"
  driver_assignments |o--o{ driver_transfers : "from_assignment_id"
  driver_transfers |o--o{ driver_assignments : "transfer_id"
  organizations {
    uuid id PK
    jsonb settings
  }
  venues {
    uuid id PK
    uuid org_id FK
    text code UK "RMS"
    text name_ar
    text status
    jsonb settings
    int version
  }
  dispatch_pools {
    uuid id PK
    uuid venue_id FK
    boolean is_default "uq per venue"
    text status
  }
  users {
    uuid id PK "permanent ID"
    text employee_code UK
    text phone_e164 UK
    text role
    boolean can_drive
    text status
    text secret_kind
    boolean mfa_enabled
    int version
  }
  role_scopes {
    uuid id PK
    uuid user_id FK
    text scope_type
    uuid venue_id FK
    timestamptz revoked_at
  }
  devices {
    uuid id PK
    uuid user_id FK
    text notification_permission
    text push_endpoint UK
    timestamptz audio_tested_at
  }
  auth_sessions {
    uuid id PK
    uuid user_id FK
    uuid device_id FK
    text token_hash UK
    timestamptz expires_at
    timestamptz revoked_at
  }
  driver_assignments {
    uuid id PK
    uuid driver_id FK
    uuid venue_id FK
    text status "one active per driver"
    timestamptz starts_at
    timestamptz ends_at
    uuid transfer_id FK
  }
  driver_transfers {
    uuid id PK
    uuid driver_id FK
    uuid from_assignment_id FK
    uuid to_venue_id FK
    timestamptz scheduled_at
    text status "one open per driver"
  }
```

### 2.ب الحفلات والورديات والمناوبة وتجهيز الموقع

```mermaid
erDiagram
  venues ||--o{ events : "hosts"
  dispatch_pools ||--o{ events : "dispatches"
  venues ||--o{ shifts : "has"
  dispatch_pools ||--o{ shifts : "one open per pool"
  shifts ||--o{ duty_sessions : "contains"
  users ||--o{ duty_sessions : "works"
  dispatch_pools ||--o{ duty_sessions : "member of"
  driver_assignments |o--o{ duty_sessions : "under"
  venues ||--o{ parking_zones : "has"
  parking_zones ||--o{ parking_spots : "has"
  venues ||--o{ key_boards : "has"
  key_boards ||--o{ key_slots : "has"
  events {
    uuid id PK
    uuid venue_id FK
    uuid dispatch_pool_id FK
    text name_ar
    date event_date
    text status
    text pricing_mode
    bigint fee_halalas
    int next_display_number "ticket counter"
    int version
  }
  shifts {
    uuid id PK
    uuid venue_id FK
    uuid dispatch_pool_id FK
    text status
    timestamptz starts_at
  }
  duty_sessions {
    uuid id PK
    uuid user_id FK
    uuid shift_id FK
    uuid dispatch_pool_id FK
    uuid assignment_id FK
    text status "one open per user"
    timestamptz available_since "longest idle"
    timestamptz last_heartbeat_at
    text connection_state
    int version
  }
  parking_zones {
    uuid id PK
    uuid venue_id FK
    text name
  }
  parking_spots {
    uuid id PK
    uuid zone_id FK
    text label "B-14"
  }
  key_boards {
    uuid id PK
    uuid venue_id FK
    text name
  }
  key_slots {
    uuid id PK
    uuid key_board_id FK
    text label "12"
  }
```

### 2.ج التذاكر والعهدة والتخصيصات والفحص والصور

```mermaid
erDiagram
  events ||--o{ tickets : "numbers"
  customers |o--o{ tickets : "owns"
  users ||--o{ tickets : "created_by"
  parking_spots |o--o{ tickets : "current_spot_id"
  key_slots |o--o{ tickets : "current_key_slot_id"
  tickets ||--o{ ticket_events : "timeline"
  tickets ||--o{ custody_events : "custody chain"
  tickets ||--o{ spot_allocations : "parked in"
  parking_spots ||--o{ spot_allocations : "allocated"
  tickets ||--o{ key_slot_allocations : "key in"
  key_slots ||--o{ key_slot_allocations : "allocated"
  tickets ||--o{ vehicle_inspections : "inspected"
  tickets ||--o{ media_assets : "photos"
  vehicle_inspections |o--o{ media_assets : "groups"
  tickets {
    uuid id PK
    uuid event_id FK
    uuid dispatch_pool_id FK
    int display_number "uq per event"
    text status
    text channel
    uuid customer_id FK
    text wa_link_status
    int link_version
    text paper_serial
    text plate_digits
    text key_tag "uq among open per venue"
    text vehicle_holder_type
    text key_holder_type
    timestamptz pending_retrieval_at
    uuid active_cycle_id FK
    text payment_status
    int version
  }
  ticket_events {
    bigint id PK
    uuid ticket_id FK
    text type
    int ticket_version
    jsonb data
  }
  custody_events {
    uuid id PK
    uuid ticket_id FK
    text subject "vehicle or key"
    text from_holder_type
    text to_holder_type
    text reason
    uuid task_id FK
    uuid actor_id FK
  }
  spot_allocations {
    uuid id PK
    uuid ticket_id FK
    uuid parking_spot_id FK
    timestamptz released_at "NULL = active"
  }
  key_slot_allocations {
    uuid id PK
    uuid ticket_id FK
    uuid key_slot_id FK
    timestamptz released_at "NULL = active"
  }
  vehicle_inspections {
    uuid id PK
    uuid ticket_id FK
    text kind
    jsonb damage_marks
  }
  media_assets {
    uuid id PK
    uuid ticket_id FK
    text kind
    text storage_key UK "private"
    text upload_status
  }
```

### 2.د دورات الاسترجاع والمهام والعروض

```mermaid
erDiagram
  tickets ||--o{ retrieval_cycles : "requests"
  tickets |o--o| retrieval_cycles : "active_cycle_id"
  tickets ||--o{ tasks : "movements"
  retrieval_cycles |o--o{ tasks : "cycle_id"
  dispatch_pools ||--o{ tasks : "queue"
  users |o--o{ tasks : "assignee_id"
  tasks ||--o{ task_offers : "offer rounds"
  task_offers ||--o{ offer_recipients : "sent to"
  users ||--o{ offer_recipients : "recipient"
  duty_sessions ||--o{ offer_recipients : "while on duty"
  tasks |o--o{ custody_events : "task_id"
  retrieval_cycles {
    uuid id PK
    uuid ticket_id FK
    int cycle_no
    timestamptz requested_at "priority key"
    text request_source
    boolean requested_early
    text outcome
    timestamptz closed_at "NULL = open"
  }
  tasks {
    uuid id PK
    uuid ticket_id FK
    uuid cycle_id FK
    uuid dispatch_pool_id FK
    text type
    text status
    timestamptz priority_at
    bigint seq UK "tie-breaker"
    uuid assignee_id FK
    timestamptz key_picked_up_at
    int version
  }
  task_offers {
    uuid id PK
    uuid task_id FK
    text mode "single or broadcast"
    int round_no
    text status "one active per task"
    timestamptz reminder_at
    timestamptz expires_at
    uuid accepted_by FK
  }
  offer_recipients {
    uuid offer_id PK
    uuid user_id PK
    uuid duty_session_id FK
    text eligible_as
    text response
  }
  custody_events {
    uuid id PK
    uuid task_id FK
  }
```

### 2.هـ العملاء وواتساب والرموز والإشعارات

```mermaid
erDiagram
  customers ||--o{ customer_consents : "consents"
  tickets |o--o{ customer_consents : "captured for"
  whatsapp_messages |o--o{ customer_consents : "evidence_message_id"
  whatsapp_channel ||--o{ whatsapp_messages : "single number"
  notifications |o--o{ whatsapp_messages : "delivers"
  customers |o--o{ whatsapp_messages : "with"
  tickets |o--o{ whatsapp_messages : "about"
  tickets ||--o{ action_tokens : "button payload"
  customers ||--o{ action_tokens : "bound to"
  tickets ||--o{ link_codes : "QR link"
  whatsapp_messages |o--o{ link_codes : "inbound_message_id"
  tickets ||--o{ claim_codes : "handover"
  retrieval_cycles ||--o{ claim_codes : "per cycle"
  whatsapp_messages |o--o{ claim_codes : "sent_message_id"
  notifications ||--o{ notification_attempts : "attempts"
  customers |o--o{ notifications : "recipient (whatsapp)"
  devices |o--o{ notifications : "recipient (push)"
  customers {
    uuid id PK
    text phone_e164 UK
    text wa_id UK
    text wa_user_id UK "BSUID, DEC-35"
    timestamptz last_inbound_at
    timestamptz wa_opted_out_at
  }
  customer_consents {
    uuid id PK
    uuid customer_id FK
    text method
    timestamptz revoked_at
  }
  whatsapp_channel {
    uuid id PK
    text phone_number_id "one active"
    text mode
    text health_status
  }
  whatsapp_templates {
    uuid id PK
    text name UK
    text language UK
    text category
    text status
  }
  whatsapp_messages {
    uuid id PK
    text wa_message_id UK
    text direction
    text kind
    text purpose "W-01..W-12"
    text status
    smallint status_rank
    text ordering_key
  }
  whatsapp_inbound_events {
    uuid id PK
    text body_sha256 UK
    text status
  }
  action_tokens {
    uuid id PK
    text token_hash UK
    int link_version
    timestamptz expires_at
  }
  link_codes {
    uuid id PK
    text code "live code unique"
    text status
    timestamptz expires_at
  }
  claim_codes {
    uuid id PK
    uuid cycle_id FK "one live per cycle"
    text code_hash
    int attempts
    timestamptz expires_at
  }
  notifications {
    uuid id PK
    text channel
    text purpose
    text dedupe_key UK
    text status
  }
  notification_attempts {
    uuid id PK
    uuid notification_id FK
    int attempt_no
    text outcome
  }
```

### 2.و المال والوقائع والتنبيهات وOutbox والتدقيق والتحليلات والتصدير

```mermaid
erDiagram
  tickets ||--o{ payments : "collected for"
  events ||--o{ payments : "in event"
  users ||--o{ payments : "collected_by"
  retrieval_cycles |o--o{ payments : "cycle_id"
  cash_handovers |o--o{ payments : "settled in"
  events ||--o{ cash_handovers : "in event"
  users ||--o{ cash_handovers : "driver_id / received_by"
  venues ||--o{ incidents : "at"
  tickets |o--o{ incidents : "about"
  venues ||--o{ alerts : "at"
  tasks |o--o{ alerts : "about"
  tickets |o--o{ alerts : "about"
  venues |o--o{ outbox_events : "venue_id"
  users ||--o{ idempotency_keys : "per user"
  organizations ||--o{ audit_log : "records"
  organizations ||--o{ analytics_events : "measures"
  users ||--o{ exports : "requested_by"
  payments {
    uuid id PK
    uuid ticket_id FK "one recorded per ticket"
    text method "cash or pos"
    bigint amount_halalas
    text pos_reference "never card data"
    text status
    uuid cash_handover_id FK
  }
  cash_handovers {
    uuid id PK
    uuid driver_id FK
    uuid received_by FK
    bigint amount_halalas
    bigint expected_halalas
    bigint difference_halalas "generated"
  }
  incidents {
    uuid id PK
    text type
    text status
    text severity
  }
  alerts {
    uuid id PK
    text type
    text severity
    text status
    text dedupe_key "unique per venue while live"
  }
  outbox_events {
    uuid id PK
    text type
    text dedupe_key "unique while pending"
    text ordering_key
    timestamptz available_at
    text status
    timestamptz locked_until
  }
  idempotency_keys {
    uuid user_id PK
    text key PK
    text request_hash
    text status
    jsonb response_body
  }
  audit_log {
    bigint id PK
    text action
    text entity_type
    uuid entity_id
  }
  analytics_events {
    bigint id PK
    text name
    text source
    jsonb properties
  }
  exports {
    uuid id PK
    text kind
    text status
    timestamptz expires_at
  }
```

---

## 3. مرجع الجداول (47 جدولًا)

الترقيم يطابق Canon §6. لكل جدول: الغرض، الأعمدة الأساسية، العلاقات، القيود والفهارس بأسمائها الفعلية، ومسارات الكتابة والقراءة (المسارات من Canon §9 والمهام من Canon §7.2).

### 3.أ المؤسسة والهوية والصلاحيات

#### 1) `organizations`
- **الغرض:** شركة الفاليت المشغّلة. مؤسسة واحدة في الإصدار الأول، وكل جدول يحمل `org_id` ليبقى المخطط جاهزًا لأكثر من مؤسسة.
- **أعمدة أساسية:** `name_ar`، `name_en`، `settings` (مفاتيح `security.*` و`heartbeat.*` و`retention.*` من Canon §12).
- **القيود:** المفتاح الأساسي فقط.
- **الكتابة/القراءة:** تُنشأ في التهيئة الأولى؛ إعدادات الاحتفاظ تُكتب عبر `PUT /v1/admin/retention-policy`. تُقرأ (مع تخزين مؤقت قصير) في كل طلب لبناء سياق الأمان.

#### 2) `venues`
- **الغرض:** موقع تشغيل فعلي (قاعة ريماس `RMS`، قاعة ليلتي `LYL`).
- **أعمدة أساسية:** `code` رمز قصير بحروف لاتينية كبيرة وأرقام، `name_ar` (يظهر للعميل في W-01)، `timezone` (`Asia/Riyadh`)، `status`، `settings` (مفاتيح `dispatch.*`، `handover.*`، `ready.*`، `inspection.*`، `link.*`، `parking.*`، `keys.*`، `pricing.*`)، `version`.
- **القيود:** `venues_org_id_code_key` (رمز فريد في المؤسسة)، `venues_code_check` (`^[A-Z0-9]{2,8}$`)، `venues_status_check`.
- **الكتابة/القراءة:** `POST /v1/venues`، `PATCH /v1/venues/{venueId}`، `PUT /v1/venues/{venueId}/settings`. يُقرأ في كل أمر تشغيلي (نطاق الموقع) وفي إرسال واتساب (اسم الموقع).

#### 3) `dispatch_pools`
- **الغرض:** مجموعة التوزيع. صفها هو **قفل التوزيع**: كل معاملة تغيّر طابور المجموعة أو توفر سائقيها تأخذ `SELECT ... FOR NO KEY UPDATE` على هذا الصف أولًا (§5.2).
- **أعمدة أساسية:** `venue_id`، `name`، `is_default`، `status`، `last_pass_at` و`pass_count` (تشخيص آخر تمريرة توزيع).
- **القيود:** `uq_dispatch_pools_default` (مجموعة افتراضية واحدة لكل موقع، DEC-21)، `dispatch_pools_venue_id_name_key`.
- **الكتابة/القراءة:** `POST /v1/venues/{venueId}/dispatch-pools`، `PATCH /v1/dispatch-pools/{poolId}`؛ تمريرة التوزيع تحدّث `last_pass_at`/`pass_count` وهي تحمل القفل أصلًا.

#### 4) `users`
- **الغرض:** حساب دائم ومستقل لكل شخص (سائق، مشرف، إدارة، مالك). `id` هو «معرّف السائق الثابت» الذي يبقى مع السائق عبر كل القاعات (المعمارية §1، §4أ). لا يُحذف المستخدم أبدًا؛ يُعطّل.
- **أعمدة أساسية:** `employee_code` (مثل `D-0042`)، `full_name`، `phone_e164`، `role`، `can_drive` (DEC-22)، `status`، `secret_kind` و`secret_hash` (argon2id)، `must_change_secret`، `mfa_enabled` و`mfa_secret_enc` (TOTP مشفّر بمفتاح `DATA_ENCRYPTION_KEY`) و`mfa_last_step` (منع إعادة استخدام رمز TOTP)، `failed_login_count` و`locked_until`، `disabled_at/by/reason`، `version`.
- **القيود:** `users_org_id_employee_code_key`، `users_org_id_phone_e164_key`، `users_phone_e164_check`، `users_role_check`، `users_status_check`، `users_secret_kind_check`؛ `ck_users_secret_kind_by_role` (السائق رقم سري `pin` والبقية `password`)، `ck_users_can_drive_supervisor_only` (`can_drive` للمشرف فقط)، `ck_users_disabled_at` (المعطّل له `disabled_at`).
- **الكتابة/القراءة:** `POST /v1/drivers`، `PATCH /v1/drivers/{driverId}`، `.../disable`، `.../enable`، `.../reset-secret`، `POST /v1/staff`، `PATCH /v1/staff/{userId}`، `POST /v1/staff/{userId}/reset-mfa` (المالك فقط: `mfa_enabled = false` و`mfa_secret_enc = NULL`)، `POST /v1/auth/login` (عداد المحاولات والقفل)، `POST /v1/auth/secret/change`، `POST /v1/auth/mfa/confirm`. يُقرأ في كل طلب لبناء السياق.

#### 5) `role_scopes`
- **الغرض:** نطاق المشرف/الإدارة/المالك: على المؤسسة كلها (`org`) أو على موقع (`venue`). السائق لا يستخدم هذا الجدول؛ نطاقه من `driver_assignments`.
- **أعمدة أساسية:** `user_id`، `scope_type`، `venue_id`، `granted_by/at`، `revoked_at/by` (السحب يحفظ التاريخ ولا يحذف).
- **القيود:** `ck_role_scopes_shape` (شكل النطاق)، `uq_role_scopes_org_active` و`uq_role_scopes_venue_active` (نطاق حي واحد لكل مستخدم/موقع).
- **الكتابة/القراءة:** `POST /v1/staff/{userId}/scopes`. يُقرأ في حارس الصلاحيات لكل طلب مشرف/إدارة (Canon §10).

#### 6) `devices`
- **الغرض:** جهاز/متصفح المستخدم: اشتراك Web Push، إذن الإشعارات، نتيجة اختبار الصوت، وضع العرض (متصفح/مثبّت على الشاشة الرئيسية).
- **أعمدة أساسية:** `platform`، `display_mode`، `notification_permission`، `push_endpoint/p256dh/auth`، `push_failed_count`، `audio_tested_at`، `audio_test_result`، `last_seen_at`، `revoked_at`.
- **القيود:** `ck_devices_push_triplet` (ثلاثية الاشتراك كلها أو لا شيء)، `uq_devices_push_endpoint` (لا يتكرر الاشتراك نفسه على جهازين: عند تسجيله لجهاز جديد يُصفَّر في الصف القديم أولًا)، `ix_devices_user`.
- **الكتابة/القراءة:** `POST /v1/me/devices`، `PUT /v1/me/devices/{deviceId}`، `POST /v1/me/audio-test`؛ المهمة `job.push_send` تزيد `push_failed_count` وتمسح الاشتراك عند رد 404/410 من خدمة الدفع. يُقرأ عند إرسال Push وفي D-14 وS-05.

#### 7) `auth_sessions`
- **الغرض:** جلسات الدخول على الخادم؛ الكوكي يحمل رمزًا معتمًا ولا يُخزن إلا بصمته.
- **أعمدة أساسية:** `token_hash` (sha256)، `device_id`، `mfa_verified`، `ip`، `user_agent`، `expires_at`، `revoked_at` و`revoked_reason` (`logout`، `transfer`، `disabled`، `secret_reset`، `admin`، `expired_cleanup`).
- **القيود:** `auth_sessions_token_hash_key`، `ix_auth_sessions_user_active`، `auth_sessions_revoked_reason_check`.
- **الكتابة/القراءة:** الدخول/الخروج؛ النقل والتعطيل وإعادة تعيين السر وإعادة ضبط MFA (`admin`) تُبطل الجلسات في معاملة الأمر نفسها (ثم `session.revoked` عبر WebSocket). يُقرأ في كل طلب بالبحث بالبصمة.

#### 8) `driver_assignments`
- **الغرض:** تعيينات السائق المؤرخة على المواقع. السجل التاريخي لا يُعاد كتابته عند النقل؛ يُغلق القديم ويُفتح جديد (المعمارية §4أ).
- **أعمدة أساسية:** `driver_id`، `venue_id`، `status` (`scheduled`/`active`/`ended`)، `starts_at`، `ends_at`، `reason`، `transfer_id`، `created_by`، `approved_by`.
- **القيود:** `uq_driver_assignments_active` (**تعيين نشط واحد لكل سائق** — ثابت §9)، `ck_assignments_ended_has_end` (المنتهي له `ends_at`)، `ck_assignments_end_after_start` (النهاية بعد البداية)، `fk_driver_assignments_transfer`، `ix_driver_assignments_venue_active`.
- **الكتابة/القراءة:** `POST /v1/drivers/{driverId}/assignments`، تفعيل النقل بالمهمة `job.transfer_activate`. يُقرأ في حارس الصلاحيات (موقع السائق) وD-03 وS-06.

#### 9) `driver_transfers`
- **الغرض:** طلب نقل سائق بين موقعين بموعد، مع نتيجة فحص العهدة.
- **أعمدة أساسية:** `from_assignment_id`، `from_venue_id`، `to_venue_id`، `scheduled_at`، `status` (`pending`/`blocked`/`completed`/`canceled`)، `reason`، `blocked_details` (قائمة العناصر المانعة)، `requested_by`، `approved_by`، `version`.
- **القيود:** `uq_driver_transfers_open` (طلب نقل مفتوح واحد لكل سائق)، `ck_transfers_distinct_venues` (الموقعان مختلفان).
- **الكتابة/القراءة:** `POST /v1/drivers/{driverId}/transfers` (النقل الفوري الممنوع بمانع DEC-32 يرد `TRANSFER_BLOCKED_CUSTODY` دون إنشاء سجل ولا تنبيه)، `POST /v1/transfers/{transferId}/cancel`، `job.transfer_activate` (يعيد الفحص عند الموعد، وعند وجود مانع يصبح `blocked` ويرفع تنبيه `transfer_blocked` ويُعاد تقييمه آليًا). يُقرأ في S-06/S-07.

### 3.ب الحفلات والورديات والمناوبة

#### 10) `events`
- **الغرض:** الحفل. أرقام التذاكر فريدة داخله، والتسعير يُحدد على مستواه.
- **أعمدة أساسية:** `dispatch_pool_id` (ثابت بعد الفتح)، `name_ar`، `host_name`، `event_date`، `starts_at/ends_at`، `status`، `pricing_mode` و`fee_halalas` و`allowed_payment_methods`، `next_display_number` (عداد التذاكر)، `opened_*`، `closing_started_at`، `closed_*`، `close_summary` (يُكتب عند الإغلاق ولا يتغير: `{closed_at, closed_by, note, tickets, finance, warnings}`، و`finance` = `{currency, amounts, drivers, discrepancies}`، DEC-287)، `canceled_at` و`cancel_reason`، `version`.
- **القيود:** `ck_events_fee_zero_unless_per_vehicle` (الرسوم صفر إلا لـ`per_vehicle`)، `ck_events_per_vehicle_fee_positive` (`per_vehicle` برسوم موجبة)، `ck_events_closed_at` (المغلق له `closed_at`)، `ck_events_payment_methods`، `events_fee_halalas_check`، `events_next_display_number_check`، `ix_events_venue_status`.
- **الكتابة/القراءة:** `POST /v1/venues/{venueId}/events`، `PATCH /v1/events/{eventId}`، `.../open`، `.../start-closing`، `.../close`، `.../cancel`؛ بدء الاستلام يزيد العداد (§5.3) **دون** زيادة `version` حتى لا يتعارض مع تعديل المشرف. يُقرأ في الاستلام (الحفلات المفتوحة) وS-08 وS-10 والتقارير.

#### 11) `shifts`
- **الغرض:** نافذة تشغيل للموقع يفتحها المشرف؛ مناوبات السائقين تُفتح داخلها.
- **أعمدة أساسية:** `dispatch_pool_id`، `name`، `starts_at/ends_at`، `status`، `opened_*`، `closed_*`، `version`.
- **القيود:** `uq_shifts_open_per_pool` (وردية مفتوحة واحدة لكل مجموعة)، `shifts_status_check`.
- **الكتابة/القراءة:** `POST /v1/venues/{venueId}/shifts`، `POST /v1/shifts/{shiftId}/open`، `POST /v1/shifts/{shiftId}/close` (المناوبات المفتوحة التي لا عهدة لأصحابها ولا مهام مفتوحة لهم تُنهى آليًا `end_reason = shift_closed`؛ ويُرفض بـ`SHIFT_CLOSE_BLOCKED` مع `details.blocking_drivers` إن وُجد سائق بعهدته مركبة أو مفتاح أو لديه مهمة مفتوحة). يُقرأ عند بدء المناوبة (`SHIFT_NOT_OPEN`).

#### 12) `duty_sessions`
- **الغرض:** مناوبة السائق الفعلية («ورديتي»). مصدر التوفر و«الأطول تفرغًا».
- **أعمدة أساسية:** `shift_id`، `venue_id`، `dispatch_pool_id`، `assignment_id` (فارغ للمشرف القائد)، `status` (`on_duty`/`on_break`/`ended`)، `available_since` (يُضبط عند الخمول ويُفرَّغ عند الانشغال أو الاستراحة؛ الأطول تفرغًا = الأقدم قيمة)، `last_heartbeat_at`، `connection_state`، `end_reason`، `version`.
- **القيود:** `uq_duty_sessions_open` (مناوبة مفتوحة واحدة لكل مستخدم)، `ck_duty_ended_at` (المنتهية لها `ended_at`)، `ck_duty_available_only_on_duty` (`available_since` فقط أثناء `on_duty`)، `ix_duty_sessions_pool_available` (مسار اختيار الأطول تفرغًا)، `ix_duty_sessions_pool_open`.
- **الكتابة/القراءة:** `POST /v1/me/duty/start|break|end`، `POST /v1/duty-sessions/{sessionId}/force-end`، إغلاق الوردية (إنهاء آلي `shift_closed`)، كل قبول/إتمام مهمة (`available_since`)، النبضات (`POST /v1/me/heartbeat` أو `client.heartbeat`) و`job.heartbeat_sweep` (`connection_state`). **النبضة لا تزيد `version`** ولا تغيّر التوفر، ويُفضّل تجاهل الكتابة إذا كانت آخر نبضة قبل أقل من 10 ثوانٍ. يُقرأ في التوزيع و`v_driver_state` وS-05.

### 3.ج العملاء والموافقات

#### 13) `customers`
- **الغرض:** صاحب المركبة كما يعرفه واتساب. لا حساب ولا صفحة للعميل.
- **أعمدة أساسية:** `phone_e164` (مطبّع؛ فارغ فقط لمستخدم أسماء واتساب الذي يصل بمعرّفه دون رقم ظاهر)، `wa_id` (من Webhook)، `wa_user_id` (معرّف BSUID حين يُخفى الرقم، DEC-35)، `locale`، `last_inbound_at` (مرساة نافذة خدمة العملاء)، `wa_opted_out_at` (طلب «إيقاف»).
- **القيود:** `customers_org_id_phone_e164_key`، `uq_customers_wa_id`، `uq_customers_wa_user_id` (معرّف BSUID فريد في المؤسسة)، `ck_customers_identifier` (`phone_e164` أو `wa_user_id` إلزامي)، `customers_phone_e164_check`.
- **الكتابة/القراءة:** إدخال/مطابقة بالجوال عند الاستلام (`PATCH /v1/tickets/{ticketId}/intake`)، تحديث `wa_id`/`wa_user_id` و`last_inbound_at` في `job.wa_process_inbound`، وصف بمعرّفاته فقط لكل مرسل وارد غير معروف لأن ردود W-10…W-12 تشترط `recipient_customer_id` (`ck_notifications_recipient`، DEC-132)، إيقاف الرسائل (W-12). يُقرأ قبل كل إرسال (الموافقة والإيقاف) وفي تفاصيل التذكرة (مقنّعًا).

#### 14) `customer_consents`
- **الغرض:** دليل موافقة العميل على رسائل واتساب ومصدرها.
- **أعمدة أساسية:** `customer_id`، `ticket_id`، `method` (`verbal_staff_confirmed` بشهادة السائق أو `customer_initiated` عبر QR)، `captured_by`، `captured_at`، `evidence_message_id`، `revoked_at`، `revoke_source`.
- **القيود:** `ck_consents_verbal_has_staff` (الموافقة الشفهية تحتاج موظفًا)، `fk_customer_consents_evidence`، `ix_customer_consents_customer`.
- **الكتابة/القراءة:** الاستلام مع موافقة، تأكيد ربط QR (`POST /v1/tickets/{ticketId}/whatsapp-link/confirm`)، إيقاف العميل (سحب). يُقرأ قبل إرسال أي قالب (`WA_CONSENT_MISSING`).

### 3.د تجهيز الموقع

#### 15) `parking_zones` · 16) `parking_spots`
- **الغرض:** أماكن الوقوف المرقّمة. يمكن أيضًا الصف بملاحظة نصية حرة (`tickets.current_spot_note`) حسب `parking.mode`.
- **أعمدة أساسية:** المنطقة: `name`، `sort_order`، `status`؛ الموقف: `zone_id`، `label` (مثل `B-14`)، `status`.
- **القيود:** `parking_zones_venue_id_name_key`، `parking_spots_zone_id_label_key`. التعطيل `inactive` بدل الحذف.
- **الكتابة/القراءة:** `POST /v1/venues/{venueId}/parking-zones`، `PATCH /v1/parking-zones/{zoneId}`، `POST /v1/venues/{venueId}/parking-spots` (إنشاء جماعي)، `PATCH /v1/parking-spots/{spotId}`. يُقرأ في D-08 (المواقف الحرة) وD-10.

#### 17) `key_boards` · 18) `key_slots`
- **الغرض:** لوحات وخانات إيداع المفاتيح. موضع المفتاح معلومة حساسة أمنيًا (Canon §2 ثابت 11).
- **أعمدة أساسية:** اللوحة: `name`، `status`؛ الخانة: `key_board_id`، `label`، `status`.
- **القيود:** `key_boards_venue_id_name_key`، `key_slots_key_board_id_label_key`.
- **الكتابة/القراءة:** `POST /v1/venues/{venueId}/key-boards`، `POST /v1/key-boards/{boardId}/slots`، `PATCH /v1/key-slots/{slotId}`. يُقرأ في D-08 (الخانات الحرة) وD-10 (للمكلّف فقط).

### 3.هـ التذاكر والعهدة

#### 19) `tickets`
- **الغرض:** الكيان المحوري: مركبة واحدة داخل حفل، من الاستلام حتى التسليم أو الإلغاء.
- **أعمدة أساسية:**
  - التعريف: `event_id`، `dispatch_pool_id` (منسوخ من الحفل وثابت)، `display_number`، `status` (Canon §5.1)، `channel`.
  - الربط بالعميل: `customer_id`، `wa_link_status`، `link_version` (يزيد عند تغيير الجوال أو الربط فيُبطل كل `action_tokens` السابقة)، `paper_serial`.
  - المركبة: `plate_country`، `plate_digits`، `plate_letters_ar`، `plate_letters_en`، `plate_raw`، `vehicle_make/model/color/type`، `key_tag`، `inspection_status`، `notes`.
  - الموضع والعهدة الحالية: `current_spot_id` أو `current_spot_note`، `current_key_slot_id`، `vehicle_holder_type/id`، `key_holder_type/id` (التاريخ الكامل في `custody_events` والتخصيصات).
  - الاسترجاع: `pending_retrieval_at` و`pending_retrieval_source` (الطلب المبكر، DEC-13)، `active_cycle_id`، `last_requested_at`.
  - الدفع: `payment_status`، `fee_halalas` (منسوخ من الحفل لحظة الاستلام)، `payment_waived_at/by`، `payment_waiver_reason`.
  - الفاعلون للتوثيق فقط (لا أثر لهم على الأولوية): `created_by`، `parked_by`، `retrieved_by` (آخر دورة)، `delivered_by`؛ أوقات `submitted_at`، `parked_at`، `delivered_at`، `voided_*`، `version`.
- **القيود:** `tickets_event_id_display_number_key` (**رقم تذكرة فريد لكل حفل** — ثابت §9)، `uq_tickets_key_tag_open` (علاقة مفتاح لتذكرة مفتوحة واحدة في الموقع)، `uq_tickets_paper_serial`، `ck_tickets_delivered_fields` (المسلّمة لها `delivered_at` و`delivered_by`)، `ck_tickets_voided_fields` (الملغاة لها وقت وسبب)، `ck_tickets_paper_serial` (الورقية لها رقم بعد التسجيل)، `ck_tickets_waiver_fields` (الإعفاء له وقت وسبب)، `ck_tickets_parked_holder` (المتوقفة عهدتها `spot` أو `unknown`)، `tickets_plate_digits_check`، `tickets_display_number_check`، `tickets_fee_halalas_check`، `fk_tickets_active_cycle`؛ الفهارس `ix_tickets_event_status` (لوحة المشرف وإغلاق الحفل)، `ix_tickets_plate_open` (البحث بأرقام اللوحة)، `ix_tickets_customer`، `ix_tickets_creator_draft` (مسودات السائق).
- **الكتابة/القراءة:** تقريبًا كل أمر تشغيلي (Canon §9.2–§9.4). القراءة: D-04، D-12، D-13، S-02، S-03، وردود واتساب W-09. السائق يرى الحقول الدنيا فقط إلا إذا كان المكلّف (Canon §10).

#### 20) `ticket_events`
- **الغرض:** الخط الزمني الإلحاقي للتذكرة («سجل الأحداث» في المعمارية §2)، يُكتب في معاملة التغيير نفسها.
- **أعمدة أساسية:** `type` (نوع حدث النطاق من Canon §7.1)، `actor_type`، `actor_id`، `ticket_version` (إصدار التذكرة بعد التغيير)، `data` (معرّفات وقيم محدودة فقط، بلا جوال أو رمز)، `occurred_at`.
- **القيود:** `ix_ticket_events_ticket`. لا تحديث ولا حذف (صلاحية INSERT/SELECT فقط).
- **الكتابة/القراءة:** كل أمر على التذكرة. يُقرأ في `GET /v1/tickets/{ticketId}/timeline` (S-03).

#### 21) `vehicle_inspections`
- **الغرض:** فحص حالة المركبة عند الاستلام أو التسليم أو ضمن واقعة.
- **أعمدة أساسية:** `kind`، `captured_by`، `notes`، `damage_marks` (مصفوفة `{area, note}`)، `required_photos_ok`.
- **القيود:** `vehicle_inspections_kind_check`.
- **الكتابة/القراءة:** خطوة الاستلام الثانية (D-06) وتقديم الاستلام؛ اعتماد استثناء الفحص يغيّر `tickets.inspection_status` إلى `exception_approved`. يُقرأ في S-03.

#### 22) `media_assets`
- **الغرض:** صور المركبة الخاصة في تخزين كائنات غير عام؛ لا تُعرض إلا بروابط موقّعة قصيرة العمر.
- **أعمدة أساسية:** `kind` (الزوايا الأربع والإضافية والضرر)، `storage_key` (مفتاح خاص)، `content_type`، `byte_size`، `sha256`، `upload_status` (`pending` ← `uploaded`/`failed`، ثم `deleted` بالاحتفاظ)، `uploaded_by`، `captured_at`، `uploaded_at`، `deleted_at`، `delete_reason`.
- **القيود:** `media_assets_storage_key_key`، `media_assets_content_type_check`، `media_assets_byte_size_check`، `ix_media_ticket`.
- **الكتابة/القراءة:** `POST /v1/tickets/{ticketId}/media` (ينشئ `pending` ويعيد رابط رفع)، `POST /v1/media/{mediaId}/complete`، مهمة الاحتفاظ (§8). القراءة عبر `GET /v1/media/{mediaId}/url` لمن يملك `ticket.read_photos`.

#### 23) `spot_allocations`
- **الغرض:** تاريخ تخصيص المواقف المرقّمة.
- **أعمدة أساسية:** `ticket_id`، `parking_spot_id`، `allocated_at/by`، `released_at/by`، `release_reason` (`retrieval_start`، `repark`، `correction`، `manual_reconcile`، `void`، `official_transfer`).
- **القيود:** `uq_spot_alloc_spot_active` (**تخصيص نشط واحد للموقف** — ثابت §9) و`uq_spot_alloc_ticket_active` (موقف نشط واحد للتذكرة).
- **الكتابة/القراءة:** `POST /v1/tasks/{taskId}/complete-parking` (تخصيص)، `POST /v1/tasks/{taskId}/start-retrieval` (تحرير لأن المركبة غادرت الموقف)، التصحيحات. يُقرأ في D-08 لإظهار المواقف المشغولة.

#### 24) `key_slot_allocations`
- **الغرض:** تاريخ إيداع المفاتيح في الخانات.
- **أعمدة أساسية:** `ticket_id`، `key_slot_id`، `allocated_at/by`، `released_at/by`، `release_reason` (`key_pickup`، `correction`، `manual_reconcile`، `void`، `official_transfer`).
- **القيود:** `uq_key_alloc_slot_active` (**تخصيص نشط واحد لخانة المفتاح** — ثابت §9) و`uq_key_alloc_ticket_active`.
- **الكتابة/القراءة:** إتمام الصف (إيداع)، `POST /v1/tasks/{taskId}/key-pickup` (تحرير)، التصحيحات. يُقرأ في D-08 وفي موانع إغلاق الحفل (§6.5).

#### 25) `custody_events`
- **الغرض:** سلسلة العهدة الكاملة للمركبة والمفتاح: من، إلى، متى، لماذا، وبأي مهمة.
- **أعمدة أساسية:** `subject` (`vehicle`/`key`)، `from_holder_type/id`، `to_holder_type/id`، `reason` (Canon §5.7)، `task_id`، `actor_id`، `note`، `occurred_at`.
- **القيود:** `custody_events_subject_check`، `custody_events_reason_check`، `ix_custody_ticket`، `ix_custody_to_driver`. إلحاقي فقط.
- **الكتابة/القراءة:** الاستلام (عميل ← سائق)، إتمام الصف (سائق ← موقف، سائق ← خانة)، استلام المفتاح (خانة ← سائق)، بدء الإحضار (موقف ← سائق)، التسليم (سائق ← عميل)، النقل الرسمي (`POST /v1/tickets/{ticketId}/custody-transfers`)، تحرير السحب، إعادة الصف، المطابقة اليدوية. في كل مرة تُحدَّث أعمدة الحائز الحالي في `tickets` بالمعاملة نفسها. يُقرأ في S-03 وفحوص النقل وإنهاء المناوبة (§6.4).

### 3.و الاسترجاع والمهام والعروض

#### 26) `retrieval_cycles`
- **الغرض:** طلب إحضار واحد من لحظة الطلب حتى التسليم أو الإلغاء أو إعادة الصف. إعادة الصف تبدأ دورة جديدة ولا تخلط أزمنة الدورتين في التقارير (المعمارية §6).
- **أعمدة أساسية:** `cycle_no`، `requested_at` (**مفتاح الأولوية**؛ للطلب المبكر يُحفظ الوقت الأصلي)، `request_source`، `requested_by_user_id` أو `requested_by_customer_id`، `request_reason`، `requested_early`، أوقات `assigned_at`، `assigned_waiting_at`، `started_at`، `ready_at`، `delivered_at`، `canceled_*`، `reparked_at`، الفاعلون `accepted_by`، `retrieved_by`، `delivered_by`، ثم `outcome` و`closed_at`.
- **القيود:** `uq_retrieval_cycles_open` (**طلب استرجاع نشط واحد لكل تذكرة** — ثابت §9)، `retrieval_cycles_ticket_id_cycle_no_key`، `ck_cycles_closed_outcome` (الإغلاق والنتيجة معًا)، `ck_cycles_staff_requester` (طلب الموظف له موظف وسبب)، `ck_cycles_whatsapp_requester` (طلب واتساب له عميل).
- **الكتابة/القراءة:** ضغط زر «طلب السيارة» (عبر `job.wa_process_inbound`) أو `POST /v1/tickets/{ticketId}/retrievals`، ثم القبول والبدء والجاهزية والتسليم والإلغاء (`POST /v1/retrieval-cycles/{cycleId}/cancel`) وإعادة الصف. يُقرأ في مؤشرات الأداء (`15_Event_Tracking_Plan.md`) والخط الزمني.

#### 27) `tasks`
- **الغرض:** عمل الحركة: `park` و`repark` تُنشأ مباشرة `in_progress` باسم السائق، و`retrieve` تمر بالطابور والعروض.
- **أعمدة أساسية:** `dispatch_pool_id`، `event_id`، `ticket_id`، `cycle_id`، `type`، `status` (Canon §5.4)، `priority_at` (= `requested_at` للإحضار)، `seq` (مفتاح ترتيب ثابت)، `assignee_id`، أوقات `queued_at`، `first_offered_at`، `broadcast_at`، `claimed_at`، `assigned_waiting_at`، `accepted_at`، `key_picked_up_at`، `started_at`، `completed_at`، `canceled_*`، `escalated_at`، `version`.
- **القيود:**
  - `uq_tasks_open_per_ticket` — **مهمة حركة واحدة للمركبة** (مهمة مفتوحة واحدة لكل تذكرة).
  - `uq_tasks_active_movement_driver` — **مهمة حركة نشطة واحدة للسائق** (`accepted` أو `in_progress`)؛ وتمنع أيضًا بدء استلام جديد أثناء حركة.
  - `uq_tasks_next_per_driver` — **مهمة تالية محجوزة واحدة لكل سائق** (`assigned_waiting`).
  - `ck_tasks_assignee_required` (الحالات المسندة لها مكلّف)، `ck_tasks_unassigned_in_queue` (حالات الطابور بلا مكلّف)، `ck_tasks_retrieve_has_cycle` (الإحضار له دورة)، `ck_tasks_park_repark_states` (الصف وإعادة الصف لا يدخلان الطابور)، `ck_tasks_completed_at`/`ck_tasks_canceled_at` (أوقات الإتمام والإلغاء)، `tasks_seq_key`.
  - الفهارس: `ix_tasks_pool_queue` (الطابور الأقدم أولًا لكل مجموعة)، `ix_tasks_ticket`.
- **الكتابة/القراءة:** تمريرة التوزيع، `POST /v1/task-offers/{offerId}/accept`، `.../key-pickup`، `.../start-retrieval`، `.../ready`، التسليم، `POST /v1/tasks/{taskId}/reassign`، `.../release-custody`، الإلغاء، `job.escalate_unaccepted`. يُقرأ في D-04 وS-02 والتوزيع.

#### 28) `task_offers`
- **الغرض:** جولة عرض للمهمة: فردية لسائق متاح بمهلة، أو بث لكل سائقي المناوبة في المجموعة.
- **أعمدة أساسية:** `task_id`، `mode`، `round_no`، `status` (Canon §5.5)، `reminder_at`/`reminded_at`، `expires_at` (للفردي فقط)، `closed_at`، `close_reason`، `accepted_by`، `version`.
- **القيود:** `uq_task_offers_active` (**جولة عرض نشطة واحدة للمهمة** — ثابت §9؛ البث جولة واحدة بعدة مستلمين)، `task_offers_task_id_round_no_key`، `ck_offers_single_expires` (الفردي له انتهاء)، `ck_offers_active_open` (النشطة بلا `closed_at` والعكس)، `ck_offers_accepted_by` (المقبولة لها قابل)، `ix_task_offers_pool_active`.
- **الكتابة/القراءة:** تمريرة التوزيع (إنشاء)، القبول (`accepted`)، `job.offer_expire` (`expired`)، الحجز من سائق آخر أو السحب أو التحويل (`revoked` مع `close_reason`). يُقرأ في معاملة القبول وبطاقة D-09.

#### 29) `offer_recipients`
- **الغرض:** من وصله العرض في كل جولة، ومتى وصله وشاهده وماذا فعل.
- **أعمدة أساسية:** المفتاح المركب `(offer_id, user_id)`، `duty_session_id`، `eligible_as` لحظة العرض (`accept`، `reserve_next`، `view_only`)، `notified_ws_at`، `notified_push_at`، `seen_at` (من `client.offer_seen`)، `responded_at`، `response` (`accepted` أو `rejected_late`).
- **القيود:** `offer_recipients_pkey`، `offer_recipients_eligible_as_check`، `ix_offer_recipients_user`.
- **الكتابة/القراءة:** تمريرة التوزيع (إدراج)، `job.push_send` (`notified_push_at` عند أول Push ناجح للمستلم، أولًا في معاملة النتيجة: L7 قبل L9؛ ولا يكتب `job.ws_publish` أوقات الإشعار، DEC-273)، القبول. القبول يُسمح فقط لمستلم مسجل (`NOT_OFFER_RECIPIENT`). يُقرأ في استعلام بطاقة السائق (§6.1).

### 3.ز واتساب والرموز والإشعارات

#### 30) `claim_codes`
- **الغرض:** رمز التسليم (6 أرقام) لكل دورة استرجاع (DEC-15).
- **أعمدة أساسية:** `cycle_id`، `code_hash` (HMAC-SHA256 بمفتاح `CODE_PEPPER` على `cycle_id:code`)، `code_ciphertext` (نسخة مشفرة للإرسال فقط تُمسح بعد قبول المزود أو الانتهاء)، `issued_at`، `expires_at`، `attempts`/`max_attempts`، `locked_at`، `consumed_at/by`، `revoked_at`، `revoke_reason`، `resend_no`، `sent_message_id`.
- **القيود:** `uq_claim_codes_live` (رمز حي واحد لكل دورة)، `ck_claim_attempts` (المحاولات ضمن الحد)، `ck_claim_consumed_xor_revoked` (لا يجتمع الاستهلاك والإبطال).
- **الكتابة/القراءة:** `POST /v1/tasks/{taskId}/ready` (إصدار)، `POST /v1/tickets/{ticketId}/handover-code/resend` (إبطال `resend` ثم إصدار جديد)، `POST /v1/tickets/{ticketId}/handover` (محاولة/استهلاك)، `job.claim_code_expire`، `job.wa_send` (يربط `sent_message_id` ويمسح النسخة المشفرة). لا يوجد أي مسار يقرأ الرمز للواجهة. التذكرة الورقية بلا صف هنا: محاولات كعبها تُعد من صفوف `ticket_events` (`handover.code_attempt_failed` بـ`data.cycle_id`) مقابل `handover.max_attempts` (DEC-176).

#### 31) `link_codes`
- **الغرض:** ربط محادثة العميل بالتذكرة عبر QR يفتح واتساب برسالة جاهزة فيها رمز قصير؛ المسح وحده ليس إرسالًا (المعمارية §4د).
- **أعمدة أساسية:** `code` (6 رموز من أبجدية بلا التباس `^[A-HJ-NP-Z2-9]{6}$`)، `status` (Canon §5.7)، `created_by`، `expires_at`، `inbound_message_id`، `inbound_wa_id`، `inbound_user_id` (BSUID حين يُخفي المرسل رقمه، DEC-35)، `inbound_phone_e164`، `confirmed_by/at`.
- **القيود:** `link_codes_code_check`، `uq_link_codes_live_code` (لا يتكرر رمز حي)، `uq_link_codes_live_ticket` (رمز حي واحد للتذكرة؛ يُبطل القديم قبل إصدار جديد)، وقيمة `revoke_reason` من `driver_rejected_match` أو `regenerated` أو `linked_direct` أو `ticket_voided` أو `channel_paper`؛ ولا قيمة لتغيير الجوال فيبطل رموزه الحية بـ`linked_direct` (DEC-201)، وكذلك رسالة رمز لتذكرة رُبطت في الأثناء (DEC-197).
- **الكتابة/القراءة:** `POST /v1/tickets/{ticketId}/whatsapp-link` بطريقة QR، المعالجة الواردة (`pending_confirmation`)، `.../whatsapp-link/confirm` (`consumed`)، `PATCH /v1/tickets/{ticketId}/customer-phone` (`revoked`)، `job.link_code_expire`. يُقرأ في D-07.

#### 32) `action_tokens`
- **الغرض:** قيمة `payload` المعتمة لزر «طلب السيارة» في W-01؛ تربط الزر بالعميل والتذكرة وإصدار الربط.
- **أعمدة أساسية:** `ticket_id`، `customer_id`، `action` (`request_retrieval`)، `token_hash` (sha256 لرمز عشوائي 128 بت؛ الرمز نفسه لا يُخزن)، `link_version`، `expires_at`، `revoked_at`، `last_used_at`، `use_count`.
- **القيود:** `action_tokens_token_hash_key`، `ix_action_tokens_ticket`.
- **الكتابة/القراءة:** إرسال W-01 (إنشاء)، ضغط الزر (`last_used_at`، `use_count`)، تغيير الجوال (`link_version` في التذكرة يزيد فيُرفض كل رمز أقدم، مع ضبط `revoked_at`). يُقرأ في معالجة الزر: البحث ببصمة الحمولة، ثم مطابقة `wa_id` المرسل مع العميل، وحالة التذكرة، و`link_version`.

#### 33) `whatsapp_channel`
- **الغرض:** إعداد رقم «مصاف» المركزي الوحيد. يخزن **مراجع** الأسرار فقط (`access_token_secret_ref` وغيرها)، لا الأسرار.
- **أعمدة أساسية:** `display_name` (`مصاف`)، `business_account_id`، `phone_number_id`، `api_version`، `mode` (`live`/`simulator`)، `is_active`، `health_status`، `quality_rating`، `messaging_limit_tier`.
- **القيود:** `uq_whatsapp_channel_active` (**قناة فعالة واحدة** — لا أرقام لكل قاعة)، `whatsapp_channel_mode_check`، `whatsapp_channel_health_status_check`.
- **الكتابة/القراءة:** `PUT /v1/admin/whatsapp/channel` (المالك)، مراقبة الصحة. يُقرأ في `job.wa_send` وتحقق Webhook.

#### 34) `whatsapp_templates`
- **الغرض:** القوالب W-01…W-08 وحالة اعتمادها لدى Meta.
- **أعمدة أساسية:** `name` (مثل `masaf_ticket_issued_v1`)، `language` (`ar`)، `category` (`UTILITY`)، `status`، `components`، `meta_template_id`، `rejection_reason`، `last_synced_at`.
- **القيود:** `whatsapp_templates_org_id_name_language_key`، `whatsapp_templates_name_check`.
- **الكتابة/القراءة:** `POST /v1/admin/whatsapp/templates/sync`. يُقرأ في `job.wa_send` (`WA_TEMPLATE_NOT_APPROVED`).

#### 35) `whatsapp_messages`
- **الغرض:** كل رسالة صادرة أو واردة وحالتها لدى المزود، بمحتوى منقّح.
- **أعمدة أساسية:** `direction`، `wa_message_id` (wamid)، `notification_id`، `customer_id`، `recipient_wa_id`/`sender_wa_id`، `recipient_user_id`/`sender_user_id` (BSUID، DEC-35)، `ticket_id`، `venue_id`، `event_id`، `kind`، `template_name`، `purpose` (W-xx)، `body_redacted` (الرمز مقنّع)، `payload_redacted`، `button_payload_hash`، `status` و`status_rank`، `error_*`، `pricing_category`، `billable`، `ordering_key` (= التذكرة لترتيب رسائلها)، أوقات كل حالة.
- **القيود:** `uq_whatsapp_messages_wamid` (**معرّف الرسالة فريد** — ثابت §9؛ يحمي من تكرار Webhook)، `ck_wa_messages_direction_status` (الوارد حالته `received` فقط والعكس)، `ix_whatsapp_messages_ticket`، `ix_whatsapp_messages_customer`، `ix_whatsapp_messages_failed`؛ و`ix_whatsapp_messages_accepted` (جزئي على الصادر الذي قبله المزود `(org_id, queued_at)` لعدّادي حصص واتساب في `SystemMonitor`، 12 §13؛ الترحيل `0005` بـ`CREATE INDEX CONCURRENTLY` (§9.2 القاعدة 5)، DEC-413، DEC-415).
- **الكتابة/القراءة:** `job.wa_send` (صادر)، `job.wa_process_inbound` (وارد وحالات). تحديث الحالة لا يخفض الرتبة أبدًا (§5.8). يُقرأ في S-03 و`GET /v1/reports/messages` وقائمة الرسائل الفاشلة في S-02.

#### 36) `whatsapp_inbound_events`
- **الغرض:** الطلبات الخام الواردة للـWebhook بعد التحقق من التوقيع، تُحفظ **قبل** رد 200 (المعمارية §10).
- **أعمدة أساسية:** `received_at`، `signature_verified_at`، `body_sha256`، `raw_body`، `status`، `attempts`، `processed_at`، `last_error`.
- **القيود:** `whatsapp_inbound_events_body_sha256_key` (تجاهل التسليم المكرر حرفيًا)، `ix_whatsapp_inbound_pending`؛ و`ix_whatsapp_inbound_org_received` `(org_id, received_at)` لآخر Webhook للمؤسسة (فحص `wa_webhook_silent` ومقياس `point_wa_webhook_last_received_timestamp_seconds`؛ الترحيل `0006` بـ`CREATE INDEX CONCURRENTLY`، DEC-415، DEC-417). الطلب الذي يفشل توقيعه يُرفض ولا يُخزن.
- **الكتابة/القراءة:** `POST /webhooks/whatsapp` ثم `job.wa_process_inbound`. لا يُعرض في أي واجهة؛ للمعالجة وإعادة المعالجة والتشخيص فقط.

#### 37) `notifications`
- **الغرض:** كل إشعار مقصود لمستلم على قناة (`whatsapp` للعميل، `push` لجهاز موظف)، مع نتيجته.
- **أعمدة أساسية:** `channel`، `purpose`، `recipient_customer_id`/`recipient_user_id`/`recipient_device_id`، `venue_id`، `ticket_id`، `task_id`، `source_outbox_id`، `dedupe_key`، `status`، `skipped_reason` (`superseded`، `opted_out`، `no_consent`، `channel_down`، `stale`، `no_subscription`)، `attempts`، `next_attempt_at`، `last_error_*`، `sent_at`، `failed_at`.
- **القيود:** `notifications_dedupe_key_key`، `ck_notifications_recipient` (المستلم يناسب القناة)، `ix_notifications_failed`.
- **الكتابة/القراءة:** الإدراج داخل معاملة الأمر (`NotificationPlanner` للعميل، DEC-41، ومخطِّط Push للموظفين)، والنتيجة من مستهلكي Outbox (`job.wa_send`، `job.push_send`)؛ و`id` UUIDv7 من الخلفية فتحفظ صفوف اللحظة الواحدة ترتيبها (DEC-273). يُقرأ في S-02 (الرسائل الفاشلة) والتقارير.

#### 38) `notification_attempts`
- **الغرض:** سجل كل محاولة إرسال ورد المزود.
- **أعمدة أساسية:** `attempt_no`، `started_at`، `finished_at`، `outcome` (`success`/`retryable_error`/`permanent_error`)، `http_status`، `provider_error_code`، `provider_error_message`.
- **القيود:** `notification_attempts_notification_id_attempt_no_key`، `notification_attempts_attempt_no_check`.
- **الكتابة/القراءة:** المرسِلون. يُقرأ في التشخيص وتقارير الرسائل.

### 3.ح المال والوقائع والتنبيهات والنظام

#### 39) `payments`
- **الغرض:** تحصيل نقدي أو بنقاط بيع خارجية عند التسليم؛ لا بيانات بطاقات إطلاقًا (المعمارية §1).
- **أعمدة أساسية:** `ticket_id`، `cycle_id`، `method`، `amount_halalas`، `currency`، `pos_reference` (رقم إيصال الجهاز فقط)، `collected_by/at`، `status` (`recorded`/`reversed`)، `reversed_*`، `reversal_reason`، `cash_handover_id`.
- **القيود:** `uq_payments_ticket_recorded` (تحصيل غير معكوس واحد لكل تذكرة)، `ck_payments_reversal_fields` (العكس له وقت وسبب)، `ck_payments_no_pan` (يرفض أي سلسلة من 13 رقمًا متتاليًا أو أكثر تشبه رقم بطاقة؛ أطوال أرقام البطاقات 13–19، ويزيل الخادم المسافات والشرطات أولًا)، `payments_amount_halalas_check`، `payments_currency_check`، `ix_payments_event_driver`.
- **الكتابة/القراءة:** التسليم أو `POST /v1/tickets/{ticketId}/payments`، `POST /v1/payments/{paymentId}/reverse`، ربط `cash_handover_id` عند تسليم النقد. يُقرأ في التسوية (§6.6) وموانع الإغلاق والتقارير. التفاصيل في `13_Payments_Settlement_Spec.md`.

#### 40) `cash_handovers`
- **الغرض:** تسليم السائق نقده للمشرف مع المبلغ المتوقع والفرق.
- **أعمدة أساسية:** `driver_id`، `received_by`، `amount_halalas`، `expected_halalas`، `difference_halalas` (عمود مولّد)، `note`، `handed_at`.
- **القيود:** `ck_cash_handover_distinct_people` (المسلّم غير المستلم)، `cash_handovers_amount_halalas_check`، `cash_handovers_expected_halalas_check`.
- **الكتابة/القراءة:** `POST /v1/cash-handovers`. يُقرأ في `GET /v1/events/{eventId}/settlement` وS-10.

#### 41) `incidents`
- **الغرض:** وقائع داخلية يعالجها المشرف (مفتاح، ضرر، غياب، تحقق يدوي، تذكرة مفقودة، فرق تحصيل...). ليست ميزة للعميل.
- **أعمدة أساسية:** `type`، `status`، `severity`، `description`، `opened_by`، `owner_id`، `resolution`، `resolved_by/at`، `closed_at`، `version`.
- **القيود:** `ck_incidents_resolution` (الحل والإغلاق يتطلبان وصف الحل ووقته)، `ix_incidents_open`.
- **الكتابة/القراءة:** `POST /v1/incidents`، `PATCH /v1/incidents/{incidentId}`. يُقرأ في S-12، وفي الحجز القانوني للاحتفاظ (§8.2).

#### 42) `alerts`
- **الغرض:** تنبيهات آلية للمشرف (طلب غير مقبول، غياب سائقين، فشل رسالة، قناة متعطلة...).
- **أعمدة أساسية:** `type` و`severity` (Canon §5.7)، `status`، `dedupe_key` (مثل `request_unaccepted:<task_id>`)، `details`، `raised_at`، `acknowledged_*`، `resolved_*` (`resolved_by` فارغ عند الحل الآلي)، `resolution_note`.
- **القيود:** `uq_alerts_live_dedupe` على `(venue_id, dedupe_key)` (تنبيه حي واحد لكل موقع ومفتاح، DEC-46؛ الإدراج upsert يحدّث تفاصيل التنبيه الحي: `ON CONFLICT (venue_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL DO UPDATE SET details = EXCLUDED.details`)، `ix_alerts_venue_live`؛ و`ix_alerts_manual_resolved` (جزئي على المحلول يدويًا `(org_id, dedupe_key, resolved_at) WHERE status = 'resolved' AND resolved_by IS NOT NULL` ليبقى حل المشرف لتنبيه حصة واتساب نافذًا لشهره أو لنافذته دون مسح الجدول، 12 §13؛ الترحيل `0007`، DEC-412، DEC-415). أنواع التنبيه التي تمس أكثر من موقع (`wa_channel_down`، `outbox_lag`، `wa_webhook_silent`، `transfer_blocked`) تُنشئ صفًا لكل موقع متأثر فيه حفل مفتوح أو قيد الإغلاق (`transfer_blocked`: الموقعان)، ويصل لمشرفي الموقع وللإدارة أيضًا.
- **الكتابة/القراءة:** المؤقتات والمهام (`job.escalate_unaccepted`، `job.next_task_wait_check`، `job.ready_uncollected_check`، فشل الإرسال)، `POST /v1/alerts/{alertId}/acknowledge|resolve`، الحل الآلي عند زوال السبب. يُقرأ في S-02/S-04 وحدث `alert.raised`.

#### 43) `outbox_events`
- **الغرض:** الأحداث والمهام المؤجلة والمؤقتات بشكل دائم؛ مصدر عمل العامل (DEC-07). كل مؤقت يحمل `aggregate_version` ويُعاد التحقق منه عند التنفيذ.
- **أعمدة أساسية:** `type` (Canon §7.1 أو §7.2)، `aggregate_type/id/version`، `venue_id`، `seq` (ترتيب ثابت مستقل عن الالتزام)، `ordering_key` (`'wa:<ticket_id>'` لمهام `job.wa_send` فقط؛ `NULL` لأحداث النطاق ولـ`job.push_send` الذي يكتفي بالدمج، DEC-41)، `dedupe_key`، `payload` (بلا أسرار — DEC-38)، `available_at`، `status`، `attempts`/`max_attempts`، `locked_by`/`locked_until` (التأجير)، `last_error`، `processed_at`.
- **الحالات:** `pending` ← `processing` ← `done`؛ عند خطأ قابل لإعادة المحاولة يعود `pending` بتأخير متزايد؛ عند استنفاد المحاولات `dead`؛ عند خطأ دائم لا يُعاد `failed`؛ `canceled` لما لم يعد مطلوبًا (ومنه الإعادة الإدارية لمهمة قديمة أو مكررة، DEC-150).
- **القيود:** `uq_outbox_dedupe_pending` (دمج المهام المكررة المعلّقة، مثل تمريرة توزيع واحدة لكل مجموعة)، `ck_outbox_processing_lease` (المؤجَّر له مالك ومدة)، `ix_outbox_due`، `ix_outbox_lease`، `ix_outbox_ordering`؛ و`ix_outbox_failed_dead` (جزئي على `failed`/`dead` للمراقب ولقائمة الإدارة؛ الترحيل `0004`، DEC-153).
- **الكتابة/القراءة:** كل معاملة أمر (إدراج)، العامل (تأجير وإتمام)، `GET /v1/admin/outbox` و`POST /v1/admin/outbox/{outboxId}/retry`. الأنماط في §5.5–§5.6.

#### 44) `idempotency_keys`
- **الغرض:** منع تكرار الأوامر ونتيجتها المحفوظة، مربوطة بالمستخدم ونوع العملية وبصمة المدخلات (المعمارية §10).
- **أعمدة أساسية:** المفتاح المركب `(user_id, key)`، `operation`، `request_hash`، `status` (`in_progress`/`completed`)، `response_status`، `response_body`، `expires_at` (24 ساعة).
- **القيود:** المفتاح الأساسي، `idempotency_keys_key_check` (طول 8–128)، `ix_idempotency_expiry`.
- **الكتابة/القراءة:** كل مسار معلّم ✓ في Canon §9. النمط في §5.7.

#### 45) `audit_log`
- **الغرض:** سجل تدقيق إلحاقي لكل أمر: من فعل ماذا ولماذا ومتى ومن أين.
- **أعمدة أساسية:** `occurred_at`، `actor_type`، `actor_id`، `action` (اسم الصلاحية أو الأمر مثل `task.reassign` أو `ticket.reveal_phone`؛ ولفاعل النظام نوع المهمة: `job.wa_process_inbound` و`job.wa_send` (DEC-145)، و`job.retention_purge` (DEC-152))، `entity_type`، `entity_id`، `venue_id`، `request_id`، `ip`، `user_agent`، `reason`، `before`/`after` (فروق دنيا بلا أسرار ولا رموز ولا جوالات كاملة)، `metadata`.
- **القيود:** `ix_audit_entity`، `ix_audit_actor`، `ix_audit_time`. لا تحديث ولا حذف إلا بمهمة الاحتفاظ.
- **الكتابة/القراءة:** كل أمر في معاملته. يُقرأ في `GET /v1/admin/audit-log`.

#### 46) `analytics_events`
- **الغرض:** أحداث القياس من الخادم والعميل لمؤشرات الأداء (DEC-24)، بلا بيانات شخصية.
- **أعمدة أساسية:** `name`، `source`، `occurred_at`، `received_at`، معرّفات السياق (`venue_id`، `event_id`، `dispatch_pool_id`، `actor_role`، `actor_id`، `ticket_id`، `task_id`، `cycle_id`)، `app_version`، `properties`.
- **القيود:** `analytics_events_source_check`، `ix_analytics_name_time`، `ix_analytics_venue_time`.
- **الكتابة/القراءة:** مستهلك Outbox أو المعاملة نفسها (يحدده `15_Event_Tracking_Plan.md`)، و`POST /v1/telemetry`. يُقرأ في التقارير.

#### 47) `exports`
- **الغرض:** ملفات تصدير مؤقتة (CSV) تُنشأ بمهمة وتُحذف بعد انتهائها.
- **أعمدة أساسية:** `requested_by`، `kind`، `filters`، `status`، `storage_key`، `row_count`، `error`، `completed_at`، `expires_at`.
- **القيود:** `exports_kind_check`، `exports_status_check`.
- **الكتابة/القراءة:** `POST /v1/exports` ثم `job.export_generate` (يرفع الملف خارج أي معاملة إلى `exports/{org_id}/{export_id}.csv` ويبقيه 24 ساعة؛ `error` عند `failed`: `requester_inactive`، `scope_revoked`، `too_many_rows` فوق 50 000 صف، `storage_unavailable`، `storage_error`؛ DEC-289)؛ `GET /v1/exports/{exportId}` لطالبه وحده. كل تصدير وكل رابط تنزيل يُسجل في `audit_log`.

### 3.ط العروض المشتقة والمشغّلات

- **`v_driver_state`:** تطبيق مرجعي لجدول Canon §5.6. يجمع المناوبة المفتوحة مع مهمة الحركة النشطة (`accepted`/`in_progress`) والمهمة التالية (`assigned_waiting`) ويعيد `driver_state` (`on_break`، `busy_with_next`، `intake_parking`، `retrieving`، `available`). من لا مناوبة مفتوحة له = `off_duty` (لا يظهر في العرض). وجود عرض فردي نشط **لا** يجعل السائق مشغولًا؛ لكنه يستبعده من عرض فردي ثانٍ (§6.3).
- **`v_pool_queue`:** طلبات الإحضار المفتوحة (`queued`/`offered`/`broadcast`) مرتبة بـ`priority_at` ثم `seq` مع جولة العرض النشطة إن وجدت. الترتيب داخل العرض غير مضمون عند ضمه أو تصفيته؛ أضف `ORDER BY priority_at, seq` دائمًا في الاستعلام المستهلك.
- **`set_updated_at()`:** مشغّل `BEFORE UPDATE` يضبط `updated_at = now()` في 22 جدولًا.

---

## 4. الثوابت ← القيد ← رمز الخطأ

### 4.1 ثوابت المعمارية §9 «قيود قاعدة البيانات»

| # | الثابت | القيد/الفهرس المنفذ | ما يعيده التطبيق إذا رفضت القاعدة |
|---|---|---|---|
| 1 | رقم تذكرة فريد لكل حفل | `tickets_event_id_display_number_key` + تخصيص العداد تحت قفل صف الحفل (§5.3) | لا يحدث في المسار السليم؛ إن حدث = عطل: `INTERNAL_ERROR` مع سجل حرج |
| 2 | معرّف الرسالة الواردة فريد | `uq_whatsapp_messages_wamid` (+ `whatsapp_inbound_events_body_sha256_key` للتكرار الحرفي) | ليس خطأ API: الـWebhook يرد 200 ويعامل الحدث كمكرر بلا أثر |
| 3أ | مهمة حركة نشطة واحدة للمركبة | `uq_tasks_open_per_ticket` | `RETRIEVAL_ALREADY_ACTIVE` لطلب الموظف؛ `INVALID_STATE_TRANSITION` لغيره |
| 3ب | مهمة حركة نشطة واحدة للسائق | `uq_tasks_active_movement_driver` | `MOVEMENT_IN_PROGRESS` (ومنه بدء الاستلام `POST /v1/tickets`؛ في القبول لا يظهر للمستخدم، 08 §5.1) |
| 4 | جولة عرض نشطة واحدة للمهمة مع عدة مستلمين في البث | `uq_task_offers_active` + المفتاح المركب `offer_recipients_pkey` | داخلي (تمريرة التوزيع تُعاد)؛ لا يصل للسائق |
| 5 | مهمة تالية محجوزة واحدة لكل سائق | `uq_tasks_next_per_driver` | `NEXT_TASK_ALREADY_RESERVED` |
| 6 | تعيين موقع نشط واحد لكل سائق | `uq_driver_assignments_active` | `ASSIGNMENT_CONFLICT` |
| 7أ | تخصيص نشط واحد لخانة المفتاح | `uq_key_alloc_slot_active` (+ `uq_key_alloc_ticket_active`) | `KEY_SLOT_OCCUPIED` (خانة واحدة للتذكرة: `INVALID_STATE_TRANSITION`) |
| 7ب | تخصيص نشط واحد للموقف المخصص | `uq_spot_alloc_spot_active` (+ `uq_spot_alloc_ticket_active`) | `PARKING_SPOT_OCCUPIED` (موقف واحد للتذكرة: `INVALID_STATE_TRANSITION`) |
| 8 | طلب استرجاع نشط واحد لكل تذكرة | `uq_retrieval_cycles_open` | `RETRIEVAL_ALREADY_ACTIVE` لطلب الموظف؛ ولضغط زر واتساب المكرر: لا خطأ، بل رد الحالة الحالية W-09 |

### 4.2 ثوابت إضافية من بقية المعمارية والقاموس

| الثابت | القيد/الفهرس | ما يعيده التطبيق |
|---|---|---|
| مناوبة مفتوحة واحدة لكل مستخدم | `uq_duty_sessions_open` | `DUTY_ALREADY_STARTED` |
| طلب نقل مفتوح واحد لكل سائق | `uq_driver_transfers_open` | `TRANSFER_ALREADY_PENDING` |
| وردية مفتوحة واحدة لكل مجموعة | `uq_shifts_open_per_pool` | `SHIFT_ALREADY_OPEN` |
| مجموعة افتراضية واحدة لكل موقع | `uq_dispatch_pools_default` | `VALIDATION_FAILED` |
| علاقة مفتاح لتذكرة مفتوحة واحدة في الموقع | `uq_tickets_key_tag_open` | `KEY_TAG_IN_USE` |
| رقم تذكرة ورقية فريد في الحفل | `uq_tickets_paper_serial` | `PAPER_SERIAL_IN_USE` |
| رمز تسليم حي واحد لكل دورة | `uq_claim_codes_live` | `VERSION_CONFLICT` (إعادة إرسال متزامنة؛ الأمر يُبطل القديم أولًا) |
| رمز ربط حي واحد للتذكرة | `uq_link_codes_live_ticket` | `VERSION_CONFLICT` (أمران متزامنان؛ الأمر يُبطل الرمز الحي السابق قبل الإنشاء) |
| قيمة رمز ربط حي فريدة | `uq_link_codes_live_code` | داخلي: توليد رمز جديد (حتى 5 مرات) ثم `INTERNAL_ERROR` |
| تحصيل غير معكوس واحد لكل تذكرة | `uq_payments_ticket_recorded` | `PAYMENT_ALREADY_RECORDED` |
| رقم واتساب إنتاج واحد | `uq_whatsapp_channel_active` | `INVALID_STATE_TRANSITION` (`reason = channel_already_active`، في `PUT /v1/admin/whatsapp/channel`) |
| تنبيه حي واحد لكل موقع وسبب | `uq_alerts_live_dedupe` (`venue_id`, `dedupe_key`) | لا خطأ: upsert يحدّث `details` للتنبيه الحي (`ON CONFLICT (venue_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL DO UPDATE`، DEC-46) |
| مهمة مؤجلة معلّقة واحدة لكل مفتاح دمج | `uq_outbox_dedupe_pending` | داخلي (`ON CONFLICT DO NOTHING`) |
| جوال/معرّف واتساب فريد للعميل | `customers_org_id_phone_e164_key` / `uq_customers_wa_id` / `uq_customers_wa_user_id` | داخلي (upsert أو الربط بالعميل القائم، DEC-35) |
| للعميل جوال أو معرّف BSUID | `ck_customers_identifier` | داخلي `INTERNAL_ERROR` |
| رمز موظف وجوال موظف فريدان | `users_org_id_employee_code_key` / `users_org_id_phone_e164_key` | `VALIDATION_FAILED` بتفاصيل الحقل |
| مرجع نقاط البيع ليس رقم بطاقة | `ck_payments_no_pan` | `VALIDATION_FAILED` (الحقل `pos_reference`) |
| الصف وإعادة الصف لا تدخل الطابور، والحالات المسندة لها مكلّف | `ck_tasks_assignee_required` … `ck_tasks_park_repark_states` | داخلي (عطل منطق) `INTERNAL_ERROR` |
| المتوقفة عهدتها في موقف | `ck_tickets_parked_holder` | داخلي `INTERNAL_ERROR` |
| الطلب الموظفي له سبب | `ck_cycles_staff_requester` | `REASON_REQUIRED` (يُفحص في الكود قبل القاعدة) |

### 4.3 ترجمة أخطاء PostgreSQL في طبقة التطبيق

- `node-postgres` يعيد `err.code` (SQLSTATE) و`err.constraint` (اسم القيد). طبقة الترجمة تبحث عن اسم القيد في جدول تحويل ثابت (المرجع الملزم `08_Error_Codes_Guide.md` §5، و§4.1–§4.2 هنا ملخص له)؛ أي قيد غير معروف = `INTERNAL_ERROR` مع سجل يحمل الاسم.
- `23505` unique_violation و`23514` check_violation و`23503` foreign_key_violation و`23502` not_null_violation: حسب اسم القيد.
- `40P01` deadlock_detected و`40001` serialization_failure: إعادة المعاملة كاملة حتى 3 مرات بتأخير عشوائي 20–80 ms (Canon §14ب؛ نادر مع ترتيب الأقفال)، ثم `SERVICE_UNAVAILABLE` (`retryable: true`).
- `55P03` lock_not_available (من `lock_timeout` = 3s): لا يُعاد على الخادم؛ إن وقع عند L0 (انتظار صف `idempotency_keys`) ← `IDEMPOTENCY_IN_PROGRESS`، وإلا ← `SERVICE_UNAVAILABLE` (`retryable: true`). `57014` query_canceled (من `statement_timeout` = 5s): `SERVICE_UNAVAILABLE` (`retryable: true`). العميل يعيد بالمفتاح نفسه `Idempotency-Key`.

---

## 5. أنماط المعاملات

العناصر بصيغة `$name` معاملات مربوطة (bound parameters). كل الأمثلة جُرّبت على PostgreSQL 16.

### 5.1 قواعد عامة

1. المعاملة قصيرة (هدف أقل من 50 ملّي ثانية)، ولا اتصال شبكي داخلها: الإرسال لواتساب والدفع والبث يتم بعد `COMMIT` عبر Outbox.
2. في بداية كل معاملة أمر: `SET LOCAL lock_timeout = '3s'; SET LOCAL statement_timeout = '5s';` (من `DATABASE_LOCK_TIMEOUT_MS` و`DATABASE_STATEMENT_TIMEOUT_MS` في 05).
3. قفل الصفوف التي سيُحدَّثها الأمر يكون `FOR NO KEY UPDATE` لا `FOR UPDATE`: لأن إدراج صف ابن له مفتاح أجنبي يأخذ `FOR KEY SHARE` على الأب، و`FOR UPDATE` يحجبه بلا داع بينما `FOR NO KEY UPDATE` يتوافق معه. هذا يمنع اختناقًا عند إدراج `ticket_events` و`custody_events` و`tasks` التي تشير إلى صفوف مقفلة.
4. مستوى العزل `READ COMMITTED` مع أقفال صريحة يكفي؛ الثوابت محمية بالقيود الفريدة لا بالعزل التسلسلي.

### 5.2 ترتيب الأقفال العام

هذا هو ترتيب Canon §14ب (DEC-27) بنصه. كل معاملة تأخذ الأقفال بهذا الترتيب، وتتخطى ما لا تحتاجه، ولا تعود إلى مستوى رقمه أصغر بعد مستوى رقمه أكبر، إلا الاستثناء الوحيد في Canon §14ب: معاملة تحمل L1 يجوز لها، بعد أقفال أمرها، أن تقفل صفوفًا إضافية من L4–L8 لنفس المجموعة لتمريرة التوزيع ولتسوية السائق بعد مهمته (`settleDriverAfterTask`). المؤقتات والعامل يلتزمون الترتيب نفسه. النمط `FOR NO KEY UPDATE` (لا يحجب فحوص المفاتيح الأجنبية للإدراجات المتزامنة)، و`FOR SHARE` حيث يكفي منع التغيير، و`FOR UPDATE SKIP LOCKED` لتأجير `outbox_events` فقط.

| المستوى | الصف | متى |
|---|---|---|
| L0 | حجز `idempotency_keys` (إدراج) | أول جملة في أي أمر معلّم ✓؛ التكرار المتزامن ينتظر هنا قبل أي قفل آخر |
| L1 | `dispatch_pools` | كل ما يمس طابور المجموعة أو توفر سائقيها: بدء الاستلام، إتمام الصف، الطلب، القبول، التسليم، الإلغاء، إعادة الإسناد، إعادة الصف، الاستراحة، المناوبة، النقل (بترتيب `id` إن تعددت المجموعات) |
| L2 | `events` | عداد أرقام التذاكر وفتح/إغلاق الحفل (`FOR NO KEY UPDATE`)؛ التحصيل وتسليم النقد (`FOR SHARE`) |
| L3 | `driver_transfers` ← `driver_assignments` ← `users` | النقل والتعيين والتعطيل فقط |
| L4 | `tasks` | أوامر المهمة؛ عند التعدد بترتيب `id`. أوامر تقدم الحركة (`key-pickup`، `start-retrieval`، `ready`) تبدأ هنا دون L1 |
| L5 | `tickets` | كل أمر على التذكرة؛ تعديل المسودة وإرسالها والصور والربط وتغيير الجوال تبدأ هنا دون L1–L4 |
| L6 | `retrieval_cycles` | أوامر الدورة |
| L7 | `task_offers` (ومستلموها) | القبول، الانتهاء، السحب |
| L8 | `duty_sessions` | بترتيب `id` عند تعدد السائقين (مثل إعادة الإسناد بين سائقين) |
| L9 | `spot_allocations` · `key_slot_allocations` · `claim_codes` · `link_codes` · `action_tokens` · `payments` · `cash_handovers` · `alerts` · `notifications` | إدراج/تحديث يحرسه فهرس فريد |
| L10 | الإلحاقيات بلا أقفال: `custody_events` · `ticket_events` · `outbox_events` · `audit_log` · `analytics_events` | آخر المعاملة، ثم تحديث `idempotency_keys` إلى `completed` |

ملاحظة: «قفل المجموعة» هو ما يجعل «بدء التسجيل يتنافس ذريًا مع قبول مهام الإحضار» (المعمارية §4ج) و«أول قبول يؤكده الخادم يفوز» (المعمارية §10) صحيحين: المعاملتان تتسلسلان على صف `dispatch_pools`. تفاصيل خطوات القبول الكاملة في `10_Dispatch_Engine_Spec.md`.

### 5.3 بدء الاستلام وتخصيص رقم التذكرة

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5s';

-- 0) حجز مفتاح التكرار (انظر §5.7)
INSERT INTO idempotency_keys (user_id, key, operation, request_hash)
VALUES ($user_id, $idem_key, 'POST /v1/tickets', $request_hash)
ON CONFLICT (user_id, key) DO NOTHING
RETURNING status;                       -- 0 صفوف = طلب مكرر: اقرأ الصف وأعد نتيجته
SAVEPOINT cmd;

-- 1) قفل المجموعة (L1) ثم صف الحفل (L2): تخصيص الرقم ولقطة الرسوم (DEC-43؛ لا نزيد version هنا)
SELECT id FROM dispatch_pools WHERE id = $pool_id FOR NO KEY UPDATE;
UPDATE events
   SET next_display_number = next_display_number + 1
 WHERE id = $event_id AND status = 'open'
RETURNING next_display_number - 1 AS display_number, pricing_mode, fee_halalas;   -- 0 صفوف = EVENT_NOT_OPEN

-- 2) أهلية السائق (لا تتغير تحت قفل المجموعة): يجب available
SELECT driver_state FROM v_driver_state WHERE user_id = $user_id;
-- لا صف (لا مناوبة) ⇒ DUTY_REQUIRED؛ on_break ⇒ DRIVER_ON_BREAK؛
-- أي مهمة حركة نشطة (accepted/in_progress من أي نوع، ومنها تالية رُقّيت) ⇒ MOVEMENT_IN_PROGRESS.
-- إن كان يحمل عرضًا فرديًا حيًا: قفل مهمته (L4) ثم الجولة (L7)، سحبها recipient_unavailable وإعادة المهمة queued (الملف 10 §7.1).

-- 3) التذكرة بلقطة الرسوم، ومهمة الصف باسم السائق (السائق يحوز المركبة والمفتاح من لحظة الاستلام)
INSERT INTO tickets (id, org_id, venue_id, event_id, dispatch_pool_id, display_number, created_by,
                     vehicle_holder_type, vehicle_holder_id, key_holder_type, key_holder_id,
                     fee_halalas, payment_status)
VALUES ($ticket_id, $org_id, $venue_id, $event_id, $pool_id, $display_number, $user_id,
        'driver', $user_id, 'driver', $user_id,
        $fee_halalas, CASE WHEN $pricing_mode = 'per_vehicle' THEN 'due' ELSE 'not_required' END);
INSERT INTO tasks (id, org_id, venue_id, dispatch_pool_id, event_id, ticket_id, type, status,
                   priority_at, assignee_id, started_at)
VALUES ($task_id, $org_id, $venue_id, $pool_id, $event_id, $ticket_id, 'park', 'in_progress', now(), $user_id, now());
-- uq_tasks_active_movement_driver يرفض هنا إن كان للسائق حركة نشطة (MOVEMENT_IN_PROGRESS)

-- 4) مناوبة السائق (L8): لم يعد متاحًا
UPDATE duty_sessions SET available_since = NULL, version = version + 1
 WHERE user_id = $user_id AND status = 'on_duty'
RETURNING id AS duty_session_id, version AS duty_version;

-- 5) العهدة والخط الزمني والتدقيق وأحداث النطاق (L10)؛ أحداث النطاق بلا ordering_key (DEC-41)
INSERT INTO custody_events (org_id, venue_id, ticket_id, subject, from_holder_type, to_holder_type, to_holder_id, reason, task_id, actor_id)
VALUES ($org_id, $venue_id, $ticket_id, 'vehicle', 'customer', 'driver', $user_id, 'intake', $task_id, $user_id),
       ($org_id, $venue_id, $ticket_id, 'key',     'customer', 'driver', $user_id, 'intake', $task_id, $user_id);
INSERT INTO ticket_events (org_id, venue_id, ticket_id, type, actor_type, actor_id, ticket_version, data)
VALUES ($org_id, $venue_id, $ticket_id, 'ticket.created', 'user', $user_id, 1, '{}');
INSERT INTO audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, venue_id, request_id, ip, user_agent)
VALUES ($org_id, 'user', $user_id, 'ticket.intake', 'ticket', $ticket_id, $venue_id, $request_id, $ip, $user_agent);
INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id, payload)
VALUES ($org_id, 'ticket.created',              'ticket',       $ticket_id,       1,             $venue_id, $ticket_payload),
       ($org_id, 'task.created',                'task',         $task_id,         1,             $venue_id, $task_payload),
       ($org_id, 'custody.changed',             'ticket',       $ticket_id,       1,             $venue_id, $vehicle_custody_payload),
       ($org_id, 'custody.changed',             'ticket',       $ticket_id,       1,             $venue_id, $key_custody_payload),
       ($org_id, 'driver.availability_changed', 'duty_session', $duty_session_id, $duty_version, $venue_id, $availability_payload);

-- 6) إتمام مفتاح التكرار بالنتيجة
UPDATE idempotency_keys
   SET status = 'completed', response_status = 201, response_body = $response, completed_at = now()
 WHERE user_id = $user_id AND key = $idem_key;
COMMIT;
```

الرقم قد يُترك فارغًا إذا أُلغيت التذكرة لاحقًا (المسودة أو التسجيل الخاطئ قبل الصف: `received` أو `parking` فقط، DEC-45)؛ هذا مقبول وموثق بإلغاء التذكرة (`voided` مع السبب) لأن «لا حذف صامت». لقطة الرسوم في الخطوة 3 (DEC-43) تحقق `ck_tickets_fee_matches_payment_status` في نوعي التسعير.

### 5.4 التحديث المتفائل بالإصدار

```sql
UPDATE tickets
   SET plate_digits = $plate_digits, plate_letters_ar = $letters_ar, plate_letters_en = $letters_en,
       vehicle_make = $make, vehicle_color = $color, version = version + 1
 WHERE id = $ticket_id AND version = $expected_version AND status = 'received'
RETURNING version;
```

صفر صفوف ⇒ اقرأ الصف: إن اختلف `version` ⇒ `VERSION_CONFLICT`؛ إن اختلفت الحالة ⇒ `INVALID_STATE_TRANSITION`؛ إن لم يوجد ⇒ `TICKET_NOT_FOUND`. الإصدار الجديد يُعاد في الرد ويُرفق بأحداث `ticket.updated`.

### 5.5 Outbox في المعاملة نفسها

```sql
-- حدث نطاق: بلا ordering_key (NULL)؛ مستهلكوه لا يعتمدون الترتيب ويتحققون من aggregate_version (DEC-41)
INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id, payload)
VALUES ($org_id, 'task.claimed', 'task', $task_id, $task_version, $venue_id, $payload);

-- رسالة واتساب للعميل: يخططها NotificationPlanner داخل معاملة الأمر من أحداث نطاقها (صف notifications
-- + job.wa_send، DEC-41)، مرتبة لكل تذكرة بـ ordering_key = 'wa:<ticket_id>'. لا أسرار في Outbox: حمولة W-05
-- تحمل notification_id فقط، والمرسل يقرأ claim_codes.code_ciphertext لحظة بناء الطلب (DEC-38)
INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id,
                           ordering_key, payload)
VALUES ($org_id, 'job.wa_send', 'ticket', $ticket_id, $ticket_version, $venue_id,
        'wa:' || $ticket_id::text, jsonb_build_object('notification_id', $notification_id));

-- مؤقت: انتهاء العرض الفردي عند expires_at + dispatch.accept_grace_ms (DEC-47؛ يُعاد التحقق من status وversion عند التنفيذ)
INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, aggregate_version, venue_id,
                           dedupe_key, available_at, payload)
VALUES ($org_id, 'job.offer_expire', 'task_offer', $offer_id, 1, $venue_id,
        'offer_expire:' || $offer_id, $expires_at + make_interval(secs => $grace_ms / 1000.0), '{}');

-- تمريرة توزيع مدموجة: سطر معلّق واحد لكل مجموعة مهما تكرر الطلب
INSERT INTO outbox_events (org_id, type, aggregate_type, aggregate_id, venue_id, dedupe_key, payload)
VALUES ($org_id, 'job.dispatch_pass', 'dispatch_pool', $pool_id, $venue_id, 'dispatch_pass:' || $pool_id, '{}')
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','processing') DO NOTHING;

-- إيقاظ العامل؛ يصل الإشعار عند COMMIT فقط
SELECT pg_notify('point_outbox', $venue_id::text);
```

### 5.6 تأجير العامل بـ SKIP LOCKED

```sql
-- المطالبة بدفعة مستحقة مع احترام ترتيب ordering_key
WITH due AS (
  SELECT o.id
    FROM outbox_events o
   WHERE o.status = 'pending'
     AND o.available_at <= now()
     AND (o.ordering_key IS NULL OR NOT EXISTS (
           SELECT 1 FROM outbox_events p
            WHERE p.ordering_key = o.ordering_key
              AND p.status IN ('pending','processing')
              AND p.seq < o.seq))
   ORDER BY o.available_at, o.seq
   LIMIT 50
   FOR UPDATE SKIP LOCKED
)
UPDATE outbox_events o
   SET status = 'processing', locked_by = $worker_id,
       locked_until = now() + interval '60 seconds', attempts = o.attempts + 1
  FROM due
 WHERE o.id = due.id
RETURNING o.*;

-- نجاح
UPDATE outbox_events
   SET status = 'done', processed_at = now(), locked_by = NULL, locked_until = NULL
 WHERE id = $id AND locked_by = $worker_id;

-- خطأ قابل لإعادة المحاولة: تأخير أسي حتى 5 دقائق ثم dead
UPDATE outbox_events
   SET status       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
       available_at = now() + make_interval(secs => LEAST(300, power(2, attempts)::int)),
       last_error   = $error, locked_by = NULL, locked_until = NULL
 WHERE id = $id AND locked_by = $worker_id;

-- خطأ دائم (مثل قالب مرفوض): failed مباشرة ويظهر في قائمة الفشل
UPDATE outbox_events
   SET status = 'failed', processed_at = now(), last_error = $error, locked_by = NULL, locked_until = NULL
 WHERE id = $id AND locked_by = $worker_id;

-- استرداد التأجير المنتهي (عامل سقط): يعيده المكنّس الدوري
UPDATE outbox_events SET status = 'pending', locked_by = NULL, locked_until = NULL
 WHERE status = 'processing' AND locked_until < now();
```

ملاحظات:
- السطر السابق في نفس `ordering_key` إن كان `failed` أو `dead` لا يحجز ما بعده؛ فشل W-02 لا يمنع وصول W-05.
- الإنصاف بين المواقع: `FOR UPDATE` لا يجتمع مع دوال النافذة في المستوى نفسه (PostgreSQL يرفض ذلك). نفّذ الإنصاف على خطوتين: ترتيب مرشحين بـ`row_number() OVER (PARTITION BY venue_id ...)` في CTE بلا قفل، ثم قفل المختارين في CTE ثانٍ بـ`FOR UPDATE OF o SKIP LOCKED`. التفاصيل في `12_WhatsApp_Integration_Spec.md`.
- الترتيب داخل المعاملة الواحدة: كل سطور المعاملة تشترك في `created_at`؛ لذا يجب توليد `id` بـUUIDv7 أحادي الاتجاه، أو اعتماد عمود تسلسلي (اقتراح في §11).

### 5.7 مفاتيح منع التكرار

```sql
BEGIN;
INSERT INTO idempotency_keys (user_id, key, operation, request_hash)
VALUES ($user_id, $idem_key, $operation, $request_hash)
ON CONFLICT (user_id, key) DO NOTHING
RETURNING status;
-- صفر صفوف: SELECT operation, request_hash, status, response_status, response_body
--   FROM idempotency_keys WHERE user_id = $user_id AND key = $idem_key;
--   عملية/بصمة مختلفة            -> IDEMPOTENCY_KEY_REUSED (422)
--   status = 'completed'          -> أعد response_status/response_body كما هي
--   (المكرر المتزامن ينتظر على هذا الإدراج حتى تنتهي الأولى؛ تجاوز lock_timeout هنا عند L0 (55P03) -> IDEMPOTENCY_IN_PROGRESS (409))
SAVEPOINT cmd;
-- ... تنفيذ الأمر ...
-- عند خطأ نطاق حتمي 4xx (403/404/409/410/422/423): ROLLBACK TO SAVEPOINT cmd; ثم احفظ الخطأ كنتيجة
-- (استثناء: زيادة claim_codes.attempts وقفله وتنبيهه عند رمز تسليم خاطئ تلتزم مع رد الخطأ دون تراجع، 08 §1.3)
UPDATE idempotency_keys
   SET status = 'completed', response_status = $http_status, response_body = $body, completed_at = now()
 WHERE user_id = $user_id AND key = $idem_key;
COMMIT;
```

- لأن الحجز في المعاملة نفسها: الطلب المكرر المتزامن ينتظر على الفهرس الفريد حتى تنتهي الأولى، ثم يقرأ النتيجة المحفوظة.
- أخطاء النطاق تُحفظ نتيجةً (إعادة المفتاح نفسه تعيد الخطأ نفسه)، أما الأخطاء غير المتوقعة (5xx) فتُلغي المعاملة كلها بما فيها الحجز، فيستطيع العميل الإعادة بالمفتاح نفسه.
- البصمة `request_hash` = sha256 لتمثيل JSON مرتب للجسم + معاملات المسار.

### 5.8 تحديث حالة رسالة واتساب دون تخفيض الرتبة

```sql
-- read قبل delivered: تُطبّق الأعلى رتبة وتُتجاهل الأدنى
UPDATE whatsapp_messages
   SET status = $status, status_rank = $rank,
       sent_at      = CASE WHEN $rank >= 1 THEN coalesce(sent_at, $ts) ELSE sent_at END,
       delivered_at = CASE WHEN $rank >= 2 THEN coalesce(delivered_at, $ts) ELSE delivered_at END,
       read_at      = CASE WHEN $rank >= 3 THEN coalesce(read_at, $ts) ELSE read_at END
 WHERE wa_message_id = $wamid AND status_rank < $rank AND status NOT IN ('failed','skipped');

-- failed يغلب queued/sent فقط ولا يغلب delivered/read
UPDATE whatsapp_messages
   SET status = 'failed', failed_at = $ts, error_code = $code, error_title = $title, error_details = $details
 WHERE wa_message_id = $wamid AND status_rank <= 1 AND status <> 'failed';
```

---

## 6. استعلامات مرجعية

### 6.1 الشاشة الرئيسية للسائق (D-04)

```sql
-- (أ) الحالة المشتقة
SELECT s.driver_state, s.duty_status, s.connection_state, s.available_since,
       s.active_task_id, s.active_task_type, s.next_task_id
  FROM v_driver_state s
 WHERE s.user_id = $me;

-- (ب) بطاقتا المهمة الحالية والتالية (موضع المفتاح والموقف يظهر لأن السائق هو المكلّف)
SELECT t.id, t.type, t.status, t.version, t.key_picked_up_at,
       k.display_number, k.status AS ticket_status,
       ks.label AS key_slot_label, kb.name AS key_board_name,
       ps.label AS spot_label, z.name AS zone_name, k.current_spot_note
  FROM tasks t
  JOIN tickets k             ON k.id  = t.ticket_id
  LEFT JOIN key_slots ks     ON ks.id = k.current_key_slot_id
  LEFT JOIN key_boards kb    ON kb.id = ks.key_board_id
  LEFT JOIN parking_spots ps ON ps.id = k.current_spot_id
  LEFT JOIN parking_zones z  ON z.id  = ps.zone_id
 WHERE t.assignee_id = $me
   AND t.status IN ('accepted','in_progress','assigned_waiting')
 ORDER BY CASE WHEN t.status = 'assigned_waiting' THEN 1 ELSE 0 END;

-- (ج) بطاقة الطلب الواحدة: أقدم عرض حي وصلني (بلا موضع مفتاح ولا جوال)
SELECT q.id AS task_id, o.id AS offer_id, o.mode, o.expires_at, r.eligible_as,
       k.display_number, k.vehicle_make, k.vehicle_color, k.plate_digits,
       now() - q.priority_at AS waiting
  FROM offer_recipients r
  JOIN task_offers o ON o.id = r.offer_id AND o.status = 'active'
  JOIN tasks q       ON q.id = o.task_id  AND q.status IN ('offered','broadcast')
  JOIN tickets k     ON k.id = q.ticket_id
 WHERE r.user_id = $me
 ORDER BY q.priority_at, q.seq
 LIMIT 1;
```

زر البطاقة («قبول الطلب» أو «حجز كمهمة تالية» أو عرض فقط) يُحسب لحظة العرض من (أ)، لا من `eligible_as` المخزن.

### 6.2 طابور المجموعة (S-02)

```sql
SELECT q.task_id, q.ticket_id, q.status, q.active_offer_mode, q.offer_expires_at,
       now() - q.priority_at AS waiting
  FROM v_pool_queue q
 WHERE q.dispatch_pool_id = $pool_id
 ORDER BY q.priority_at, q.seq;
```

### 6.3 السائقون المتاحون الأطول تفرغًا

```sql
SELECT ds.id AS duty_session_id, ds.user_id, ds.available_since
  FROM duty_sessions ds
 WHERE ds.dispatch_pool_id = $pool_id
   AND ds.status = 'on_duty'
   AND ds.available_since IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tasks t
                    WHERE t.assignee_id = ds.user_id
                      AND t.status IN ('accepted','in_progress','assigned_waiting'))
   AND NOT EXISTS (SELECT 1 FROM offer_recipients r
                     JOIN task_offers o ON o.id = r.offer_id
                    WHERE r.user_id = ds.user_id AND o.status = 'active' AND o.mode = 'single')
 ORDER BY ds.available_since, ds.id;
```

يستخدم `ix_duty_sessions_pool_available`. شروط الأهلية النهائية (مثل استبعاد من انتهى عنده العرض نفسه في الجولة الحالية) يحددها `10_Dispatch_Engine_Spec.md`.

### 6.4 العهدة والمسؤوليات المفتوحة للسائق (النقل، إنهاء المناوبة، التعطيل)

```sql
SELECT 'vehicle' AS item, k.id AS ticket_id, k.display_number
  FROM tickets k
 WHERE k.vehicle_holder_type = 'driver' AND k.vehicle_holder_id = $driver_id
   AND k.status NOT IN ('delivered','voided')
UNION ALL
SELECT 'key', k.id, k.display_number
  FROM tickets k
 WHERE k.key_holder_type = 'driver' AND k.key_holder_id = $driver_id
   AND k.status NOT IN ('delivered','voided')
UNION ALL
SELECT 'task:' || t.type || ':' || t.status, t.ticket_id, k.display_number
  FROM tasks t JOIN tickets k ON k.id = t.ticket_id
 WHERE t.assignee_id = $driver_id
   AND t.status IN ('assigned_waiting','accepted','in_progress')
UNION ALL
SELECT 'cash_not_handed_over', p.ticket_id, NULL
  FROM payments p
 WHERE p.collected_by = $driver_id
   AND p.method = 'cash' AND p.status = 'recorded' AND p.cash_handover_id IS NULL;
```

قاعدة DEC-32 الواحدة: سطور `vehicle` و`key` والمهام بحالة `in_progress` (ومنها كل مهمة صف/إعادة صف نشطة) تمنع التعطيل (`CUSTODY_OPEN`) والنقل (`TRANSFER_BLOCKED_CUSTODY`) وإنهاء المشرف للمناوبة (`DUTY_END_BLOCKED_CUSTODY`) دون تجاوز. أما المهمة التالية `assigned_waiting` ومهمة الإحضار `accepted` قبل استلام المفتاح (`key_picked_up_at IS NULL`؛ بعد استلامه يظهر سطر `key`) فلا تمنع: تُعادان للطابور بأولويتهما الأصلية (`task.withdrawn`) ضمن معاملة الأمر (في النقل إلى طابور الموقع القديم، المعمارية §4أ). إنهاء السائق لمناوبته بنفسه أشد: أي سطر عهدة أو مهمة يمنعه. سطر النقد غير المسلّم يُعامل وفق `13_Payments_Settlement_Spec.md`.

### 6.5 موانع إغلاق الحفل (S-10)

```sql
SELECT
  (SELECT count(*) FROM tickets k
    WHERE k.event_id = $event_id AND k.status NOT IN ('delivered','voided'))                        AS open_tickets,
  (SELECT count(*) FROM key_slot_allocations a JOIN tickets k ON k.id = a.ticket_id
    WHERE k.event_id = $event_id AND a.released_at IS NULL)                                         AS keys_on_board,
  (SELECT count(*) FROM tickets k
    WHERE k.event_id = $event_id AND k.status NOT IN ('delivered','voided')
      AND k.key_holder_type IN ('driver','supervisor','unknown'))                                    AS keys_with_people,
  (SELECT count(*) FROM retrieval_cycles c JOIN tickets k ON k.id = c.ticket_id
    WHERE k.event_id = $event_id AND c.closed_at IS NULL)                                           AS open_requests,
  (SELECT count(*) FROM tasks t
    WHERE t.event_id = $event_id AND t.status NOT IN ('completed','canceled'))                      AS open_tasks,
  (SELECT coalesce(sum(p.amount_halalas), 0) FROM payments p
    WHERE p.event_id = $event_id AND p.method = 'cash' AND p.status = 'recorded'
      AND p.cash_handover_id IS NULL)                                                                AS cash_not_handed_over_halalas,
  (SELECT count(*) FROM tickets k
    WHERE k.event_id = $event_id AND k.status = 'delivered' AND k.payment_status = 'due')           AS delivered_but_due,
  (SELECT count(*) FROM incidents i
    WHERE i.event_id = $event_id AND i.status IN ('open','in_review'))                              AS open_incidents_info;
```

الأعمدة الستة الأولى موانع (`EVENT_CLOSE_BLOCKED` بتفاصيلها)؛ `delivered_but_due` فحص سلامة يجب أن يكون صفرًا؛ `open_incidents_info` للعرض فقط (الوقائع قد تبقى مفتوحة بعد الحفل). القائمة النهائية للشروط في `11_State_Machines_Domain_Events.md` و`13_Payments_Settlement_Spec.md`.

### 6.6 التسوية لكل سائق

```sql
SELECT p.collected_by AS driver_id, u.full_name,
       count(*) FILTER (WHERE p.method = 'cash')                                     AS cash_count,
       coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'cash'), 0)           AS cash_halalas,
       count(*) FILTER (WHERE p.method = 'pos')                                      AS pos_count,
       coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'pos'), 0)            AS pos_halalas,
       coalesce(sum(p.amount_halalas) FILTER (WHERE p.method = 'cash'
                                                AND p.cash_handover_id IS NULL), 0)  AS cash_not_handed_over_halalas
  FROM payments p
  JOIN users u ON u.id = p.collected_by
 WHERE p.event_id = $event_id AND p.status = 'recorded'
 GROUP BY p.collected_by, u.full_name
 ORDER BY u.full_name;

SELECT h.driver_id,
       sum(h.amount_halalas)     AS handed_halalas,
       sum(h.expected_halalas)   AS expected_halalas,
       sum(h.difference_halalas) AS difference_halalas
  FROM cash_handovers h
 WHERE h.event_id = $event_id
 GROUP BY h.driver_id;
```

---

## 7. تصنيف البيانات والخصوصية

### 7.1 المستويات

| المستوى | المعنى | المعاملة |
|---|---|---|
| عام | يجوز أن يراه العميل أو يُنشر | — |
| داخلي | تشغيلي بلا بيانات شخصية | متاح للموظفين حسب الدور |
| سري | بيانات شخصية أو حساسة تشغيليًا | أقل قدر ممكن، إخفاء، تدقيق عند الكشف، لا يدخل السجلات والتحليلات |
| أسرار | مفاتيح وبصمات ورموز | لا يُعرض ولا يُسجل ولا يُصدّر أبدًا |

### 7.2 تصنيف مجموعات الأعمدة

| المجموعة | أمثلة | المستوى |
|---|---|---|
| العلامة والمواقع | `venues.name_ar`، `venues.code`، نصوص القوالب | عام |
| الحالات والأوقات والمعرّفات والإعدادات | `*.status`، `*_at`، `tasks.*`، `task_offers.*`، `settings` | داخلي |
| بيانات العميل | `customers.phone_e164`، `customers.wa_id`، `customers.wa_user_id`، `link_codes.inbound_phone_e164`، `link_codes.inbound_wa_id`، `link_codes.inbound_user_id`، `whatsapp_messages.recipient_wa_id/sender_wa_id`، `whatsapp_messages.recipient_user_id/sender_user_id` | سري |
| بيانات المركبة | `tickets.plate_*`، `vehicle_*`، `notes`، `paper_serial`، `media_assets` (الصور)، `vehicle_inspections.notes/damage_marks` | سري |
| موضع المركبة والمفتاح | `tickets.current_key_slot_id`، `current_spot_id`، `current_spot_note`، `key_tag`، `key_slots.label` حين يرتبط بتذكرة | سري (أمني) |
| محتوى الرسائل | `whatsapp_messages.body_redacted/payload_redacted`، `whatsapp_inbound_events.raw_body` (يحوي الجوال واسم الملف الشخصي ونص العميل) | سري |
| بيانات الموظفين | `users.full_name`، `users.phone_e164`، `auth_sessions.ip/user_agent`، `audit_log.ip/user_agent` | سري |
| بيانات الحفل | `events.host_name`، `events.name_ar` (قد يحوي اسم عائلة) | سري |
| المال والوقائع | `payments.*`، `cash_handovers.*`، `incidents.description` | سري |
| الأسرار | `users.secret_hash`، `users.mfa_secret_enc`، `auth_sessions.token_hash`، `action_tokens.token_hash`، `claim_codes.code_hash/code_ciphertext`، `devices.push_p256dh/push_auth` | أسرار |

لا يُستخرج اسم ملف العميل الشخصي في واتساب (`contacts[].profile.name`) ولا يُخزن خارج `raw_body`.

### 7.3 قواعد الإخفاء والعرض

- الجوال يُعرض `05•••••123`؛ الكامل فقط عبر `POST /v1/tickets/{ticketId}/reveal-phone` بسبب وتدقيق، ويُفك في ذاكرة العامل لحظة الإرسال فقط.
- `wa_id` و`wa_user_id` (BSUID) لا يُعرضان في أي واجهة.
- اللوحة تُعرض لموظفي الموقع لأنها حاجة تشغيلية للبحث والتسليم، ولا تدخل الإشعارات ولا التحليلات ولا السجلات التقنية.
- خانة المفتاح والموقف تظهر لمن يملك `ticket.read_full` على التذكرة فقط (Canon §10): السائق المكلّف بمهمة مفتوحة عليها أو منشئها أثناء التسجيل، ومشرف الموقع، والإدارة والمالك؛ ولا تدخل `TicketSummary`.
- رمز التسليم لا يُعرض إطلاقًا؛ `body_redacted` يحمله مقنّعًا (`******`).
- الصور عبر روابط موقّعة قصيرة العمر (مدتها في `09_RBAC_Permissions_Matrix.md`)؛ الرابط الموقّع نفسه رمز وصول ولا يُسجل.
- التصدير الذي يحوي لوحات (نوع `tickets`) متاح بالصلاحية `export.create` فقط ويُسجل في `audit_log`.

### 7.4 ما لا يدخل أبدًا

| الوجهة | ممنوع |
|---|---|
| السجلات التقنية (logs) | كوكي الجلسة، رموز الأزرار، رموز الربط، رموز التسليم، مفاتيح الدفع، الروابط الموقّعة، `raw_body`، أجسام ردود `idempotency_keys`، الجوال الكامل و`wa_id` و`wa_user_id` (يُسجل المعرّف الداخلي أو آخر 3 أرقام)، اللوحات، نص الرسائل |
| التحليلات (`analytics_events`) | الجوال، `wa_id`، `wa_user_id`، اللوحة، الأسماء، النصوص الحرة، مواضع المفتاح والموقف، الرموز، IP و`user_agent` (يكفي `app_version`) |
| إشعارات Web Push | الجوال، اللوحة، اسم العميل، موضع المفتاح أو الموقف، رمز التسليم؛ المسموح رقم التذكرة الظاهر والمعرّفات فقط (DEC-23) |
| `ticket_events.data` و`audit_log.before/after` | الأسرار والرموز والجوال الكامل؛ تُكتب المعرّفات والقيم المحدودة والفروق الدنيا |

---

## 8. الاحتفاظ والحذف

القيم من Canon §12 مقترحة **بانتظار اعتماد المالك (Q-06)**. القيم «التقنية» أدناه افتراضات تنفيذية تُعتمد ضمن Q-06 أيضًا.

### 8.1 جدول الاحتفاظ

| الجدول | القاعدة | المدة |
|---|---|---|
| `media_assets` + كائنات التخزين | حذف الكائن وتحويل السطر إلى `upload_status = 'deleted'` و`delete_reason = 'retention'` (يبقى السطر شاهدًا) | `retention.photos_days` (90 يومًا) من إغلاق التذكرة |
| `media_assets` بحالة `pending` | تحويل السطر إلى `upload_status = 'failed'` (رفع لم يكتمل أو إتمام مرفوض ترك السطر `pending`، DEC-101)؛ والأصل في `incoming/` تحذفه قاعدة دورة حياة الدلو (DEC-97) | تقني: أقدم من مدة رابط الرفع `MEDIA_UPLOAD_URL_TTL_S` + 3,600 ثانية هامشًا منذ إنشاء السطر (DEC-162) |
| `whatsapp_messages` | تنقيح: تفريغ `body_redacted` و`payload_redacted` و`recipient_wa_id`/`sender_wa_id` و`recipient_user_id`/`sender_user_id`؛ يبقى الهيكل (المعرّفات والحالات والأوقات) | `retention.wa_messages_days` (180 يومًا)؛ الهيكل يُحذف مع حذف العميل |
| `whatsapp_inbound_events` | تفريغ `raw_body` بعد المعالجة، ثم حذف السطر | `retention.wa_raw_days` (7 أيام) للتفريغ، و`retention.wa_messages_days` للحذف |
| `notifications` · `notification_attempts` | حذف | `retention.wa_messages_days` |
| `claim_codes` | `code_ciphertext` (النسخة المشفرة الوحيدة، DEC-38) يُمسح فورًا بعد قبول المزود أو الانتهاء (DEC-15)؛ السطر يُحذف مع إخفاء هوية التذكرة | — / `retention.tickets_months` |
| `action_tokens` | حذف | تقني: 30 يومًا بعد `expires_at` أو `revoked_at` |
| `link_codes` | حذف | تقني: 7 أيام بعد `expires_at` |
| `idempotency_keys` | حذف | بعد `expires_at` (24 ساعة) |
| `auth_sessions` | حذف | تقني: 30 يومًا بعد الانتهاء أو الإبطال |
| `outbox_events` | حذف `done`/`canceled`؛ و`failed`/`dead` بعد مراجعتها | تقني: 14 يومًا / 90 يومًا |
| `tickets` وتوابعها (`ticket_events`، `custody_events`، `retrieval_cycles`، `tasks`، `task_offers`، `offer_recipients`، `spot_allocations`، `key_slot_allocations`، `vehicle_inspections`) | **إخفاء هوية** لا حذف: تفريغ `plate_*`، `vehicle_*`، `notes`، `key_tag`، `current_spot_note`، `custody_events.note`، `vehicle_inspections.notes/damage_marks`، و`tickets.customer_id`؛ يبقى `paper_serial` (يشترطه `ck_tickets_paper_serial` للتذكرة الورقية غير الملغاة، DEC-155)؛ يبقى الهيكل للإحصاء والمال | `retention.tickets_months` (36 شهرًا) من الإغلاق |
| `customers` · `customer_consents` | لا حذف في الإصدار الأول (DEC-155): دورات واتساب تحتفظ بـ`requested_by_customer_id` (`ck_cycles_whatsapp_requester`)، وصف العميل يحتاج معرّفه (`ck_customers_identifier`)؛ حذف العميل الذي ليست له تذكرة أحدث من المدة (بعد حذف رموزه وموافقاته وهياكل رسائله وإشعاراته) يحتاج قاعدة خاصة به | — (`retention.tickets_months` حين تُعتمد القاعدة) |
| `payments` · `cash_handovers` | لا تُحذف مع التذاكر؛ مدتها حسب سياسة السجلات المالية (Q-05/Q-06)؛ التذاكر المرتبطة تبقى هياكل مخفية الهوية | يحددها المالك مع المحاسب |
| `incidents` | تتبع التذكرة؛ المفتوحة حجز قانوني (§8.2) | `retention.tickets_months` |
| `alerts` | حذف المحلولة | تقني: 12 شهرًا |
| `audit_log` | حذف | `retention.audit_months` (60 شهرًا) |
| `analytics_events` | بلا بيانات شخصية؛ حذف | `retention.analytics_months` (24 شهرًا) |
| `exports` | حذف الملف عند `expires_at` وتحويل السطر `expired`؛ حذف السطر لاحقًا | تقني: 24 ساعة للملف، 90 يومًا للسطر |
| `users` · `driver_assignments` · `role_scopes` | لا تُحذف (معرّف دائم وسجل تاريخي)؛ الأجهزة الملغاة منذ 12 شهرًا تُفرَّغ مفاتيح دفعها | — |

### 8.2 الحجز القانوني

- أي تذكرة لها واقعة بحالة `open` أو `in_review`، أو لحفلها واقعة بلا تذكرة بهذه الحالة (مثل `payment_discrepancy` لفرق تسليم النقد؛ نزاعات التحصيل وقائع)، تُستثنى من كل خطوات الحذف والتنقيح وإخفاء الهوية بكل صفوفها: الصور والرسائل والإشعارات ورموز الإجراء ورموز الربط وبياناتها (DEC-156).
- عند حل الواقعة تبدأ مدة الاحتفاظ لتلك التذكرة من `max(وقت إغلاق التذكرة، incidents.resolved_at)`، أي من آخر حل لواقعة كهذه إن تأخر عن الإغلاق.
- تذاكر حفل ليس `closed` لا تُمس أبدًا (DEC-156).
- لحجز يدوي بلا واقعة تشغيلية، يفتح المشرف واقعة من نوع `other` بوصف «حجز».

### 8.3 تنفيذ مهمة الاحتفاظ

- `job.retention_purge` صف واحد يوميًا لكل المؤسسات عند `RETENTION_PURGE_CRON_UTC` (02:00 UTC = 05:00 بتوقيت `Asia/Riyadh`، خارج وقت الذروة وبعيدًا عن ليالي الحفلات) بمفتاح `retention:<date>`، وداخله تشغيل لكل مؤسسة؛ تُعاد جدولته بعد كل تشغيل فعلي ويُنشئه المراقب إن غاب (DEC-161).
- دفعات صغيرة (1000 سطر لكل معاملة؛ 10,000 للتحليلات) بدور قاعدة البيانات `point_retention` (الترحيل `0004_retention_role.sql`: عضو في `point_app`، مع `DELETE` على الجداول القابلة للحذف فقط و`UPDATE (note)` على `custody_events`) تأخذه المهمة بـ`SET LOCAL ROLE`، وتمنح كل بيئة دور دخول العامل عضويته بلا وراثة: `GRANT point_retention TO point_worker WITH INHERIT FALSE, SET TRUE` (المنح العادي يورّث العامل `DELETE` على `audit_log` و`analytics_events` في كل معاملاته)؛ والأدوار في `infra/db/bootstrap-roles.sql`: `point_owner` يملك الكائنات ويشغّل الترحيلات، و`point_api` و`point_worker` عضوان في `point_app`، ومجموعتا `point_app` و`point_retention` تُنشآن قبل أول ترحيل مع `ADMIN OPTION` للمالك؛ وكل ترحيل يضيف جدولًا يمنح `point_app` صراحة (DEC-153، DEC-301؛ تعليق القسم 17 في `06_schema.sql` أمثلة فقط ولا يتغير).
- تكتب سطر `audit_log` لكل دفعة بالفعل `job.retention_purge` (`entity_type` = الجدول، ومعرّف التشغيل والخطوة والأعداد والكائنات المحذوفة والفاشلة) وسطر ملخص لكل تشغيل (`entity_type = organization`، السياسة وكل خطوة)، ولها وضع تجربة (dry-run) يكتب الملخص وحده، وقياسات للعدد والزمن (DEC-152).
- المرشحون يُقرؤون خارج أي معاملة، وتُحذف كائنات التخزين دون معاملة مفتوحة، ثم تُعلَّم في معاملة قصيرة الصفوف التي زالت كائناتها فقط، ويُعاد ما فشل حذفه في التشغيل التالي؛ وبلا حاذف كائنات مسجل تُتخطى الخطوة ويُبلَّغ بها (`no_object_deleter`)؛ والحجز (§8.2) يُفحص عند اختيار المرشحين فقط، فالكائن المحذوف فعلًا يُعلَّم دائمًا (DEC-151).

---

## 9. سياسة الترحيلات والبيانات الأولية

### 9.1 Drizzle والمرجع

- `06_schema.sql` هو المرجع؛ مخطط Drizzle في `packages/db` مرآة نوعية له لكتابة الاستعلامات.
- الترحيل الأول `0001_init` = محتوى `06_schema.sql` حرفيًا كترحيل SQL يدوي (ملف ترحيل مخصص من drizzle-kit، مثل `drizzle-kit generate --custom`؛ يُتحقق من الأمر في وثائق الإصدار المستخدم). لا يُعدَّل بعد تسليمه: كل تصحيح لاحق لـ`06_schema.sql` يُشحن ترحيلًا جديدًا (مثل `0003_fix_wa_template_name_check.sql`)، واختبار الترحيلات لا يقبل بين الاثنين إلا التصحيحات الموثقة (DEC-129).
- كل بنية لا يعبّر عنها Drizzle بدقة في الإصدار المستخدم (فهرس جزئي بشرط `WHERE`، `CHECK`، عمود مولّد، عرض، مشغّل، دالة) تُكتب في ترحيل SQL يدوي. لا يُعتمد على توليد آلي قد يُسقط شرط فهرس جزئي.

### 9.2 قواعد الترحيل

1. **لا يُحذف ولا يُرخى أي قيد ثابت** من §4 (كل `uq_*` وفحوص `ck_tasks_*` و`ck_tickets_*`...) إلا بقرار `D-##` جديد في `DECISIONS.md` وتحديث `06_schema_invariants_test.sql` في الطلب نفسه.
2. **توسيع ثم تقليص (expand/contract):** عمود جديد يُضاف قابلًا للفراغ ← تعبئة بدفعات ← نشر كود يكتبه ← فرض `NOT NULL`. إزالة عمود: إيقاف الكتابة ← نشر ← حذف في إصدار لاحق.
3. **قيم الحالات:** توسيع `CHECK` بالقيمة الجديدة في ترحيل يسبق نشر الكود الذي يكتبها؛ إزالة قيمة بعد ترحيل البيانات فقط. وتُحدَّث Canon §5 أولًا.
4. **أسماء صريحة** لكل قيد وفهرس جديد (`ck_`، `uq_`، `ix_`، `fk_`)؛ والقيود الحالية ذات الأسماء الآلية تُعاد تسميتها في ترحيل مبكر (§11).
5. الفهارس على الجداول الكبيرة لاحقًا بـ`CREATE INDEX CONCURRENTLY` في ترحيل خارج معاملة.
6. ترحيلات البيانات منفصلة عن ترحيلات البنية، والتعبئة الطويلة بمهمة على دفعات لا داخل الترحيل.
7. تُشغّل الترحيلات مرة واحدة لكل نشر بمهمة مخصصة قبل بدء الإصدار الجديد (`05_Tech_Stack_Environment.md`)، والإصلاح بترحيل لاحق لا بالتراجع.

### 9.3 حارس التطابق في CI

1. تطبيق كل الترحيلات على PostgreSQL 16 فارغة ثم تشغيل `06_schema_invariants_test.sql` عليها: يجب `ALL INVARIANT TESTS PASSED`.
2. مقارنة لقطة الكتالوج (الجداول والأعمدة وأنواعها والقيود و`pg_get_indexdef` للفهارس بشروطها، والعروض والدوال والمشغّلات) بين قاعدة الترحيلات وقاعدة محمّلة من `06_schema.sql`: يفشل البناء إن **نقص** من قاعدة الترحيلات كائن يعرّفه `06_schema.sql` أو اختلف تعريفه، ما لم يُحدَّث `06_schema.sql` في الطلب نفسه؛ أما الكائنات **الزائدة** التي تضيفها ترحيلات لاحقة (مثل فهرس `ix_outbox_failed_dead` في الترحيل `0004`، DEC-153) فمسموحة ولا يطبعها الفحص (يطبع الناقص عند الفشل وحده)؛ والأدوار والمنح (مثل `point_retention`) خارج اللقطة أصلًا (DEC-364).
3. اختبار يتأكد من وجود كل فهرس `uq_*` المذكور في §4 بالاسم.

### 9.4 البيانات الأولية للتطوير

- المرجع الوحيد لمحتوى البذر هو جدول بيانات الاختبار في `17_Test_Acceptance_Plan.md` §4 (DEC-51)؛ التنفيذ في `packages/db/src/seed/` ويُشغّل بـ`pnpm db:seed`.
- معرّفات ثابتة مقروءة بالصيغة `00000000-0000-4000-8000-KKKKAAAABBBB` مصدّرة في `SEED_IDS` (DEC-53)، وبيانات دخول التطوير والاختبار في `SEED_CREDENTIALS` (DEC-55).
- لا يعمل السكربت في الاختبار المرحلي ولا الإنتاج، ولا على قاعدة فيها قناة `live` (DEC-56). البصمات argon2id مع `AUTH_SECRET_PEPPER` (DEC-58)، وتشفير أسرار MFA بالصيغة في DEC-57.
- لا يُنشئ البذر قوالب واتساب؛ تنشئها المزامنة `POST /v1/admin/whatsapp/templates/sync` من تعريفات `WA_TEMPLATE_DEFINITIONS` (DEC-52، DEC-139).

## 10. ملاحظات الأداء

### 10.1 المسارات الساخنة وفهارسها

| المسار | الفهارس |
|---|---|
| تمريرة التوزيع | قفل صف `dispatch_pools` + `ix_tasks_pool_queue` + `ix_duty_sessions_pool_available` + `ix_task_offers_pool_active` |
| معاملة القبول | المفاتيح الأساسية + `uq_tasks_active_movement_driver` و`uq_tasks_next_per_driver` (تُستخدم أيضًا كفهارس بحث لمهام السائق) |
| الشاشة الرئيسية للسائق | `uq_duty_sessions_open`، `uq_tasks_*_driver`، `ix_offer_recipients_user` |
| زر واتساب | `action_tokens_token_hash_key`، `uq_whatsapp_messages_wamid`، `uq_customers_wa_id`، `uq_customers_wa_user_id` |
| استطلاع العامل | `ix_outbox_due`، `ix_outbox_ordering`، `ix_outbox_lease`، `uq_outbox_dedupe_pending` |
| بحث المركبات | `ix_tickets_plate_open`، وبالرقم `tickets_event_id_display_number_key` |
| لوحة المشرف | `ix_tickets_event_status`، `ix_alerts_venue_live`، `ix_notifications_failed`، `ix_whatsapp_messages_failed` |
| سجل التذكرة | `ix_ticket_events_ticket`، `ix_custody_ticket`، `ix_whatsapp_messages_ticket` |

### 10.2 تقدير الأحجام (افتراض تخطيطي لا قياس)

بافتراض 5 قاعات × 300 ليلة تشغيل سنويًا × 400 مركبة لليلة ≈ 600 ألف تذكرة سنويًا: `ticket_events` نحو 15 سطرًا للتذكرة (≈ 9 ملايين/سنة)، `whatsapp_messages` نحو 7 (≈ 4 ملايين)، `audit_log` نحو 10 (≈ 6 ملايين)، `analytics_events` نحو 30 (≈ 18 مليونًا)، و`outbox_events` نحو 20 لكنها تُحذف خلال أسبوعين. الذروة: 100 طلب إحضار في الدقيقة (اختبار الحمل في المعمارية §16 بند 13). تُستبدل هذه الأرقام بقياسات التشغيل التجريبي.

### 10.3 الصيانة والتقسيم لاحقًا

- تقسيم `analytics_events` و`audit_log` (ثم `ticket_events` إن لزم) تقسيمًا تصريحيًا شهريًا عند تجاوز عشرات الملايين أو عندما يصبح حذف الاحتفاظ ثقيلًا؛ حذف قسم كامل أرخص من حذف سطور.
- الجداول كثيرة التحديث (`outbox_events`، `tasks`، `task_offers`، `offer_recipients`، `duty_sessions`) تحتاج ضبط autovacuum أكثر تكرارًا (مثل `autovacuum_vacuum_scale_factor = 0.02` لهذه الجداول).
- تفعيل `pg_stat_statements` ومراجعة `EXPLAIN (ANALYZE, BUFFERS)` للاستعلامات في §6 أثناء اختبار الحمل.
- مراقبة انتظار الأقفال على صف المجموعة (`pg_stat_activity.wait_event_type = 'Lock'`) كمؤشر مبكر للاختناق.

### 10.4 الاتصالات

- تجمع اتصالات بحجم معتدل لكل عملية (API والعامل)؛ المعاملات القصيرة أهم من حجم التجمع.
- `LISTEN` يحتاج اتصال جلسة مخصصًا ودائمًا للعامل؛ لا يعمل عبر وسيط تجميع بوضع المعاملات (مثل PgBouncer transaction mode)، وفي ذلك الوضع تُستخدم `SET LOCAL` فقط.
- `now()` ثابت داخل المعاملة؛ لا يُعتمد عليه لقياس مدد داخلها (`clock_timestamp()` لذلك).

---

## 11. إضافات مقترحة للقاموس (الحالة)

كل ما اقترحه هذا الملف في مسودته اعتُمد وطُبق على `06_schema.sql` 1.2 وCanon؛ يبقى هذا القسم سجلًا للأثر.

1. **(اعتُمد)** عمود ترتيب `outbox_events.seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE` مع `ix_outbox_ordering (ordering_key, seq)`؛ استعلام التأجير في §5.6 يستخدم `seq` بدل `(created_at, id)`.
2. **(اعتُمد)** فهرسا الحائز `ix_tickets_vehicle_holder_open` و`ix_tickets_key_holder_open` لاستعلام §6.4.
3. **(اعتُمد بقيمة 7 أيام)** مفتاح الإعداد `retention.wa_raw_days` لمدة بقاء `whatsapp_inbound_events.raw_body` (Canon §12).
4. **(اعتُمد)** أسماء ثابتة `ck_*` لكل القيود التي كانت أسماؤها آلية؛ الأسماء المستخدمة في هذا الملف و08 هي أسماء المخطط 1.2.
5. **(اعتُمد بصيغة Canon §14ب)** ترتيب الأقفال الموحد L0–L10 (DEC-27)، منسوخًا في §5.2 و`04_Architecture_Flow.md` §5.3 و`10_Dispatch_Engine_Spec.md` §2.1.

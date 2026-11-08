# نموذج البيانات للإصدار الثاني — مسودة SQL (DEC-459)

> مسودة للمراجعة: تُنفَّذ كترحيلات إلحاقية بعد `0007` (DEC-129)، ولا يُعدَّل `06_schema.sql` الأصلي ولا تُضعف قيوده.
> المبالغ بالهللة `bigint`، والأوقات `timestamptz` UTC، وكل جدول مالي إلحاقي أو بإلغاء مسبَّب (لا حذف صامت).

## 1. المنصة

> **نُفذ في `packages/db/migrations/0008_platform.sql` (V2-001، DEC-461)** — النص أدناه هو الترحيل المطبَّق (مع حذف الصلاحيات والمشغّلات). الفروق عن المسودة: حقول الدخول في `platform_users` كحقول `users` (تغيير السر الإلزامي، TOTP مشفّر بـ`encrypt()` في `mfa_secret_enc text` بدل `bytea`، خطوة TOTP الأخيرة، عدّاد الإخفاق والقفل)؛ جدولا `platform_sessions` و`platform_idempotency_keys`؛ في `platform_audit_log` نوع الفاعل ودوره و`request_id` والعنوان، و`occurred_at` بدل `created_at`؛ أسماء صريحة لكل قيد (06 ERD §9.2 القاعدة 4)؛ فحص صيغة السجل التجاري والرقم الضريبي؛ وقاعدة «عقد واحد في أي يوم» في الأمر تحت قفل صف المؤسسة لغياب `btree_gist` (DEC-463).

```sql
CREATE TABLE platform_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164          text NOT NULL,
  full_name           text NOT NULL,
  role                text NOT NULL,
  status              text NOT NULL DEFAULT 'active',
  secret_hash         text NOT NULL,                                 -- argon2id + AUTH_SECRET_PEPPER (09 §9.1, DEC-58)
  must_change_secret  boolean NOT NULL DEFAULT true,
  mfa_enabled         boolean NOT NULL DEFAULT false,                -- MFA is mandatory: false only until the first set-up
  mfa_secret_enc      text,                                          -- TOTP secret, encrypted with DATA_ENCRYPTION_KEY
  mfa_last_step       bigint,                                        -- last accepted TOTP time-step (replay protection)
  failed_login_count  int  NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  disabled_at         timestamptz,
  disabled_by         uuid REFERENCES platform_users(id),
  disabled_reason     text,
  created_by          uuid REFERENCES platform_users(id),              -- NULL: the bootstrap command (create-platform-owner)
  version             int  NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_platform_users_phone UNIQUE (phone_e164),
  CONSTRAINT ck_platform_users_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT ck_platform_users_role CHECK (role IN ('platform_owner','platform_admin','platform_finance','platform_support')),
  CONSTRAINT ck_platform_users_status CHECK (status IN ('active','disabled')),
  CONSTRAINT ck_platform_users_disabled_at CHECK (status <> 'disabled' OR disabled_at IS NOT NULL),
  CONSTRAINT ck_platform_users_mfa_secret CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL),
  CONSTRAINT ck_platform_users_failed_count CHECK (failed_login_count >= 0)
);

-- Server-side sessions of the platform (DEC-09 pattern): an opaque 256-bit token in the platform cookie
-- (PLATFORM_SESSION_COOKIE_NAME), only its sha256 stored. kind = 'mfa_challenge' is the 5-minute single-use step
-- between the password and the TOTP code; it never authorizes a request.
CREATE TABLE platform_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id  uuid NOT NULL REFERENCES platform_users(id),
  kind              text NOT NULL DEFAULT 'session',
  token_hash        text NOT NULL,
  mfa_verified      boolean NOT NULL DEFAULT false,
  ip                inet,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_reason    text,
  CONSTRAINT uq_platform_sessions_token UNIQUE (token_hash),
  CONSTRAINT ck_platform_sessions_kind CHECK (kind IN ('session','mfa_challenge')),
  CONSTRAINT ck_platform_sessions_revoked_reason
    CHECK (revoked_reason IN ('logout','disabled','secret_reset','admin','expired_cleanup','consumed')),
  CONSTRAINT ck_platform_sessions_revoked CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL),
  CONSTRAINT ck_platform_sessions_challenge CHECK (kind <> 'mfa_challenge' OR mfa_verified = false),
  CONSTRAINT ck_platform_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ix_platform_sessions_user_active ON platform_sessions(platform_user_id) WHERE revoked_at IS NULL;

-- Idempotency keys of platform commands (07 §1.4 protocol, scoped per platform account): same columns and rules
-- as idempotency_keys, whose user_id references users(id) and so cannot hold a platform account.
CREATE TABLE platform_idempotency_keys (
  platform_user_id uuid NOT NULL REFERENCES platform_users(id),
  key              text NOT NULL,
  operation        text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress',
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT pk_platform_idempotency_keys PRIMARY KEY (platform_user_id, key),
  CONSTRAINT ck_platform_idempotency_keys_key CHECK (length(key) BETWEEN 8 AND 128),
  CONSTRAINT ck_platform_idempotency_keys_status CHECK (status IN ('in_progress','completed'))
);
CREATE INDEX ix_platform_idempotency_expiry ON platform_idempotency_keys(expires_at);

-- Every platform action (02 §1: «كل فعل منصة يُدوَّن في platform_audit_log وفي audit_log للمؤسسة المعنية إن مسّها»).
-- Append-only: the app role gets INSERT/SELECT only (below), like audit_log (PNT-009).
CREATE TABLE platform_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL,
  actor_id     uuid REFERENCES platform_users(id),
  actor_role   text,
  action       text NOT NULL,                 -- e.g. platform.auth.login, operator.suspend, plan.price_change
  entity_type  text NOT NULL,
  entity_id    uuid,
  org_id       uuid REFERENCES organizations(id),
  request_id   text,
  ip           inet,
  user_agent   text,
  reason       text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ck_platform_audit_actor CHECK (
    (actor_type = 'platform_user' AND actor_id IS NOT NULL) OR (actor_type = 'system' AND actor_id IS NULL))
);
CREATE INDEX ix_platform_audit_occurred ON platform_audit_log(occurred_at);
CREATE INDEX ix_platform_audit_org ON platform_audit_log(org_id, occurred_at) WHERE org_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Operators = the existing organizations, with platform fields
-- ---------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN operator_status text NOT NULL DEFAULT 'active',
  ADD COLUMN is_platform_operated boolean NOT NULL DEFAULT false,   -- venues POINT runs itself
  ADD COLUMN legal_name text,
  ADD COLUMN cr_number text,                                        -- commercial registration, 10 digits
  ADD COLUMN vat_number text,                                       -- VAT registration, 15 digits 3…3
  ADD CONSTRAINT ck_organizations_operator_status
    CHECK (operator_status IN ('invited','trial','active','suspended','terminated')),
  ADD CONSTRAINT ck_organizations_cr_number CHECK (cr_number IS NULL OR cr_number ~ '^[0-9]{10}$'),
  ADD CONSTRAINT ck_organizations_vat_number CHECK (vat_number IS NULL OR vat_number ~ '^3[0-9]{13}3$');

-- The operator's commercial terms with POINT (V2-D04, V2-D05). At most one contract per operator on any day:
-- enforced by the creating command under a row lock on the organization (assertNoContractOverlap, DEC-463),
-- because no migration enables btree_gist for an EXCLUDE constraint.
CREATE TABLE operator_contracts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                          uuid NOT NULL REFERENCES organizations(id),
  saas_fee_halalas_per_venue      bigint NOT NULL,
  saas_cycle                      text NOT NULL,
  subscriber_visit_payout_halalas bigint NOT NULL,
  app_payment_commission_bp       int NOT NULL,                     -- basis points of the in-app payment
  starts_on                       date NOT NULL,
  ends_on                         date,                             -- NULL: open-ended; exclusive end day
  created_by                      uuid NOT NULL REFERENCES platform_users(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_operator_contracts_saas_fee CHECK (saas_fee_halalas_per_venue >= 0),
  CONSTRAINT ck_operator_contracts_saas_cycle CHECK (saas_cycle IN ('monthly','yearly')),
  CONSTRAINT ck_operator_contracts_payout CHECK (subscriber_visit_payout_halalas >= 0),
  CONSTRAINT ck_operator_contracts_commission CHECK (app_payment_commission_bp BETWEEN 0 AND 10000),
  CONSTRAINT ck_operator_contracts_period CHECK (ends_on IS NULL OR ends_on > starts_on)
);
CREATE INDEX ix_operator_contracts_org ON operator_contracts(org_id, starts_on);
```

## 2. الموقع العام

> نُفذ في `0008_platform.sql` مع `org_id` (عزل المشغل، 09) و`version` و`created_at`، وفحوص: الموقع إحداثيان معًا أو لا شيء، والمعتمد له معتمِد ووقت (DEC-461).

```sql
CREATE TABLE venue_public_profiles (
  venue_id               uuid PRIMARY KEY REFERENCES venues(id),
  org_id                 uuid NOT NULL REFERENCES organizations(id),   -- = venues.org_id (operator isolation, 09)
  status                 text NOT NULL DEFAULT 'draft',
  category               text NOT NULL,
  lat                    numeric(9,6),
  lng                    numeric(9,6),
  opening_hours          jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_asset_ids        uuid[] NOT NULL DEFAULT '{}',
  subscriptions_enabled  boolean NOT NULL DEFAULT false,
  pay_per_visit_halalas  bigint,                                       -- non-subscribers (set by POINT, V2-D05)
  approved_by            uuid REFERENCES platform_users(id),
  approved_at            timestamptz,
  version                int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_venue_public_profiles_status CHECK (status IN ('draft','submitted','approved','hidden')),
  CONSTRAINT ck_venue_public_profiles_category
    CHECK (category IN ('hall','office','mall','hospital','residential','hotel','club','other')),
  CONSTRAINT ck_venue_public_profiles_location CHECK (
    (lat IS NULL) = (lng IS NULL) AND (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180))),
  CONSTRAINT ck_venue_public_profiles_pay_per_visit CHECK (pay_per_visit_halalas IS NULL OR pay_per_visit_halalas > 0),
  CONSTRAINT ck_venue_public_profiles_approved CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX ix_venue_public_profiles_org ON venue_public_profiles(org_id);
CREATE INDEX ix_venue_public_profiles_listed ON venue_public_profiles(category) WHERE status = 'approved';
```

## 3. العميل على مستوى المنصة

> **نُفذ في `packages/db/migrations/0009_customer_accounts.sql` و`0009_customers_account_index.sql` (V2-010، DEC-496…DEC-498).** الفروق عن المسودة أدناه: أسماء صريحة لكل قيد وفهرس، وفحص اللغة وطول الاسم والجهاز؛ في `customer_account_sessions` أعمدة `access_hash` و`access_expires_at` و`refresh_expires_at` و`rotation_count` و`refreshed_at` و`revoked_reason` وجلسة حية واحدة لكل حساب وجهاز؛ جداول جديدة `customer_otp_challenges` (رموز الدخول: HMAC ونسخة مشفرة مؤقتة) و`customer_idempotency_keys` و`customer_audit_log` (إلحاقي)؛ `customer_account_consents.request_id` وقيد يمنع «رفض» الشروط والخصوصية؛ وفهرس `uq_customers_org_account` في ملف مستقل يُبنى `CONCURRENTLY`. أما `tickets.customer_vehicle_id` و`entitlement` و`customer_passes` فليست في هذا الترحيل (V2-013 وما بعدها).
>
> **الزيارة الحية والإشعارات في `0013_customer_visits_push.sql` و`0013_customer_visits_push_token_index.sql` (V2-015، V2-016؛ DEC-516 … DEC-519):** `retrieval_cycles.request_source` و`tickets.pending_retrieval_source` يقبلان `app` (قيدان مسميان يحلان محل قيدي 06)، و`ck_cycles_app_requester`؛ `customer_visit_ratings` (تقييم واحد لكل تذكرة، 1–5، ملاحظة ≤ 500، بلا حذف)؛ أعمدة `push_provider` و`push_registered_at` على `customer_account_sessions` مع `push_token` القائم (رمز لجلسة حية واحدة بفهرس فريد `CONCURRENTLY`، والجلسة الملغاة بلا رمز)؛ و`customer_push_messages` (صف لكل إشعار وجلسة بالمعرّفات والحالة وإيصال المزود، بلا نص ولا رمز).

> **بطاقة الدخول وتذكرة التطبيق في `0010_customer_pass_and_app_intake.sql` (V2-013، V2-014؛ DEC-500 … DEC-502):** `customer_passes` بالسر مشفرًا نصًا (`encrypt()`، لا `bytea`) ومعه `previous_secret_ciphertext`/`previous_valid_until` للتدوير و`key_version` و`last_used_step`/`last_used_at` لرفض الخطوة المعادة؛ وقيد القناة أُعيد باسم `ck_tickets_channel` بالقيمة `app`؛ و`tickets.customer_vehicle_id` (`fk_tickets_customer_vehicle`) و`tickets.entitlement` (`ck_tickets_entitlement`) وقيود `ck_tickets_app_customer` و`ck_tickets_app_no_whatsapp` و`ck_tickets_customer_vehicle_app`، وفهرس `ix_tickets_customer_vehicle_open` في ملف مستقل `CONCURRENTLY`. **`tickets.subscription_id` لم يُضف:** يأتي مع `subscriptions` في المرحلة V4 مع قيده.
>
> **حذف الحساب في `0011_customer_account_deletion.sql` (V2-017، DEC-507، DEC-508):** `customer_accounts.phone_hash` (بصمة HMAC لا تُعكس)، و`phone_e164` يقبل `NULL` للمحذوف وحده (`ck_customer_accounts_phone_present`)، والمحذوف بلا رقم ولا اسم وببصمة (`ck_customer_accounts_deleted_phone` / `_deleted_name` / `_deleted_hash`، و`_phone_hash` sha256 hex) — فيسجّل الرقم نفسه حسابًا جديدًا؛ و`customer_account_sessions.reauth_hash` / `reauth_expires_at` لدليل إعادة التحقق قبل الحذف (`ck_customer_sessions_reauth`). صفوف `customers` لدى المشغلين لا تُمس.

```sql
CREATE TABLE customer_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164     text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name   text,
  locale         text NOT NULL DEFAULT 'ar',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  deleted_at     timestamptz,                   -- حذف الحساب: تُمسح البيانات الشخصية وتبقى السجلات المالية نظامًا
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_account_sessions (       -- رمز تحديث مجزأ، لكل جهاز
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  device_id text NOT NULL, platform text NOT NULL CHECK (platform IN ('ios','android')),
  refresh_hash text NOT NULL, push_token text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, revoked_at timestamptz
);

CREATE TABLE customer_account_consents (       -- إلحاقي
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  kind text NOT NULL CHECK (kind IN ('terms','privacy','marketing','card_on_file')),
  version text NOT NULL, granted boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  plate_country text NOT NULL DEFAULT 'SA', plate_digits text CHECK (plate_digits ~ '^[0-9]{1,4}$'),
  plate_letters_ar text, plate_letters_en text, plate_raw text,
  vehicle_make text, vehicle_model text, vehicle_color text,
  vehicle_type text CHECK (vehicle_type IN ('sedan','suv','pickup','van','other')),
  removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_customer_vehicles_plate ON customer_vehicles(account_id, plate_country, plate_digits, plate_letters_ar)
  WHERE removed_at IS NULL;

-- الربط بصفوف العملاء الحالية لكل مؤسسة (V2-D12)
ALTER TABLE customers ADD COLUMN customer_account_id uuid REFERENCES customer_accounts(id);
CREATE UNIQUE INDEX uq_customers_org_account ON customers(org_id, customer_account_id) WHERE customer_account_id IS NOT NULL;

-- التذكرة من التطبيق
ALTER TABLE tickets DROP CONSTRAINT tickets_channel_check;   -- يُعاد بقيمة إضافية لا أضيق
ALTER TABLE tickets ADD CONSTRAINT tickets_channel_check CHECK (channel IN ('whatsapp','paper','app'));
ALTER TABLE tickets
  ADD COLUMN customer_vehicle_id uuid REFERENCES customer_vehicles(id),
  ADD COLUMN entitlement text NOT NULL DEFAULT 'none'
    CHECK (entitlement IN ('none','subscription','app_paid','event_included')),
  ADD COLUMN subscription_id uuid;              -- FK بعد إنشاء subscriptions

CREATE TABLE customer_passes (                 -- بطاقة الدخول المتغيرة (V2-D14)
  account_id uuid PRIMARY KEY REFERENCES customer_accounts(id),
  secret_ciphertext bytea NOT NULL,             -- مفتاح TOTP-like لكل حساب، مشفّر (DATA_ENCRYPTION_KEY)
  rotated_at timestamptz NOT NULL DEFAULT now()
);
```

## 4. الاشتراكات والدفع

> **الدفع نُفذ في `packages/db/migrations/0012_online_payments.sql` (V2-020 / V2-021، DEC-510 … DEC-514)** — `customer_payment_methods` و`online_payments` و`refunds` و`gateway_webhook_events`، ومعها `payment_reconciliation_runs` و`platform_alerts`. الفروق عن المسودة أدناه: أسماء صريحة لكل قيد؛ `online_payments` بـ`given_id` (مفتاح تكرار الإنشاء لدى البوابة) و`refunded_halalas` التراكمي و`payment_method_id` و`source_type` وعلامة البطاقة وآخر 4 أرقام وأوقات كل حالة و`gateway_updated_at` و`version`، و`gateway_payment_id` فارغ حتى أول رد من البوابة وفريد مع `gateway`؛ القيود مسطحة بلا `BETWEEN` ولا مجموعات `AND` متداخلة (تمرين الاستعادة)؛ `subscription_id` بلا مفتاح أجنبي حتى `subscriptions` (V2-031)؛ الدفعة الناجحة الواحدة للتذكرة تشمل `partially_refunded`؛ `refunds` بـ`failure_code` و`request_id` و`sent_at` و`completed_at` ومشغّل يمنع تعديل غير نتيجة البوابة، ولا حذف لأي صف مالي (REVOKE DELETE). جداول الاشتراك والباقات أدناه للمرحلة V4.

```sql
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  name_ar text NOT NULL,
  vehicles_included int NOT NULL DEFAULT 1 CHECK (vehicles_included BETWEEN 1 AND 5),
  monthly_price_halalas bigint CHECK (monthly_price_halalas > 0),
  yearly_price_halalas  bigint CHECK (yearly_price_halalas > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_by uuid NOT NULL REFERENCES platform_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_plans_has_price CHECK (monthly_price_halalas IS NOT NULL OR yearly_price_halalas IS NOT NULL)
);
-- تغيير السعر = باقة جديدة وتقاعد القديمة؛ المشترك الحالي يبقى على سعره حتى التجديد التالي بعد إشعار

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  venue_id uuid NOT NULL REFERENCES venues(id),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
  status text NOT NULL CHECK (status IN ('pending_payment','active','past_due','canceled','expired','frozen')),
  current_period_start timestamptz, current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  payment_method_id uuid,                       -- FK إلى customer_payment_methods
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- اشتراك حي واحد لكل حساب في كل موقع
CREATE UNIQUE INDEX uq_subscriptions_live ON subscriptions(account_id, venue_id)
  WHERE status IN ('pending_payment','active','past_due','frozen');

CREATE TABLE subscription_vehicles (            -- السيارات المشمولة؛ التبديل مرة كل دورة
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  customer_vehicle_id uuid NOT NULL REFERENCES customer_vehicles(id),
  added_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);

CREATE TABLE customer_payment_methods (         -- رمز البوابة فقط، لا بيانات بطاقة
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  gateway text NOT NULL, gateway_token text NOT NULL,
  brand text, last4 text CHECK (last4 ~ '^[0-9]{4}$'), expires_month int, expires_year int,
  is_default boolean NOT NULL DEFAULT false, removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE online_payments (                  -- مدفوعات البوابة (منفصلة عن payments النقدية/الشبكة)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  purpose text NOT NULL CHECK (purpose IN ('subscription','visit')),
  subscription_id uuid REFERENCES subscriptions(id),
  ticket_id uuid REFERENCES tickets(id),
  org_id uuid REFERENCES organizations(id),     -- مشغل الموقع (للتسوية)
  venue_id uuid REFERENCES venues(id),
  amount_halalas bigint NOT NULL CHECK (amount_halalas > 0),
  vat_halalas bigint NOT NULL CHECK (vat_halalas >= 0),
  currency text NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  gateway text NOT NULL, gateway_payment_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('initiated','authorized','paid','failed','refunded','partially_refunded')),
  failure_code text, paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_online_payments_purpose CHECK (
    (purpose = 'subscription' AND subscription_id IS NOT NULL) OR (purpose = 'visit' AND ticket_id IS NOT NULL))
);
-- دفعة ناجحة واحدة لكل تذكرة
CREATE UNIQUE INDEX uq_online_payments_ticket_paid ON online_payments(ticket_id) WHERE purpose = 'visit' AND status = 'paid';

CREATE TABLE refunds (                          -- بسبب ومُصدِر، إلحاقي
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  online_payment_id uuid NOT NULL REFERENCES online_payments(id),
  amount_halalas bigint NOT NULL CHECK (amount_halalas > 0),
  reason text NOT NULL, issued_by uuid NOT NULL REFERENCES platform_users(id),
  gateway_refund_id text UNIQUE, status text NOT NULL CHECK (status IN ('requested','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway_webhook_events (           -- خام وموقّع، معالجة مرة واحدة (كما في whatsapp_inbound_events)
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway text NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE (gateway, event_id)
);
```

## 5. الفواتير والتسوية

```sql
CREATE TABLE invoices (                         -- ZATCA؛ الفاتورة لا تُعدَّل، التصحيح بإشعار دائن
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('customer_simplified','operator_standard','credit_note')),
  number text NOT NULL UNIQUE,                  -- تسلسل بلا فجوات
  account_id uuid REFERENCES customer_accounts(id),
  org_id uuid REFERENCES organizations(id),
  online_payment_id uuid REFERENCES online_payments(id),
  original_invoice_id uuid REFERENCES invoices(id),
  subtotal_halalas bigint NOT NULL, vat_halalas bigint NOT NULL, total_halalas bigint NOT NULL,
  zatca_status text NOT NULL DEFAULT 'pending' CHECK (zatca_status IN ('pending','reported','cleared','rejected')),
  zatca_uuid uuid, qr_payload text, pdf_asset_id uuid,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_invoices_total CHECK (total_halalas = subtotal_halalas + vat_halalas)
);

CREATE TABLE settlement_statements (            -- كشف شهري لكل مشغل
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  period_start date NOT NULL, period_end date NOT NULL,
  subscriber_visits int NOT NULL, subscriber_payout_halalas bigint NOT NULL,
  app_visit_gross_halalas bigint NOT NULL, app_visit_commission_halalas bigint NOT NULL,
  saas_fee_halalas bigint NOT NULL,
  net_payable_halalas bigint NOT NULL,          -- موجب: بوينت تدفع للمشغل؛ سالب: المشغل يدفع لبوينت
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','disputed','paid','void')),
  paid_reference text, paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_start),
  CONSTRAINT ck_settlement_net CHECK (net_payable_halalas =
    subscriber_payout_halalas + (app_visit_gross_halalas - app_visit_commission_halalas) - saas_fee_halalas)
);

CREATE TABLE settlement_lines (                 -- كل زيارة/دفعة محسوبة مرة واحدة
  statement_id uuid NOT NULL REFERENCES settlement_statements(id),
  kind text NOT NULL CHECK (kind IN ('subscriber_visit','app_visit_payment','saas_fee','adjustment')),
  ticket_id uuid REFERENCES tickets(id), online_payment_id uuid REFERENCES online_payments(id),
  amount_halalas bigint NOT NULL, note text
);
CREATE UNIQUE INDEX uq_settlement_ticket ON settlement_lines(ticket_id) WHERE ticket_id IS NOT NULL;
```

## 6. قيود تُضاف للثوابت (`06_schema_invariants_test.sql` بإصدار ثانٍ)

- اشتراك حي واحد لكل حساب وموقع (`uq_subscriptions_live`).
- دفعة إلكترونية ناجحة واحدة لكل تذكرة، ولا تجتمع مع `payments.recorded` لنفس التذكرة (قيد أو مشغّل).
- `tickets.entitlement = 'subscription'` يستلزم `subscription_id` لاشتراك `active` لحظة الإنشاء (يُفحص في الأمر، ويُوثَّق في `ticket_events`).
- الزيارة الواحدة لا تدخل كشف تسوية مرتين (`uq_settlement_ticket`).
- لا عمود فيه رقم بطاقة كامل (فحص كما في `ck_payments_no_pan`).

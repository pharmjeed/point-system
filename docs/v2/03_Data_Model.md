# نموذج البيانات للإصدار الثاني — مسودة SQL (DEC-459)

> مسودة للمراجعة: تُنفَّذ كترحيلات إلحاقية بعد `0007` (DEC-129)، ولا يُعدَّل `06_schema.sql` الأصلي ولا تُضعف قيوده.
> المبالغ بالهللة `bigint`، والأوقات `timestamptz` UTC، وكل جدول مالي إلحاقي أو بإلغاء مسبَّب (لا حذف صامت).

## 1. المنصة

```sql
CREATE TABLE platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('platform_owner','platform_admin','platform_finance','platform_support')),
  secret_hash   text NOT NULL,                  -- argon2id + pepper (09 §9.1)
  mfa_secret_ciphertext bytea,                  -- MFA إلزامي
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_audit_log (               -- إلحاقي (REVOKE UPDATE/DELETE)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id      uuid REFERENCES platform_users(id),
  action        text NOT NULL,                  -- e.g. operator.suspend, plan.price_change, refund.issue
  entity_type   text NOT NULL,
  entity_id     uuid,
  org_id        uuid REFERENCES organizations(id),
  reason        text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- المشغل = المؤسسة الحالية، بحقول المنصة
ALTER TABLE organizations
  ADD COLUMN operator_status text NOT NULL DEFAULT 'active'
    CHECK (operator_status IN ('invited','trial','active','suspended','terminated')),
  ADD COLUMN is_platform_operated boolean NOT NULL DEFAULT false,   -- مواقع تديرها بوينت نفسها
  ADD COLUMN legal_name text, ADD COLUMN cr_number text, ADD COLUMN vat_number text;

CREATE TABLE operator_contracts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL REFERENCES organizations(id),
  saas_fee_halalas_per_venue  bigint NOT NULL CHECK (saas_fee_halalas_per_venue >= 0),
  saas_cycle                  text NOT NULL CHECK (saas_cycle IN ('monthly','yearly')),
  subscriber_visit_payout_halalas bigint NOT NULL CHECK (subscriber_visit_payout_halalas >= 0),   -- V2-D04
  app_payment_commission_bp   int NOT NULL CHECK (app_payment_commission_bp BETWEEN 0 AND 10000),  -- نقاط أساس
  starts_on                   date NOT NULL,
  ends_on                     date,
  created_by                  uuid NOT NULL REFERENCES platform_users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_operator_contracts_period CHECK (ends_on IS NULL OR ends_on > starts_on)
);
-- عقد سارٍ واحد لكل مشغل في أي يوم (استبعاد التداخل)
-- EXCLUDE USING gist (org_id WITH =, daterange(starts_on, ends_on) WITH &&)
```

## 2. الموقع العام

```sql
CREATE TABLE venue_public_profiles (
  venue_id               uuid PRIMARY KEY REFERENCES venues(id),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','hidden')),
  category               text NOT NULL CHECK (category IN ('hall','office','mall','hospital','residential','hotel','club','other')),
  lat                    numeric(9,6), lng numeric(9,6),
  opening_hours          jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_asset_ids        uuid[] NOT NULL DEFAULT '{}',
  subscriptions_enabled  boolean NOT NULL DEFAULT false,          -- V2-D07
  pay_per_visit_halalas  bigint CHECK (pay_per_visit_halalas > 0), -- لغير المشتركين (يحدده بوينت، V2-D05)
  approved_by            uuid REFERENCES platform_users(id),
  approved_at            timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
```

## 3. العميل على مستوى المنصة

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

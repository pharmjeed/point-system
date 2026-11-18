-- V2-030 … V2-035 (docs/v2/03 §4, docs/v2/04 §1–§2; DEC-531 … DEC-539): the subscriptions POINT sells per venue —
-- the plans (P-05), the customer's subscription and its state machine, the covered vehicles, the paid periods — and
-- the links of the existing tables to them: online_payments.subscription_id gets its foreign key (reserved by 0012),
-- tickets.subscription_id arrives with the entitlement `subscription` at intake (reserved by 0010, DEC-502), and a
-- customer push may be about a subscription. Append-only like every migration (DEC-129). The new tables are created
-- empty, so their indexes are built inline; the indexes on tickets and online_payments are built concurrently in
-- their own files (0016_tickets_subscription_index.sql, 0016_online_payments_subscription_index.sql, 06 ERD §9.2
-- rule 5). CHECKs are flat comparisons joined by OR or one top-level AND (no BETWEEN, no nested AND groups), so that
-- pg_dump writes them back unchanged (restore drill). No V1 constraint is dropped or weakened.

-- ---------------------------------------------------------------------
-- 1. Plans (P-05, platform.plan_manage; DEC-531). A plan belongs to one venue (org_id = venues.org_id, the operator
--    isolation of 09 and the settlement of V2-041). A price change is a new plan and the old one retired
--    (replaced_by_plan_id): nothing of a plan is edited; its subscribers keep their own price (subscriptions
--    .price_halalas) until the first renewal announced by a renewal notice that carried the new one.
-- ---------------------------------------------------------------------
CREATE TABLE subscription_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  venue_id               uuid NOT NULL REFERENCES venues(id),
  name_ar                text NOT NULL,
  name_en                text,
  vehicles_included      int  NOT NULL DEFAULT 1,
  monthly_price_halalas  bigint,                       -- VAT included (04 §4); NULL = the cycle is not sold
  yearly_price_halalas   bigint,
  status                 text NOT NULL DEFAULT 'active',
  replaces_plan_id       uuid REFERENCES subscription_plans(id),
  replaced_by_plan_id    uuid REFERENCES subscription_plans(id),
  created_by             uuid NOT NULL REFERENCES platform_users(id),
  retired_at             timestamptz,
  retired_by             uuid REFERENCES platform_users(id),
  retire_reason          text,
  version                int  NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_subscription_plans_status CHECK (status IN ('active','retired')),
  CONSTRAINT ck_subscription_plans_vehicles_min CHECK (vehicles_included >= 1),
  CONSTRAINT ck_subscription_plans_vehicles_max CHECK (vehicles_included <= 5),
  CONSTRAINT ck_subscription_plans_has_price CHECK (monthly_price_halalas IS NOT NULL OR yearly_price_halalas IS NOT NULL),
  CONSTRAINT ck_subscription_plans_monthly CHECK (monthly_price_halalas >= 100),     -- the gateway's minimum, 1.00 SAR
  CONSTRAINT ck_subscription_plans_yearly CHECK (yearly_price_halalas >= 100),
  CONSTRAINT ck_subscription_plans_name CHECK (char_length(name_ar) >= 2 AND char_length(name_ar) <= 60),
  CONSTRAINT ck_subscription_plans_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT ck_subscription_plans_retired_by CHECK (retired_at IS NULL OR retired_by IS NOT NULL),
  CONSTRAINT ck_subscription_plans_replaced CHECK (replaced_by_plan_id IS NULL OR status = 'retired'),
  CONSTRAINT ck_subscription_plans_not_self CHECK (replaced_by_plan_id IS NULL OR replaced_by_plan_id <> id),
  CONSTRAINT ck_subscription_plans_no_pan CHECK (retire_reason !~ '[0-9]{13,}')
);
CREATE INDEX ix_subscription_plans_venue ON subscription_plans(venue_id, created_at);
CREATE INDEX ix_subscription_plans_org ON subscription_plans(org_id);
CREATE INDEX ix_subscription_plans_active ON subscription_plans(venue_id) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- 2. Subscriptions (the state machine of docs/v2/04 §1, DEC-532). The price and the vehicles of the plan are copied
--    when the subscription starts (and the price again at a renewal that moves it to a replacement plan). The
--    period boundaries come from the server's clock: the first period starts when the first payment is paid
--    (cycle_anchor_at), each period ends `periods_paid` calendar months (12 for a year) after the anchor on the
--    Asia/Riyadh calendar; a frozen time moves the anchor and the end by the same amount (DEC-533, DEC-536).
-- ---------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES customer_accounts(id),
  plan_id                uuid NOT NULL REFERENCES subscription_plans(id),
  org_id                 uuid NOT NULL REFERENCES organizations(id),   -- = venues.org_id (isolation, settlement)
  venue_id               uuid NOT NULL REFERENCES venues(id),
  billing_cycle          text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending_payment',
  price_halalas          bigint NOT NULL,             -- the current period's price, VAT included
  vehicles_included      int  NOT NULL,
  cycle_anchor_at        timestamptz,
  periods_paid           int  NOT NULL DEFAULT 0,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  cancel_requested_at    timestamptz,
  payment_method_id      uuid REFERENCES customer_payment_methods(id),   -- the card of the last charge
  pending_expires_at     timestamptz,                 -- pending_payment: the 30 minutes of 04 §1
  grace_ends_at          timestamptz,                 -- past_due: the 3 days of 04 §1
  renewal_attempts       int  NOT NULL DEFAULT 0,     -- failed charges of the period being renewed
  next_plan_id           uuid REFERENCES subscription_plans(id),   -- announced by the renewal notice (DEC-531)
  next_price_halalas     bigint,
  renewal_notice_for     timestamptz,                 -- the period end the last renewal notice was sent for
  vehicles_changed_at    timestamptz,                 -- the covered vehicles change once per period (01 R6)
  frozen_at              timestamptz,
  frozen_reason          text,
  frozen_seconds_total   bigint NOT NULL DEFAULT 0,
  activated_at           timestamptz,
  ended_at               timestamptz,
  ended_reason           text,
  version                int  NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_subscriptions_cycle CHECK (billing_cycle IN ('monthly','yearly')),
  CONSTRAINT ck_subscriptions_status
    CHECK (status IN ('pending_payment','active','past_due','canceled','expired','frozen')),
  CONSTRAINT ck_subscriptions_price CHECK (price_halalas >= 100),
  CONSTRAINT ck_subscriptions_next_price CHECK (next_price_halalas >= 100),
  CONSTRAINT ck_subscriptions_next_plan CHECK ((next_plan_id IS NULL) = (next_price_halalas IS NULL)),
  CONSTRAINT ck_subscriptions_vehicles_min CHECK (vehicles_included >= 1),
  CONSTRAINT ck_subscriptions_vehicles_max CHECK (vehicles_included <= 5),
  CONSTRAINT ck_subscriptions_periods CHECK (periods_paid >= 0),
  CONSTRAINT ck_subscriptions_period_pair CHECK ((current_period_start IS NULL) = (current_period_end IS NULL)),
  CONSTRAINT ck_subscriptions_period_order CHECK (current_period_end > current_period_start),
  CONSTRAINT ck_subscriptions_anchor CHECK ((cycle_anchor_at IS NULL) = (current_period_end IS NULL)),
  CONSTRAINT ck_subscriptions_paid_period CHECK ((periods_paid = 0) = (current_period_end IS NULL)),
  CONSTRAINT ck_subscriptions_live_period
    CHECK (status NOT IN ('active','past_due','frozen') OR current_period_end IS NOT NULL),
  CONSTRAINT ck_subscriptions_pending CHECK (status <> 'pending_payment' OR pending_expires_at IS NOT NULL),
  CONSTRAINT ck_subscriptions_pending_unpaid CHECK (status <> 'pending_payment' OR periods_paid = 0),
  CONSTRAINT ck_subscriptions_grace CHECK ((status = 'past_due') = (grace_ends_at IS NOT NULL)),
  CONSTRAINT ck_subscriptions_attempts CHECK (renewal_attempts >= 0),
  CONSTRAINT ck_subscriptions_frozen CHECK ((status = 'frozen') = (frozen_at IS NOT NULL)),
  CONSTRAINT ck_subscriptions_frozen_reason_set CHECK ((frozen_at IS NULL) = (frozen_reason IS NULL)),
  CONSTRAINT ck_subscriptions_frozen_reason CHECK (frozen_reason IN ('operator_suspended','venue_inactive')),
  CONSTRAINT ck_subscriptions_frozen_total CHECK (frozen_seconds_total >= 0),
  CONSTRAINT ck_subscriptions_ended CHECK ((status IN ('canceled','expired')) = (ended_at IS NOT NULL)),
  CONSTRAINT ck_subscriptions_ended_reason_set CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
  CONSTRAINT ck_subscriptions_ended_reason CHECK (ended_reason IN ('pending_expired','abandoned','period_end',
    'grace_expired','past_due_canceled','account_deleted','operator_terminated','refunded')),
  CONSTRAINT ck_subscriptions_expired_reason CHECK (status <> 'expired' OR ended_reason = 'grace_expired'),
  CONSTRAINT ck_subscriptions_cancel_flag CHECK (cancel_at_period_end = false OR cancel_requested_at IS NOT NULL),
  CONSTRAINT ck_subscriptions_activated CHECK (periods_paid = 0 OR activated_at IS NOT NULL)
);
-- one live subscription per account and venue (docs/v2/03 §4, §6)
CREATE UNIQUE INDEX uq_subscriptions_live ON subscriptions(account_id, venue_id)
  WHERE status IN ('pending_payment','active','past_due','frozen');
CREATE INDEX ix_subscriptions_account ON subscriptions(account_id, created_at);
CREATE INDEX ix_subscriptions_org ON subscriptions(org_id, status);
CREATE INDEX ix_subscriptions_venue_live ON subscriptions(venue_id, status)
  WHERE status IN ('pending_payment','active','past_due','frozen');
CREATE INDEX ix_subscriptions_plan ON subscriptions(plan_id);
CREATE INDEX ix_subscriptions_period_end ON subscriptions(current_period_end) WHERE status IN ('active','past_due');

-- ---------------------------------------------------------------------
-- 3. The covered vehicles (01 R6: changed once per period). A vehicle leaves the list with removed_at; nothing is
--    deleted. At most the plan's vehicles_included at a time (the command, under the subscription's lock).
-- ---------------------------------------------------------------------
CREATE TABLE subscription_vehicles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id      uuid NOT NULL REFERENCES subscriptions(id),
  account_id           uuid NOT NULL REFERENCES customer_accounts(id),
  customer_vehicle_id  uuid NOT NULL REFERENCES customer_vehicles(id),
  added_at             timestamptz NOT NULL DEFAULT now(),
  removed_at           timestamptz,
  CONSTRAINT ck_subscription_vehicles_removed CHECK (removed_at IS NULL OR removed_at >= added_at)
);
CREATE UNIQUE INDEX uq_subscription_vehicles_live ON subscription_vehicles(subscription_id, customer_vehicle_id)
  WHERE removed_at IS NULL;
CREATE INDEX ix_subscription_vehicles_vehicle ON subscription_vehicles(customer_vehicle_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------
-- 4. Paid periods: one row per period, written in the transaction of the payment that paid it (the subscription
--    payments the settlement of V2-041 reads). A period is paid once (uq_subscription_periods_seq); a second
--    payment for it is refunded by the platform (DEC-523's double payment). extended_seconds: frozen time added.
-- ---------------------------------------------------------------------
CREATE TABLE subscription_periods (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    uuid NOT NULL REFERENCES subscriptions(id),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  venue_id           uuid NOT NULL REFERENCES venues(id),
  seq                int  NOT NULL,                   -- 1 = the first period
  plan_id            uuid NOT NULL REFERENCES subscription_plans(id),
  billing_cycle      text NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  price_halalas      bigint NOT NULL,
  online_payment_id  uuid NOT NULL REFERENCES online_payments(id),
  extended_seconds   bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subscription_periods_seq UNIQUE (subscription_id, seq),
  CONSTRAINT uq_subscription_periods_payment UNIQUE (online_payment_id),
  CONSTRAINT ck_subscription_periods_seq CHECK (seq >= 1),
  CONSTRAINT ck_subscription_periods_order CHECK (ends_at > starts_at),
  CONSTRAINT ck_subscription_periods_price CHECK (price_halalas >= 100),
  CONSTRAINT ck_subscription_periods_cycle CHECK (billing_cycle IN ('monthly','yearly')),
  CONSTRAINT ck_subscription_periods_extended CHECK (extended_seconds >= 0)
);
CREATE INDEX ix_subscription_periods_org ON subscription_periods(org_id, starts_at);

-- updated_at maintained by the trigger of 0001 (set_updated_at)
CREATE TRIGGER trg_subscription_plans_updated_at BEFORE UPDATE ON subscription_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 5. The existing tables
-- ---------------------------------------------------------------------
-- 0012 reserved online_payments.subscription_id without its foreign key; the period a subscription payment pays
-- (renewals are idempotent per period and attempt: given_id, DEC-533)
ALTER TABLE online_payments
  ADD CONSTRAINT fk_online_payments_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id);
ALTER TABLE online_payments ADD COLUMN subscription_period_seq int;
ALTER TABLE online_payments ADD CONSTRAINT ck_online_payments_subscription_seq
  CHECK (subscription_period_seq IS NULL OR purpose = 'subscription');
ALTER TABLE online_payments ADD CONSTRAINT ck_online_payments_subscription_seq_min
  CHECK (subscription_period_seq >= 1);
ALTER TABLE online_payments ADD CONSTRAINT ck_online_payments_subscription_seq_set
  CHECK (purpose <> 'subscription' OR subscription_period_seq IS NOT NULL);
-- the operator and venue of a subscription payment (settlement): set like a visit's
ALTER TABLE online_payments ADD CONSTRAINT ck_online_payments_subscription_venue
  CHECK (purpose <> 'subscription' OR venue_id IS NOT NULL);

-- tickets.subscription_id (reserved by 0010, DEC-502): the entitlement `subscription` names the subscription that
-- covered the visit at intake, and only that entitlement names one (docs/v2/03 §6). A nullable column with no
-- default: no table rewrite; the index is built concurrently (0016_tickets_subscription_index.sql).
ALTER TABLE tickets
  ADD COLUMN subscription_id uuid CONSTRAINT fk_tickets_subscription REFERENCES subscriptions(id);
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_subscription
  CHECK (entitlement <> 'subscription' OR subscription_id IS NOT NULL);
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_subscription_entitlement
  CHECK (subscription_id IS NULL OR entitlement = 'subscription');
-- a visit covered by a subscription owes nothing at the handover (DEC-210 gate, ck_tickets_fee_matches_payment_status)
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_subscription_not_due
  CHECK (subscription_id IS NULL OR payment_status = 'not_required');

-- a customer push about a subscription (V2-031, DEC-535): the renewal notice, a failed renewal, the expiry
ALTER TABLE customer_push_messages
  ADD COLUMN subscription_id uuid CONSTRAINT fk_customer_push_subscription REFERENCES subscriptions(id);
ALTER TABLE customer_push_messages ADD CONSTRAINT ck_customer_push_subscription_kind
  CHECK (subscription_id IS NULL OR kind IN ('subscription_renewal','subscription_payment_failed','subscription_expired'));
ALTER TABLE customer_push_messages ADD CONSTRAINT ck_customer_push_subscription_org
  CHECK (subscription_id IS NULL OR org_id IS NOT NULL);
ALTER TABLE customer_push_messages ADD CONSTRAINT ck_customer_push_subscription_alone
  CHECK (subscription_id IS NULL OR ticket_id IS NULL);

-- ---------------------------------------------------------------------
-- 6. Privileges (like 0012): nothing of a subscription is ever deleted by the application
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON subscription_plans, subscriptions, subscription_vehicles, subscription_periods
  TO point_app;
REVOKE DELETE ON subscription_plans, subscriptions, subscription_vehicles, subscription_periods FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;

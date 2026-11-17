-- V2-036 / V2-037 (docs/v2/04 §7, docs/v2/01 C-09/C-14/C-21/C-22, docs/v2/02 P-05/P-07/P-13; DEC-590 … DEC-609): the
-- subscriptions annex of an operating agreement turned into per-plan policies, so that the V4 plans run unchanged and a
-- contract's plan (a student plan of 22 counted days, Sunday … Thursday, renewed by hand, non-refundable, checked for
-- eligibility, with one customer freeze per term and a capacity) is data:
--   1. the policies of a plan (their defaults = the V4 behaviour of DEC-531 … DEC-536);
--   2. a subscription's counted-day term, the remaining days of a freeze, the exceptional refund's due day, and the
--      new statuses and reasons (pending_eligibility; customer_freeze; eligibility_rejected, term_completed,
--      exceptional_refund);
--   3. the eligibility application, the venue's eligible list, the customer's freezes, the purchase consent;
--   4. the venue's announced holidays and closures;
--   5. customer complaints with a reference number;
--   6. the new customer pushes.
-- Append-only like every migration (DEC-129). The new tables are created empty, so their indexes are built inline.
-- CHECKs are flat comparisons joined by OR or one top-level AND (no BETWEEN, no nested AND groups) so that pg_dump
-- writes them back unchanged (restore drill). A widened CHECK keeps every value it allowed before; the one live
-- subscription per account and venue (uq_subscriptions_live) now also counts an application waiting for its
-- eligibility decision. No constraint is weakened.

-- ---------------------------------------------------------------------
-- 1. The plan's policies (DEC-590). A plan is never edited (DEC-531): a policy change is a new plan.
-- ---------------------------------------------------------------------
ALTER TABLE subscription_plans
  ADD COLUMN term_kind             text NOT NULL DEFAULT 'calendar',
  ADD COLUMN service_days          int,              -- service_days: the counted days of a term (22)
  ADD COLUMN service_weekdays_mask int,              -- bit d = weekday d counts (0 = Sunday … 6 = Saturday); Sun–Thu = 31
  ADD COLUMN renewal_mode          text NOT NULL DEFAULT 'auto',
  ADD COLUMN daily_visit_limit     int,              -- visits covered per Riyadh day; NULL = no limit
  ADD COLUMN refund_policy         text NOT NULL DEFAULT 'prorated_on_termination',
  ADD COLUMN closure_policy        text NOT NULL DEFAULT 'freeze',
  ADD COLUMN freeze_max_times      int  NOT NULL DEFAULT 0,   -- customer freezes per term
  ADD COLUMN freeze_max_days       int,              -- counted days per customer freeze
  ADD COLUMN eligibility           text NOT NULL DEFAULT 'none',
  ADD COLUMN capacity              int,              -- live subscriptions sold at most (DEC-598); NULL = no limit
  ADD COLUMN audience_ar           text,             -- «الفئة المستفيدة», shown on C-08/C-09
  ADD COLUMN vehicle_change        text NOT NULL DEFAULT 'once_per_period';  -- or any_time before an intake

ALTER TABLE subscription_plans
  ADD CONSTRAINT ck_subscription_plans_term_kind CHECK (term_kind IN ('calendar','service_days')),
  ADD CONSTRAINT ck_subscription_plans_service_days_set CHECK ((term_kind = 'service_days') = (service_days IS NOT NULL)),
  ADD CONSTRAINT ck_subscription_plans_weekdays_set
    CHECK ((term_kind = 'service_days') = (service_weekdays_mask IS NOT NULL)),
  ADD CONSTRAINT ck_subscription_plans_service_days CHECK (service_days >= 1 AND service_days <= 60),
  ADD CONSTRAINT ck_subscription_plans_weekdays CHECK (service_weekdays_mask >= 1 AND service_weekdays_mask <= 127),
  -- a counted-day term is sold as the plan's «month» only, and renewed by hand
  ADD CONSTRAINT ck_subscription_plans_service_monthly CHECK (term_kind <> 'service_days' OR yearly_price_halalas IS NULL),
  ADD CONSTRAINT ck_subscription_plans_renewal_mode CHECK (renewal_mode IN ('auto','manual')),
  ADD CONSTRAINT ck_subscription_plans_service_manual CHECK (term_kind <> 'service_days' OR renewal_mode = 'manual'),
  ADD CONSTRAINT ck_subscription_plans_daily_limit CHECK (daily_visit_limit >= 1 AND daily_visit_limit <= 10),
  ADD CONSTRAINT ck_subscription_plans_refund_policy
    CHECK (refund_policy IN ('prorated_on_termination','non_refundable')),
  ADD CONSTRAINT ck_subscription_plans_closure_policy CHECK (closure_policy IN ('freeze','continue')),
  ADD CONSTRAINT ck_subscription_plans_freeze_times CHECK (freeze_max_times >= 0 AND freeze_max_times <= 3),
  ADD CONSTRAINT ck_subscription_plans_freeze_days_set CHECK ((freeze_max_times = 0) = (freeze_max_days IS NULL)),
  ADD CONSTRAINT ck_subscription_plans_freeze_days CHECK (freeze_max_days >= 1 AND freeze_max_days <= 30),
  ADD CONSTRAINT ck_subscription_plans_freeze_term CHECK (freeze_max_times = 0 OR term_kind = 'service_days'),
  ADD CONSTRAINT ck_subscription_plans_eligibility CHECK (eligibility IN ('none','student_id_review')),
  ADD CONSTRAINT ck_subscription_plans_capacity CHECK (capacity >= 1 AND capacity <= 100000),
  ADD CONSTRAINT ck_subscription_plans_audience CHECK (char_length(audience_ar) >= 2 AND char_length(audience_ar) <= 120),
  ADD CONSTRAINT ck_subscription_plans_audience_no_pan CHECK (audience_ar !~ '[0-9]{13,}'),
  ADD CONSTRAINT ck_subscription_plans_vehicle_change CHECK (vehicle_change IN ('once_per_period','any_time'));

-- ---------------------------------------------------------------------
-- 2. The subscription (DEC-591 … DEC-600)
-- ---------------------------------------------------------------------
ALTER TABLE subscriptions
  ADD COLUMN service_start_on      date,             -- a counted-day term: its first counted day (Riyadh)
  ADD COLUMN service_end_on        date,             -- … and its last one, moved by a freeze
  ADD COLUMN frozen_remaining_days int,              -- frozen counted-day term: the counted days left when it froze
  ADD COLUMN refund_due_at         timestamptz;      -- exceptional refund: back on the payment method by then

ALTER TABLE subscriptions
  ADD CONSTRAINT ck_subscriptions_service_pair CHECK ((service_start_on IS NULL) = (service_end_on IS NULL)),
  ADD CONSTRAINT ck_subscriptions_service_order CHECK (service_end_on >= service_start_on),
  ADD CONSTRAINT ck_subscriptions_service_paid CHECK (service_start_on IS NULL OR periods_paid > 0),
  ADD CONSTRAINT ck_subscriptions_frozen_remaining CHECK (frozen_remaining_days >= 0),
  ADD CONSTRAINT ck_subscriptions_frozen_remaining_set CHECK (frozen_remaining_days IS NULL OR frozen_at IS NOT NULL),
  ADD CONSTRAINT ck_subscriptions_refund_due CHECK (refund_due_at IS NULL OR ended_reason = 'exceptional_refund');

-- the new status, freeze reason and end reasons (every value allowed before stays allowed)
ALTER TABLE subscriptions DROP CONSTRAINT ck_subscriptions_status;
ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_status
  CHECK (status IN ('pending_eligibility','pending_payment','active','past_due','canceled','expired','frozen'));
ALTER TABLE subscriptions DROP CONSTRAINT ck_subscriptions_frozen_reason;
ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_frozen_reason
  CHECK (frozen_reason IN ('operator_suspended','venue_inactive','customer_freeze'));
ALTER TABLE subscriptions DROP CONSTRAINT ck_subscriptions_ended_reason;
ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_ended_reason CHECK (ended_reason IN ('pending_expired',
  'abandoned','period_end','grace_expired','past_due_canceled','account_deleted','operator_terminated','refunded',
  'eligibility_rejected','term_completed','exceptional_refund'));
ALTER TABLE subscriptions DROP CONSTRAINT ck_subscriptions_expired_reason;
ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_expired_reason
  CHECK (status <> 'expired' OR ended_reason IN ('grace_expired','term_completed'));
-- an application waiting for its decision has paid nothing
ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_eligibility_unpaid
  CHECK (status <> 'pending_eligibility' OR periods_paid = 0);

-- one live subscription per account and venue, an application waiting for its eligibility decision included: a
-- unique index over the five live statuses, built concurrently in its own file
-- (0019_subscriptions_live_index.sql, 06 ERD §9.2 rule 5); uq_subscriptions_live of 0016 stays (a subset of it).

-- ---------------------------------------------------------------------
-- 3a. The eligibility application (DEC-596): the student number and the name as on the card, one per subscription,
--     decided by the platform (review), by the venue's eligible list (list), or by an approval of the same number at
--     the same venue within 180 days (reuse). POINT's record (V2-D12): the operator never reads it.
-- ---------------------------------------------------------------------
CREATE TABLE subscription_eligibility (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id),
  account_id       uuid NOT NULL REFERENCES customer_accounts(id),
  plan_id          uuid NOT NULL REFERENCES subscription_plans(id),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  venue_id         uuid NOT NULL REFERENCES venues(id),
  kind             text NOT NULL,
  student_number   text NOT NULL,
  student_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  source           text,
  decided_by       uuid REFERENCES platform_users(id),
  decided_at       timestamptz,
  decision_reason  text,
  version          int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subscription_eligibility_subscription UNIQUE (subscription_id),
  CONSTRAINT ck_subscription_eligibility_kind CHECK (kind IN ('student_id_review')),
  CONSTRAINT ck_subscription_eligibility_number CHECK (student_number ~ '^[A-Z0-9-]{3,32}$'),
  CONSTRAINT ck_subscription_eligibility_name CHECK (char_length(student_name) >= 2 AND char_length(student_name) <= 80),
  CONSTRAINT ck_subscription_eligibility_status CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT ck_subscription_eligibility_source CHECK (source IN ('review','list','reuse')),
  CONSTRAINT ck_subscription_eligibility_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT ck_subscription_eligibility_source_set CHECK ((status = 'pending') = (source IS NULL)),
  CONSTRAINT ck_subscription_eligibility_review_by CHECK (source <> 'review' OR decided_by IS NOT NULL),
  CONSTRAINT ck_subscription_eligibility_rejected CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
  CONSTRAINT ck_subscription_eligibility_no_pan
    CHECK (student_number !~ '[0-9]{13,}' AND student_name !~ '[0-9]{13,}' AND decision_reason !~ '[0-9]{13,}')
);
CREATE INDEX ix_subscription_eligibility_pending ON subscription_eligibility(venue_id, created_at)
  WHERE status = 'pending';
CREATE INDEX ix_subscription_eligibility_number ON subscription_eligibility(venue_id, student_number, decided_at)
  WHERE status = 'approved';

-- 3b. The venue's eligible list (DEC-597): numbers imported by the platform; a number leaves it with removed_at.
CREATE TABLE subscription_eligible_students (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  venue_id         uuid NOT NULL REFERENCES venues(id),
  student_number   text NOT NULL,
  added_by         uuid NOT NULL REFERENCES platform_users(id),
  added_at         timestamptz NOT NULL DEFAULT now(),
  removed_by       uuid REFERENCES platform_users(id),
  removed_at       timestamptz,
  CONSTRAINT ck_subscription_eligible_students_number CHECK (student_number ~ '^[A-Z0-9-]{3,32}$'),
  CONSTRAINT ck_subscription_eligible_students_no_pan CHECK (student_number !~ '[0-9]{13,}'),
  CONSTRAINT ck_subscription_eligible_students_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT ck_subscription_eligible_students_order CHECK (removed_at IS NULL OR removed_at >= added_at)
);
CREATE UNIQUE INDEX uq_subscription_eligible_students_live ON subscription_eligible_students(venue_id, student_number)
  WHERE removed_at IS NULL;

-- 3c. The customer's freeze of a counted-day term (DEC-594): asked ahead from the app with its start and return
--     days; one live (scheduled or active) freeze at a time; used once started, even when ended early.
CREATE TABLE subscription_freezes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id),
  account_id       uuid NOT NULL REFERENCES customer_accounts(id),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  venue_id         uuid NOT NULL REFERENCES venues(id),
  period_seq       int  NOT NULL,                     -- the term it belongs to (subscription_periods.seq)
  starts_on        date NOT NULL,
  returns_on       date NOT NULL,
  days             int  NOT NULL,                     -- counted days asked for
  status           text NOT NULL DEFAULT 'scheduled',
  used_days        int,                               -- counted days actually frozen
  ended_on         date,
  end_reason       text,
  version          int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_subscription_freezes_order CHECK (returns_on > starts_on),
  CONSTRAINT ck_subscription_freezes_days CHECK (days >= 1 AND days <= 30),
  CONSTRAINT ck_subscription_freezes_seq CHECK (period_seq >= 1),
  CONSTRAINT ck_subscription_freezes_status
    CHECK (status IN ('scheduled','active','completed','withdrawn','canceled')),
  CONSTRAINT ck_subscription_freezes_used CHECK (used_days >= 0),
  CONSTRAINT ck_subscription_freezes_used_set CHECK (status <> 'completed' OR used_days IS NOT NULL),
  CONSTRAINT ck_subscription_freezes_ended CHECK (status IN ('scheduled','active') OR ended_on IS NOT NULL),
  CONSTRAINT ck_subscription_freezes_end_reason
    CHECK (end_reason IN ('returned','early_reactivation','withdrawn','not_active','subscription_ended'))
);
CREATE UNIQUE INDEX uq_subscription_freezes_live ON subscription_freezes(subscription_id)
  WHERE status IN ('scheduled','active');
CREATE INDEX ix_subscription_freezes_subscription ON subscription_freezes(subscription_id, period_seq);

-- 3d. The purchase consent (DEC-601): terms and privacy versions, the price shown (net + VAT = total), the
--     non-refund condition and the valuables notice, recorded with the payment that starts a term. Append-only.
CREATE TABLE subscription_purchase_consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    uuid NOT NULL REFERENCES subscriptions(id),
  account_id         uuid NOT NULL REFERENCES customer_accounts(id),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  venue_id           uuid NOT NULL REFERENCES venues(id),
  plan_id            uuid NOT NULL REFERENCES subscription_plans(id),
  period_seq         int  NOT NULL,
  online_payment_id  uuid NOT NULL REFERENCES online_payments(id),
  terms_version      text NOT NULL,
  privacy_version    text NOT NULL,
  price_halalas      bigint NOT NULL,
  net_halalas        bigint NOT NULL,
  vat_halalas        bigint NOT NULL,
  non_refundable     boolean NOT NULL,
  valuables_notice   boolean NOT NULL,
  request_id         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subscription_purchase_consents_payment UNIQUE (online_payment_id),
  CONSTRAINT ck_subscription_purchase_consents_seq CHECK (period_seq >= 1),
  CONSTRAINT ck_subscription_purchase_consents_price CHECK (price_halalas >= 100),
  CONSTRAINT ck_subscription_purchase_consents_sum CHECK (price_halalas = net_halalas + vat_halalas),
  CONSTRAINT ck_subscription_purchase_consents_vat CHECK (vat_halalas >= 0),
  CONSTRAINT ck_subscription_purchase_consents_terms
    CHECK (char_length(terms_version) >= 1 AND char_length(terms_version) <= 40),
  CONSTRAINT ck_subscription_purchase_consents_privacy
    CHECK (char_length(privacy_version) >= 1 AND char_length(privacy_version) <= 40)
);
CREATE INDEX ix_subscription_purchase_consents_subscription ON subscription_purchase_consents(subscription_id);

-- ---------------------------------------------------------------------
-- 4. The venue's announced holidays and closures (DEC-599): shown before payment, the subscribers notified; the
--    counted days are not changed by them. Withdrawn with a reason, never deleted.
-- ---------------------------------------------------------------------
CREATE TABLE venue_closures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  venue_id       uuid NOT NULL REFERENCES venues(id),
  kind           text NOT NULL,
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,                       -- included
  reason_ar      text NOT NULL,
  created_by     uuid NOT NULL REFERENCES platform_users(id),
  canceled_at    timestamptz,
  canceled_by    uuid REFERENCES platform_users(id),
  cancel_reason  text,
  version        int  NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_venue_closures_kind CHECK (kind IN ('holiday','closure')),
  CONSTRAINT ck_venue_closures_order CHECK (ends_on >= starts_on),
  CONSTRAINT ck_venue_closures_reason CHECK (char_length(reason_ar) >= 3 AND char_length(reason_ar) <= 200),
  CONSTRAINT ck_venue_closures_canceled CHECK ((canceled_at IS NULL) = (canceled_by IS NULL)),
  CONSTRAINT ck_venue_closures_cancel_reason CHECK (canceled_at IS NULL OR cancel_reason IS NOT NULL),
  CONSTRAINT ck_venue_closures_no_pan CHECK (reason_ar !~ '[0-9]{13,}' AND cancel_reason !~ '[0-9]{13,}')
);
CREATE INDEX ix_venue_closures_venue ON venue_closures(venue_id, ends_on) WHERE canceled_at IS NULL;

-- ---------------------------------------------------------------------
-- 5. Customer complaints with a reference number (DEC-603, DEC-604): PT-C-000123 of ref_seq. Nothing deleted.
-- ---------------------------------------------------------------------
CREATE SEQUENCE customer_complaint_ref_seq START 1;
CREATE TABLE customer_complaints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_seq          bigint NOT NULL DEFAULT nextval('customer_complaint_ref_seq'),
  account_id       uuid NOT NULL REFERENCES customer_accounts(id),
  category         text NOT NULL,
  body             text NOT NULL,
  ticket_id        uuid REFERENCES tickets(id),
  subscription_id  uuid REFERENCES subscriptions(id),
  org_id           uuid REFERENCES organizations(id),
  venue_id         uuid REFERENCES venues(id),
  status           text NOT NULL DEFAULT 'open',
  resolution_note  text,
  handled_by       uuid REFERENCES platform_users(id),
  version          int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_complaints_ref UNIQUE (ref_seq),
  CONSTRAINT ck_customer_complaints_ref CHECK (ref_seq >= 1),
  CONSTRAINT ck_customer_complaints_category CHECK (category IN ('service','delay','vehicle_damage','lost_item',
    'payment','subscription','staff','other')),
  CONSTRAINT ck_customer_complaints_status CHECK (status IN ('open','in_progress','resolved','closed')),
  CONSTRAINT ck_customer_complaints_body CHECK (char_length(body) >= 10 AND char_length(body) <= 2000),
  CONSTRAINT ck_customer_complaints_note CHECK (char_length(resolution_note) >= 3 AND char_length(resolution_note) <= 1000),
  CONSTRAINT ck_customer_complaints_no_pan CHECK (body !~ '[0-9]{13,}' AND resolution_note !~ '[0-9]{13,}'),
  CONSTRAINT ck_customer_complaints_ticket_org CHECK (ticket_id IS NULL OR org_id IS NOT NULL),
  CONSTRAINT ck_customer_complaints_subscription_org CHECK (subscription_id IS NULL OR org_id IS NOT NULL),
  CONSTRAINT ck_customer_complaints_handled CHECK (status = 'open' OR handled_by IS NOT NULL)
);
ALTER SEQUENCE customer_complaint_ref_seq OWNED BY customer_complaints.ref_seq;
CREATE INDEX ix_customer_complaints_account ON customer_complaints(account_id, created_at);
CREATE INDEX ix_customer_complaints_status ON customer_complaints(status, created_at);

-- updated_at maintained by the trigger of 0001 (set_updated_at)
CREATE TRIGGER trg_subscription_eligibility_updated_at BEFORE UPDATE ON subscription_eligibility
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscription_freezes_updated_at BEFORE UPDATE ON subscription_freezes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_venue_closures_updated_at BEFORE UPDATE ON venue_closures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customer_complaints_updated_at BEFORE UPDATE ON customer_complaints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 6. The customer pushes of the annex (DEC-595, DEC-596, DEC-599): every kind allowed before stays allowed
-- ---------------------------------------------------------------------
ALTER TABLE customer_push_messages DROP CONSTRAINT ck_customer_push_kind;
ALTER TABLE customer_push_messages ADD CONSTRAINT ck_customer_push_kind CHECK (kind IN ('car_received',
  'request_accepted','car_ready','pickup_reminder','subscription_renewal','subscription_payment_failed',
  'subscription_expired','subscription_ending','subscription_eligibility_approved','subscription_eligibility_rejected',
  'subscription_venue_closure'));
ALTER TABLE customer_push_messages DROP CONSTRAINT ck_customer_push_subscription_kind;
ALTER TABLE customer_push_messages ADD CONSTRAINT ck_customer_push_subscription_kind CHECK (subscription_id IS NULL
  OR kind IN ('subscription_renewal','subscription_payment_failed','subscription_expired','subscription_ending',
  'subscription_eligibility_approved','subscription_eligibility_rejected','subscription_venue_closure'));

-- ---------------------------------------------------------------------
-- 7. Privileges (like 0016): nothing of these is ever deleted by the application; a consent is never changed
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON subscription_eligibility, subscription_eligible_students, subscription_freezes,
  venue_closures, customer_complaints TO point_app;
GRANT SELECT, INSERT ON subscription_purchase_consents TO point_app;
REVOKE DELETE ON subscription_eligibility, subscription_eligible_students, subscription_freezes, venue_closures,
  customer_complaints FROM point_app;
REVOKE UPDATE, DELETE ON subscription_purchase_consents FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;

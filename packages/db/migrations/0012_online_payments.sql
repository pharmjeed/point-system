-- V2-020 / V2-021 (docs/v2/03_Data_Model.md §4, docs/v2/04 §3, §6; DEC-510 … DEC-514): the online payments POINT
-- collects through its payment gateway (Moyasar, V2-D08 as set by DEC-460), apart from the operators' cash and POS
-- `payments` of V1. Card data never reaches these tables (PCI DSS SAQ-A, V2-D08): a saved card is the gateway's
-- token plus brand/last4/expiry, and every column that could carry a card number is checked like ck_payments_no_pan.
-- Append-only like every migration (DEC-129). 0010 and 0011 are reserved for parallel V2 streams. The tables are
-- created empty, so their indexes are built inline (06 ERD §9.2 rule 5 targets large live tables). CHECKs are flat
-- comparisons joined by OR (no BETWEEN and no nested AND groups), so pg_dump writes them back unchanged (restore drill).

-- ---------------------------------------------------------------------
-- 1. Saved cards: the gateway token only (C-18 comes with V2-023)
-- ---------------------------------------------------------------------
CREATE TABLE customer_payment_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES customer_accounts(id),
  gateway        text NOT NULL,
  gateway_token  text NOT NULL,                      -- e.g. token_… (Moyasar); never a card number
  brand          text,                               -- the gateway's company: mada, visa, master, amex …
  last4          text,
  expires_month  int,
  expires_year   int,
  is_default     boolean NOT NULL DEFAULT false,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_payment_methods_gateway CHECK (gateway IN ('moyasar')),
  CONSTRAINT ck_payment_methods_token CHECK (gateway_token ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT ck_payment_methods_no_pan CHECK (gateway_token !~ '[0-9]{13,}'),   -- PANs are 13-19 digits
  CONSTRAINT ck_payment_methods_brand CHECK (brand ~ '^[a-z_]{2,20}$'),
  CONSTRAINT ck_payment_methods_last4 CHECK (last4 ~ '^[0-9]{4}$'),
  CONSTRAINT ck_payment_methods_month CHECK (expires_month >= 1 AND expires_month <= 12),
  CONSTRAINT ck_payment_methods_year CHECK (expires_year >= 2000 AND expires_year <= 2100)
);
CREATE UNIQUE INDEX uq_payment_methods_token ON customer_payment_methods(gateway, gateway_token);
-- one default card per account among the cards still on file
CREATE UNIQUE INDEX uq_payment_methods_default ON customer_payment_methods(account_id) WHERE is_default AND removed_at IS NULL;
CREATE INDEX ix_payment_methods_account ON customer_payment_methods(account_id, created_at) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------
-- 2. Online payments (status machine of docs/v2/04 §3, DEC-512)
-- ---------------------------------------------------------------------
-- initiated → authorized → paid | failed; paid → partially_refunded → refunded. The state only moves forward and
-- only from what the gateway itself answers (its signed webhook confirmed by a server-side fetch, or the answer to
-- our own authenticated call); the customer's return from the 3-D Secure page changes nothing. The row is written
-- before the gateway is called (given_id is the gateway's idempotency key), so gateway_payment_id is filled by the
-- first answer. org_id/venue_id: the operator of the visit (settlement, V2-041); subscription_id gets its foreign key
-- with the subscriptions table (phase V4, V2-031).
CREATE TABLE online_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES customer_accounts(id),
  purpose             text NOT NULL,
  subscription_id     uuid,
  ticket_id           uuid REFERENCES tickets(id),
  org_id              uuid REFERENCES organizations(id),
  venue_id            uuid REFERENCES venues(id),
  payment_method_id   uuid REFERENCES customer_payment_methods(id),
  amount_halalas      bigint NOT NULL,              -- VAT included (04 §4)
  vat_halalas         bigint NOT NULL,
  refunded_halalas    bigint NOT NULL DEFAULT 0,    -- the gateway's cumulative refunded amount
  currency            text NOT NULL DEFAULT 'SAR',
  gateway             text NOT NULL,
  given_id            uuid NOT NULL,                -- sent as the gateway's given_id (idempotent creation)
  gateway_payment_id  text,
  source_type         text,                         -- token, applepay, creditcard (tokenized on the device)
  card_brand          text,
  card_last4          text,
  status              text NOT NULL DEFAULT 'initiated',
  failure_code        text,                         -- the gateway's response code or message key, no free text
  authorized_at       timestamptz,
  paid_at             timestamptz,
  failed_at           timestamptz,
  refunded_at         timestamptz,
  gateway_updated_at  timestamptz,                  -- updated_at of the gateway's record last applied
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_online_payments_gateway_id UNIQUE (gateway, gateway_payment_id),
  CONSTRAINT uq_online_payments_given_id UNIQUE (given_id),
  CONSTRAINT ck_online_payments_purpose CHECK (purpose IN ('visit','subscription')),
  CONSTRAINT ck_online_payments_visit_ticket CHECK (purpose <> 'visit' OR ticket_id IS NOT NULL),
  CONSTRAINT ck_online_payments_visit_org CHECK (purpose <> 'visit' OR org_id IS NOT NULL),
  CONSTRAINT ck_online_payments_visit_venue CHECK (purpose <> 'visit' OR venue_id IS NOT NULL),
  CONSTRAINT ck_online_payments_subscription CHECK (purpose <> 'subscription' OR subscription_id IS NOT NULL),
  CONSTRAINT ck_online_payments_amount CHECK (amount_halalas >= 100),           -- the gateway's minimum: 1.00 SAR
  CONSTRAINT ck_online_payments_vat CHECK (vat_halalas >= 0 AND vat_halalas < amount_halalas),
  CONSTRAINT ck_online_payments_refunded CHECK (refunded_halalas >= 0 AND refunded_halalas <= amount_halalas),
  CONSTRAINT ck_online_payments_currency CHECK (currency = 'SAR'),
  CONSTRAINT ck_online_payments_gateway CHECK (gateway IN ('moyasar')),
  CONSTRAINT ck_online_payments_status CHECK (status IN ('initiated','authorized','paid','failed','partially_refunded','refunded')),
  CONSTRAINT ck_online_payments_source CHECK (source_type IN ('token','applepay','creditcard','stcpay')),
  CONSTRAINT ck_online_payments_last4 CHECK (card_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT ck_online_payments_brand CHECK (card_brand ~ '^[a-z_]{2,20}$'),
  CONSTRAINT ck_online_payments_failure_code CHECK (failure_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT ck_online_payments_no_pan CHECK (gateway_payment_id !~ '[0-9]{13,}'),
  CONSTRAINT ck_online_payments_gateway_id CHECK (status IN ('initiated','failed') OR gateway_payment_id IS NOT NULL),
  CONSTRAINT ck_online_payments_paid_at CHECK (status NOT IN ('paid','partially_refunded','refunded') OR paid_at IS NOT NULL),
  CONSTRAINT ck_online_payments_failed_at CHECK (status <> 'failed' OR failed_at IS NOT NULL),
  CONSTRAINT ck_online_payments_refunded_full CHECK (status <> 'refunded' OR refunded_halalas = amount_halalas),
  CONSTRAINT ck_online_payments_refunded_part CHECK (status <> 'partially_refunded' OR refunded_halalas > 0),
  CONSTRAINT ck_online_payments_refunded_less CHECK (status <> 'partially_refunded' OR refunded_halalas < amount_halalas),
  CONSTRAINT ck_online_payments_refund_paid CHECK (refunded_halalas = 0 OR status IN ('partially_refunded','refunded'))
);
-- one successful online payment per ticket (docs/v2/03 §4, §6): paid or partly refunded (DEC-512)
CREATE UNIQUE INDEX uq_online_payments_ticket_paid ON online_payments(ticket_id)
  WHERE purpose = 'visit' AND status IN ('paid','partially_refunded');
CREATE INDEX ix_online_payments_account ON online_payments(account_id, created_at);
CREATE INDEX ix_online_payments_created ON online_payments(created_at);
CREATE INDEX ix_online_payments_ticket ON online_payments(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX ix_online_payments_org ON online_payments(org_id, created_at) WHERE org_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Refunds (P-06 / P-08, platform.refund_issue; DEC-513)
-- ---------------------------------------------------------------------
-- A refund is never deleted and never edited: requested by a platform account with a reason, then sent to the
-- gateway by the worker after COMMIT, ending succeeded or failed. Only that outcome may change (trg_refunds_guard).
CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  online_payment_id  uuid NOT NULL REFERENCES online_payments(id),
  amount_halalas     bigint NOT NULL,
  reason             text NOT NULL,
  issued_by          uuid NOT NULL REFERENCES platform_users(id),
  status             text NOT NULL DEFAULT 'requested',
  gateway_refund_id  text,
  failure_code       text,
  request_id         text,
  sent_at            timestamptz,                    -- the last time the worker sent it to the gateway
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_refunds_gateway_id UNIQUE (gateway_refund_id),
  CONSTRAINT ck_refunds_amount CHECK (amount_halalas > 0),
  CONSTRAINT ck_refunds_reason CHECK (char_length(reason) >= 3 AND char_length(reason) <= 500),
  CONSTRAINT ck_refunds_status CHECK (status IN ('requested','succeeded','failed')),
  CONSTRAINT ck_refunds_completed CHECK ((status = 'requested') = (completed_at IS NULL)),
  CONSTRAINT ck_refunds_failure_code CHECK (failure_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT ck_refunds_no_pan CHECK (reason !~ '[0-9]{13,}')
);
CREATE INDEX ix_refunds_payment ON refunds(online_payment_id, created_at);

CREATE FUNCTION refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.online_payment_id IS DISTINCT FROM OLD.online_payment_id OR NEW.amount_halalas IS DISTINCT FROM OLD.amount_halalas
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'refunds are append-only: only the gateway outcome may change' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'ck_refunds_immutable';
  END IF;
  IF OLD.status <> 'requested' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a completed refund is final' USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_refunds_final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_refunds_guard BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_guard();

-- ---------------------------------------------------------------------
-- 4. Gateway webhooks: stored once, processed once by the worker (the whatsapp_inbound_events pattern, DEC-512)
-- ---------------------------------------------------------------------
-- The body is kept as received minus its shared secret and with the card fields reduced to brand/last4 (payload);
-- body_sha256 is the hash of the exact bytes. A redelivery of the same event (gateway, event_id) is not stored again.
CREATE TABLE gateway_webhook_events (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway             text NOT NULL,
  event_id            text NOT NULL,
  event_type          text NOT NULL,
  gateway_payment_id  text,
  live                boolean,
  body_sha256         text NOT NULL,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  outcome             text,
  online_payment_id   uuid REFERENCES online_payments(id),
  CONSTRAINT uq_gateway_webhook_events UNIQUE (gateway, event_id),
  CONSTRAINT ck_gateway_webhook_events_gateway CHECK (gateway IN ('moyasar')),
  CONSTRAINT ck_gateway_webhook_events_outcome
    CHECK (outcome IN ('applied','unchanged','unknown_payment','conflict','not_at_gateway','ignored')),
  CONSTRAINT ck_gateway_webhook_events_processed CHECK ((processed_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT ck_gateway_webhook_events_no_pan CHECK (payload::text !~ '[0-9]{13,}')
);
CREATE INDEX ix_gateway_webhook_events_pending ON gateway_webhook_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX ix_gateway_webhook_events_payment ON gateway_webhook_events(gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. Daily reconciliation with the gateway (job.payments_reconcile, P-08; DEC-514)
-- ---------------------------------------------------------------------
CREATE TABLE payment_reconciliation_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway                text NOT NULL,
  run_date               date NOT NULL,              -- the Asia/Riyadh day compared
  status                 text NOT NULL DEFAULT 'running',
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  gateway_count          int,
  local_count            int,
  matched_count          int,
  mismatch_count         int,
  gateway_paid_halalas   bigint,                     -- paid minus refunded, per side
  local_paid_halalas     bigint,
  mismatches             jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason         text,
  CONSTRAINT ck_reconciliation_gateway CHECK (gateway IN ('moyasar')),
  CONSTRAINT ck_reconciliation_status CHECK (status IN ('running','matched','mismatched','failed')),
  CONSTRAINT ck_reconciliation_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT ck_reconciliation_counts CHECK (mismatch_count >= 0),
  CONSTRAINT ck_reconciliation_no_pan CHECK (mismatches::text !~ '[0-9]{13,}')
);
CREATE INDEX ix_reconciliation_runs_date ON payment_reconciliation_runs(gateway, run_date, started_at);

-- ---------------------------------------------------------------------
-- 6. Platform finance alerts (P-01 / P-08; DEC-514): the operators' `alerts` need a venue and reach the venue's
--    supervisors (14 §8); the platform's money is POINT's, so its alerts live here, one live row per dedupe key
-- ---------------------------------------------------------------------
CREATE TABLE platform_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               text NOT NULL,
  severity           text NOT NULL,
  status             text NOT NULL DEFAULT 'open',
  dedupe_key         text NOT NULL,
  online_payment_id  uuid REFERENCES online_payments(id),
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences        int NOT NULL DEFAULT 1,
  raised_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES platform_users(id),   -- NULL when resolved by the system
  resolution_note    text,
  CONSTRAINT ck_platform_alerts_type
    CHECK (type IN ('payment_unknown','payment_mismatch','payment_refund_failed','payment_reconcile_failed')),
  CONSTRAINT ck_platform_alerts_severity CHECK (severity IN ('info','warning','critical')),
  CONSTRAINT ck_platform_alerts_status CHECK (status IN ('open','acknowledged','resolved')),
  CONSTRAINT ck_platform_alerts_resolved CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT ck_platform_alerts_occurrences CHECK (occurrences >= 1),
  CONSTRAINT ck_platform_alerts_no_pan CHECK (details::text !~ '[0-9]{13,}')
);
CREATE UNIQUE INDEX uq_platform_alerts_live ON platform_alerts(dedupe_key) WHERE status <> 'resolved';
CREATE INDEX ix_platform_alerts_open ON platform_alerts(raised_at) WHERE status <> 'resolved';

-- updated_at maintained by the trigger of 0001 (set_updated_at)
CREATE TRIGGER trg_online_payments_updated_at BEFORE UPDATE ON online_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 7. Privileges (like 0008/0009): nothing financial is ever deleted by the application
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON customer_payment_methods, online_payments, refunds, gateway_webhook_events,
  payment_reconciliation_runs, platform_alerts TO point_app;
REVOKE DELETE ON customer_payment_methods, online_payments, refunds, gateway_webhook_events,
  payment_reconciliation_runs, platform_alerts FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;

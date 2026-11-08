-- V2-015 / V2-016 (docs/v2/01 R3/R4 C-12, C-13, §3; docs/v2/05 §1; DEC-516 … DEC-520): the customer requests the car
-- from the app, rates the visit once, and receives push notifications on the devices of the account. Append-only like
-- every migration (DEC-129). Checks are flat (no BETWEEN, no nested AND groups).

-- ---------------------------------------------------------------------
-- 1. A request from the customer app (DEC-516): the same retrieval command as the WhatsApp button, with its own
--    source. Widenings of V1 value lists (06 ERD §9.2 rules 3 and 4): every V1 value is kept, the auto-named V1
--    check gets an explicit name (SUPERSEDED_CONSTRAINTS of the drift check).
-- ---------------------------------------------------------------------
ALTER TABLE retrieval_cycles DROP CONSTRAINT retrieval_cycles_request_source_check;
ALTER TABLE retrieval_cycles ADD CONSTRAINT ck_cycles_request_source
  CHECK (request_source IN ('whatsapp','staff','app'));
-- a request from the app names the operator's customers row of the account, as the WhatsApp one does
ALTER TABLE retrieval_cycles ADD CONSTRAINT ck_cycles_app_requester
  CHECK (request_source <> 'app' OR requested_by_customer_id IS NOT NULL);

-- an early request (DEC-13) from the app while the car is being parked
ALTER TABLE tickets DROP CONSTRAINT tickets_pending_retrieval_source_check;
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_pending_retrieval_source
  CHECK (pending_retrieval_source IN ('whatsapp','app'));

-- ---------------------------------------------------------------------
-- 2. C-13 the rating of a visit (DEC-518): once per ticket, 1–5 stars and an optional note. The row belongs to the
--    operator's ticket (its org_id and venue_id) and to the account that gave it; never deleted. Deleting the account
--    (C-20) erases the note, the stars stay (DEC-508: the operator's data stays).
-- ---------------------------------------------------------------------
CREATE TABLE customer_visit_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  venue_id    uuid NOT NULL REFERENCES venues(id),
  ticket_id   uuid NOT NULL REFERENCES tickets(id),
  account_id  uuid NOT NULL REFERENCES customer_accounts(id),
  stars       int  NOT NULL,
  note        text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_visit_ratings_ticket UNIQUE (ticket_id),
  CONSTRAINT ck_customer_visit_ratings_stars_min CHECK (stars >= 1),
  CONSTRAINT ck_customer_visit_ratings_stars_max CHECK (stars <= 5),
  CONSTRAINT ck_customer_visit_ratings_note CHECK (char_length(note) <= 500)
);
CREATE INDEX ix_customer_visit_ratings_account ON customer_visit_ratings(account_id);
CREATE INDEX ix_customer_visit_ratings_venue ON customer_visit_ratings(venue_id, created_at);

-- ---------------------------------------------------------------------
-- 3. Push registration per session (POST /v1/customer/devices, DEC-519): the Expo push token of the signed-in
--    device. A token is registered on one live session only (it moves to the device's newest session), and a revoked
--    session holds none (logout, sign-in again, theft detection, account deletion all drop it).
-- ---------------------------------------------------------------------
ALTER TABLE customer_account_sessions ADD COLUMN push_provider text;
ALTER TABLE customer_account_sessions ADD COLUMN push_registered_at timestamptz;
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_push_provider
  CHECK (push_provider IN ('expo'));
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_push_pair
  CHECK ((push_token IS NULL) = (push_provider IS NULL));
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_push_registered
  CHECK ((push_token IS NULL) = (push_registered_at IS NULL));
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_push_token_len
  CHECK (char_length(push_token) <= 200);
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_revoked_push
  CHECK (revoked_at IS NULL OR push_token IS NULL);
-- the unique index of one token per session is built CONCURRENTLY, alone in 0013_customer_visits_push_token_index.sql
-- (06 ERD §9.2 rule 5: customer_account_sessions is a live table since 0009)

-- ---------------------------------------------------------------------
-- 4. Customer pushes (DEC-519, DEC-520): one row per notification and device session, written in the transaction of
--    the change with its job.customer_push_send; the worker sends after COMMIT and checks the provider's receipt later
--    (job.customer_push_receipts). No title, body, token or customer data is stored here: the text is rebuilt from
--    the kind at send time (lock-screen rule DEC-23), the token is read from the session.
-- ---------------------------------------------------------------------
CREATE TABLE customer_push_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES customer_accounts(id),
  session_id          uuid NOT NULL REFERENCES customer_account_sessions(id),
  org_id              uuid REFERENCES organizations(id),
  ticket_id           uuid REFERENCES tickets(id),
  kind                text NOT NULL,
  dedupe_key          text NOT NULL,
  source_outbox_id    uuid,
  status              text NOT NULL DEFAULT 'pending',
  skipped_reason      text,
  provider            text,
  provider_receipt_id text,
  receipt_status      text,
  error_code          text,
  attempts            int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  receipt_checked_at  timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_push_dedupe UNIQUE (dedupe_key),
  CONSTRAINT ck_customer_push_kind CHECK (kind IN ('car_received','request_accepted','car_ready','pickup_reminder',
    'subscription_renewal','subscription_payment_failed','subscription_expired')),
  CONSTRAINT ck_customer_push_status CHECK (status IN ('pending','sent','delivered','failed','skipped')),
  CONSTRAINT ck_customer_push_skipped_reason CHECK (skipped_reason IN ('no_token','session_revoked',
    'account_unavailable','stale','token_moved')),
  CONSTRAINT ck_customer_push_skipped CHECK ((status = 'skipped') = (skipped_reason IS NOT NULL)),
  CONSTRAINT ck_customer_push_provider CHECK (provider IN ('expo','simulator')),
  CONSTRAINT ck_customer_push_sent_provider CHECK (sent_at IS NULL OR provider IS NOT NULL),
  CONSTRAINT ck_customer_push_receipt_status CHECK (receipt_status IN ('ok','error')),
  CONSTRAINT ck_customer_push_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_customer_push_ticket_org CHECK (ticket_id IS NULL OR org_id IS NOT NULL)
);
CREATE INDEX ix_customer_push_account ON customer_push_messages(account_id, created_at);
CREATE INDEX ix_customer_push_receipts_due ON customer_push_messages(sent_at)
  WHERE status = 'sent' AND provider_receipt_id IS NOT NULL AND receipt_checked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON customer_visit_ratings, customer_push_messages TO point_app;
REVOKE DELETE ON customer_visit_ratings FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;
GRANT DELETE ON customer_push_messages TO point_retention;

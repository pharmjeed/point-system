-- V2-010 (docs/v2/03_Data_Model.md §3, docs/v2/05_API_Integrations.md §1.1; DEC-482, DEC-495 … DEC-499): the
-- customer at platform level. A customer account is not a member of any operator organization: these tables carry
-- no org_id, are read by the /v1/customer/* routes only, and an operator never sees them beyond V2-D12 (its own
-- `customers` rows, linked by customers.customer_account_id). Append-only like every migration (DEC-129). The new
-- tables are created empty, so their indexes are built inline (06 ERD §9.2 rule 5 targets large live tables); the
-- index on the live `customers` table is built CONCURRENTLY alone in 0011_customers_account_index.sql.

-- ---------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------
CREATE TABLE customer_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164     text NOT NULL,
  display_name   text,
  locale         text NOT NULL DEFAULT 'ar',
  status         text NOT NULL DEFAULT 'active',
  deleted_at     timestamptz,                       -- account deletion (C-20): personal data erased, financial records kept
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customer_accounts_phone UNIQUE (phone_e164),
  CONSTRAINT ck_customer_accounts_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT ck_customer_accounts_locale CHECK (locale IN ('ar','en')),
  CONSTRAINT ck_customer_accounts_status CHECK (status IN ('active','suspended','deleted')),
  CONSTRAINT ck_customer_accounts_deleted CHECK (status <> 'deleted' OR deleted_at IS NOT NULL),
  CONSTRAINT ck_customer_accounts_display_name CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 60)
);

-- ---------------------------------------------------------------------
-- 2. Sign-in codes over WhatsApp (V2-D11 as amended by DEC-460; DEC-496)
-- ---------------------------------------------------------------------
-- One row per code sent. The code is checked against code_hash = HMAC-SHA256(CODE_PEPPER, 'customer_otp:<id>:<code>')
-- (the claim-code pattern, DEC-15); code_ciphertext is the single encrypted copy the worker needs to send it after
-- COMMIT (no network inside a transaction, canon rule 3), wiped as soon as the send ends or the row stops being
-- open (ck_customer_otp_ciphertext). Attempts carry over to the next code of the number (a resend does not reset
-- them); the fifth wrong code locks the number (status 'locked', locked_until).
CREATE TABLE customer_otp_challenges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164           text NOT NULL,
  device_id            text NOT NULL,
  platform             text NOT NULL,
  locale               text NOT NULL DEFAULT 'ar',
  status               text NOT NULL DEFAULT 'open',
  code_hash            text NOT NULL,
  code_ciphertext      text,
  attempts_left        int  NOT NULL,
  expires_at           timestamptz NOT NULL,
  resend_available_at  timestamptz NOT NULL,
  locked_until         timestamptz,
  consumed_at          timestamptz,
  closed_at            timestamptz,                  -- superseded / locked / consumed
  wa_channel_id        uuid REFERENCES whatsapp_channel(id),
  delivery_status      text NOT NULL DEFAULT 'queued',
  wa_message_id        text,
  delivery_error_code  text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_customer_otp_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT ck_customer_otp_device CHECK (char_length(device_id) BETWEEN 8 AND 128),
  CONSTRAINT ck_customer_otp_platform CHECK (platform IN ('ios','android')),
  CONSTRAINT ck_customer_otp_locale CHECK (locale IN ('ar','en')),
  CONSTRAINT ck_customer_otp_status CHECK (status IN ('open','consumed','superseded','locked')),
  CONSTRAINT ck_customer_otp_attempts CHECK (attempts_left BETWEEN 0 AND 5),
  CONSTRAINT ck_customer_otp_expiry CHECK (expires_at > created_at AND resend_available_at > created_at),
  CONSTRAINT ck_customer_otp_locked CHECK ((status = 'locked') = (locked_until IS NOT NULL)),
  CONSTRAINT ck_customer_otp_consumed CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT ck_customer_otp_closed CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT ck_customer_otp_ciphertext CHECK (status = 'open' OR code_ciphertext IS NULL),
  CONSTRAINT ck_customer_otp_delivery CHECK (delivery_status IN ('queued','sent','failed','skipped')),
  CONSTRAINT ck_customer_otp_delivery_sent CHECK (delivery_status <> 'sent' OR (sent_at IS NOT NULL AND code_ciphertext IS NULL))
);
-- one live code per number: a new one supersedes the open one in the same transaction
CREATE UNIQUE INDEX uq_customer_otp_open_phone ON customer_otp_challenges(phone_e164) WHERE status = 'open';
CREATE INDEX ix_customer_otp_phone ON customer_otp_challenges(phone_e164, created_at);
CREATE INDEX ix_customer_otp_device ON customer_otp_challenges(device_id, created_at);
CREATE INDEX ix_customer_otp_locked ON customer_otp_challenges(phone_e164, locked_until) WHERE status = 'locked';

-- ---------------------------------------------------------------------
-- 3. Sessions: one per account and device (DEC-497)
-- ---------------------------------------------------------------------
-- Tokens are opaque, `<prefix>.<session id>.<256-bit secret>`; only their sha256 is stored. The access token (15 min)
-- and the refresh token (60 days from the sign-in) rotate together on every refresh; a refresh token that is not
-- the current one of its live session is a reuse and revokes the session (theft detection).
CREATE TABLE customer_account_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES customer_accounts(id),
  device_id           text NOT NULL,
  platform            text NOT NULL,
  refresh_hash        text NOT NULL,
  access_hash         text NOT NULL,
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  rotation_count      int  NOT NULL DEFAULT 0,
  push_token          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  refreshed_at        timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  CONSTRAINT uq_customer_sessions_refresh UNIQUE (refresh_hash),
  CONSTRAINT uq_customer_sessions_access UNIQUE (access_hash),
  CONSTRAINT ck_customer_sessions_device CHECK (char_length(device_id) BETWEEN 8 AND 128),
  CONSTRAINT ck_customer_sessions_platform CHECK (platform IN ('ios','android')),
  CONSTRAINT ck_customer_sessions_expiry CHECK (access_expires_at > created_at AND refresh_expires_at > created_at),
  CONSTRAINT ck_customer_sessions_rotation CHECK (rotation_count >= 0),
  CONSTRAINT ck_customer_sessions_revoked_reason
    CHECK (revoked_reason IN ('logout','refresh_reuse','device_mismatch','signed_in_again','account_closed','expired_cleanup')),
  CONSTRAINT ck_customer_sessions_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- one live session per account and device: signing in again on the device revokes the previous one
CREATE UNIQUE INDEX uq_customer_sessions_live_device ON customer_account_sessions(account_id, device_id)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_customer_sessions_account ON customer_account_sessions(account_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 4. Consents (append-only, with the version of the text shown)
-- ---------------------------------------------------------------------
CREATE TABLE customer_account_consents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES customer_accounts(id),
  kind        text NOT NULL,
  version     text NOT NULL,
  granted     boolean NOT NULL,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_customer_consents_kind CHECK (kind IN ('terms','privacy','marketing','card_on_file')),
  CONSTRAINT ck_customer_consents_version CHECK (char_length(version) BETWEEN 1 AND 40),
  -- withdrawing terms or privacy is deleting the account (C-20), never a «false» row
  CONSTRAINT ck_customer_consents_required_granted CHECK (kind NOT IN ('terms','privacy') OR granted)
);
CREATE INDEX ix_customer_consents_account ON customer_account_consents(account_id, kind, id);

-- ---------------------------------------------------------------------
-- 5. Vehicles (C-05/C-15: up to 5, the Saudi plate normalised as in tickets, 07 §1.8)
-- ---------------------------------------------------------------------
CREATE TABLE customer_vehicles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES customer_accounts(id),
  plate_country     text NOT NULL DEFAULT 'SA',
  plate_digits      text,
  plate_letters_ar  text,
  plate_letters_en  text,
  plate_raw         text,
  vehicle_make      text,
  vehicle_model     text,
  vehicle_color     text,
  vehicle_type      text,
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_customer_vehicles_digits CHECK (plate_digits ~ '^[0-9]{1,4}$'),
  CONSTRAINT ck_customer_vehicles_sa_plate CHECK (
    plate_country <> 'SA' OR (plate_digits IS NOT NULL AND plate_letters_ar IS NOT NULL AND plate_letters_en IS NOT NULL)),
  CONSTRAINT ck_customer_vehicles_type CHECK (vehicle_type IN ('sedan','suv','pickup','van','other'))
);
CREATE UNIQUE INDEX uq_customer_vehicles_plate ON customer_vehicles(account_id, plate_country, plate_digits, plate_letters_ar)
  WHERE removed_at IS NULL;
CREATE INDEX ix_customer_vehicles_account ON customer_vehicles(account_id, created_at) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------
-- 6. Idempotency keys of customer commands (07 §1.4 protocol, scoped per account): idempotency_keys.user_id
--    references users(id) and platform_idempotency_keys a platform account, neither can hold a customer
-- ---------------------------------------------------------------------
CREATE TABLE customer_idempotency_keys (
  account_id       uuid NOT NULL REFERENCES customer_accounts(id),
  key              text NOT NULL,
  operation        text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'in_progress',
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT pk_customer_idempotency_keys PRIMARY KEY (account_id, key),
  CONSTRAINT ck_customer_idempotency_keys_key CHECK (length(key) BETWEEN 8 AND 128),
  CONSTRAINT ck_customer_idempotency_keys_status CHECK (status IN ('in_progress','completed'))
);
CREATE INDEX ix_customer_idempotency_expiry ON customer_idempotency_keys(expires_at);

-- ---------------------------------------------------------------------
-- 7. Audit of customer actions (append-only like audit_log; DEC-498): sign-in, profile, consents, vehicles
-- ---------------------------------------------------------------------
CREATE TABLE customer_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL,
  account_id   uuid REFERENCES customer_accounts(id),
  action       text NOT NULL,                 -- e.g. customer.auth.otp_requested, customer.vehicle.add
  entity_type  text NOT NULL,
  entity_id    uuid,
  request_id   text,
  ip           inet,
  user_agent   text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ck_customer_audit_actor CHECK (
    (actor_type = 'customer' AND account_id IS NOT NULL) OR actor_type IN ('anonymous','system'))
);
CREATE INDEX ix_customer_audit_account ON customer_audit_log(account_id, occurred_at) WHERE account_id IS NOT NULL;
CREATE INDEX ix_customer_audit_occurred ON customer_audit_log(occurred_at);

-- ---------------------------------------------------------------------
-- 8. The link to the operators' customers rows (V2-D12; the unique index in 0011_customers_account_index.sql)
-- ---------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN customer_account_id uuid REFERENCES customer_accounts(id);

-- updated_at maintained by the trigger of 0001 (set_updated_at)
CREATE TRIGGER trg_customer_accounts_updated_at BEFORE UPDATE ON customer_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 9. Privileges (like 0008)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON customer_accounts, customer_otp_challenges, customer_account_sessions,
  customer_account_consents, customer_vehicles, customer_idempotency_keys, customer_audit_log TO point_app;
REVOKE UPDATE, DELETE ON customer_account_consents, customer_audit_log FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;
-- housekeeping of expired keys, like idempotency_keys (0002)
GRANT DELETE ON customer_idempotency_keys TO point_app;
-- the retention job may purge expired codes and sessions, like auth_sessions (0004)
GRANT DELETE ON customer_otp_challenges, customer_account_sessions TO point_retention;

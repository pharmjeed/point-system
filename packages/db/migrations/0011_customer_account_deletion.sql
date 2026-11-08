-- V2-017 (docs/v2/01 C-20, docs/v2/03 §3; DEC-507, DEC-508): deleting a customer account and the fresh WhatsApp
-- verification it needs. Append-only like every migration (DEC-129). Both tables are small and recent (0009), so
-- the checks are added inline (06 ERD §9.2 rule 5 targets the large live tables).

-- ---------------------------------------------------------------------
-- 1. A deleted account keeps its row (audit, consents and future financial records reference it) but no
--    personal data: the name is erased and the phone is replaced by an irreversible keyed hash
--    (HMAC-SHA256 with CODE_PEPPER), so the same number can sign up again as a new account
--    (uq_customer_accounts_phone ignores NULL) while support can still tell that it had an account before.
-- ---------------------------------------------------------------------
ALTER TABLE customer_accounts ADD COLUMN phone_hash text;
ALTER TABLE customer_accounts ALTER COLUMN phone_e164 DROP NOT NULL;
-- ck_customer_accounts_phone (0009) still checks every number present; only a deleted account may have none
ALTER TABLE customer_accounts ADD CONSTRAINT ck_customer_accounts_phone_present
  CHECK (status = 'deleted' OR phone_e164 IS NOT NULL);
ALTER TABLE customer_accounts ADD CONSTRAINT ck_customer_accounts_deleted_phone
  CHECK (status <> 'deleted' OR phone_e164 IS NULL);
ALTER TABLE customer_accounts ADD CONSTRAINT ck_customer_accounts_deleted_name
  CHECK (status <> 'deleted' OR display_name IS NULL);
ALTER TABLE customer_accounts ADD CONSTRAINT ck_customer_accounts_deleted_hash
  CHECK (status <> 'deleted' OR phone_hash IS NOT NULL);
ALTER TABLE customer_accounts ADD CONSTRAINT ck_customer_accounts_phone_hash
  CHECK (phone_hash IS NULL OR phone_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------
-- 2. The re-verification proof (POST /v1/customer/auth/reauth/verify): one per session, single use, 300 s; only
--    its sha256 is stored, like the session tokens (DEC-497)
-- ---------------------------------------------------------------------
ALTER TABLE customer_account_sessions ADD COLUMN reauth_hash text;
ALTER TABLE customer_account_sessions ADD COLUMN reauth_expires_at timestamptz;
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_reauth
  CHECK ((reauth_hash IS NULL) = (reauth_expires_at IS NULL));

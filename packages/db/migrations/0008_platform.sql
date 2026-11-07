-- V2-001 (docs/v2/03_Data_Model.md §1–§2, docs/v2/02_Platform_and_Operators.md; DEC-461 … DEC-465): the platform
-- layer above the organizations. Platform identity lives in its own tables, never in users/auth_sessions: a
-- platform account is not a member of any operator organization and an operator account cannot become one.
-- Append-only like every migration (DEC-129). New tables are created empty, so their indexes are built inline
-- (06 ERD §9.2 rule 5 targets large live tables). The organizations columns are additive with constant defaults:
-- every existing organization stays valid as an active operator run by its own company.

-- ---------------------------------------------------------------------
-- 1. Platform accounts (platform_owner · platform_admin · platform_finance · platform_support)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. Public venue profile (map listing, V2-004 fills it; V2-D07 subscriptions only on recurring venues)
-- ---------------------------------------------------------------------
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
    -- one flat AND (no BETWEEN): its deparsed text survives a dump/restore unchanged (restore drill, DEC-303)
    (lat IS NULL) = (lng IS NULL) AND (lat IS NULL OR (lat >= -90 AND lat <= 90 AND lng >= -180 AND lng <= 180))),
  CONSTRAINT ck_venue_public_profiles_pay_per_visit CHECK (pay_per_visit_halalas IS NULL OR pay_per_visit_halalas > 0),
  CONSTRAINT ck_venue_public_profiles_approved CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX ix_venue_public_profiles_org ON venue_public_profiles(org_id);
CREATE INDEX ix_venue_public_profiles_listed ON venue_public_profiles(category) WHERE status = 'approved';

-- updated_at maintained by the trigger of 0001 (set_updated_at), as on every mutable V1 table
CREATE TRIGGER trg_platform_users_updated_at BEFORE UPDATE ON platform_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_venue_public_profiles_updated_at BEFORE UPDATE ON venue_public_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Privileges (0002 granted the tables that existed then; these are new)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform_users, platform_sessions, platform_idempotency_keys, platform_audit_log,
  operator_contracts, venue_public_profiles TO point_app;
REVOKE UPDATE, DELETE ON platform_audit_log FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;
-- housekeeping of expired keys, like idempotency_keys (0002)
GRANT DELETE ON platform_idempotency_keys TO point_app;
-- the retention job may purge expired platform sessions, like auth_sessions (0004)
GRANT DELETE ON platform_sessions TO point_retention;

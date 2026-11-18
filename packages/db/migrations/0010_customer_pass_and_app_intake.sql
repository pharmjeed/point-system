-- V2-013 / V2-014 (docs/v2/03_Data_Model.md §3, docs/v2/04 §2, docs/v2/05 §1.3; DEC-500 … DEC-504): the customer's
-- entry pass (C-11, V2-D14) and the tickets it opens at intake (O-01, O-02). Append-only like every migration
-- (DEC-129). The CHECKs are simple ORs of single conditions (no BETWEEN, no nested AND groups, which the restore
-- drill's schema comparison does not survive). The index on the live `tickets` table is built
-- CONCURRENTLY alone in 0010_tickets_customer_vehicle_index.sql (06 ERD §9.2 rule 5).

-- ---------------------------------------------------------------------
-- 1. The entry pass: one secret per account (V2-D14; DEC-500)
-- ---------------------------------------------------------------------
-- The secret (32 random bytes, base64url) is stored only encrypted with DATA_ENCRYPTION_KEY (`encrypt()`, the
-- `mfa_secret_enc` pattern of 0008: text, `<key id>:<iv>:<tag>:<ciphertext>`), delivered to the signed-in device by
-- GET /v1/customer/pass, never logged. A rotation keeps the previous secret valid until previous_valid_until, so a
-- device that cached it and is offline keeps working. last_used_step is the newest step an intake consumed: an
-- older or equal step is refused (a screenshot replayed inside the ±1 window).
CREATE TABLE customer_passes (
  account_id                  uuid PRIMARY KEY REFERENCES customer_accounts(id),
  secret_ciphertext           text NOT NULL,
  previous_secret_ciphertext  text,
  previous_valid_until        timestamptz,
  key_version                 int  NOT NULL DEFAULT 1,
  last_used_step              bigint,
  last_used_at                timestamptz,
  rotated_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_customer_passes_previous CHECK ((previous_secret_ciphertext IS NULL) = (previous_valid_until IS NULL)),
  CONSTRAINT ck_customer_passes_key_version CHECK (key_version >= 1),
  CONSTRAINT ck_customer_passes_last_step CHECK (last_used_step IS NULL OR last_used_step >= 0),
  CONSTRAINT ck_customer_passes_last_used CHECK ((last_used_step IS NULL) = (last_used_at IS NULL))
);

-- ---------------------------------------------------------------------
-- 2. Tickets opened by the pass (V2-014; DEC-501, DEC-502)
-- ---------------------------------------------------------------------
-- The channel check of 06_schema.sql (auto-named tickets_channel_check) is widened with 'app' and renamed
-- (06 ERD §9.2 rules 3 and 4): a widening keeps every V1 value, nothing is narrowed.
ALTER TABLE tickets DROP CONSTRAINT tickets_channel_check;
ALTER TABLE tickets ADD CONSTRAINT ck_tickets_channel CHECK (channel IN ('whatsapp','paper','app'));

-- The vehicle of the customer's account the intake copied (customer_vehicles), and the entitlement decided at
-- intake (04 §2). tickets.subscription_id arrives with the subscriptions (phase V4, V2-03x), with its check
-- «entitlement = subscription ⇒ subscription_id»; until then the command never writes subscription or app_paid.
-- Existing rows keep 'none' (no backfill: the badge reads the payment state for them, DEC-502).
ALTER TABLE tickets
  ADD COLUMN customer_vehicle_id uuid CONSTRAINT fk_tickets_customer_vehicle REFERENCES customer_vehicles(id),
  ADD COLUMN entitlement text NOT NULL DEFAULT 'none',
  ADD CONSTRAINT ck_tickets_entitlement CHECK (entitlement IN ('none','subscription','app_paid','event_included')),
  -- an app ticket is linked to the account's customers row and never goes through WhatsApp linking (02 §3)
  ADD CONSTRAINT ck_tickets_app_customer CHECK (channel <> 'app' OR customer_id IS NOT NULL),
  ADD CONSTRAINT ck_tickets_app_no_whatsapp CHECK (channel <> 'app' OR wa_link_status = 'none'),
  -- a vehicle of a customer account belongs to an app ticket only
  ADD CONSTRAINT ck_tickets_customer_vehicle_app CHECK (customer_vehicle_id IS NULL OR channel = 'app');

-- ---------------------------------------------------------------------
-- 3. Privileges (like 0009)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON customer_passes TO point_app;

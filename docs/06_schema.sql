-- =====================================================================
-- POINT (staff) / MASAF (customer) — Valet system reference schema
-- File: docs/06_schema.sql      Version: 1.2 (2026-10-27) — named constraints, outbox seq, holder indexes, BSUID, closed reason lists
-- Target: PostgreSQL 16+ (validated on 16). Explained in 06_ERD_Database_Schema.md
--
-- Conventions
--   * snake_case; uuid primary keys (app may supply UUIDv7; default gen_random_uuid()).
--   * All times are timestamptz stored in UTC; UI displays Asia/Riyadh.
--   * Closed value sets use text + CHECK (values are binding: see 00_Glossary_Canon.md §5).
--   * Money is integer halalas (*_halalas bigint), currency SAR.
--   * `version int` = optimistic concurrency; every UPDATE does
--       SET version = version + 1 ... WHERE id = $1 AND version = $expected.
--   * Business invariants are enforced HERE (unique/partial indexes, CHECKs),
--     not only in application code. Do not drop them in migrations.
--   * No hard deletes for operational records; use status/void/reverse columns.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 1. Organization, venues, dispatch pools
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar       text NOT NULL,
  name_en       text,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- canon §12 (security.*, heartbeat.*, retention.*)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),   -- e.g. RMS
  name_ar       text NOT NULL,                                     -- e.g. قاعة ريماس
  name_en       text,
  address       text,
  city          text,
  timezone      text NOT NULL DEFAULT 'Asia/Riyadh',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,               -- canon §12 (dispatch.*, handover.*, ...)
  version       int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE dispatch_pools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  name          text NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_pass_at  timestamptz,          -- last dispatch pass (diagnostics)
  pass_count    bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, name)
);
-- One default pool per venue. The pool row is the dispatch LOCK (SELECT ... FOR NO KEY UPDATE; canon §14ب L1).
CREATE UNIQUE INDEX uq_dispatch_pools_default ON dispatch_pools(venue_id) WHERE is_default;

-- ---------------------------------------------------------------------
-- 2. Identity & access
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- permanent driver/staff ID
  org_id              uuid NOT NULL REFERENCES organizations(id),
  employee_code       text NOT NULL,                                 -- human ID, e.g. D-0042
  full_name           text NOT NULL,
  phone_e164          text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  role                text NOT NULL CHECK (role IN ('owner','admin','supervisor','driver')),
  can_drive           boolean NOT NULL DEFAULT false,                -- supervisors only (DEC-22); drivers implicitly drive
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  secret_kind         text NOT NULL CHECK (secret_kind IN ('pin','password')),
  secret_hash         text NOT NULL,                                 -- argon2id
  must_change_secret  boolean NOT NULL DEFAULT true,
  mfa_enabled         boolean NOT NULL DEFAULT false,
  mfa_secret_enc      text,                                          -- TOTP secret, encrypted with DATA_ENCRYPTION_KEY
  mfa_last_step       bigint,                                        -- last accepted TOTP time-step (replay protection)
  failed_login_count  int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  disabled_at         timestamptz,
  disabled_by         uuid REFERENCES users(id),
  disabled_reason     text,
  created_by          uuid REFERENCES users(id),
  version             int  NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, employee_code),
  UNIQUE (org_id, phone_e164),
  CONSTRAINT ck_users_secret_kind_by_role CHECK ((role = 'driver' AND secret_kind = 'pin') OR (role <> 'driver' AND secret_kind = 'password')),
  CONSTRAINT ck_users_can_drive_supervisor_only CHECK (can_drive = false OR role = 'supervisor'),
  CONSTRAINT ck_users_disabled_at CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);

CREATE TABLE role_scopes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  scope_type    text NOT NULL CHECK (scope_type IN ('org','venue')),
  venue_id      uuid REFERENCES venues(id),
  granted_by    uuid REFERENCES users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),
  CONSTRAINT ck_role_scopes_shape CHECK ((scope_type = 'org' AND venue_id IS NULL) OR (scope_type = 'venue' AND venue_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_role_scopes_org_active   ON role_scopes(user_id)           WHERE scope_type = 'org'   AND revoked_at IS NULL;
CREATE UNIQUE INDEX uq_role_scopes_venue_active ON role_scopes(user_id, venue_id) WHERE scope_type = 'venue' AND revoked_at IS NULL;

CREATE TABLE devices (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id),
  user_id                   uuid NOT NULL REFERENCES users(id),
  label                     text,
  user_agent                text,
  platform                  text NOT NULL DEFAULT 'other' CHECK (platform IN ('ios','android','desktop','other')),
  display_mode              text NOT NULL DEFAULT 'browser' CHECK (display_mode IN ('browser','standalone')),
  notification_permission   text NOT NULL DEFAULT 'default' CHECK (notification_permission IN ('default','granted','denied','unsupported')),
  push_endpoint             text,
  push_p256dh               text,
  push_auth                 text,
  push_subscribed_at        timestamptz,
  push_failed_count         int NOT NULL DEFAULT 0,
  audio_tested_at           timestamptz,
  audio_test_result         text CHECK (audio_test_result IN ('heard','not_heard','blocked')),
  last_seen_at              timestamptz,
  revoked_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_devices_push_triplet CHECK ((push_endpoint IS NULL) = (push_p256dh IS NULL) AND (push_endpoint IS NULL) = (push_auth IS NULL))
);
CREATE UNIQUE INDEX uq_devices_push_endpoint ON devices(push_endpoint) WHERE push_endpoint IS NOT NULL;
CREATE INDEX ix_devices_user ON devices(user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  device_id      uuid REFERENCES devices(id),
  token_hash     text NOT NULL UNIQUE,            -- sha256 of the opaque cookie token; token itself never stored
  mfa_verified   boolean NOT NULL DEFAULT false,
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('logout','transfer','disabled','secret_reset','admin','expired_cleanup'))
);
CREATE INDEX ix_auth_sessions_user_active ON auth_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE driver_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  driver_id     uuid NOT NULL REFERENCES users(id),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  status        text NOT NULL CHECK (status IN ('scheduled','active','ended')),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  reason        text,
  transfer_id   uuid,                                -- FK added below (driver_transfers)
  created_by    uuid NOT NULL REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assignments_ended_has_end CHECK (status <> 'ended' OR ends_at IS NOT NULL),
  CONSTRAINT ck_assignments_end_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
-- One active venue assignment per driver at any moment.
CREATE UNIQUE INDEX uq_driver_assignments_active ON driver_assignments(driver_id) WHERE status = 'active';
CREATE INDEX ix_driver_assignments_venue_active ON driver_assignments(venue_id) WHERE status = 'active';

CREATE TABLE driver_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  driver_id           uuid NOT NULL REFERENCES users(id),
  from_assignment_id  uuid REFERENCES driver_assignments(id),
  from_venue_id       uuid REFERENCES venues(id),
  to_venue_id         uuid NOT NULL REFERENCES venues(id),
  scheduled_at        timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','blocked','completed','canceled')),
  reason              text NOT NULL,
  blocked_details     jsonb,                          -- e.g. {"items":[{"type":"key","ticket_id":...}]}
  requested_by        uuid NOT NULL REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  completed_at        timestamptz,
  canceled_at         timestamptz,
  canceled_by         uuid REFERENCES users(id),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_transfers_distinct_venues CHECK (from_venue_id IS NULL OR from_venue_id <> to_venue_id)
);
CREATE UNIQUE INDEX uq_driver_transfers_open ON driver_transfers(driver_id) WHERE status IN ('pending','blocked');
ALTER TABLE driver_assignments
  ADD CONSTRAINT fk_driver_assignments_transfer FOREIGN KEY (transfer_id) REFERENCES driver_transfers(id);

-- ---------------------------------------------------------------------
-- 3. Events (الحفلات), shifts, duty sessions
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  venue_id              uuid NOT NULL REFERENCES venues(id),
  dispatch_pool_id      uuid NOT NULL REFERENCES dispatch_pools(id),
  name_ar               text NOT NULL,                 -- e.g. حفل زواج آل فلان
  host_name             text,
  event_date            date NOT NULL,                 -- local (Asia/Riyadh) date
  starts_at             timestamptz,
  ends_at               timestamptz,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closing','closed','canceled')),
  pricing_mode          text NOT NULL DEFAULT 'included' CHECK (pricing_mode IN ('included','per_vehicle')),
  fee_halalas           bigint NOT NULL DEFAULT 0 CHECK (fee_halalas >= 0),
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY['cash','pos']::text[],
  next_display_number   int NOT NULL DEFAULT 1 CHECK (next_display_number >= 1),  -- ticket counter (row-locked increment)
  opened_at             timestamptz,
  opened_by             uuid REFERENCES users(id),
  closing_started_at    timestamptz,
  closed_at             timestamptz,
  closed_by             uuid REFERENCES users(id),
  close_summary         jsonb,
  canceled_at           timestamptz,
  cancel_reason         text,
  created_by            uuid NOT NULL REFERENCES users(id),
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_events_fee_zero_unless_per_vehicle CHECK (pricing_mode = 'per_vehicle' OR fee_halalas = 0),
  CONSTRAINT ck_events_per_vehicle_fee_positive CHECK (pricing_mode = 'included' OR fee_halalas > 0),
  CONSTRAINT ck_events_payment_methods CHECK (allowed_payment_methods <@ ARRAY['cash','pos']::text[]),
  CONSTRAINT ck_events_closed_at CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE INDEX ix_events_venue_status ON events(venue_id, status);

CREATE TABLE shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  venue_id          uuid NOT NULL REFERENCES venues(id),
  dispatch_pool_id  uuid NOT NULL REFERENCES dispatch_pools(id),
  name              text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','open','closed')),
  opened_at         timestamptz,
  opened_by         uuid REFERENCES users(id),
  closed_at         timestamptz,
  closed_by         uuid REFERENCES users(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- At most one open shift per dispatch pool.
CREATE UNIQUE INDEX uq_shifts_open_per_pool ON shifts(dispatch_pool_id) WHERE status = 'open';

CREATE TABLE duty_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  shift_id           uuid NOT NULL REFERENCES shifts(id),
  venue_id           uuid NOT NULL REFERENCES venues(id),
  dispatch_pool_id   uuid NOT NULL REFERENCES dispatch_pools(id),
  assignment_id      uuid REFERENCES driver_assignments(id),   -- NULL for a supervisor with can_drive
  status             text NOT NULL DEFAULT 'on_duty' CHECK (status IN ('on_duty','on_break','ended')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  ended_by           uuid REFERENCES users(id),
  end_reason         text CHECK (end_reason IN ('self','forced','transfer','disabled','shift_closed')),
  available_since    timestamptz,             -- set when idle; NULL when busy/on break. Longest idle = MIN(available_since)
  last_heartbeat_at  timestamptz,
  connection_state   text NOT NULL DEFAULT 'online' CHECK (connection_state IN ('online','uncertain','offline')),
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_duty_ended_at CHECK (status <> 'ended' OR ended_at IS NOT NULL),
  CONSTRAINT ck_duty_available_only_on_duty CHECK (status = 'on_duty' OR available_since IS NULL)
);
-- One open duty session per user.
CREATE UNIQUE INDEX uq_duty_sessions_open ON duty_sessions(user_id) WHERE status <> 'ended';
CREATE INDEX ix_duty_sessions_pool_available ON duty_sessions(dispatch_pool_id, available_since)
  WHERE status = 'on_duty' AND available_since IS NOT NULL;
CREATE INDEX ix_duty_sessions_pool_open ON duty_sessions(dispatch_pool_id) WHERE status <> 'ended';

-- ---------------------------------------------------------------------
-- 4. Customers & consent
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  phone_e164        text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- NULL only for username users seen via BSUID
  wa_id             text,                      -- WhatsApp ID (phone-based) from webhooks
  wa_user_id        text,                      -- business-scoped user ID (BSUID) when the phone is hidden (DEC-35)
  locale            text NOT NULL DEFAULT 'ar',
  last_inbound_at   timestamptz,               -- customer service window anchor
  wa_opted_out_at   timestamptz,               -- «إيقاف»; no further template messages
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone_e164),
  CONSTRAINT ck_customers_identifier CHECK (phone_e164 IS NOT NULL OR wa_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_customers_wa_id      ON customers(org_id, wa_id)      WHERE wa_id IS NOT NULL;
CREATE UNIQUE INDEX uq_customers_wa_user_id ON customers(org_id, wa_user_id) WHERE wa_user_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. Venue physical setup: parking & keys
-- ---------------------------------------------------------------------
CREATE TABLE parking_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  venue_id    uuid NOT NULL REFERENCES venues(id),
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, name)
);

CREATE TABLE parking_spots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  venue_id    uuid NOT NULL REFERENCES venues(id),
  zone_id     uuid NOT NULL REFERENCES parking_zones(id),
  label       text NOT NULL,                  -- e.g. B-14
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, label)
);

CREATE TABLE key_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  venue_id    uuid NOT NULL REFERENCES venues(id),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, name)
);

CREATE TABLE key_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  key_board_id  uuid NOT NULL REFERENCES key_boards(id),
  label         text NOT NULL,                -- e.g. 12
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_board_id, label)
);

-- ---------------------------------------------------------------------
-- 6. Tickets & timeline
-- ---------------------------------------------------------------------
CREATE TABLE tickets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id),
  venue_id                 uuid NOT NULL REFERENCES venues(id),
  event_id                 uuid NOT NULL REFERENCES events(id),
  dispatch_pool_id         uuid NOT NULL REFERENCES dispatch_pools(id),
  display_number           int  NOT NULL CHECK (display_number >= 1),
  status                   text NOT NULL DEFAULT 'received' CHECK (status IN (
                             'received','parking','parked','requested','assigned','assigned_waiting',
                             'retrieving','ready','delivered','reparking','voided')),
  channel                  text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','paper')),
  customer_id              uuid REFERENCES customers(id),
  wa_link_status           text NOT NULL DEFAULT 'none' CHECK (wa_link_status IN (
                             'none','pending_send','pending_confirmation','linked','failed','opted_out')),
  link_version             int  NOT NULL DEFAULT 1,        -- bumped on phone/link change → old action tokens invalid
  paper_serial             text,
  -- vehicle
  plate_country            text NOT NULL DEFAULT 'SA',
  plate_digits             text CHECK (plate_digits ~ '^[0-9]{1,4}$'),
  plate_letters_ar         text,                            -- e.g. 'ب ح د' (normalized, space separated)
  plate_letters_en         text,                            -- e.g. 'B J D'
  plate_raw                text,                            -- non-Saudi / free form
  vehicle_make             text,
  vehicle_model            text,
  vehicle_color            text,
  vehicle_type             text CHECK (vehicle_type IN ('sedan','suv','pickup','van','other')),
  key_tag                  text,                            -- physical key tag number
  inspection_status        text NOT NULL DEFAULT 'pending' CHECK (inspection_status IN ('pending','complete','incomplete','exception_approved')),
  notes                    text,
  -- current placement & custody (history in custody_events / *_allocations)
  current_spot_id          uuid REFERENCES parking_spots(id),
  current_spot_note        text,
  current_key_slot_id      uuid REFERENCES key_slots(id),
  vehicle_holder_type      text NOT NULL DEFAULT 'driver' CHECK (vehicle_holder_type IN ('customer','driver','spot','supervisor','unknown')),
  vehicle_holder_id        uuid,
  key_holder_type          text NOT NULL DEFAULT 'driver' CHECK (key_holder_type IN ('customer','driver','key_slot','supervisor','unknown')),
  key_holder_id            uuid,
  -- retrieval
  pending_retrieval_at     timestamptz,                     -- early request while received/parking/reparking (DEC-13)
  pending_retrieval_source text CHECK (pending_retrieval_source IN ('whatsapp')),   -- staff requests need status parked (DEC-25)
  active_cycle_id          uuid,                            -- FK added after retrieval_cycles
  last_requested_at        timestamptz,
  -- payment
  payment_status           text NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required','due','collected','waived')),
  fee_halalas              bigint NOT NULL DEFAULT 0 CHECK (fee_halalas >= 0),
  payment_waived_at        timestamptz,
  payment_waived_by        uuid REFERENCES users(id),
  payment_waiver_reason    text,
  -- actors (documentation only; never used for dispatch priority)
  created_by               uuid NOT NULL REFERENCES users(id),
  parked_by                uuid REFERENCES users(id),
  retrieved_by             uuid REFERENCES users(id),       -- last cycle
  delivered_by             uuid REFERENCES users(id),
  submitted_at             timestamptz,
  parked_at                timestamptz,
  delivered_at             timestamptz,
  voided_at                timestamptz,
  voided_by                uuid REFERENCES users(id),
  void_reason              text,
  version                  int  NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, display_number),
  CONSTRAINT ck_tickets_delivered_fields CHECK (status <> 'delivered' OR (delivered_at IS NOT NULL AND delivered_by IS NOT NULL)),
  CONSTRAINT ck_tickets_voided_fields CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT ck_tickets_paper_serial CHECK (channel <> 'paper' OR paper_serial IS NOT NULL OR status IN ('received','voided')),
  CONSTRAINT ck_tickets_waiver_fields CHECK (payment_status <> 'waived' OR (payment_waived_at IS NOT NULL AND payment_waiver_reason IS NOT NULL)),
  CONSTRAINT ck_tickets_parked_holder CHECK (status NOT IN ('parked') OR (vehicle_holder_type = 'spot' OR vehicle_holder_type = 'unknown')),
  CONSTRAINT ck_tickets_fee_matches_payment_status CHECK ((payment_status = 'not_required') = (fee_halalas = 0))
);
CREATE UNIQUE INDEX uq_tickets_paper_serial ON tickets(event_id, paper_serial)
  WHERE paper_serial IS NOT NULL AND status <> 'voided';
-- A physical key tag can belong to one open ticket per venue.
CREATE UNIQUE INDEX uq_tickets_key_tag_open ON tickets(venue_id, key_tag)
  WHERE key_tag IS NOT NULL AND status NOT IN ('delivered','voided');
CREATE INDEX ix_tickets_event_status  ON tickets(event_id, status);
CREATE INDEX ix_tickets_plate_open    ON tickets(venue_id, plate_digits) WHERE status NOT IN ('delivered','voided');
CREATE INDEX ix_tickets_customer      ON tickets(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_tickets_creator_draft ON tickets(created_by) WHERE status = 'received';
-- open custody per driver (transfer / duty end / disable checks)
CREATE INDEX ix_tickets_vehicle_holder_open ON tickets(vehicle_holder_id) WHERE vehicle_holder_type = 'driver' AND status NOT IN ('delivered','voided');
CREATE INDEX ix_tickets_key_holder_open     ON tickets(key_holder_id)     WHERE key_holder_type = 'driver' AND status NOT IN ('delivered','voided');

CREATE TABLE ticket_events (                  -- append-only ticket timeline (written in the same TX as the change)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  ticket_id     uuid NOT NULL REFERENCES tickets(id),
  type          text NOT NULL,                -- domain event type (canon §7.1)
  actor_type    text NOT NULL CHECK (actor_type IN ('user','customer','system')),
  actor_id      text,
  ticket_version int NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ticket_events_ticket ON ticket_events(ticket_id, occurred_at);

CREATE TABLE customer_consents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  customer_id           uuid NOT NULL REFERENCES customers(id),
  ticket_id             uuid REFERENCES tickets(id),
  channel               text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  method                text NOT NULL CHECK (method IN ('verbal_staff_confirmed','customer_initiated')),
  captured_by           uuid REFERENCES users(id),
  captured_at           timestamptz NOT NULL DEFAULT now(),
  evidence_message_id   uuid,                 -- FK to whatsapp_messages added below (QR flow)
  revoked_at            timestamptz,
  revoke_source         text CHECK (revoke_source IN ('customer_opt_out','staff','admin')),
  CONSTRAINT ck_consents_verbal_has_staff CHECK (method <> 'verbal_staff_confirmed' OR captured_by IS NOT NULL)
);
CREATE INDEX ix_customer_consents_customer ON customer_consents(customer_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 7. Inspection & media (private object storage)
-- ---------------------------------------------------------------------
CREATE TABLE vehicle_inspections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  ticket_id            uuid NOT NULL REFERENCES tickets(id),
  kind                 text NOT NULL CHECK (kind IN ('intake','handover','incident')),
  captured_by          uuid NOT NULL REFERENCES users(id),
  notes                text,
  damage_marks         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{"area":"front_left","note":"خدش"}]
  required_photos_ok   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  ticket_id       uuid NOT NULL REFERENCES tickets(id),
  inspection_id   uuid REFERENCES vehicle_inspections(id),
  kind            text NOT NULL CHECK (kind IN ('photo_front','photo_rear','photo_left','photo_right','photo_extra','photo_damage')),
  storage_key     text NOT NULL UNIQUE,      -- private bucket key; never public
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg','image/webp','image/heic','image/png')),
  byte_size       int CHECK (byte_size > 0),
  sha256          text,
  upload_status   text NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending','uploaded','failed','deleted')),
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  captured_at     timestamptz,
  uploaded_at     timestamptz,
  deleted_at      timestamptz,
  delete_reason   text CHECK (delete_reason IN ('retention','correction','admin')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_media_ticket ON media_assets(ticket_id);

-- ---------------------------------------------------------------------
-- 8. Spot & key slot allocations (one active allocation per slot and per ticket)
-- ---------------------------------------------------------------------
CREATE TABLE spot_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  ticket_id        uuid NOT NULL REFERENCES tickets(id),
  parking_spot_id  uuid NOT NULL REFERENCES parking_spots(id),
  allocated_at     timestamptz NOT NULL DEFAULT now(),
  allocated_by     uuid NOT NULL REFERENCES users(id),
  released_at      timestamptz,
  released_by      uuid REFERENCES users(id),
  release_reason   text CHECK (release_reason IN ('retrieval_start','repark','correction','manual_reconcile','void','official_transfer'))
);
CREATE UNIQUE INDEX uq_spot_alloc_spot_active   ON spot_allocations(parking_spot_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_spot_alloc_ticket_active ON spot_allocations(ticket_id)       WHERE released_at IS NULL;

CREATE TABLE key_slot_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  ticket_id      uuid NOT NULL REFERENCES tickets(id),
  key_slot_id    uuid NOT NULL REFERENCES key_slots(id),
  allocated_at   timestamptz NOT NULL DEFAULT now(),
  allocated_by   uuid NOT NULL REFERENCES users(id),
  released_at    timestamptz,
  released_by    uuid REFERENCES users(id),
  release_reason text CHECK (release_reason IN ('key_pickup','correction','manual_reconcile','void','official_transfer'))
);
CREATE UNIQUE INDEX uq_key_alloc_slot_active   ON key_slot_allocations(key_slot_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX uq_key_alloc_ticket_active ON key_slot_allocations(ticket_id)   WHERE released_at IS NULL;

-- ---------------------------------------------------------------------
-- 9. Retrieval cycles, tasks, offers
-- ---------------------------------------------------------------------
CREATE TABLE retrieval_cycles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id),
  venue_id                  uuid NOT NULL REFERENCES venues(id),
  ticket_id                 uuid NOT NULL REFERENCES tickets(id),
  cycle_no                  int  NOT NULL CHECK (cycle_no >= 1),
  requested_at              timestamptz NOT NULL,          -- priority key (original time kept for early requests)
  request_source            text NOT NULL CHECK (request_source IN ('whatsapp','staff')),
  requested_by_user_id      uuid REFERENCES users(id),
  requested_by_customer_id  uuid REFERENCES customers(id),
  request_reason            text,                          -- required when source = staff
  requested_early           boolean NOT NULL DEFAULT false,
  assigned_at               timestamptz,
  assigned_waiting_at       timestamptz,
  accepted_by               uuid REFERENCES users(id),
  started_at                timestamptz,
  ready_at                  timestamptz,
  delivered_at              timestamptz,
  canceled_at               timestamptz,
  canceled_by               uuid REFERENCES users(id),
  cancel_reason             text,
  reparked_at               timestamptz,
  retrieved_by              uuid REFERENCES users(id),
  delivered_by              uuid REFERENCES users(id),
  handover_method           text CHECK (handover_method IN ('code','paper_stub','supervisor_exception','manual_reconcile')),
  outcome                   text CHECK (outcome IN ('delivered','canceled','reparked')),
  closed_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, cycle_no),
  CONSTRAINT ck_cycles_closed_outcome CHECK ((closed_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT ck_cycles_staff_requester CHECK (request_source <> 'staff' OR (requested_by_user_id IS NOT NULL AND request_reason IS NOT NULL)),
  CONSTRAINT ck_cycles_whatsapp_requester CHECK (request_source <> 'whatsapp' OR requested_by_customer_id IS NOT NULL)
);
-- One open retrieval request per ticket.
CREATE UNIQUE INDEX uq_retrieval_cycles_open ON retrieval_cycles(ticket_id) WHERE closed_at IS NULL;

ALTER TABLE tickets
  ADD CONSTRAINT fk_tickets_active_cycle FOREIGN KEY (active_cycle_id) REFERENCES retrieval_cycles(id);

CREATE TABLE tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  venue_id           uuid NOT NULL REFERENCES venues(id),
  dispatch_pool_id   uuid NOT NULL REFERENCES dispatch_pools(id),
  event_id           uuid NOT NULL REFERENCES events(id),
  ticket_id          uuid NOT NULL REFERENCES tickets(id),
  cycle_id           uuid REFERENCES retrieval_cycles(id),
  type               text NOT NULL CHECK (type IN ('park','retrieve','repark')),
  status             text NOT NULL CHECK (status IN (
                       'queued','offered','broadcast','assigned_waiting','accepted','in_progress','completed','canceled')),
  priority_at        timestamptz NOT NULL,          -- retrieve: cycle.requested_at; others: created_at
  seq                bigint GENERATED ALWAYS AS IDENTITY,   -- stable tie-breaker
  assignee_id        uuid REFERENCES users(id),
  queued_at          timestamptz,
  first_offered_at   timestamptz,
  broadcast_at       timestamptz,
  claimed_at         timestamptz,
  assigned_waiting_at timestamptz,
  accepted_at        timestamptz,
  key_picked_up_at   timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  canceled_at        timestamptz,
  canceled_by        uuid REFERENCES users(id),
  cancel_reason      text CHECK (cancel_reason IN ('customer_field_cancel','supervisor_cancel','repark_customer_absent',
                                                    'manual_reconcile','draft_discarded','ticket_voided')),
  escalated_at       timestamptz,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seq),
  CONSTRAINT ck_tasks_assignee_required CHECK (status IN ('queued','offered','broadcast','canceled') OR assignee_id IS NOT NULL),
  CONSTRAINT ck_tasks_unassigned_in_queue CHECK (status NOT IN ('queued','offered','broadcast') OR assignee_id IS NULL),
  CONSTRAINT ck_tasks_retrieve_has_cycle CHECK (type <> 'retrieve' OR cycle_id IS NOT NULL),
  CONSTRAINT ck_tasks_park_repark_states CHECK (type = 'retrieve' OR status IN ('in_progress','completed','canceled')),
  CONSTRAINT ck_tasks_completed_at CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT ck_tasks_canceled_at CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)
);
-- Invariants (architecture §9):
--   one open task per ticket (one movement per vehicle),
--   one active movement per driver (accepted|in_progress),
--   one reserved next task per driver (assigned_waiting).
CREATE UNIQUE INDEX uq_tasks_open_per_ticket       ON tasks(ticket_id)   WHERE status NOT IN ('completed','canceled');
CREATE UNIQUE INDEX uq_tasks_active_movement_driver ON tasks(assignee_id) WHERE status IN ('accepted','in_progress');
CREATE UNIQUE INDEX uq_tasks_next_per_driver        ON tasks(assignee_id) WHERE status = 'assigned_waiting';
CREATE INDEX ix_tasks_pool_queue ON tasks(dispatch_pool_id, priority_at, seq) WHERE status IN ('queued','offered','broadcast');
CREATE INDEX ix_tasks_ticket     ON tasks(ticket_id, created_at);

CREATE TABLE task_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  task_id           uuid NOT NULL REFERENCES tasks(id),
  dispatch_pool_id  uuid NOT NULL REFERENCES dispatch_pools(id),
  mode              text NOT NULL CHECK (mode IN ('single','broadcast')),
  round_no          int  NOT NULL CHECK (round_no >= 1),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','accepted','expired','revoked')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  reminder_at       timestamptz,
  reminded_at       timestamptz,
  expires_at        timestamptz,                       -- single: created_at + ttl; broadcast: NULL (escalation is separate)
  closed_at         timestamptz,
  close_reason      text CHECK (close_reason IN ('accepted','expired','claimed_elsewhere','task_canceled','reassigned','recipient_unavailable','converted_to_broadcast','converted_to_single','transfer')),
  accepted_by       uuid REFERENCES users(id),
  version           int NOT NULL DEFAULT 1,
  UNIQUE (task_id, round_no),
  CONSTRAINT ck_offers_single_expires CHECK (mode <> 'single' OR expires_at IS NOT NULL),
  CONSTRAINT ck_offers_active_open CHECK ((status = 'active') = (closed_at IS NULL)),
  CONSTRAINT ck_offers_accepted_by CHECK (status <> 'accepted' OR accepted_by IS NOT NULL)
);
-- One active offer round per task (a broadcast round has many recipients).
CREATE UNIQUE INDEX uq_task_offers_active ON task_offers(task_id) WHERE status = 'active';
CREATE INDEX ix_task_offers_pool_active ON task_offers(dispatch_pool_id) WHERE status = 'active';

CREATE TABLE offer_recipients (
  offer_id          uuid NOT NULL REFERENCES task_offers(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  duty_session_id   uuid NOT NULL REFERENCES duty_sessions(id),
  eligible_as       text NOT NULL CHECK (eligible_as IN ('accept','reserve_next','view_only')),  -- at offer time
  notified_ws_at    timestamptz,
  notified_push_at  timestamptz,
  seen_at           timestamptz,
  responded_at      timestamptz,
  response          text CHECK (response IN ('accepted','rejected_late')),
  PRIMARY KEY (offer_id, user_id)
);
CREATE INDEX ix_offer_recipients_user ON offer_recipients(user_id);

-- ---------------------------------------------------------------------
-- 10. Custody chain
-- ---------------------------------------------------------------------
CREATE TABLE custody_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  venue_id         uuid NOT NULL REFERENCES venues(id),
  ticket_id        uuid NOT NULL REFERENCES tickets(id),
  subject          text NOT NULL CHECK (subject IN ('vehicle','key')),
  from_holder_type text NOT NULL CHECK (from_holder_type IN ('customer','driver','spot','key_slot','supervisor','unknown')),
  from_holder_id   uuid,
  to_holder_type   text NOT NULL CHECK (to_holder_type IN ('customer','driver','spot','key_slot','supervisor','unknown')),
  to_holder_id     uuid,
  reason           text NOT NULL CHECK (reason IN ('intake','parked','key_deposited','key_pickup','retrieval_start','handover',
                                                   'repark','official_transfer','withdrawal_release','manual_reconcile','correction')),
  task_id          uuid REFERENCES tasks(id),
  actor_id         uuid NOT NULL REFERENCES users(id),
  note             text,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_custody_ticket ON custody_events(ticket_id, occurred_at);
CREATE INDEX ix_custody_to_driver ON custody_events(to_holder_id, occurred_at) WHERE to_holder_type = 'driver';

-- ---------------------------------------------------------------------
-- 11. WhatsApp (single central number) & notifications
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_channel (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id),
  display_name              text NOT NULL DEFAULT 'مصاف',
  business_account_id       text NOT NULL,          -- WABA ID
  phone_number_id           text NOT NULL,          -- the ONE production sender
  phone_display             text,
  access_token_secret_ref   text NOT NULL,          -- reference into the secret manager, never the token
  app_secret_ref            text NOT NULL,
  verify_token_secret_ref   text NOT NULL,
  api_version               text NOT NULL,          -- pinned Graph API version, e.g. 'vXX.0'
  mode                      text NOT NULL DEFAULT 'simulator' CHECK (mode IN ('live','simulator')),
  is_active                 boolean NOT NULL DEFAULT true,
  health_status             text NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy','degraded','down')),
  health_changed_at         timestamptz,
  quality_rating            text,
  messaging_limit_tier      text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- Exactly one active channel per organization/environment (no per-venue numbers).
CREATE UNIQUE INDEX uq_whatsapp_channel_active ON whatsapp_channel(org_id) WHERE is_active;

CREATE TABLE whatsapp_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),   -- e.g. masaf_ticket_issued_v1 (DEC-129)
  language          text NOT NULL DEFAULT 'ar',
  category          text NOT NULL CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','paused','disabled')),
  components        jsonb NOT NULL,
  meta_template_id  text,
  rejection_reason  text,
  version           int NOT NULL DEFAULT 1,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name, language)
);

CREATE TABLE notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  channel               text NOT NULL CHECK (channel IN ('whatsapp','push')),
  purpose               text NOT NULL,              -- W-xx ID (canon §11) or push kind (canon §5.7: offer, broadcast, reminder, next_due, escalation, closed)
  recipient_customer_id uuid REFERENCES customers(id),
  recipient_user_id     uuid REFERENCES users(id),
  recipient_device_id   uuid REFERENCES devices(id),
  venue_id              uuid REFERENCES venues(id),
  ticket_id             uuid REFERENCES tickets(id),
  task_id               uuid REFERENCES tasks(id),
  source_outbox_id      uuid,                       -- outbox event that produced it
  dedupe_key            text UNIQUE,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  skipped_reason        text CHECK (skipped_reason IN ('superseded','opted_out','no_consent','channel_down','stale','no_subscription')),
  attempts              int NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz,
  last_error_code       text,
  last_error_message    text,
  sent_at               timestamptz,
  failed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_notifications_recipient CHECK ((channel = 'whatsapp' AND recipient_customer_id IS NOT NULL) OR (channel = 'push' AND recipient_device_id IS NOT NULL))
);
CREATE INDEX ix_notifications_failed ON notifications(venue_id, created_at) WHERE status = 'failed';

CREATE TABLE notification_attempts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id          uuid NOT NULL REFERENCES notifications(id),
  attempt_no               int NOT NULL CHECK (attempt_no >= 1),
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  outcome                  text CHECK (outcome IN ('success','retryable_error','permanent_error')),
  http_status              int,
  provider_error_code      text,
  provider_error_message   text,
  UNIQUE (notification_id, attempt_no)
);

CREATE TABLE whatsapp_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  channel_id        uuid NOT NULL REFERENCES whatsapp_channel(id),
  direction         text NOT NULL CHECK (direction IN ('outbound','inbound')),
  wa_message_id     text,                                 -- provider id (wamid); NULL until accepted (outbound)
  notification_id   uuid REFERENCES notifications(id),
  customer_id       uuid REFERENCES customers(id),
  recipient_wa_id   text,
  sender_wa_id      text,
  recipient_user_id text,                                 -- BSUID when sending by user id (DEC-35)
  sender_user_id    text,                                 -- BSUID of an inbound sender without a visible phone
  ticket_id         uuid REFERENCES tickets(id),
  venue_id          uuid REFERENCES venues(id),
  event_id          uuid REFERENCES events(id),
  kind              text NOT NULL CHECK (kind IN ('template','session_text','inbound_text','inbound_button','inbound_interactive','inbound_other')),
  template_name     text,
  purpose           text,                                 -- canon §11 ID (W-01 … W-12)
  body_redacted     text,                                 -- rendered text with the claim code masked
  payload_redacted  jsonb,
  button_payload_hash text,                               -- inbound button: sha256(payload); raw token never stored
  status            text NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed','skipped','received')),
  status_rank       smallint NOT NULL DEFAULT 0,          -- queued 0, sent 1, delivered 2, read 3 — never decreases
  error_code        text,
  error_title       text,
  error_details     jsonb,
  pricing_category  text,
  billable          boolean,
  ordering_key      text,                                 -- ticket_id: per-ticket ordering of outbound messages
  queued_at         timestamptz,
  sent_at           timestamptz,
  delivered_at      timestamptz,
  read_at           timestamptz,
  failed_at         timestamptz,
  received_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_wa_messages_direction_status CHECK ((direction = 'inbound') = (status = 'received'))
);
-- Unique provider message id (dedupes webhook retries for inbound and statuses for outbound).
CREATE UNIQUE INDEX uq_whatsapp_messages_wamid ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX ix_whatsapp_messages_ticket   ON whatsapp_messages(ticket_id, created_at);
CREATE INDEX ix_whatsapp_messages_customer ON whatsapp_messages(customer_id, created_at);
CREATE INDEX ix_whatsapp_messages_failed   ON whatsapp_messages(venue_id, created_at) WHERE status = 'failed';

ALTER TABLE customer_consents
  ADD CONSTRAINT fk_customer_consents_evidence FOREIGN KEY (evidence_message_id) REFERENCES whatsapp_messages(id);

CREATE TABLE whatsapp_inbound_events (     -- raw verified webhook deliveries, saved BEFORE the 200 ACK
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid REFERENCES organizations(id),
  received_at            timestamptz NOT NULL DEFAULT now(),
  signature_verified_at  timestamptz NOT NULL,
  body_sha256            text NOT NULL UNIQUE,            -- exact duplicate deliveries are ignored
  raw_body               text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed','ignored')),
  attempts               int NOT NULL DEFAULT 0,
  processed_at           timestamptz,
  last_error             text
);
CREATE INDEX ix_whatsapp_inbound_pending ON whatsapp_inbound_events(received_at) WHERE status = 'pending';

CREATE TABLE action_tokens (               -- payload of the single «طلب السيارة» button
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  ticket_id      uuid NOT NULL REFERENCES tickets(id),
  customer_id    uuid NOT NULL REFERENCES customers(id),
  action         text NOT NULL DEFAULT 'request_retrieval' CHECK (action IN ('request_retrieval')),
  token_hash     text NOT NULL UNIQUE,      -- sha256(token); token = 128-bit random, base64url, never stored
  link_version   int  NOT NULL,             -- must equal tickets.link_version at use time
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  use_count      int NOT NULL DEFAULT 0
);
CREATE INDEX ix_action_tokens_ticket ON action_tokens(ticket_id);

CREATE TABLE link_codes (                  -- QR linking: wa.me deep link with a short-lived code
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  ticket_id            uuid NOT NULL REFERENCES tickets(id),
  code                 text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),   -- unambiguous alphabet (no 0/O/1/I)
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_confirmation','consumed','expired','revoked')),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  inbound_message_id   uuid REFERENCES whatsapp_messages(id),
  inbound_wa_id        text,
  inbound_user_id      text,                               -- BSUID when the sender hides the phone
  inbound_phone_e164   text,
  revoke_reason        text CHECK (revoke_reason IN ('driver_rejected_match','regenerated','linked_direct','ticket_voided','channel_paper')),
  confirmed_by         uuid REFERENCES users(id),
  confirmed_at         timestamptz
);
CREATE UNIQUE INDEX uq_link_codes_live_code   ON link_codes(code)      WHERE status IN ('active','pending_confirmation');
CREATE UNIQUE INDEX uq_link_codes_live_ticket ON link_codes(ticket_id) WHERE status IN ('active','pending_confirmation');

CREATE TABLE claim_codes (                 -- handover codes (DEC-15)
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  ticket_id         uuid NOT NULL REFERENCES tickets(id),
  cycle_id          uuid NOT NULL REFERENCES retrieval_cycles(id),
  code_hash         text NOT NULL,           -- HMAC-SHA256(CODE_PEPPER, cycle_id || ':' || code)
  code_ciphertext   text,                    -- the ONLY encrypted copy (AES-GCM) read by the W-05 sender; purged after provider acceptance or expiry (DEC-38)
  issued_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  attempts          int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 5,
  locked_at         timestamptz,
  consumed_at       timestamptz,
  consumed_by       uuid REFERENCES users(id),
  revoked_at        timestamptz,
  revoke_reason     text CHECK (revoke_reason IN ('resend','reparked','canceled','exception_handover','expired_cleanup')),
  resend_no         int NOT NULL DEFAULT 0,
  sent_message_id   uuid REFERENCES whatsapp_messages(id),
  CONSTRAINT ck_claim_attempts CHECK (attempts <= max_attempts),
  CONSTRAINT ck_claim_consumed_xor_revoked CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
-- One live code per retrieval cycle.
CREATE UNIQUE INDEX uq_claim_codes_live ON claim_codes(cycle_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 12. Payments & settlement (no card data)
-- ---------------------------------------------------------------------
CREATE TABLE cash_handovers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  venue_id            uuid NOT NULL REFERENCES venues(id),
  event_id            uuid NOT NULL REFERENCES events(id),
  driver_id           uuid NOT NULL REFERENCES users(id),
  received_by         uuid NOT NULL REFERENCES users(id),
  amount_halalas      bigint NOT NULL CHECK (amount_halalas >= 0),
  expected_halalas    bigint NOT NULL CHECK (expected_halalas >= 0),
  difference_halalas  bigint GENERATED ALWAYS AS (amount_halalas - expected_halalas) STORED,
  note                text,
  handed_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cash_handover_distinct_people CHECK (driver_id <> received_by)
);

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  venue_id          uuid NOT NULL REFERENCES venues(id),
  event_id          uuid NOT NULL REFERENCES events(id),
  ticket_id         uuid NOT NULL REFERENCES tickets(id),
  cycle_id          uuid REFERENCES retrieval_cycles(id),
  method            text NOT NULL CHECK (method IN ('cash','pos')),
  amount_halalas    bigint NOT NULL CHECK (amount_halalas > 0),
  currency          text NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  pos_reference     text,                    -- terminal receipt number only; never card data
  collected_by      uuid NOT NULL REFERENCES users(id),
  collected_at      timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','reversed')),
  reversed_at       timestamptz,
  reversed_by       uuid REFERENCES users(id),
  reversal_reason   text,
  cash_handover_id  uuid REFERENCES cash_handovers(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_payments_reversal_fields CHECK (status <> 'reversed' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL)),
  CONSTRAINT ck_payments_no_pan CHECK (pos_reference IS NULL OR pos_reference !~ '[0-9]{13,}')   -- PANs are 13-19 digits; server strips spaces/hyphens first
);
-- One non-reversed collection per ticket.
CREATE UNIQUE INDEX uq_payments_ticket_recorded ON payments(ticket_id) WHERE status = 'recorded';
CREATE INDEX ix_payments_event_driver ON payments(event_id, collected_by);

-- ---------------------------------------------------------------------
-- 13. Incidents & supervisor alerts
-- ---------------------------------------------------------------------
CREATE TABLE incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  venue_id      uuid NOT NULL REFERENCES venues(id),
  event_id      uuid REFERENCES events(id),
  ticket_id     uuid REFERENCES tickets(id),
  type          text NOT NULL CHECK (type IN ('key_missing','vehicle_damage','customer_absent','manual_verification','lost_ticket',
                                              'payment_discrepancy','inspection_incomplete','wrong_vehicle','custody_mismatch','other')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','closed')),
  severity      text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  description   text NOT NULL,
  opened_by     uuid NOT NULL REFERENCES users(id),
  owner_id      uuid REFERENCES users(id),
  resolution    text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  closed_at     timestamptz,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_incidents_resolution CHECK (status NOT IN ('resolved','closed') OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX ix_incidents_open ON incidents(venue_id, created_at) WHERE status IN ('open','in_review');

CREATE TABLE alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  venue_id          uuid NOT NULL REFERENCES venues(id),
  dispatch_pool_id  uuid REFERENCES dispatch_pools(id),
  event_id          uuid REFERENCES events(id),
  ticket_id         uuid REFERENCES tickets(id),
  task_id           uuid REFERENCES tasks(id),
  user_id           uuid REFERENCES users(id),          -- driver concerned (if any)
  type              text NOT NULL CHECK (type IN ('no_drivers_on_duty','request_unaccepted','next_task_waiting_long',
                      'idle_driver_while_next_waiting','ready_not_collected','wa_send_failed','wa_channel_down',
                      'driver_connection_lost_with_custody','handover_code_locked','inspection_incomplete','draft_abandoned',
                      'transfer_blocked','outbox_lag','push_failed_repeatedly','task_stuck','wa_webhook_silent')),
  severity          text NOT NULL CHECK (severity IN ('info','warning','critical')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  dedupe_key        text,                                -- e.g. 'request_unaccepted:<task_id>'
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES users(id),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users(id),           -- NULL when auto-resolved by the system
  resolution_note   text
);
CREATE UNIQUE INDEX uq_alerts_live_dedupe ON alerts(venue_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL;  -- one live alert per venue and key (DEC-46)
CREATE INDEX ix_alerts_venue_live ON alerts(venue_id, raised_at) WHERE status <> 'resolved';

-- ---------------------------------------------------------------------
-- 14. Outbox, idempotency, audit, analytics, exports
-- ---------------------------------------------------------------------
CREATE TABLE outbox_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- commit-independent monotonic order (per-ordering-key serialization)
  org_id             uuid NOT NULL REFERENCES organizations(id),
  type               text NOT NULL,                 -- domain event (canon §7.1) or job.* (canon §7.2)
  aggregate_type     text,
  aggregate_id       uuid,
  aggregate_version  int,                           -- re-checked when a timer/job fires
  venue_id           uuid REFERENCES venues(id),
  ordering_key       text,                          -- serialize per key: 'wa:<ticket_id>' for job.wa_send; NULL for domain events (DEC-41)
  dedupe_key         text,                          -- collapse duplicate pending jobs (e.g. 'dispatch_pass:<pool_id>')
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at       timestamptz NOT NULL DEFAULT now(),   -- timers: now() + delay
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed','dead','canceled')),
  attempts           int NOT NULL DEFAULT 0,
  max_attempts       int NOT NULL DEFAULT 8,
  locked_by          text,
  locked_until       timestamptz,                   -- lease; another worker resumes after expiry
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT ck_outbox_processing_lease CHECK (status <> 'processing' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL))
);
CREATE UNIQUE INDEX uq_outbox_dedupe_pending ON outbox_events(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','processing');
CREATE INDEX ix_outbox_due      ON outbox_events(available_at) WHERE status = 'pending';
CREATE INDEX ix_outbox_lease    ON outbox_events(locked_until) WHERE status = 'processing';
CREATE INDEX ix_outbox_ordering ON outbox_events(ordering_key, seq) WHERE ordering_key IS NOT NULL AND status IN ('pending','processing');

CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id),
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  operation        text NOT NULL,                  -- e.g. 'POST /v1/task-offers/{id}/accept'
  request_hash     text NOT NULL,                  -- sha256 of canonical JSON body + path params
  status           text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX ix_idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE audit_log (                    -- append-only (grant INSERT/SELECT only to the app role)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user','customer','system')),
  actor_id     text,
  action       text NOT NULL,                 -- permission/command, e.g. 'task.reassign', 'ticket.reveal_phone'
  entity_type  text,
  entity_id    uuid,
  venue_id     uuid,
  request_id   text,
  ip           inet,
  user_agent   text,
  reason       text,
  before       jsonb,                         -- minimal diff, no secrets/codes/full phones
  after        jsonb,
  metadata     jsonb
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id, occurred_at);
CREATE INDEX ix_audit_actor  ON audit_log(actor_id, occurred_at);
CREATE INDEX ix_audit_time   ON audit_log(occurred_at);

CREATE TABLE analytics_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,                -- see 15_Event_Tracking_Plan.md
  source         text NOT NULL CHECK (source IN ('server','client')),
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  venue_id       uuid,
  event_id       uuid,
  dispatch_pool_id uuid,
  actor_role     text,
  actor_id       uuid,
  ticket_id      uuid,
  task_id        uuid,
  cycle_id       uuid,
  app_version    text,
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb   -- never phone numbers, plates, codes or key positions
);
CREATE INDEX ix_analytics_name_time  ON analytics_events(name, occurred_at);
CREATE INDEX ix_analytics_venue_time ON analytics_events(venue_id, occurred_at);

CREATE TABLE exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  requested_by  uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('event_summary','tickets','payments','drivers','messages','audit')),
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed','expired')),
  storage_key   text,
  row_count     int,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz
);

-- ---------------------------------------------------------------------
-- 15. Derived views (reference implementations of canon §5.6)
-- ---------------------------------------------------------------------
CREATE VIEW v_driver_state AS
SELECT ds.id               AS duty_session_id,
       ds.user_id,
       ds.venue_id,
       ds.dispatch_pool_id,
       ds.status           AS duty_status,
       ds.available_since,
       ds.connection_state,
       ds.last_heartbeat_at,
       act.id              AS active_task_id,
       act.type            AS active_task_type,
       nxt.id              AS next_task_id,
       CASE
         WHEN ds.status = 'on_break'                       THEN 'on_break'
         WHEN act.id IS NOT NULL AND nxt.id IS NOT NULL    THEN 'busy_with_next'
         WHEN act.type IN ('park','repark')                THEN 'intake_parking'
         WHEN act.type = 'retrieve'                        THEN 'retrieving'
         ELSE 'available'
       END                 AS driver_state
FROM duty_sessions ds
LEFT JOIN tasks act ON act.assignee_id = ds.user_id AND act.status IN ('accepted','in_progress')
LEFT JOIN tasks nxt ON nxt.assignee_id = ds.user_id AND nxt.status = 'assigned_waiting'
WHERE ds.status <> 'ended';

CREATE VIEW v_pool_queue AS                 -- oldest-first open retrieval demand per pool
SELECT t.dispatch_pool_id, t.id AS task_id, t.ticket_id, t.cycle_id, t.status, t.priority_at, t.seq,
       o.id AS active_offer_id, o.mode AS active_offer_mode, o.expires_at AS offer_expires_at
FROM tasks t
LEFT JOIN task_offers o ON o.task_id = t.id AND o.status = 'active'
WHERE t.type = 'retrieve' AND t.status IN ('queued','offered','broadcast')
ORDER BY t.dispatch_pool_id, t.priority_at, t.seq;

-- ---------------------------------------------------------------------
-- 16. updated_at triggers
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','venues','dispatch_pools','users','devices','driver_assignments','driver_transfers',
    'events','shifts','duty_sessions','customers','parking_zones','parking_spots','key_boards','key_slots',
    'tickets','tasks','whatsapp_channel','whatsapp_templates','notifications','whatsapp_messages','incidents']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

COMMIT;

-- ---------------------------------------------------------------------
-- 17. Privileges (apply per environment; role names are examples)
-- ---------------------------------------------------------------------
-- CREATE ROLE point_app LOGIN;            -- used by api + worker
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO point_app;
-- REVOKE UPDATE, DELETE ON audit_log, ticket_events, custody_events, analytics_events FROM point_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO point_app;
-- DELETE is granted only to the retention job role for media_assets/whatsapp_messages purges (see 06 ERD §Retention).

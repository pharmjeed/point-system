-- 06_schema.sql §17 applied as a migration: the application role used by api + worker.
-- Append-only tables (audit_log, ticket_events, custody_events, analytics_events) never get
-- UPDATE or DELETE (PNT-009). Login users for each environment are granted membership in point_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'point_app') THEN
    CREATE ROLE point_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO point_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO point_app;
REVOKE UPDATE, DELETE ON audit_log, ticket_events, custody_events, analytics_events FROM point_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO point_app;
-- Row purges are limited to the retention job's tables and to housekeeping of expired keys.
GRANT DELETE ON media_assets, whatsapp_messages, whatsapp_inbound_events, idempotency_keys TO point_app;

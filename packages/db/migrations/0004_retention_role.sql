-- PNT-091: the database role of job.retention_purge (06 ERD §8.3: "a separate database role with DELETE
-- on the purgeable tables only"; 06_schema.sql §17; 09 §11, §12.9 least privilege).
-- point_app keeps no UPDATE/DELETE on the append-only tables (PNT-009): only point_retention may delete
-- audit_log and analytics_events rows past retention.audit_months / retention.analytics_months.
-- The job switches to this role with SET LOCAL ROLE inside its own short transactions; the worker's login
-- role is granted membership per environment (GRANT point_retention TO <worker login>).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'point_retention') THEN
    CREATE ROLE point_retention NOLOGIN;
  END IF;
END $$;

-- SELECT, INSERT (its audit rows), UPDATE (redaction, marking) through point_app
GRANT point_app TO point_retention;

-- row purges of 06 ERD §8.1 that point_app may not do
GRANT DELETE ON audit_log, analytics_events, outbox_events, notifications, notification_attempts,
  exports, action_tokens, link_codes, auth_sessions, alerts
  TO point_retention;

-- anonymizing a closed ticket clears the free-text note of its custody chain (06 ERD §8.1)
GRANT UPDATE (note) ON custody_events TO point_retention;

-- The SystemMonitor (outbox_lag on any dead row) and GET /v1/admin/outbox read failed/dead rows on
-- every tick; they are rare, so a small partial index avoids scanning the whole outbox.
CREATE INDEX IF NOT EXISTS ix_outbox_failed_dead ON outbox_events (seq) WHERE status IN ('failed', 'dead');

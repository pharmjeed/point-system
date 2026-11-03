-- GAP-9 (12 §13): a supervisor's resolution of a WhatsApp quota alert holds for its month or its 24 h window, so the
-- SystemMonitor looks for manually resolved rows of a quota key before raising it again at a venue. Resolved alerts
-- are kept 12 months (retention) and the two partial indexes of 06 cover live rows only; this one keeps that lookup
-- an index range scan. Built CONCURRENTLY (06 ERD §9.2 rule 5): one statement alone in the file, sent outside any
-- transaction block; an interrupted build leaves an INVALID index, which the runner refuses (packages/db/src/migrate.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_alerts_manual_resolved
  ON alerts (org_id, dedupe_key, resolved_at)
  WHERE status = 'resolved' AND resolved_by IS NOT NULL;

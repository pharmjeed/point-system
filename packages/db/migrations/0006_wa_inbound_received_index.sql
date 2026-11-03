-- Server sweep (05 §12.2, 14 §8): the time of the last webhook delivery of an organization is read once a minute by
-- the sender (`wa_webhook_silent`, DEC-146) and by the SystemMonitor (point_wa_webhook_last_received_timestamp_seconds
-- in every process, not only in the api that received it). whatsapp_inbound_events keeps processed rows for
-- retention.wa_messages_days, so `max(received_at)` per organization needs an index to stay a single index probe.
-- Built CONCURRENTLY (06 ERD §9.2 rule 5: the webhook intake inserts into this table before its 200 ACK while the
-- migrations of a new version run): one statement alone in the file, sent outside any transaction block; an
-- interrupted build leaves an INVALID index, which the runner refuses (packages/db/src/migrate.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_whatsapp_inbound_org_received ON whatsapp_inbound_events (org_id, received_at);

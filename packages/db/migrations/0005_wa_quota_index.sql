-- GAP-9 (12 §13, F-03, F-18): the SystemMonitor counts, per organization, the outbound WhatsApp messages the
-- provider accepted over the current month (service messages) and over the last 24 h (templates sent outside the
-- customer service window). whatsapp_messages only grows (retention clears its text, never its rows), so a partial
-- index keeps both counts range scans instead of full scans of the table. Additive: no constraint changes.
CREATE INDEX IF NOT EXISTS ix_whatsapp_messages_accepted
  ON whatsapp_messages (org_id, queued_at)
  WHERE direction = 'outbound' AND wa_message_id IS NOT NULL;

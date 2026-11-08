-- V2-051 (DEC-564): the status webhooks of a sign-in code (C-02) find their challenge by the message id the provider
-- gave the send (customer_otp_challenges.wa_message_id; a code has no whatsapp_messages row by design, DEC-38), so
-- they are acknowledged at once instead of retried five times as orphans. Its own file, built concurrently because
-- the table grows with every sign-in (06 ERD §9.2 rule 5).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_customer_otp_wamid ON customer_otp_challenges(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

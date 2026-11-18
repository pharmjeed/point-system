-- V2-022 (DEC-521): the live online payments of a ticket, read by the pay command under the ticket lock («one payment
-- in progress»). Its own file, built concurrently (06 ERD §9.2 rule 5).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_online_payments_ticket_live ON online_payments(ticket_id, created_at)
  WHERE purpose = 'visit' AND status IN ('initiated','authorized');

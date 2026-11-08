-- V2-033 (docs/v2/04 §2, DEC-535): the visits a subscription covered (P-07, the settlement of V2-041, the «one open
-- ticket per covered vehicle» check at intake). Its own file, built concurrently (06 ERD §9.2 rule 5).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_tickets_subscription ON tickets(subscription_id, created_at)
  WHERE subscription_id IS NOT NULL;

-- V2-031 (docs/v2/04 §1, DEC-533): the payments of a subscription, read under its lock by the renewal (one charge
-- per period and attempt) and by C-14 (the latest payment). Its own file, built concurrently (06 ERD §9.2 rule 5).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_online_payments_subscription ON online_payments(subscription_id, created_at)
  WHERE subscription_id IS NOT NULL;

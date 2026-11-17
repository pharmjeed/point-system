-- V2-036 (DEC-596): one live subscription per account and venue now counts an application waiting for its
-- eligibility decision (`pending_eligibility`) too. A superset of uq_subscriptions_live (0016, kept), built
-- concurrently in its own file because subscriptions is a live table (06 ERD §9.2 rule 5).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_subscriptions_live_eligibility ON subscriptions(account_id, venue_id)
  WHERE status IN ('pending_eligibility','pending_payment','active','past_due','frozen');

-- V2-024 (P-06, DEC-527): the platform ends every live session of a customer account with a recorded reason.
-- The revocation reason of customer_account_sessions (0009) is widened with 'platform_revoked' (06 ERD §9.2 rule 3:
-- a widening keeps every value, nothing is narrowed), so the session row says who ended it and the app's next
-- request gets AUTH_SESSION_REVOKED with that reason. A flat IN list: no BETWEEN, no nested AND (the restore drill).
ALTER TABLE customer_account_sessions DROP CONSTRAINT ck_customer_sessions_revoked_reason;
ALTER TABLE customer_account_sessions ADD CONSTRAINT ck_customer_sessions_revoked_reason
  CHECK (revoked_reason IN ('logout','refresh_reuse','device_mismatch','signed_in_again','account_closed','expired_cleanup','platform_revoked'));

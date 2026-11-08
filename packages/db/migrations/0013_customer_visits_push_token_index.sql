-- V2-016 (DEC-519): a push token belongs to one live customer session at a time (POST /v1/customer/devices moves it
-- to the newest one). Built CONCURRENTLY, alone in its file, because customer_account_sessions is a live table
-- (06 ERD §9.2 rule 5); the columns come from 0013_customer_visits_push.sql. An interrupted build leaves an INVALID
-- index and the migration is not recorded.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_customer_sessions_push_token ON customer_account_sessions(push_token) WHERE push_token IS NOT NULL;

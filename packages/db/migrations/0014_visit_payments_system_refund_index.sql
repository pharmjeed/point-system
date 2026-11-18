-- V2-022 (DEC-523): one automatic (system) refund per online payment. Its own file, built concurrently after the
-- refunds.kind column of 0014_visit_payments.sql (06 ERD §9.2 rule 5).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_refunds_system ON refunds(online_payment_id) WHERE kind = 'system';

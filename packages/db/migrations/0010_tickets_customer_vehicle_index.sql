-- V2-014 (DEC-502): the open visits of a customer's vehicle (`in_active_visit` of C-15, the visit cards of the account).
-- Built CONCURRENTLY, alone in its file, because tickets is a live table (06 ERD §9.2 rule 5); the column comes from
-- 0010_customer_pass_and_app_intake.sql. An interrupted build leaves an INVALID index and the migration is not recorded.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_tickets_customer_vehicle_open ON tickets(customer_vehicle_id) WHERE customer_vehicle_id IS NOT NULL AND status NOT IN ('delivered','voided');

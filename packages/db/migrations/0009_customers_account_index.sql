-- V2-010 (docs/v2/03_Data_Model.md §3, V2-D12): one customers row per operator and customer account. Built
-- CONCURRENTLY, alone in its file, because customers is a live table (06 ERD §9.2 rule 5); the column comes
-- from 0009_customer_accounts.sql. An interrupted build leaves an INVALID index and the migration is not recorded.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_customers_org_account ON customers(org_id, customer_account_id) WHERE customer_account_id IS NOT NULL;

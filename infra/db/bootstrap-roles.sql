-- Roles and database of one environment (docs/DEPLOYMENT.md; 06_schema.sql §17; migrations 0002, 0004).
-- Run ONCE per environment as the database administrator (a superuser, or the provider's admin role with
-- CREATEROLE and CREATEDB), BEFORE the first migration:
--   psql "postgres://<admin>@<host>:5432/postgres?sslmode=verify-full" \
--     -v owner_pw="$POINT_OWNER_DB_PASSWORD" -v api_pw="$POINT_API_DB_PASSWORD" \
--     -v worker_pw="$POINT_WORKER_DB_PASSWORD" [-v db=point] -f infra/db/bootstrap-roles.sql
-- Re-running it is safe; the given passwords are (re)applied, which is also how they are rotated.
--
--   point_owner      LOGIN  owns the database and every object, runs the migrations (MIGRATION_DATABASE_URL)
--   point_api        LOGIN  member of point_app                    (API_DATABASE_URL)
--   point_worker     LOGIN  member of point_app (WORKER_DATABASE_URL) and of point_retention WITHOUT inheritance:
--                           job.retention_purge switches to it with SET LOCAL ROLE, nothing else can delete
--   point_app        NOLOGIN  SELECT/INSERT/UPDATE (+ a few DELETEs) granted by 0002; never UPDATE/DELETE on the
--                             append-only tables audit_log, ticket_events, custody_events, analytics_events (PNT-009)
--   point_retention  NOLOGIN  the purge's extra DELETEs, granted by 0004
-- The runtime roles never own anything, so the append-only rule holds for them (an owner bypasses REVOKE).
\set ON_ERROR_STOP on
\if :{?db}
\else
  \set db point
\endif
\if :{?owner_pw}
\else
  \echo 'set -v owner_pw=… -v api_pw=… -v worker_pw=…'
  \quit
\endif

-- group roles first: the migrations find them and the owner may grant them (ADMIN OPTION, PostgreSQL 16)
SELECT 'CREATE ROLE point_app NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'point_app') \gexec
SELECT 'CREATE ROLE point_retention NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'point_retention') \gexec

SELECT 'CREATE ROLE point_owner LOGIN CREATEROLE' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'point_owner') \gexec
SELECT 'CREATE ROLE point_api LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'point_api') \gexec
SELECT 'CREATE ROLE point_worker LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'point_worker') \gexec
SELECT format('ALTER ROLE point_owner PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE point_api PASSWORD %L', :'api_pw') \gexec
SELECT format('ALTER ROLE point_worker PASSWORD %L', :'worker_pw') \gexec

GRANT point_app, point_retention TO point_owner WITH ADMIN OPTION;
GRANT point_app TO point_api;
GRANT point_app TO point_worker;
-- not inherited: the worker holds the purge's DELETEs only inside SET LOCAL ROLE point_retention (PNT-091)
GRANT point_retention TO point_worker WITH INHERIT FALSE, SET TRUE;

-- PostgreSQL 16: creating a database owned by point_owner requires being able to SET ROLE to it
GRANT point_owner TO CURRENT_USER;
SELECT format('CREATE DATABASE %I OWNER point_owner ENCODING ''UTF8'' TEMPLATE template0', :'db')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO point_api, point_worker', :'db') \gexec

\connect :db
-- PostgreSQL 15+: public belongs to the database owner and PUBLIC cannot create in it
ALTER SCHEMA public OWNER TO point_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO point_app;
SELECT 'roles ready: point_owner, point_api, point_worker; database ' || current_database() AS bootstrap;

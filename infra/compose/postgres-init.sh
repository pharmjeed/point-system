#!/bin/sh
# /docker-entrypoint-initdb.d hook of the `local-db` profile (docker-compose.prod.yml): on the FIRST start with
# an empty data directory, creates the roles and the database of infra/db/bootstrap-roles.sql (point_owner,
# point_api, point_worker, point_app, point_retention, database «point»). Later starts skip it.
set -eu
: "${POINT_OWNER_DB_PASSWORD:?POINT_OWNER_DB_PASSWORD is required}"
: "${POINT_API_DB_PASSWORD:?POINT_API_DB_PASSWORD is required}"
: "${POINT_WORKER_DB_PASSWORD:?POINT_WORKER_DB_PASSWORD is required}"
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$POINT_OWNER_DB_PASSWORD" -v api_pw="$POINT_API_DB_PASSWORD" -v worker_pw="$POINT_WORKER_DB_PASSWORD" \
  -f /point/bootstrap-roles.sql

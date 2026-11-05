#!/usr/bin/env bash
# `docker compose` for this server's POINT stack (DEC-457): the compose files chosen by infra/deploy/install.sh
# (POINT_COMPOSE_FILES in .env) and the .env of the repository root. Any compose sub-command:
#   bash infra/deploy/pc.sh ps
#   bash infra/deploy/pc.sh logs -f --tail 100 api worker
#   bash infra/deploy/pc.sh run --rm migrate
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${POINT_ENV_FILE:-$ROOT/.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE: run infra/deploy/install.sh first" >&2; exit 1; }
files="$(sed -n 's/^POINT_COMPOSE_FILES=//p' "$ENV_FILE" | tail -1)"
files="${files:-infra/compose/docker-compose.prod.yml}"
args=()
IFS=':' read -r -a list <<<"$files"
for f in "${list[@]}"; do args+=(-f "$ROOT/$f"); done
exec docker compose --project-directory "$ROOT/infra/compose" --env-file "$ENV_FILE" "${args[@]}" "$@"

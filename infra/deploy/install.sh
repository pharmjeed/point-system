#!/usr/bin/env bash
# One-command install / update of POINT on one Linux server with Docker (DEC-457; docs/DEPLOYMENT.md §14).
# Run on the server, from a clone of the repository (re-running it later is the update: it keeps .env):
#   bash infra/deploy/install.sh
#
# What it does:
#   1. checks Docker + Compose v2 and chooses the mode:
#        gateway  the server already has a shared Caddy gateway container on 80/443 that imports
#                 /data/conf.d/*.caddyfile (POINT_GATEWAY_CONTAINER, default vm-caddy-1): POINT's own Caddy
#                 serves plain HTTP on one host address, and a site file «point.caddyfile» in the gateway adds
#                 DOMAIN (TLS by the gateway) and, in staging, the WhatsApp simulator page behind a password
#        direct   ports 80/443 are free: POINT's Caddy owns them and obtains the certificate itself
#      anything else on 80/443 stops the script (it never takes over another project's ports);
#   2. writes .env once (chmod 600) with every secret generated HERE with openssl — no secret leaves the server,
#      none is printed except the simulator page password and the owner's one-time password;
#   3. staging stack: PostgreSQL 16 + MinIO on this server, the WhatsApp simulator (no real customer is ever
#      messaged; APP_ENV=staging, WA_MODE=simulator — going live is docs/DEPLOYMENT.md §8);
#   4. builds the images, runs the migrations, starts the stack, waits for /health/ready;
#   5. creates the first owner once (create-owner prints a one-time password).
#
# Non-interactive: set the answers in the environment and POINT_YES=1, e.g.
#   POINT_YES=1 DOMAIN=app.example.sa ACME_EMAIL=ops@example.sa OWNER_PHONE=05XXXXXXXX OWNER_NAME='…' bash …
# Overrides: POINT_MODE=gateway|direct · POINT_GATEWAY_CONTAINER · POINT_HTTP_PORT (8095) · POINT_SIM_PORT (8097)
#            SIM_DOMAIN (sim.<root>; empty = no public simulator page) · POINT_SKIP_BUILD=1 · POINT_SKIP_OWNER=1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
PC=(bash "$ROOT/infra/deploy/pc.sh")

say() { printf '\n\033[1m>> %s\033[0m\n' "$*"; }
ok() { printf '   ✓ %s\n' "$*"; }
warn() { printf '   ! %s\n' "$*" >&2; }
die() {
  printf '\n!! %s\n' "$*" >&2
  exit 1
}
interactive() { [ "${POINT_YES:-0}" != 1 ] && [ -t 0 ]; }
ask() { # ask VAR "question" default
  local var=$1 q=$2 def=${3:-} v
  if [ -n "${!var:-}" ]; then return; fi
  if interactive; then
    read -r -p "   $q [${def}]: " v
    printf -v "$var" '%s' "${v:-$def}"
  else
    printf -v "$var" '%s' "$def"
  fi
}
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }
env_set() { # replace or append KEY=VALUE in .env
  local k=$1 v=$2 tmp
  tmp="$(mktemp)"
  if grep -q "^$k=" "$ENV_FILE"; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$k" "$v" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}
b64() { openssl rand -base64 32 | tr -d '\n'; }
# brand names come from settings (canon §1): the defaults of .env.example
brand() { sed -n "s/^$1=//p" "$ROOT/.env.example" | awk '{print $1}' | head -1; }
hex() { openssl rand -hex "${1:-24}"; }
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
port_free() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

# ------------------------------------------------------------------------------------------ 1. prerequisites
say "Checking the server"
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/ubuntu/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (package docker-compose-plugin)"
docker info >/dev/null 2>&1 || die "this user cannot use Docker: add it to the docker group (sudo usermod -aG docker \$USER), log in again"
for c in openssl ss awk sed curl getent; do command -v "$c" >/dev/null || die "missing command: $c"; done
ok "$(docker --version | cut -d, -f1) · $(docker compose version --short) · $(uname -m)"
avail_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "${avail_gb:-0}" -ge 10 ] || warn "only ${avail_gb} GB free on /: the images and the database need ~10 GB"

GW="${POINT_GATEWAY_CONTAINER:-vm-caddy-1}"
MODE="${POINT_MODE:-}"
if [ -z "$MODE" ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$GW"; then
    MODE=gateway
  elif ss -ltnH '( sport = :80 or sport = :443 )' | grep -q . && ! docker ps --format '{{.Names}}' | grep -qx 'point-web-1'; then
    die "ports 80/443 are taken by something that is not a known gateway. Free them, or run its reverse proxy in
   front of POINT by hand (docs/DEPLOYMENT.md §14), or set POINT_GATEWAY_CONTAINER to its Caddy container."
  else
    MODE=direct
  fi
fi
case "$MODE" in gateway | direct) ;; *) die "POINT_MODE must be gateway or direct" ;; esac
ok "mode: $MODE"

if [ "$MODE" = gateway ]; then
  docker ps --format '{{.Names}}' | grep -qx "$GW" || die "gateway container $GW is not running"
  docker exec "$GW" grep -q 'import /data/conf.d/\*.caddyfile' /etc/caddy/Caddyfile ||
    die "$GW does not import /data/conf.d/*.caddyfile: its Caddyfile must contain that line"
  GW_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' "$GW" | awk '{print $1}')
  CONF_DIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$GW")/conf.d"
  [ -n "$GW_IP" ] && [ "$CONF_DIR" != /conf.d ] || die "cannot read the network or the /data volume of $GW"
  GW_CADDY=$(docker exec "$GW" caddy version | awk '{print $1}')
  ok "gateway $GW (Caddy $GW_CADDY) reaches this host on $GW_IP; site files in $CONF_DIR"
fi

# ------------------------------------------------------------------------------------------ 2. answers
say "Settings"
DOMAIN="${DOMAIN:-$(env_get DOMAIN)}"
ask DOMAIN "Staff app host name" "app.pointsa.net"
ROOT_DOMAIN="${DOMAIN#*.}"
ACME_EMAIL="${ACME_EMAIL:-$(env_get ACME_EMAIL)}"
ask ACME_EMAIL "Operator e-mail (certificates, Web Push contact)" "ops@${ROOT_DOMAIN}"
if [ "$MODE" = gateway ]; then
  # SIM_DOMAIN set in the environment (even empty) wins; then the previous run's answer; then ask
  if [ "${SIM_DOMAIN+x}" != x ]; then
    if [ -f "$ENV_FILE" ] && grep -q '^POINT_SIM_DOMAIN=' "$ENV_FILE"; then
      SIM_DOMAIN="$(env_get POINT_SIM_DOMAIN)"
    else
      SIM_DOMAIN=""
      ask SIM_DOMAIN "Host name of the WhatsApp simulator page (none = no page)" "sim.${ROOT_DOMAIN}"
      [ "$SIM_DOMAIN" != none ] || SIM_DOMAIN=""
    fi
  fi
fi
OWNER_PHONE="${OWNER_PHONE:-}"
OWNER_NAME="${OWNER_NAME:-}"
if [ "${POINT_SKIP_OWNER:-0}" != 1 ] && [ -z "$(env_get POINT_OWNER_CREATED)" ]; then
  ask OWNER_PHONE "Owner's mobile (05XXXXXXXX) for the first sign-in" ""
  ask OWNER_NAME "Owner's full name" ""
  ask ORG_NAME_AR "Organization name in Arabic" "$(brand BRAND_STAFF_NAME_AR)"
  ask ORG_NAME_EN "Organization name in English" "POINT"
fi
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "invalid host name: $DOMAIN"

# DNS: Caddy keeps retrying until the record exists, but say it now
PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
check_dns() {
  local host=$1 ip
  ip=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -z "$ip" ]; then
    warn "$host has no DNS A record yet: add  A  ${host%%.${ROOT_DOMAIN}}  →  ${PUBLIC_IP:-<the public IP of this server>}"
    return 1
  elif [ -n "$PUBLIC_IP" ] && [ "$ip" != "$PUBLIC_IP" ]; then
    warn "$host points at $ip, but this server is $PUBLIC_IP: fix the A record"
    return 1
  fi
  ok "$host → $ip"
}
check_dns "$DOMAIN" || true
[ -z "${SIM_DOMAIN:-}" ] || check_dns "$SIM_DOMAIN" || true

# ------------------------------------------------------------------------------------------ 3. .env
if [ ! -f "$ENV_FILE" ]; then
  say "Writing .env with new secrets (kept on this server only)"
  umask 077
  der="$(mktemp)"
  openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$der" 2>/dev/null
  VAPID_PRIVATE=$(head -c 39 "$der" | tail -c 32 | b64url)
  VAPID_PUBLIC=$(tail -c 65 "$der" | b64url)
  rm -f "$der"
  OWNER_PW=$(hex 24) API_PW=$(hex 24) WORKER_PW=$(hex 24)
  cat >"$ENV_FILE" <<EOF
# POINT on this server — written by infra/deploy/install.sh on $(date -u +%FT%TZ). Never commit or copy it.
NODE_ENV=production
APP_ENV=staging
TZ=UTC
DISPLAY_TIMEZONE=Asia/Riyadh
LOG_LEVEL=info
APP_VERSION=dev
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
APP_BASE_URL=https://$DOMAIN
API_BASE_URL=https://$DOMAIN
API_PORT=3000
BRAND_STAFF_NAME_AR=$(brand BRAND_STAFF_NAME_AR)
BRAND_STAFF_NAME_EN=$(brand BRAND_STAFF_NAME_EN)
BRAND_CUSTOMER_NAME_AR=$(brand BRAND_CUSTOMER_NAME_AR)
BRAND_CUSTOMER_NAME_EN=$(brand BRAND_CUSTOMER_NAME_EN)
VITE_BRAND_STAFF_NAME_AR=$(brand BRAND_STAFF_NAME_AR)
VITE_BRAND_STAFF_NAME_EN=$(brand BRAND_STAFF_NAME_EN)
VITE_BRAND_CUSTOMER_NAME_AR=$(brand BRAND_CUSTOMER_NAME_AR)
SESSION_SECRET=$(b64)
CODE_PEPPER=$(b64)
AUTH_SECRET_PEPPER=$(b64)
DATA_ENCRYPTION_KEY=$(b64)
DATA_ENCRYPTION_KEY_ID=k1
SESSION_COOKIE_NAME=__Host-point_sid
SESSION_COOKIE_SECURE=true
# PostgreSQL 16 on this server (docker-compose.local-db.yml)
POSTGRES_ADMIN_PASSWORD=$(hex 24)
POINT_OWNER_DB_PASSWORD=$OWNER_PW
POINT_API_DB_PASSWORD=$API_PW
POINT_WORKER_DB_PASSWORD=$WORKER_PW
MIGRATION_DATABASE_URL=postgres://point_owner:$OWNER_PW@postgres:5432/point
API_DATABASE_URL=postgres://point_api:$API_PW@postgres:5432/point
WORKER_DATABASE_URL=postgres://point_worker:$WORKER_PW@postgres:5432/point
DATABASE_SSL=false
# MinIO on this server, served on the app origin (docker-compose.minio.yml)
MINIO_ROOT_USER=point-root-$(hex 4)
MINIO_ROOT_PASSWORD=$(hex 24)
S3_ACCESS_KEY_ID=point-app-$(hex 4)
S3_SECRET_ACCESS_KEY=$(hex 24)
S3_ENDPOINT=https://$DOMAIN
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_BUCKET_MEDIA=point-media
S3_BUCKET_EXPORTS=point-exports
STORAGE_ORIGIN=
# WhatsApp: the simulator until the Meta assets exist (Q-03, docs/DEPLOYMENT.md §8) — nobody is messaged
WA_MODE=simulator
WA_GRAPH_BASE_URL=http://wa-simulator:4010
WA_BUSINESS_ACCOUNT_ID=100000000000002
WA_PHONE_NUMBER_ID=100000000000001
WA_DISPLAY_PHONE_E164=+966500000999
WA_ACCESS_TOKEN_REF=env://WA_ACCESS_TOKEN
WA_APP_SECRET_REF=env://WA_APP_SECRET
WA_VERIFY_TOKEN_REF=env://WA_VERIFY_TOKEN
WA_ACCESS_TOKEN=$(hex 24)
WA_APP_SECRET=$(hex 24)
WA_VERIFY_TOKEN=$(hex 24)
# Web Push (VAPID, P-256)
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:$ACME_EMAIL
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC
METRICS_ENABLED=true
METRICS_PORT=9464
TRUST_PROXY=1
EOF
  chmod 600 "$ENV_FILE"
  umask 022
  ok ".env written (chmod 600)"
else
  say "Keeping the existing .env"
  [ "$(env_get DOMAIN)" = "$DOMAIN" ] || die ".env has DOMAIN=$(env_get DOMAIN); edit it by hand to change the host"
fi
env_set APP_VERSION "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"

FILES="infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.local-db.yml:infra/compose/docker-compose.minio.yml:infra/compose/docker-compose.simulator.yml"
if [ "$MODE" = gateway ]; then
  HTTP_PORT="${POINT_HTTP_PORT:-$(env_get POINT_HTTP_BIND | awk -F: '{print $NF}')}"
  HTTP_PORT="${HTTP_PORT:-8095}"
  SIM_PORT="${POINT_SIM_PORT:-$(env_get POINT_SIM_BIND | awk -F: '{print $NF}')}"
  SIM_PORT="${SIM_PORT:-8097}"
  running_web=$(docker ps --format '{{.Names}}' | grep -cx 'point-web-1' || true)
  if [ "$running_web" = 0 ]; then
    port_free "$HTTP_PORT" || die "port $HTTP_PORT is in use: set POINT_HTTP_PORT to a free port"
    port_free "$SIM_PORT" || die "port $SIM_PORT is in use: set POINT_SIM_PORT to a free port"
  fi
  FILES="$FILES:infra/compose/docker-compose.behind-proxy.yml:infra/compose/docker-compose.simulator-ui.yml"
  env_set SITE_SCHEME "http://"
  env_set POINT_HTTP_BIND "$GW_IP:$HTTP_PORT"
  env_set POINT_HTTPS_BIND "127.0.0.1:$((HTTP_PORT + 400))"
  env_set POINT_SIM_BIND "$GW_IP:$SIM_PORT"
  env_set TRUSTED_PROXIES "private_ranges"
  env_set TRUST_PROXY "2"
  env_set WEB_NETWORK_ALIAS "point-web"
  env_set POINT_HOST_GATEWAY "$GW_IP"
  env_set POINT_SIM_DOMAIN "${SIM_DOMAIN:-}"
  [ -z "${SIM_DOMAIN:-}" ] || [ -n "$(env_get POINT_SIM_PASSWORD)" ] || env_set POINT_SIM_PASSWORD "$(hex 12)"
fi
env_set POINT_COMPOSE_FILES "$FILES"

# ------------------------------------------------------------------------------------------ 4. build, migrate, start
if [ "${POINT_SKIP_BUILD:-0}" != 1 ]; then
  say "Building the images (first time: several minutes)"
  "${PC[@]}" build
fi
say "Database migrations"
"${PC[@]}" up -d postgres
"${PC[@]}" run --rm migrate
say "Starting the services"
"${PC[@]}" up -d --remove-orphans
for i in $(seq 1 60); do
  if "${PC[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    ok "api ready"
    break
  fi
  [ "$i" = 60 ] && {
    "${PC[@]}" ps
    "${PC[@]}" logs --tail 60 api worker
    die "the api did not become ready in 3 minutes (logs above)"
  }
  sleep 3
done
"${PC[@]}" ps

# ------------------------------------------------------------------------------------------ 5. gateway site file
if [ "$MODE" = gateway ]; then
  say "Adding $DOMAIN to the shared gateway $GW"
  for i in $(seq 1 20); do
    curl -fsS -o /dev/null -H "Host: $DOMAIN" "http://$GW_IP:$HTTP_PORT/health/ready" && break
    [ "$i" = 20 ] && die "POINT's Caddy does not answer on $GW_IP:$HTTP_PORT"
    sleep 3
  done
  auth_directive=basic_auth
  case "$GW_CADDY" in v2.[0-7].*) auth_directive=basicauth ;; esac
  shard="$(mktemp)"
  {
    echo "# POINT — owned by pharmjeed/point-system, written by infra/deploy/install.sh. Do not edit here:"
    echo "# re-run the installer. TLS for these hosts is obtained by this gateway."
    echo "$DOMAIN {"
    echo "	reverse_proxy $GW_IP:$HTTP_PORT"
    echo "}"
    if [ -n "${SIM_DOMAIN:-}" ]; then
      hash=$(docker exec "$GW" caddy hash-password --plaintext "$(env_get POINT_SIM_PASSWORD)")
      echo ""
      echo "# the WhatsApp simulator page (staging only: the customer's phone, nobody real is messaged)"
      echo "$SIM_DOMAIN {"
      echo "	$auth_directive {"
      echo "		sim $hash"
      echo "	}"
      echo "	reverse_proxy $GW_IP:$SIM_PORT"
      echo "}"
    fi
  } >"$shard"
  target="$CONF_DIR/point.caddyfile"
  backup="$(mktemp)"
  had_old=0
  if $SUDO test -f "$target"; then
    $SUDO cat "$target" >"$backup"
    had_old=1
  fi
  $SUDO mkdir -p "$CONF_DIR"
  $SUDO tee "$target" >/dev/null <"$shard"
  if ! docker exec "$GW" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/point-caddy-validate.log 2>&1; then
    if [ "$had_old" = 1 ]; then $SUDO tee "$target" >/dev/null <"$backup"; else $SUDO rm -f "$target"; fi
    tail -5 /tmp/point-caddy-validate.log >&2
    die "the gateway rejected the site file: restored the previous state, nothing reloaded"
  fi
  docker exec -w /etc/caddy "$GW" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  rm -f "$shard" "$backup"
  ok "gateway reloaded (the other sites were not interrupted)"
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/health/ready" || echo 000)
    [ "$code" = 200 ] && break
    sleep 6
  done
  if [ "$code" = 200 ]; then ok "https://$DOMAIN/health/ready → 200"; else warn "https://$DOMAIN is not reachable yet ($code): DNS or the certificate is still pending; the gateway keeps retrying"; fi
fi

# ------------------------------------------------------------------------------------------ 6. first owner
if [ "${POINT_SKIP_OWNER:-0}" != 1 ] && [ -z "$(env_get POINT_OWNER_CREATED)" ] && [ -n "$OWNER_PHONE" ]; then
  say "Creating the owner (the temporary password is printed once)"
  set +e
  "${PC[@]}" run --rm --no-deps api node api/dist/cli.js create-owner \
    --phone "$OWNER_PHONE" --name "$OWNER_NAME" --org-name-ar "$ORG_NAME_AR" --org-name-en "$ORG_NAME_EN"
  rc=$?
  set -e
  case $rc in
    0) env_set POINT_OWNER_CREATED "$(date -u +%F)" ;;
    3) env_set POINT_OWNER_CREATED "existing" && ok "an owner already exists" ;;
    *) die "create-owner failed (exit $rc)" ;;
  esac
fi

# ------------------------------------------------------------------------------------------ summary
say "Done"
cat <<EOF
   Staff app:  https://$DOMAIN   (sign-in: /staff/login with the owner's mobile and the password above;
               then change the password and set up the authenticator app)
EOF
if [ "$MODE" = gateway ] && [ -n "${SIM_DOMAIN:-}" ]; then
  cat <<EOF
   Simulator:  https://$SIM_DOMAIN   user «sim», password: $(env_get POINT_SIM_PASSWORD)
EOF
fi
cat <<EOF
   WhatsApp channel (once, as the owner, «قناة واتساب» in the administration):
               Business account ID $(env_get WA_BUSINESS_ACCOUNT_ID) · Phone number ID $(env_get WA_PHONE_NUMBER_ID)
               API version: any vN.N for the simulator (e.g. v23.0) · mode «محاكي» ·
               references env://WA_ACCESS_TOKEN, env://WA_APP_SECRET,
               env://WA_VERIFY_TOKEN
   Operate:    bash infra/deploy/pc.sh ps | logs -f api worker | restart api
   Update:     git pull && bash infra/deploy/install.sh
EOF

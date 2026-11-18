#!/usr/bin/env bash
# One-command install / update of POINT on one Linux server with Docker (DEC-457, DEC-630 … DEC-635;
# docs/DEPLOYMENT.md §14, docs/runbooks/server-install-v2.md). Run on the server, from a clone of the repository
# (re-running it later is the update: it keeps .env and only appends the keys a newer version needs):
#   bash infra/deploy/install.sh
#
# What it does:
#   1. checks Docker + Compose v2, reports free memory, free disk and the ports it will bind, and chooses the mode:
#        gateway  the server already has a shared Caddy gateway container on 80/443 that imports
#                 /data/conf.d/*.caddyfile (POINT_GATEWAY_CONTAINER, default vm-caddy-1): POINT's own Caddy
#                 serves plain HTTP on one host address, and a site file «point.caddyfile» in the gateway adds
#                 DOMAIN (TLS by the gateway) and, in staging, the WhatsApp simulator page behind a password
#        direct   ports 80/443 are free: POINT's Caddy owns them and obtains the certificate itself
#      anything else on 80/443 stops the script (it never takes over another project's ports);
#   2. writes .env once (chmod 600) with every secret generated HERE with openssl (infra/deploy/env.sh) — no secret
#      leaves the server, none is printed except the simulator page password and the owners' one-time passwords;
#      on an update, the keys of a newer version that .env lacks are appended (their NAMES are printed, DEC-631);
#   3. staging stack: PostgreSQL 16 + MinIO on this server, the WhatsApp simulator and the payment simulator
#      (nobody is messaged, no card is charged; e-invoicing and customer push are in-process simulators;
#      APP_ENV=staging — going live is docs/DEPLOYMENT.md §8);
#   4. refuses to build below POINT_MIN_FREE_GB free on Docker's disk; builds the images, prunes POINT's dangling
#      images and old build cache (never `docker system prune`, never another project's image, container or volume,
#      DEC-632), runs the migrations, starts the stack, waits for /health/ready;
#   5. creates the first owner and the first platform owner once (each prints a one-time password).
#
# Non-interactive: set the answers in the environment and POINT_YES=1, e.g.
#   POINT_YES=1 DOMAIN=app.example.sa ACME_EMAIL=ops@example.sa OWNER_PHONE=05XXXXXXXX OWNER_NAME='…' bash …
# Overrides: POINT_MODE=gateway|direct · POINT_GATEWAY_CONTAINER · POINT_HTTP_PORT (8095) · POINT_SIM_PORT (8097)
#            SIM_DOMAIN (sim.<root>; empty = no public simulator page) · POINT_SKIP_BUILD=1 · POINT_SKIP_OWNER=1
#            PLATFORM_OWNER_PHONE / PLATFORM_OWNER_NAME (default: the owner's) · POINT_MIN_FREE_GB (8)
#            POINT_BUILD_CACHE_UNTIL (24h: build cache unused for longer is pruned after a build; off = keep it)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
PC=(bash "$ROOT/infra/deploy/pc.sh")
# shellcheck source=infra/deploy/env.sh
. "$ROOT/infra/deploy/env.sh"

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
env_get() {
  if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; fi
}
env_set() { # replace or append KEY=VALUE in .env (the file keeps its mode)
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
port_free() { ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
# a port published by a container of POINT's own compose project (an update re-binds it)
point_owns_port() {
  docker ps --filter label=com.docker.compose.project=point --format '{{.Ports}}' | grep -Eq "(^|[ ,]|:)$1->"
}
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

# disk: Docker's own data directory (images, build cache, volumes); / when it cannot be read
docker_fs() {
  local d
  d=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$d" ] && df "$d" >/dev/null 2>&1; then echo "$d"; else echo /; fi
}
free_gb() { df -BG --output=avail "$DOCKER_FS" | tail -1 | tr -dc 0-9; }
build_cache_size() { docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null | awk -F'|' '$1=="Build Cache"{print $2}'; }
disk_report() { ok "$1: $(free_gb) GB free on $DOCKER_FS · Docker build cache (all projects) $(build_cache_size)"; }
# DEC-632: only what POINT built — its dangling images (the label sa.point.stack=point of every POINT build, and the
# label Docker Compose puts on the images of the project «point», which also covers images an earlier version built)
# — and build cache unused for longer than POINT_BUILD_CACHE_UNTIL (BuildKit's cache has no owner: entries another
# build used within that time stay, and losing an old one only makes that build slower). Never `docker system prune`,
# never an image in use or tagged, a container, a volume or a network.
prune_point() {
  docker image prune -f --filter label=sa.point.stack=point >/dev/null || warn "could not prune POINT's dangling images"
  docker image prune -f --filter label=com.docker.compose.project=point >/dev/null || true
  if [ "${POINT_BUILD_CACHE_UNTIL:-24h}" != off ]; then
    docker builder prune -f --filter "until=${POINT_BUILD_CACHE_UNTIL:-24h}" >/dev/null || warn "could not prune the build cache"
  fi
}

# ------------------------------------------------------------------------------------------ 1. prerequisites
say "Checking the server"
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/ubuntu/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (package docker-compose-plugin)"
docker info >/dev/null 2>&1 || die "this user cannot use Docker: add it to the docker group (sudo usermod -aG docker \$USER), log in again"
for c in openssl ss awk sed curl getent df; do command -v "$c" >/dev/null || die "missing command: $c"; done
ok "$(docker --version | cut -d, -f1) · $(docker compose version --short) · $(uname -m)"
DOCKER_FS="$(docker_fs)"
MIN_FREE_GB="${POINT_MIN_FREE_GB:-8}"
mem_total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
mem_avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
ok "memory: ${mem_avail} MB available of ${mem_total} MB"
[ "${mem_avail:-0}" -ge 1500 ] || warn "less than 1.5 GB of free memory: building the images may fail or be very slow"
disk_report "disk"

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
  if [ -z "$GW_IP" ] || [ "$CONF_DIR" = /conf.d ]; then die "cannot read the network or the /data volume of $GW"; fi
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
  ask ORG_NAME_AR "Organization name in Arabic" "$(point_brand BRAND_STAFF_NAME_AR)"
  ask ORG_NAME_EN "Organization name in English" "POINT"
fi
# V2-002: the platform console (/platform) has its own owner, by default the same person (DEC-633)
PLATFORM_OWNER_PHONE="${PLATFORM_OWNER_PHONE:-}"
PLATFORM_OWNER_NAME="${PLATFORM_OWNER_NAME:-}"
if [ "${POINT_SKIP_OWNER:-0}" != 1 ] && [ -z "$(env_get POINT_PLATFORM_OWNER_CREATED)" ]; then
  ask PLATFORM_OWNER_PHONE "Platform owner's mobile (the /platform console)" "$OWNER_PHONE"
  ask PLATFORM_OWNER_NAME "Platform owner's full name" "$OWNER_NAME"
fi
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "invalid host name: $DOMAIN"

# DNS: Caddy keeps retrying until the record exists, but say it now
PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
check_dns() {
  local host=$1 ip
  ip=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -z "$ip" ]; then
    warn "$host has no DNS A record yet: add  A  ${host%%."${ROOT_DOMAIN}"}  →  ${PUBLIC_IP:-<the public IP of this server>}"
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
  point_env_write_new "$ENV_FILE" "$DOMAIN" "$ACME_EMAIL"
  point_env_ensure "$ENV_FILE" >/dev/null
  ok ".env written (chmod 600)"
else
  say "Keeping the existing .env"
  [ "$(env_get DOMAIN)" = "$DOMAIN" ] || die ".env has DOMAIN=$(env_get DOMAIN); edit it by hand to change the host"
  # DEC-631: an install of an earlier version gets the keys of this one; existing keys are never changed
  added="$(point_env_ensure "$ENV_FILE")"
  if [ -n "$added" ]; then
    ok "added $(printf '%s\n' "$added" | wc -l | tr -d ' ') new key(s) for this version (values not shown):"
    printf '%s\n' "$added" | paste -sd' ' | fold -s -w 100 | sed 's/^/       /'
  else
    ok "no new key needed"
  fi
fi
chmod 600 "$ENV_FILE"
env_set APP_VERSION "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"

FILES="infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.local-db.yml:infra/compose/docker-compose.minio.yml:infra/compose/docker-compose.simulator.yml"
# the payment simulator while payments are simulated (MOYASAR_MODE=test, the gateway's test API, needs none)
if [ "$(env_get MOYASAR_MODE)" = simulator ]; then
  FILES="$FILES:infra/compose/docker-compose.payment-simulator.yml"
fi
if [ "$MODE" = gateway ]; then
  HTTP_PORT="${POINT_HTTP_PORT:-$(env_get POINT_HTTP_BIND | awk -F: '{print $NF}')}"
  HTTP_PORT="${HTTP_PORT:-8095}"
  SIM_PORT="${POINT_SIM_PORT:-$(env_get POINT_SIM_BIND | awk -F: '{print $NF}')}"
  SIM_PORT="${SIM_PORT:-8097}"
  BIND_PORTS="$HTTP_PORT $((HTTP_PORT + 400)) $SIM_PORT"
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
  [ -z "${SIM_DOMAIN:-}" ] || [ -n "$(env_get POINT_SIM_PASSWORD)" ] || env_set POINT_SIM_PASSWORD "$(point_hex 12)"
else
  BIND_PORTS="80 443"
fi
env_set POINT_COMPOSE_FILES "$FILES"

# ports this stack binds on the host: free, or already POINT's (an update)
for p in $BIND_PORTS; do
  if port_free "$p"; then
    ok "port $p: free"
  elif point_owns_port "$p"; then
    ok "port $p: POINT's own (kept)"
  else
    case "$p" in
      "${HTTP_PORT:-}") die "port $p is in use by another program: set POINT_HTTP_PORT to a free port" ;;
      "${SIM_PORT:-}") die "port $p is in use by another program: set POINT_SIM_PORT to a free port" ;;
      *) die "port $p is in use by another program" ;;
    esac
  fi
done

# ------------------------------------------------------------------------------------------ 4. build, migrate, start
if [ "${POINT_SKIP_BUILD:-0}" != 1 ]; then
  say "Disk before the build"
  disk_report "before"
  if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
    warn "less than $MIN_FREE_GB GB free: removing POINT's dangling images and old build cache first"
    prune_point
    disk_report "after the safe prune"
    [ "$(free_gb)" -ge "$MIN_FREE_GB" ] || die "only $(free_gb) GB free on $DOCKER_FS: a build needs at least $MIN_FREE_GB GB
   (POINT_MIN_FREE_GB). Nothing was built, stopped or removed beyond POINT's own leftovers.
   See what uses the disk: docker system df ; sudo du -xsh /var/log /home /opt 2>/dev/null
   Free space by hand (docs/runbooks/server-install-v2.md «تحرير المساحة»), then run this again."
  fi
  say "Building the images (first time: several minutes)"
  "${PC[@]}" build
  say "Cleaning POINT's build leftovers (DEC-632)"
  prune_point
  disk_report "after"
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
if [[ ":$FILES:" == *":infra/compose/docker-compose.payment-simulator.yml:"* ]]; then
  # the api reaches the simulator by its service name (MOYASAR_BASE_URL), on the internal network only
  for i in $(seq 1 20); do
    if "${PC[@]}" exec -T api node -e "fetch(process.env.MOYASAR_BASE_URL+'/_sim/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      ok "payment simulator reachable from the api ($(env_get MOYASAR_BASE_URL), not published)"
      break
    fi
    [ "$i" = 20 ] && {
      "${PC[@]}" logs --tail 40 payment-simulator
      die "the api cannot reach the payment simulator (logs above)"
    }
    sleep 3
  done
fi
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
    echo "# Everything on $DOMAIN goes to POINT's own Caddy, which routes it (infra/caddy/Caddyfile) and enforces each"
    echo "# body limit (DEC-562, DEC-634): /v1/* (staff, /v1/customer/*, /v1/platform/*) and /ws (staff and /customer"
    echo "# sockets) 2 MB, /webhooks/whatsapp 4 MB, /webhooks/payments/moyasar and /webhooks/einvoicing 1 MB, the"
    echo "# buckets 12 MB, the PWA and the /platform console pages."
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

# ------------------------------------------------------------------------------------------ 6. first owners
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
if [ "${POINT_SKIP_OWNER:-0}" != 1 ] && [ -z "$(env_get POINT_PLATFORM_OWNER_CREATED)" ]; then
  if [ -n "$PLATFORM_OWNER_PHONE" ] && [ -n "$PLATFORM_OWNER_NAME" ]; then
    say "Creating the platform owner (/platform; the temporary password is printed once)"
    set +e
    "${PC[@]}" run --rm --no-deps api node api/dist/cli.js create-platform-owner \
      --phone "$PLATFORM_OWNER_PHONE" --name "$PLATFORM_OWNER_NAME"
    rc=$?
    set -e
    case $rc in
      0) env_set POINT_PLATFORM_OWNER_CREATED "$(date -u +%F)" ;;
      3) env_set POINT_PLATFORM_OWNER_CREATED "existing" && ok "a platform owner already exists" ;;
      *) die "create-platform-owner failed (exit $rc)" ;;
    esac
  else
    warn "no platform owner yet: run again with PLATFORM_OWNER_PHONE=05XXXXXXXX PLATFORM_OWNER_NAME='…' (docs/DEPLOYMENT.md §7.2)"
  fi
fi

# ------------------------------------------------------------------------------------------ summary
say "Done"
cat <<EOF
   Staff app:  https://$DOMAIN   (sign-in: /staff/login with the owner's mobile and the password above;
               then change the password and set up the authenticator app)
   Platform:   https://$DOMAIN/platform/login   (the platform owner, same first steps)
   Customer app API: https://$DOMAIN/v1/customer/* and the socket namespace /customer on /ws
EOF
if [ "$MODE" = gateway ] && [ -n "${SIM_DOMAIN:-}" ]; then
  cat <<EOF
   Simulator:  https://$SIM_DOMAIN   user «sim», password: $(env_get POINT_SIM_PASSWORD)
EOF
fi
cat <<EOF
   Payments:   simulated (MOYASAR_MODE=$(env_get MOYASAR_MODE)); the payment simulator is internal only:
               bash infra/deploy/pc.sh exec -T payment-simulator wget -qO- http://127.0.0.1:4020/_sim/payments
   WhatsApp channel (once, as the owner, «قناة واتساب» in the administration):
               Business account ID $(env_get WA_BUSINESS_ACCOUNT_ID) · Phone number ID $(env_get WA_PHONE_NUMBER_ID)
               API version: any vN.N for the simulator (e.g. v23.0) · mode «محاكي» ·
               references env://WA_ACCESS_TOKEN, env://WA_APP_SECRET,
               env://WA_VERIFY_TOKEN
   Operate:    bash infra/deploy/pc.sh ps | logs -f api worker | restart api
   Update:     git pull && bash infra/deploy/install.sh
EOF

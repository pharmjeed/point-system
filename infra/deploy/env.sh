# shellcheck shell=bash
# The server's .env for the staging stack of infra/deploy/install.sh (DEC-457, DEC-630, DEC-631). Sourced, not run:
#   ROOT=<repository root> . infra/deploy/env.sh
#   point_env_write_new <file> <domain> <acme e-mail>   a new .env (chmod 600): every secret generated here
#   point_env_ensure <file>                             appends every key of point_env_defaults the file lacks
#                                                       (an install of an earlier version gets the new keys; a key
#                                                       already there, even empty, is never changed); prints the
#                                                       NAMES of the keys it added, never a value
# apps/api/test/deploy-config.test.ts runs both and boots the configuration through loadEnv/deploymentProblems.

point_b64() { openssl rand -base64 32 | tr -d '\n'; }
point_hex() { openssl rand -hex "${1:-24}"; }
point_b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
# brand names come from settings (canon §1): the defaults of .env.example
point_brand() { sed -n "s/^$1=//p" "$ROOT/.env.example" | awk '{print $1}' | head -1; }

# The first .env of a server (the keys of the first release, V1). point_env_ensure adds the rest right after.
point_env_write_new() {
  local file=$1 domain=$2 email=$3 der vapid_private vapid_public owner_pw api_pw worker_pw
  (
    umask 077
    der="$(mktemp)"
    openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$der" 2>/dev/null
    vapid_private=$(head -c 39 "$der" | tail -c 32 | point_b64url)
    vapid_public=$(tail -c 65 "$der" | point_b64url)
    rm -f "$der"
    owner_pw=$(point_hex 24) api_pw=$(point_hex 24) worker_pw=$(point_hex 24)
    cat >"$file" <<EOF
# POINT on this server — written by infra/deploy/install.sh on $(date -u +%FT%TZ). Never commit or copy it.
NODE_ENV=production
APP_ENV=staging
TZ=UTC
DISPLAY_TIMEZONE=Asia/Riyadh
LOG_LEVEL=info
APP_VERSION=dev
DOMAIN=$domain
ACME_EMAIL=$email
APP_BASE_URL=https://$domain
API_BASE_URL=https://$domain
API_PORT=3000
BRAND_STAFF_NAME_AR=$(point_brand BRAND_STAFF_NAME_AR)
BRAND_STAFF_NAME_EN=$(point_brand BRAND_STAFF_NAME_EN)
BRAND_CUSTOMER_NAME_AR=$(point_brand BRAND_CUSTOMER_NAME_AR)
BRAND_CUSTOMER_NAME_EN=$(point_brand BRAND_CUSTOMER_NAME_EN)
VITE_BRAND_STAFF_NAME_AR=$(point_brand BRAND_STAFF_NAME_AR)
VITE_BRAND_STAFF_NAME_EN=$(point_brand BRAND_STAFF_NAME_EN)
VITE_BRAND_CUSTOMER_NAME_AR=$(point_brand BRAND_CUSTOMER_NAME_AR)
SESSION_SECRET=$(point_b64)
CODE_PEPPER=$(point_b64)
AUTH_SECRET_PEPPER=$(point_b64)
DATA_ENCRYPTION_KEY=$(point_b64)
DATA_ENCRYPTION_KEY_ID=k1
SESSION_COOKIE_NAME=__Host-point_sid
SESSION_COOKIE_SECURE=true
# PostgreSQL 16 on this server (docker-compose.local-db.yml)
POSTGRES_ADMIN_PASSWORD=$(point_hex 24)
POINT_OWNER_DB_PASSWORD=$owner_pw
POINT_API_DB_PASSWORD=$api_pw
POINT_WORKER_DB_PASSWORD=$worker_pw
MIGRATION_DATABASE_URL=postgres://point_owner:$owner_pw@postgres:5432/point
API_DATABASE_URL=postgres://point_api:$api_pw@postgres:5432/point
WORKER_DATABASE_URL=postgres://point_worker:$worker_pw@postgres:5432/point
DATABASE_SSL=false
# MinIO on this server, served on the app origin (docker-compose.minio.yml)
MINIO_ROOT_USER=point-root-$(point_hex 4)
MINIO_ROOT_PASSWORD=$(point_hex 24)
S3_ACCESS_KEY_ID=point-app-$(point_hex 4)
S3_SECRET_ACCESS_KEY=$(point_hex 24)
S3_ENDPOINT=https://$domain
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
WA_ACCESS_TOKEN=$(point_hex 24)
WA_APP_SECRET=$(point_hex 24)
WA_VERIFY_TOKEN=$(point_hex 24)
# Web Push (VAPID, P-256)
VAPID_PUBLIC_KEY=$vapid_public
VAPID_PRIVATE_KEY=$vapid_private
VAPID_SUBJECT=mailto:$email
VITE_VAPID_PUBLIC_KEY=$vapid_public
METRICS_ENABLED=true
METRICS_PORT=9464
TRUST_PROXY=1
EOF
  )
  chmod 600 "$file"
}

# Every key a staging server needs beyond the first release, as KEY=VALUE lines (V2, DEC-630). Secrets are generated
# here with openssl; a key whose code default is right everywhere is NOT listed (the terms/consent versions follow the
# code and the app that ships their text, DEC-631: pinning them here would freeze them at this install's version).
point_env_defaults() {
  cat <<EOF
PLATFORM_SESSION_COOKIE_NAME=__Host-point_psid
WA_TEMPLATE_SET=v1
CUSTOMER_APP_LINK=
CUSTOMER_TERMS_URL=
CUSTOMER_PRIVACY_URL=
CUSTOMER_MARKETING_URL=
MOYASAR_MODE=simulator
MOYASAR_BASE_URL=http://payment-simulator:4020
MOYASAR_SECRET_KEY_REF=env://MOYASAR_SECRET_KEY
MOYASAR_WEBHOOK_SECRET_REF=env://MOYASAR_WEBHOOK_SECRET
MOYASAR_SECRET_KEY=sk_test_$(point_hex 24)
MOYASAR_WEBHOOK_SECRET=$(point_hex 32)
EINVOICE_MODE=simulator
EINVOICE_WEBHOOK_SECRET_REF=env://EINVOICE_WEBHOOK_SECRET
EINVOICE_WEBHOOK_SECRET=$(point_hex 32)
INVOICE_SELLER_LEGAL_NAME_AR=
INVOICE_SELLER_LEGAL_NAME_EN=
INVOICE_SELLER_VAT_NUMBER=
INVOICE_SELLER_CR_NUMBER=
INVOICE_SELLER_ADDRESS_AR=
CUSTOMER_PUSH_MODE=simulator
CUSTOMER_PUSH_ACCESS_TOKEN_REF=env://EXPO_ACCESS_TOKEN
EXPO_ACCESS_TOKEN=
EOF
}

point_env_ensure() {
  local file=$1 line key missing=()
  while IFS= read -r line; do
    key=${line%%=*}
    [ -n "$key" ] || continue
    grep -q "^$key=" "$file" || missing+=("$line")
  done < <(point_env_defaults)
  [ "${#missing[@]}" -gt 0 ] || return 0
  # a file without a final newline would glue the first new key to its last line
  [ -z "$(tail -c1 "$file")" ] || printf '\n' >>"$file"
  {
    printf '# added by infra/deploy/install.sh on %s (V2: platform console, customer app, payments, invoices,\n' "$(date -u +%FT%TZ)"
    printf '# customer push). Simulators only: no card is charged, no invoice reaches ZATCA, no device is pushed.\n'
    printf '# INVOICE_SELLER_* empty = visible test placeholders on every invoice (required with real values in production).\n'
    printf '%s\n' "${missing[@]}"
  } >>"$file"
  chmod 600 "$file"
  for line in "${missing[@]}"; do printf '%s\n' "${line%%=*}"; done
}

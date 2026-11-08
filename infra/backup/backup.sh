#!/usr/bin/env bash
# Encrypted logical backup of the POINT database (PNT-095, 05 §13; runbook: docs/DEPLOYMENT.md).
#
#   BACKUP_DATABASE_URL=postgres://point_owner:…@host:5432/point infra/backup/backup.sh
#
# What it writes to BACKUP_DIR (mode 0600, never a plaintext dump on disk):
#   <name>-<UTC time>.dump.age (or .dump.enc)   pg_dump --format=custom, streamed through age (or openssl)
#   … .sha256                                    checksum of the encrypted file
#   … .json                                      manifest: time, versions, migrations and row counts taken in
#                                                the SAME snapshot as the dump (restore.sh compares them)
# Environment:
#   BACKUP_DATABASE_URL        required; a role that can read every table (the schema owner, point_owner)
#   BACKUP_DIR                 default /var/backups/point
#   BACKUP_AGE_RECIPIENTS      age public key(s) «age1…», space or comma separated (preferred: the server only
#   BACKUP_AGE_RECIPIENTS_FILE holds public keys; the identity that decrypts stays offline with the owner)
#   BACKUP_PASSPHRASE / BACKUP_PASSPHRASE_FILE  fallback: openssl AES-256-CBC + PBKDF2 (600000 iterations)
#   BACKUP_RETENTION_DAYS      default 30 (05 §13); BACKUP_MONTHLY_KEEP default 12 (first backup of each month)
#   BACKUP_S3_URI              optional off-site copy, e.g. s3://point-backups/prod (lifecycle rules there)
#   BACKUP_S3_ENDPOINT         optional endpoint for an S3-compatible provider (aws CLI --endpoint-url)
#   BACKUP_METRICS_FILE        optional node_exporter textfile: point_backup_last_success_timestamp_seconds
#   BACKUP_NAME                file prefix, default point
# Exit status: 0 success, 2 configuration, 1 failure (alert on it: 05 §12.3 «فشل النسخ الاحتياطي»).
set -euo pipefail
umask 077

die() { echo "backup: $*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed" 2; }

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/point}"
BACKUP_NAME="${BACKUP_NAME:-point}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
MONTHLY_KEEP="${BACKUP_MONTHLY_KEEP:-12}"
need pg_dump
need psql
need sha256sum

recipients=()
if [ -n "${BACKUP_AGE_RECIPIENTS:-}" ] || [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
  need age
  mode=age
  ext=dump.age
  for r in ${BACKUP_AGE_RECIPIENTS//,/ }; do recipients+=(-r "$r"); done
  [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ] && recipients+=(-R "$BACKUP_AGE_RECIPIENTS_FILE")
elif [ -n "${BACKUP_PASSPHRASE:-}" ] || [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  need openssl
  mode=openssl
  ext=dump.enc
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then pass="file:$BACKUP_PASSPHRASE_FILE"; else pass="env:BACKUP_PASSPHRASE"; fi
else
  die "no encryption configured: set BACKUP_AGE_RECIPIENTS (preferred) or BACKUP_PASSPHRASE_FILE — backups are never stored unencrypted" 2
fi
encrypt() {
  if [ "$mode" = age ]; then age "${recipients[@]}"; else openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass "$pass"; fi
}
# openssl AES-CBC is not authenticated (age is): an altered .dump.enc may still decrypt and restore. The backup
# therefore carries an HMAC-SHA256 of the ciphertext under a key derived from the passphrase (DEC-515); the plain
# .sha256 only detects accidents, since anyone can recompute it. The derived key (never the passphrase) is the
# only secret that appears in openssl's arguments, for the duration of one call.
mac_key() {
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then { printf 'point-backup-mac\0'; cat "$BACKUP_PASSPHRASE_FILE"; } | sha256sum | cut -d' ' -f1
  else { printf 'point-backup-mac\0'; printf '%s' "$BACKUP_PASSPHRASE"; } | sha256sum | cut -d' ' -f1; fi
}

mkdir -p "$BACKUP_DIR"
started=$(date -u +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
base="$BACKUP_DIR/$BACKUP_NAME-$stamp.$ext"
tmp="$BACKUP_DIR/.partial-$BACKUP_NAME-$stamp"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

# One REPEATABLE READ snapshot shared by the counts and pg_dump (--snapshot): the manifest describes exactly
# what the dump contains, so a restore can be checked row for row.
coproc PG { psql -X -q -At -v ON_ERROR_STOP=1 "$BACKUP_DATABASE_URL" 2>&1; }
exec 3>&"${PG[1]}" 4<&"${PG[0]}"
echo "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;" >&3
echo "SELECT pg_export_snapshot();" >&3
read -r -t 60 snapshot <&4 || die "could not open a snapshot"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "could not open a snapshot: $snapshot"
cat >&3 <<'SQL'
SELECT json_build_object(
  'organizations', (SELECT count(*) FROM organizations), 'venues', (SELECT count(*) FROM venues),
  'users', (SELECT count(*) FROM users), 'events', (SELECT count(*) FROM events), 'shifts', (SELECT count(*) FROM shifts),
  'tickets', (SELECT count(*) FROM tickets), 'retrieval_cycles', (SELECT count(*) FROM retrieval_cycles),
  'tasks', (SELECT count(*) FROM tasks), 'task_offers', (SELECT count(*) FROM task_offers),
  'payments', (SELECT count(*) FROM payments), 'custody_events', (SELECT count(*) FROM custody_events),
  'ticket_events', (SELECT count(*) FROM ticket_events), 'audit_log', (SELECT count(*) FROM audit_log),
  'outbox_events', (SELECT count(*) FROM outbox_events), 'whatsapp_messages', (SELECT count(*) FROM whatsapp_messages),
  'media_assets', (SELECT count(*) FROM media_assets), 'analytics_events', (SELECT count(*) FROM analytics_events));
SQL
read -r -t 900 counts <&4 || die "could not count rows"
echo "SELECT coalesce(json_agg(name ORDER BY name), '[]'::json) FROM schema_migrations;" >&3
read -r -t 60 migrations <&4 || die "could not read schema_migrations"
echo "SELECT current_setting('server_version_num') || '|' || current_database();" >&3
read -r -t 60 serverinfo <&4 || die "could not read the server version"
server_num=${serverinfo%%|*}
database=${serverinfo#*|}
dump_major=$(pg_dump --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')
[ "$dump_major" -ge "$((server_num / 10000))" ] || die "pg_dump $dump_major is older than the server ($server_num)" 2

pg_dump --snapshot="$snapshot" --format=custom --compress=6 --no-password "$BACKUP_DATABASE_URL" | encrypt >"$tmp"
echo "COMMIT;" >&3
echo '\q' >&3
exec 3>&- 4<&-
wait "$PG_PID" 2>/dev/null || true
[ -s "$tmp" ] || die "the dump is empty"
mv "$tmp" "$base"
sum=$(sha256sum "$base" | cut -d' ' -f1)
echo "$sum  $(basename "$base")" >"$base.sha256"
if [ "$mode" = openssl ]; then
  mac=$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(mac_key)" -r "$base" | cut -d' ' -f1)
  echo "hmac-sha256 $mac" >"$base.hmac"
fi
size=$(stat -c %s "$base")
finished=$(date -u +%s)
cat >"$base.json" <<EOF
{"file":"$(basename "$base")","created_at":"$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)","database":"$database","server_version_num":$server_num,"pg_dump_major":$dump_major,"format":"custom","encryption":"$mode","size_bytes":$size,"sha256":"$sum","duration_s":$((finished - started)),"migrations":$migrations,"counts":$counts}
EOF

if [ -n "${BACKUP_S3_URI:-}" ]; then
  need aws
  endpoint=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  for f in "$base" "$base.sha256" "$base.json" ${mac:+"$base.hmac"}; do
    aws "${endpoint[@]}" s3 cp --only-show-errors "$f" "${BACKUP_S3_URI%/}/$(basename "$f")"
  done
fi

# retention: everything younger than RETENTION_DAYS, plus the first backup of each of the last MONTHLY_KEEP months
now=$(date -u +%s)
shopt -s nullglob
backups=("$BACKUP_DIR/$BACKUP_NAME"-*."$ext") # glob order = name order = time order
declare -A first_of_month=()
for f in "${backups[@]}"; do
  m=$(basename "$f" | sed -E "s/^$BACKUP_NAME-([0-9]{6}).*/\1/")
  [ -z "${first_of_month[$m]:-}" ] && first_of_month[$m]="$f"
done
ym=$(date -u +%Y%m)
months=$((10#${ym:0:4} * 12 + 10#${ym:4:2} - 1 - (MONTHLY_KEEP - 1)))
oldest_month=$(printf '%04d%02d' $((months / 12)) $((months % 12 + 1)))
for f in "${backups[@]}"; do
  age_days=$(((now - $(stat -c %Y "$f")) / 86400))
  [ "$age_days" -lt "$RETENTION_DAYS" ] && continue
  m=$(basename "$f" | sed -E "s/^$BACKUP_NAME-([0-9]{6}).*/\1/")
  if [ "${first_of_month[$m]:-}" = "$f" ] && [ "$m" -ge "$oldest_month" ]; then continue; fi
  rm -f "$f" "$f.sha256" "$f.json" "$f.hmac"
done

if [ -n "${BACKUP_METRICS_FILE:-}" ]; then
  printf '# HELP point_backup_last_success_timestamp_seconds Last successful database backup (05 §12.2).\n# TYPE point_backup_last_success_timestamp_seconds gauge\npoint_backup_last_success_timestamp_seconds %s\n' \
    "$finished" >"$BACKUP_METRICS_FILE.tmp" && mv "$BACKUP_METRICS_FILE.tmp" "$BACKUP_METRICS_FILE"
fi
echo "{\"backup\":\"ok\",\"file\":\"$base\",\"encryption\":\"$mode\",\"size_bytes\":$size,\"duration_s\":$((finished - started))}"

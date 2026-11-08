#!/usr/bin/env bash
# Restores an encrypted backup of backup.sh into an EMPTY database and proves it (PNT-095, 17 TC-037 / H-09;
# runbook: docs/DEPLOYMENT.md).
#
#   BACKUP_AGE_IDENTITY_FILE=/secure/point-backup.key \
#     infra/backup/restore.sh /var/backups/point/point-20261028T020000Z.dump.age postgres://point_owner:…@host/point_restore
#
# Steps: checksum → decrypt (stream) → pg_restore --single-transaction --exit-on-error --no-owner into the target
# (all or nothing; objects owned by the connecting role, privileges for point_app / point_retention kept, so
# run infra/db/bootstrap-roles.sql on a new server first) → verify: the migrations and the row count of every
# table in the manifest equal what the backup's snapshot held, and infra/backup/consistency.sql answers 0.
# Environment: BACKUP_AGE_IDENTITY_FILE (age) or BACKUP_PASSPHRASE / BACKUP_PASSPHRASE_FILE (openssl).
# Options: --allow-nonempty (restore over existing tables: never on a live database).
# Exit status: 0 restored and verified, 2 usage/configuration/refused, 1 failure or verification mismatch.
set -euo pipefail
umask 077

die() { echo "restore: $*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed" 2; }
HERE=$(cd "$(dirname "$0")" && pwd)

allow_nonempty=false
args=()
for a in "$@"; do
  case "$a" in
    --allow-nonempty) allow_nonempty=true ;;
    *) args+=("$a") ;;
  esac
done
[ "${#args[@]}" -eq 2 ] || die "usage: restore.sh <backup file> <target database url> [--allow-nonempty]" 2
file=${args[0]}
target=${args[1]}
[ -f "$file" ] || die "no such file: $file" 2
need pg_restore
need psql
need sha256sum

started=$(date -u +%s)
if [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum --check --status "$(basename "$file").sha256") ||
    die "checksum mismatch: $file is damaged or was modified" 1
  echo "checksum ok"
else
  echo "restore: no $file.sha256 next to the backup — checksum not verified" >&2
fi

case "$file" in
  *.age)
    need age
    : "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required for an age backup}"
    decrypt() { age --decrypt -i "$BACKUP_AGE_IDENTITY_FILE" "$file"; }
    ;;
  *.enc)
    need openssl
    if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then pass="file:$BACKUP_PASSPHRASE_FILE"; else
      : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE is required for an openssl backup}"
      pass="env:BACKUP_PASSPHRASE"
    fi
    # authenticate before decrypting: CBC is malleable, so a forged .sha256 must not be enough (DEC-515)
    [ -f "$file.hmac" ] || die "no $file.hmac next to the openssl backup: it cannot be authenticated" 1
    if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
      key=$({ printf 'point-backup-mac\0'; cat "$BACKUP_PASSPHRASE_FILE"; } | sha256sum | cut -d' ' -f1)
    else
      key=$({ printf 'point-backup-mac\0'; printf '%s' "$BACKUP_PASSPHRASE"; } | sha256sum | cut -d' ' -f1)
    fi
    expected=$(sed -n 's/^hmac-sha256 \([0-9a-f]\{64\}\)$/\1/p' "$file.hmac")
    actual=$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" -r "$file" | cut -d' ' -f1)
    unset key
    [ -n "$expected" ] && [ "$expected" = "$actual" ] ||
      die "authentication failed: $file was modified or was not made with this passphrase" 1
    echo "hmac ok"
    decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass "$pass" -in "$file"; }
    ;;
  *) die "unknown backup type (expected .dump.age or .dump.enc): $file" 2 ;;
esac

tables=$(psql -X -At "$target" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") ||
  die "cannot connect to the target database" 2
if [ "$tables" != 0 ] && [ "$allow_nonempty" != true ]; then
  die "the target database already has $tables table(s): restore into a new, empty database (or --allow-nonempty)" 2
fi

decrypt | pg_restore --single-transaction --exit-on-error --no-owner --no-password -d "$target"
restored=$(date -u +%s)
echo "restored in $((restored - started)) s"

status=0
manifest="${file}.json"
if [ -f "$manifest" ]; then
  expected_migrations=$(sed -E 's/.*"migrations":(\[[^]]*\]).*/\1/' "$manifest")
  actual_migrations=$(psql -X -At "$target" -c "SELECT coalesce(json_agg(name ORDER BY name), '[]'::json) FROM schema_migrations")
  if [ "$expected_migrations" = "$actual_migrations" ]; then echo "migrations ok: $actual_migrations"; else
    echo "MIGRATIONS DIFFER: backup $expected_migrations, restored $actual_migrations" >&2
    status=1
  fi
  counts=$(sed -E 's/.*"counts":\{([^}]*)\}.*/\1/' "$manifest")
  IFS=',' read -ra pairs <<<"$counts"
  mismatches=0
  for p in "${pairs[@]}"; do
    t=$(echo "$p" | sed -E 's/^ *"([a-z_]+)" *: *([0-9]+) *$/\1/')
    n=$(echo "$p" | sed -E 's/^ *"([a-z_]+)" *: *([0-9]+) *$/\2/')
    got=$(psql -X -At "$target" -c "SELECT count(*) FROM \"$t\"")
    if [ "$got" != "$n" ]; then
      echo "COUNT MISMATCH $t: backup $n, restored $got" >&2
      mismatches=$((mismatches + 1))
    fi
  done
  if [ "$mismatches" -eq 0 ]; then echo "row counts ok (${#pairs[@]} tables, as in the backup snapshot)"; else status=1; fi
else
  echo "restore: no manifest next to the backup — counts not verified" >&2
fi

bad=$(psql -X -At -F '|' "$target" -f "$HERE/consistency.sql" | awk -F'|' '$2 != 0')
if [ -z "$bad" ]; then echo "consistency ok ($(grep -c "AS check_name\|^SELECT '" "$HERE/consistency.sql") checks)"; else
  echo "CONSISTENCY VIOLATIONS:" >&2
  echo "$bad" >&2
  status=1
fi
finished=$(date -u +%s)
if [ "$status" -eq 0 ]; then
  echo "{\"restore\":\"verified\",\"file\":\"$(basename "$file")\",\"restore_s\":$((restored - started)),\"total_s\":$((finished - started))}"
else
  echo "{\"restore\":\"FAILED VERIFICATION\",\"file\":\"$(basename "$file")\"}" >&2
fi
exit "$status"

#!/usr/bin/env bash
# Restore drill (PNT-095 acceptance, 17 TC-037 / H-09 / §13) — `pnpm ops:restore-drill`.
# On a PostgreSQL 16 server where ADMIN_DATABASE_URL may CREATE DATABASE (never a production server):
#   1. source = migrations + dev seed + a mini event (drill-activity.sql);
#   2. backup.sh (age, or openssl when age is missing) → encrypted dump + manifest at snapshot T;
#   3. more writes after T, so the restore must reproduce T and not "now";
#   4. restore.sh into a fresh database: checksum, decrypt, pg_restore in one transaction, migrations and row
#      counts equal to the manifest, consistency.sql all 0;
#   5. the restored schema equals a freshly migrated one (pg_dump --schema-only, normalized);
#   6. docs/06_schema_invariants_test.sql passes on a structure copy of the restored database;
#   7. a modified backup is refused (checksum) and an altered one with a forged checksum cannot be decrypted;
#   8. the measured restore time is compared with the RTO of 05 §13 (1 hour).
# DRILL_EVIDENCE=<file.md> writes the record that 17 §13 asks for; DRILL_ENCRYPTION=openssl tests the fallback.
# Exit 0 = drill passed.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/infra/backup"
ADMIN="${ADMIN_DATABASE_URL:-${TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}}"
RTO_S=3600
for t in psql pg_dump pg_restore node sha256sum; do command -v "$t" >/dev/null || { echo "drill: $t is required" >&2; exit 2; }; done
[ -f "$ROOT/packages/db/dist/cli.js" ] || (cd "$ROOT" && pnpm --filter @point/db build >/dev/null)

id=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
SRC="point_drill_src_$id" DST="point_drill_dst_$id" REF="point_drill_ref_$id" INV="point_drill_inv_$id"
url() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$ADMIN" "$1"; }
work=$(mktemp -d "${TMPDIR:-/tmp}/point-drill.XXXXXX")
cleanup() {
  for d in "$SRC" "$DST" "$REF" "$INV" "${DST}_x"; do psql -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS $d WITH (FORCE)" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
step() { echo "== $*"; }
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }

step "1. source database: migrations, dev seed, mini event (200 delivered tickets)"
for d in "$SRC" "$DST" "$REF" "$INV" "${DST}_x"; do psql -X -q "$ADMIN" -c "CREATE DATABASE $d" >/dev/null; done
DATABASE_URL=$(url "$SRC") node "$ROOT/packages/db/dist/cli.js" migrate >/dev/null
DATABASE_URL=$(url "$REF") node "$ROOT/packages/db/dist/cli.js" migrate >/dev/null
APP_ENV=test NODE_ENV=test DATABASE_URL=$(url "$SRC") node "$ROOT/packages/db/dist/seed/cli.js" >/dev/null
psql -X -q "$(url "$SRC")" -v n=200 -v base=1000 -f "$HERE/drill-activity.sql" >/dev/null

step "2. encrypted backup at snapshot T"
if [ "${DRILL_ENCRYPTION:-auto}" != openssl ] && command -v age >/dev/null && command -v age-keygen >/dev/null; then
  age-keygen -o "$work/identity.key" 2>/dev/null
  BACKUP_AGE_RECIPIENTS=$(age-keygen -y "$work/identity.key")
  export BACKUP_AGE_RECIPIENTS
  export BACKUP_AGE_IDENTITY_FILE="$work/identity.key"
  encryption=age
else
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$work/passphrase"
  export BACKUP_PASSPHRASE_FILE="$work/passphrase"
  encryption=openssl
fi
t0=$(date -u +%s)
out=$(BACKUP_DATABASE_URL=$(url "$SRC") BACKUP_DIR="$work/backups" "$HERE/backup.sh")
backup_s=$(($(date -u +%s) - t0))
file=$(echo "$out" | sed -E 's/.*"file":"([^"]+)".*/\1/')
[ -f "$file" ] || fail "no backup file ($out)"
size=$(stat -c %s "$file")
if head -c 5 "$file" | grep -q PGDMP; then fail "the backup file is not encrypted"; fi
counts_t=$(sed -E 's/.*"counts":(\{[^}]*\}).*/\1/' "$file.json")
echo "   $encryption, $size bytes in ${backup_s}s; counts at T: $counts_t"

step "3. writes after T (50 more tickets in the source)"
psql -X -q "$(url "$SRC")" -v n=50 -v base=5000 -f "$HERE/drill-activity.sql" >/dev/null
src_tickets=$(psql -X -At "$(url "$SRC")" -c "SELECT count(*) FROM tickets")

step "4. restore into a fresh database and verify against the manifest"
t1=$(date -u +%s)
"$HERE/restore.sh" "$file" "$(url "$DST")" | sed 's/^/   /' || fail "restore or its verification failed"
restore_s=$(($(date -u +%s) - t1))
dst_tickets=$(psql -X -At "$(url "$DST")" -c "SELECT count(*) FROM tickets")
[ "$dst_tickets" -lt "$src_tickets" ] || fail "the restore holds the writes made after T ($dst_tickets tickets)"
echo "   restored $dst_tickets tickets (the source has $src_tickets after T)"

step "5. restored schema = freshly migrated schema"
schema() {
  pg_dump --schema-only --no-owner --no-privileges "$1" |
    grep -vE '^(--|SET |SELECT pg_catalog\.set_config|\\(un)?restrict )' | sed '/^$/d'
}
if ! diff <(schema "$(url "$DST")") <(schema "$(url "$REF")") >"$work/schema.diff"; then
  head -40 "$work/schema.diff" >&2
  fail "the restored schema differs from the migrations"
fi
echo "   identical ($(schema "$(url "$REF")" | wc -l) normalized lines)"

step "6. invariants on a structure copy of the restored database"
pg_dump --schema-only "$(url "$DST")" | psql -X -q -v ON_ERROR_STOP=1 "$(url "$INV")" >/dev/null
inv=$(psql -X -At -v ON_ERROR_STOP=1 "$(url "$INV")" -f "$ROOT/docs/06_schema_invariants_test.sql" 2>&1 | tail -1)
[ "$inv" = "ALL INVARIANT TESTS PASSED" ] || fail "invariants: $inv"
echo "   $inv"

step "7. a modified backup is refused"
cp "$file" "$work/tampered.$(basename "$file" | sed 's/.*\.dump\./dump./')"
tampered="$work/tampered.$(basename "$file" | sed 's/.*\.dump\./dump./')"
offset=$((size / 2))
# flip every bit of one byte (writing a fixed value would change nothing when the byte already has it)
orig=$(od -An -tu1 -j "$offset" -N1 "$tampered" | tr -d ' ')
printf '%b' "\\0$(printf '%03o' $((orig ^ 255)))" | dd of="$tampered" bs=1 seek="$offset" conv=notrunc status=none
[ -f "$file.hmac" ] && cp "$file.hmac" "$tampered.hmac"
cp "$file.sha256" "$tampered.sha256"
sed -i "s#  .*#  $(basename "$tampered")#" "$tampered.sha256"
if "$HERE/restore.sh" "$tampered" "$(url "${DST}_x")" >/dev/null 2>"$work/tamper1.err"; then fail "a modified backup was restored"; fi
grep -q "checksum mismatch" "$work/tamper1.err" || fail "modified backup: $(cat "$work/tamper1.err")"
echo "   checksum mismatch → refused"
sha256sum "$tampered" | sed "s#  .*#  $(basename "$tampered")#" >"$tampered.sha256"
if "$HERE/restore.sh" "$tampered" "$(url "${DST}_x")" >/dev/null 2>"$work/tamper2.err"; then fail "an altered backup with a forged checksum was restored"; fi
left=$(psql -X -At "$(url "${DST}_x")" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$left" = 0 ] || fail "a failed restore left $left table(s) behind"
echo "   forged checksum → cannot be decrypted/restored, target left empty"

step "8. RTO"
verdict=PASS
[ "$restore_s" -le "$RTO_S" ] || verdict=FAIL
echo "   restore + verification ${restore_s}s ≤ ${RTO_S}s (05 §13): $verdict"
[ "$verdict" = PASS ] || fail "restore slower than the RTO"

if [ -n "${DRILL_EVIDENCE:-}" ]; then
  pgver=$(psql -X -At "$ADMIN" -c "SHOW server_version")
  cat >"$DRILL_EVIDENCE" <<EOF
# Restore drill — $(date -u +%Y-%m-%d)

Automated drill \`pnpm ops:restore-drill\` (infra/backup/restore-drill.sh, PNT-095, 17 TC-037 / H-09 / §13).

| Item | Value |
|---|---|
| Server | PostgreSQL $pgver (local, throwaway databases) |
| Source | migrations + dev seed + 200 delivered tickets (drill-activity.sql); 50 more written after the backup |
| Restore point T | the backup snapshot (pg_dump --snapshot, manifest counts at T) |
| Encryption | $encryption |
| Backup | $size bytes, ${backup_s} s |
| Restore + verification | ${restore_s} s (RTO 05 §13: ${RTO_S} s) — $verdict |
| Counts at T | \`$counts_t\` |
| Checks | checksum; migrations and row counts = manifest; consistency.sql all 0; schema = fresh migrations; 06_schema_invariants_test.sql on a structure copy: ALL INVARIANT TESTS PASSED; modified backup refused; forged checksum not restorable |
| Differences | none |
| Run by | $(whoami)@$(hostname) |
EOF
  echo "   evidence: $DRILL_EVIDENCE"
fi
echo "RESTORE DRILL PASSED"

#!/bin/sh
# One-shot setup of the self-hosted MinIO (profile `minio` of docker-compose.prod.yml; docs/DEPLOYMENT.md):
#   - the media and exports buckets, private (no anonymous access, 09 §6 rule 1);
#   - no versioning on either bucket (DEC-128): a versioned bucket is refused;
#   - the lifecycle rule that expires incoming/ after one day (05 §9 rule 4, DEC-97), reset on every run;
#   - the application's own access key, allowed only Get/Put/Delete on objects of the two buckets.
# Idempotent: safe to run on every `up`.
set -eu
: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}"
MEDIA="${S3_BUCKET_MEDIA:-point-media}"
EXPORTS="${S3_BUCKET_EXPORTS:-point-exports}"
ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"

mc alias set point "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
for b in "$MEDIA" "$EXPORTS"; do
  mc mb -p "point/$b" >/dev/null
  mc anonymous set none "point/$b" >/dev/null
  if mc version info --json "point/$b" | grep -q '"Enabled"'; then
    echo "bucket $b has versioning enabled: refused (DEC-128, deleted photos must not survive as old versions)" >&2
    exit 1
  fi
done
mc ilm rule rm --all --force "point/$MEDIA" >/dev/null 2>&1 || true
mc ilm rule add --expire-days 1 --prefix incoming/ "point/$MEDIA" >/dev/null

policy=/tmp/point-app-policy.json
cat >"$policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$MEDIA/*", "arn:aws:s3:::$EXPORTS/*"]
    }
  ]
}
EOF
mc admin policy create point point-app "$policy" >/dev/null
mc admin user add point "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
mc admin policy attach point point-app --user "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 || true
rm -f "$policy"
echo "minio: buckets $MEDIA and $EXPORTS private and unversioned, incoming/ expires after 1 day, app user ready"

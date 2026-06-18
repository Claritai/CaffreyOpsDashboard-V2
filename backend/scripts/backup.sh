#!/bin/bash
#
# Caffrey Ops — nightly backup.
#
# Replays the encrypted hypercare.db to a fresh encrypted snapshot (the
# multiple-ciphers .backup() API doesn't carry the cipher to the
# destination, so we walk sqlite_master in a single transaction instead —
# fast enough at this scale and consistent). Bundles the live config JSON
# alongside, tars + dates, writes mode-600 to /var/backups/caffrey-ops/,
# rotates to the last 7 snapshots.
#
# Runs as www-data via caffrey-ops-backup.service systemd unit, which
# sources backend/.env so DB_ENCRYPTION_KEY is available.
#
# NOT BACKED UP:
# - backend/.env (and therefore DB_ENCRYPTION_KEY itself). Without the
#   key the backups are unrecoverable; the key MUST be backed up
#   OUT-OF-BAND (password manager). This is intentional — a leaked
#   tarball without the key remains opaque.
# - sessions.db (ephemeral).
# - *.example.json (already in git).
#
# RESTORE: see BACKUP.md beside this script.

set -euo pipefail

APP_DIR=/var/www/caffrey-ops
BACKUP_DIR=/var/backups/caffrey-ops
KEEP=7
TS=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$BACKUP_DIR"

node -e "
  const { copyDb } = require('$APP_DIR/backend/scripts/lib/copy-db');
  const key = process.env.DB_ENCRYPTION_KEY;
  if (!key) { console.error('DB_ENCRYPTION_KEY missing'); process.exit(1); }
  const r = copyDb(
    { path: '$APP_DIR/backend/data/hypercare.db', key },
    { path: '$TMP/hypercare.db', key }
  );
  console.log('snapshot:', r.tables, 'tables,', r.rows, 'rows');
"

cp -a "$APP_DIR/backend/config/hypercare.json"    "$TMP/"
cp -a "$APP_DIR/backend/config/top-clients.json"  "$TMP/"
cp -a "$APP_DIR/backend/config/categories.json"   "$TMP/"
cp -a "$APP_DIR/backend/config/sla.json"          "$TMP/"

OUT="$BACKUP_DIR/caffrey-ops-$TS.tgz"
tar -czf "$OUT" -C "$TMP" .
chmod 600 "$OUT"

ls -1t "$BACKUP_DIR"/caffrey-ops-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "wrote $OUT ($(stat -c %s "$OUT") bytes); kept $KEEP most recent"

# --- S3 offsite upload (added for AWS migration, 2026-06-06) ---
# Uses the EC2 instance role (caffrey-ops-ec2-role) — no stored AWS keys.
# S3-side retention is handled by the bucket lifecycle rule (Glacier IR @30d,
# expire @365d), so we do NOT rotate on S3 here — only upload.
S3_BUCKET="s3://caffrey-ops-backups-906ffb76"
if aws s3 cp "$OUT" "$S3_BUCKET/$(basename "$OUT")" --region eu-west-1 --only-show-errors; then
  echo "uploaded $(basename "$OUT") to $S3_BUCKET"
else
  echo "WARNING: S3 upload failed for $(basename "$OUT")" >&2
fi

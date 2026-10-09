#!/usr/bin/env bash
set -euo pipefail

: "${NEXOMOCHIS_DB_PATH:?Set NEXOMOCHIS_DB_PATH}"
: "${NEXOMOCHIS_UPLOAD_DIR:?Set NEXOMOCHIS_UPLOAD_DIR}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT}"
: "${R2_REMOTE:?Set R2_REMOTE}"
: "${R2_BUCKET:?Set R2_BUCKET}"

R2_PREFIX="${R2_PREFIX:-mymochis}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_BACKUP="$TMP_DIR/mymochis-$STAMP.db"
UPLOADS_BACKUP="$TMP_DIR/uploads-$STAMP.tar.gz"
MANIFEST="$TMP_DIR/manifest.json"
BUNDLE="$TMP_DIR/mymochis-backup-$STAMP.tar"
ENCRYPTED="$TMP_DIR/mymochis-backup-$STAMP.tar.age"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$NEXOMOCHIS_DB_PATH" ".timeout 5000" ".backup '$DB_BACKUP'"
else
  node "$SCRIPT_DIR/backup-sqlite.mjs" "$NEXOMOCHIS_DB_PATH" "$DB_BACKUP"
fi

if [ -d "$NEXOMOCHIS_UPLOAD_DIR" ]; then
  tar -C "$NEXOMOCHIS_UPLOAD_DIR" -czf "$UPLOADS_BACKUP" .
else
  mkdir -p "$TMP_DIR/empty-uploads"
  tar -C "$TMP_DIR/empty-uploads" -czf "$UPLOADS_BACKUP" .
fi

printf '{"created_at":"%s","app":"mymochis","db":"%s","uploads":"%s"}\n' "$STAMP" "$(basename "$DB_BACKUP")" "$(basename "$UPLOADS_BACKUP")" > "$MANIFEST"

tar -C "$TMP_DIR" -cf "$BUNDLE" "$(basename "$DB_BACKUP")" "$(basename "$UPLOADS_BACKUP")" "$(basename "$MANIFEST")"
age -r "$AGE_RECIPIENT" -o "$ENCRYPTED" "$BUNDLE"

R2_BASE="$R2_REMOTE:$R2_BUCKET/$R2_PREFIX"
rclone copyto "$ENCRYPTED" "$R2_BASE/daily/mymochis-$STAMP.tar.age"

if [ "$(date -u +%u)" = "1" ]; then
  rclone copyto "$ENCRYPTED" "$R2_BASE/weekly/mymochis-$STAMP.tar.age"
fi

if [ "$(date -u +%d)" = "01" ]; then
  rclone copyto "$ENCRYPTED" "$R2_BASE/monthly/mymochis-$STAMP.tar.age"
fi

echo "backup_uploaded=$R2_BASE/daily/mymochis-$STAMP.tar.age"

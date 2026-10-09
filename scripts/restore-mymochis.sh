#!/usr/bin/env bash
set -euo pipefail

: "${NEXOMOCHIS_DB_PATH:?Set NEXOMOCHIS_DB_PATH}"
: "${NEXOMOCHIS_UPLOAD_DIR:?Set NEXOMOCHIS_UPLOAD_DIR}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE}"
: "${R2_REMOTE:?Set R2_REMOTE}"
: "${R2_BUCKET:?Set R2_BUCKET}"

if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Set CONFIRM_RESTORE=yes to proceed." >&2
  exit 2
fi

SOURCE="${1:?Usage: restore-mymochis.sh <r2-remote-object|local-file.age>}"
R2_PREFIX="${R2_PREFIX:-mymochis}"
TMP_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_AGE="$TMP_DIR/backup.tar.age"
ARCHIVE_TAR="$TMP_DIR/backup.tar"
EXTRACT_DIR="$TMP_DIR/extract"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

case "$SOURCE" in
  *:*)
    rclone copyto "$SOURCE" "$ARCHIVE_AGE"
    ;;
  *)
    if [ ! -f "$SOURCE" ]; then
      echo "Backup file not found: $SOURCE" >&2
      exit 1
    fi
    cp "$SOURCE" "$ARCHIVE_AGE"
    ;;
esac

age --decrypt -i "$AGE_IDENTITY_FILE" -o "$ARCHIVE_TAR" "$ARCHIVE_AGE"
mkdir -p "$EXTRACT_DIR"
tar -C "$EXTRACT_DIR" -xf "$ARCHIVE_TAR"

DB_FILE="$(find "$EXTRACT_DIR" -maxdepth 1 -name 'mymochis-*.db' | head -n 1)"
UPLOADS_FILE="$(find "$EXTRACT_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' | head -n 1)"

if [ -z "$DB_FILE" ] || [ -z "$UPLOADS_FILE" ]; then
  echo "Backup archive missing db or uploads payload." >&2
  exit 1
fi

mkdir -p "$(dirname "$NEXOMOCHIS_DB_PATH")" "$NEXOMOCHIS_UPLOAD_DIR"

if [ -f "$NEXOMOCHIS_DB_PATH" ]; then
  node "$SCRIPT_DIR/backup-sqlite.mjs" "$NEXOMOCHIS_DB_PATH" "$TMP_DIR/pre-restore.db"
fi

if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  docker compose stop app || true
fi

cp "$DB_FILE" "$NEXOMOCHIS_DB_PATH.restore-tmp"
mv "$NEXOMOCHIS_DB_PATH.restore-tmp" "$NEXOMOCHIS_DB_PATH"
tar -C "$NEXOMOCHIS_UPLOAD_DIR" -xzf "$UPLOADS_FILE"

if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  docker compose start app
fi

echo "restore_complete_from=$SOURCE"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

BACKUP_FILE="${1:-"$ROOT_DIR/database/uav-db_current.backup"}"
SCHEMA_PATCH_FILE="$ROOT_DIR/database/latest_schema_patch_20260518.sql"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-}"
export PGDATABASE="${PGDATABASE:-uav-db}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "数据库备份不存在：$BACKUP_FILE" >&2
  exit 1
fi

for cmd in psql createdb pg_restore; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少命令：$cmd。请先把 PostgreSQL bin 目录加入 PATH。" >&2
    exit 1
  fi
done

if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE';" | grep -q 1; then
  createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
fi

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
pg_restore --clean --if-exists --no-owner --no-privileges -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$BACKUP_FILE"

if [[ -f "$SCHEMA_PATCH_FILE" ]]; then
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -f "$SCHEMA_PATCH_FILE"
fi

echo "数据库已恢复到：$PGDATABASE"

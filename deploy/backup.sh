#!/usr/bin/env bash
# Дамп базы. Ставится в cron: 0 3 * * * /opt/b24-kit-queue/deploy/backup.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/b24-kit-queue}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/b24kit-$(date +%F-%H%M).sql.gz"

cd "$PROJECT_DIR"
docker compose exec -T db pg_dump -U b24kit b24kit | gzip > "$FILE"
find "$BACKUP_DIR" -name 'b24kit-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"

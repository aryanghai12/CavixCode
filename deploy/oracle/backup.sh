#!/usr/bin/env bash
#
# backup.sh — dump the database, keep 14 days, delete the rest.
#
# Render's managed Postgres took its own backups. This one does not, so this
# script is the difference between a bad morning and a finished product. cron
# runs it nightly (bootstrap.sh installs /etc/cron.d/cavix-backup); run it by
# hand any time, especially before a `git pull` you are unsure about.
#
#   ./backup.sh                 → backups/cavix-<timestamp>.sql.gz
#
# Restoring, when it comes to that:
#   gunzip -c backups/cavix-TIMESTAMP.sql.gz | sudo docker compose exec -T postgres psql -U cavix -d cavix

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CAVIX_BACKUP_DIR:-$HERE/backups}"
KEEP_DAYS="${CAVIX_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

DOCKER=docker
[[ $EUID -ne 0 ]] && ! docker info >/dev/null 2>&1 && DOCKER="sudo docker"

mkdir -p "$DEST"
chmod 700 "$DEST"
cd "$HERE"

# --clean --if-exists so the dump can be replayed over a database that already
# has the table, which is the situation you are in during every restore that
# matters — the box is up, the data is wrong, and you want last night's back.
if ! $DOCKER compose exec -T postgres \
      pg_dump -U cavix -d cavix --clean --if-exists \
      | gzip -9 > "$DEST/cavix-$STAMP.sql.gz"; then
  rm -f "$DEST/cavix-$STAMP.sql.gz"
  echo "backup FAILED at $STAMP — is the postgres container running?" >&2
  exit 1
fi

# An empty gzip stream is 20-odd bytes. Catching it here means a broken backup is
# noticed tonight rather than during the restore.
SIZE="$(stat -c%s "$DEST/cavix-$STAMP.sql.gz")"
if (( SIZE < 200 )); then
  echo "backup at $STAMP is only ${SIZE} bytes — treating it as a failure" >&2
  mv "$DEST/cavix-$STAMP.sql.gz" "$DEST/SUSPECT-cavix-$STAMP.sql.gz"
  exit 1
fi

# The .env goes with it, and this is not belt-and-braces.
#
# Every BYOK API key and OAuth token in that dump is encrypted with
# CAVIX_SECRET_KEY, which lives only in .env. A database backup without the key
# restores a workspace whose credentials all read as absent — and the store
# reports an undecryptable blob as "no credential" rather than as an error, so
# the restore looks like it worked right up until somebody tries a review.
if [[ -f "$HERE/.env" ]]; then
  cp "$HERE/.env" "$DEST/env-$STAMP"
  chmod 600 "$DEST/env-$STAMP"
fi

find "$DEST" -name 'cavix-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'env-*'          -mtime "+$KEEP_DAYS" -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: cavix-$STAMP.sql.gz ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"

# Both copies are on the same disk as the thing they are backing up, which
# protects you from a bad deploy or a wrong DELETE and not at all from losing the
# instance. Pull them down periodically:
#   scp -r opc@<ip>:$DEST ./cavix-backups

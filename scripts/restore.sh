#!/bin/sh
# Restore a backup into the running stack. Run from the repo folder on the server:
#   scripts/restore.sh backups/db_2026-11-10_0200.dump backups/uploads_2026-11-10_0200.tar.gz
# This REPLACES the current database and uploaded files.
set -eu

DUMP="${1:?usage: scripts/restore.sh <db_*.dump> <uploads_*.tar.gz>}"
TARBALL="${2:?usage: scripts/restore.sh <db_*.dump> <uploads_*.tar.gz>}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 1; }
[ -f "$TARBALL" ] || { echo "No such file: $TARBALL" >&2; exit 1; }

printf 'This replaces the live database and photos with %s and %s. Type RESTORE to continue: ' "$DUMP" "$TARBALL"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

docker compose stop app
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DUMP"
docker compose run --rm --no-deps -T -u root --entrypoint sh \
  -v "$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")":/restore.tar.gz:ro \
  app -c 'find /data/uploads -mindepth 1 -delete && tar -xzf /restore.tar.gz -C /data/uploads && chown -R node:node /data/uploads'
docker compose start app
echo "Restore finished."

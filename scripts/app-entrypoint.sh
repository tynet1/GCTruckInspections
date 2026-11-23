#!/bin/sh
# Entrypoint of the app image: runs the app (or any command given) as the unprivileged "node" user.
# docker-compose.yml starts the container as root for one reason: the backup folder (BACKUP_DIR, a host folder that
# Docker creates owned by root) is mounted at /backups, and the app writes its backup there before it migrates the
# database (src/backup.ts). If "node" can't write to it, this makes "node" its owner; then it drops to "node" before
# anything else runs. Started as any other user, it just runs the command.
set -eu

if [ "$(id -u)" = "0" ]; then
  dir="${BACKUP_DIR:-/backups}"
  if [ -d "$dir" ] && ! setpriv --reuid=node --regid=node --init-groups test -w "$dir"; then
    if chown node "$dir"; then
      echo "app-entrypoint: made the app's user the owner of the backup folder, so it can back up before migrations"
    else
      echo "app-entrypoint: the app can't write to the backup folder $dir; the backup before migrations will fail" >&2
    fi
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"

#!/bin/sh
# Nightly backup, run by the `backup` service in docker-compose.yml.
#   backup.sh        take one backup now
#   backup.sh loop   take one backup per day after BACKUP_HOUR (local time), forever
# Writes /backups/db_<stamp>.dump (pg_dump custom format) and /backups/uploads_<stamp>.tar.gz,
# then deletes backups older than BACKUP_KEEP_DAYS.
set -eu

KEEP="${BACKUP_KEEP_DAYS:-30}"
HOUR="${BACKUP_HOUR:-2}"

backup_once() {
  stamp=$(date +%Y-%m-%d_%H%M)
  pg_dump -Fc -f "/backups/db_${stamp}.dump.part"
  mv "/backups/db_${stamp}.dump.part" "/backups/db_${stamp}.dump"
  tar -czf "/backups/uploads_${stamp}.tar.gz.part" -C /uploads .
  mv "/backups/uploads_${stamp}.tar.gz.part" "/backups/uploads_${stamp}.tar.gz"
  find /backups -maxdepth 1 -type f \( -name 'db_*.dump' -o -name 'uploads_*.tar.gz' \) -mtime +"$KEEP" -delete
  find /backups -maxdepth 1 -type f -name '*.part' -mtime +1 -delete
  echo "$(date '+%F %T') backup ${stamp} done"
}

if [ "${1:-}" != "loop" ]; then
  backup_once
  exit 0
fi

echo "$(date '+%F %T') backup loop started: daily after ${HOUR}:00, keeping ${KEEP} days"
while true; do
  today=$(date +%Y-%m-%d)
  hour=$(date +%H)
  hour=${hour#0}
  if [ "$hour" -ge "$HOUR" ] && ! ls /backups/db_"${today}"_*.dump >/dev/null 2>&1; then
    backup_once || echo "$(date '+%F %T') backup FAILED, will retry in 10 minutes" >&2
  fi
  sleep 600
done

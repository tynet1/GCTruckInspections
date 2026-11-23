#!/bin/sh
# Nightly backup, run by the `backup` service in docker-compose.yml.
#   backup.sh          take one backup now
#   backup.sh <label>  take one backup now, named ..._<label> (restore.sh uses "before-restore")
#   backup.sh loop     take one backup per day after BACKUP_HOUR (local time), forever
# Writes /backups/db_<stamp>.dump (pg_dump custom format) and /backups/uploads_<stamp>.tar.gz, <stamp> being
# YYYY-MM-DD_HHMMSS[_label], then deletes backups older than BACKUP_KEEP_DAYS.
# Safety rules:
# - one backup at a time (a lock), each written to its own temp file and renamed only when complete,
#   so a half-written or failed backup never looks like a good one;
# - an existing backup file is never overwritten (restore.sh may be about to read it);
# - old backups are only pruned after a new one succeeded.
# The app takes its own backup before migrating the database (src/backup.ts) with the same names and rules.
# Each run, good or failed, is recorded in the database's backup_runs table (migration 021) for Admin -> About;
# recording never makes a backup fail.
set -eu

KEEP="${BACKUP_KEEP_DAYS:-30}"
HOUR="${BACKUP_HOUR:-2}"
LOCK=/tmp/backup.lock # the nightly loop and restore.sh's safety copy both run in this container

size() { wc -c <"$1" | tr -d ' '; }

# record_run <kind> <ok> <started epoch> <label> <db file> <db bytes> <uploads file> <uploads bytes> <error>
# Adds a row to backup_runs. Values go in as psql variables (:'name' quotes them), never pasted into the SQL.
# If the database is down, or doesn't have the table yet (the app adds it on start), the run is only in this log.
record_run() {
  recf="/tmp/backup-record.$$"
  if ! PGCONNECT_TIMEOUT=10 psql -X -q -v ON_ERROR_STOP=1 \
      -v kind="$1" -v ok="$2" -v started="$3" -v label="$4" -v db_file="$5" -v db_bytes="$6" \
      -v up_file="$7" -v up_bytes="$8" -v err="$9" >/dev/null 2>"$recf" <<'SQL'
INSERT INTO backup_runs (kind, ok, started_at, label, db_file, db_bytes, uploads_file, uploads_bytes, error)
VALUES (:'kind', :'ok'::boolean, to_timestamp(:'started'::bigint), NULLIF(:'label', ''), NULLIF(:'db_file', ''),
        NULLIF(:'db_bytes', '')::bigint, NULLIF(:'up_file', ''), NULLIF(:'up_bytes', '')::bigint,
        NULLIF(left(btrim(:'err'), 1000), ''));
SQL
  then
    echo "$(date '+%F %T') couldn't record this backup run in the database (backup_runs): $(head -n 1 "$recf" 2>/dev/null)." \
      "The backup itself is unaffected." >&2
  fi
  rm -f "$recf"
}

# backup_once <label or ""> <kind>
# Every step is checked by hand: in the loop this runs as `backup_once || ...`, where `set -e` is off.
backup_once() {
  label=${1:+_$1}
  kind=$2
  started=$(date +%s)
  exec 9>"$LOCK"
  flock 9 || return 1
  stamp=$(date +%Y-%m-%d_%H%M%S)$label
  while [ -e "/backups/db_${stamp}.dump" ] || [ -e "/backups/uploads_${stamp}.tar.gz" ]; do
    sleep 1
    stamp=$(date +%Y-%m-%d_%H%M%S)$label
  done
  db="/backups/db_${stamp}.dump"
  up="/backups/uploads_${stamp}.tar.gz"
  errf="/tmp/backup-err.$$"
  if ! { pg_dump -Fc -f "$db.part" 2>"$errf" && mv "$db.part" "$db" \
      && tar -czf "$up.part" -C /uploads . 2>>"$errf" && mv "$up.part" "$up"; }; then
    cat "$errf" >&2 2>/dev/null
    err=$(tail -n 3 "$errf" 2>/dev/null | tr '\n' ' ')
    rm -f "$db.part" "$up.part" "$errf"
    exec 9>&-
    echo "$(date '+%F %T') backup ${stamp} FAILED" >&2
    dbf=""
    [ -e "$db" ] && dbf=$(basename "$db") # the database part finished; only the uploads failed
    record_run "$kind" false "$started" "${1:-}" "$dbf" "" "" "" "${err:-backup failed}"
    return 1
  fi
  cat "$errf" >&2 2>/dev/null # warnings, if any
  rm -f "$errf"
  find /backups -maxdepth 1 -type f \( -name 'db_*.dump' -o -name 'uploads_*.tar.gz' \) -mtime +"$KEEP" -delete
  find /backups -maxdepth 1 -type f -name '*.part' -mtime +1 -delete
  exec 9>&-
  echo "$(date '+%F %T') backup ${stamp} done"
  record_run "$kind" true "$started" "${1:-}" "$(basename "$db")" "$(size "$db")" "$(basename "$up")" "$(size "$up")" ""
}

# True if tonight's plain nightly backup exists (HHMMSS, or HHMM from older versions of this script).
# A labeled one-off like _before-restore doesn't count.
has_nightly() {
  for f in /backups/db_"$1"_[0-9][0-9][0-9][0-9][0-9][0-9].dump /backups/db_"$1"_[0-9][0-9][0-9][0-9].dump; do
    [ -e "$f" ] && return 0
  done
  return 1
}

if [ "${1:-}" != "loop" ]; then
  case "${1:-}" in
    *[!a-z0-9-]*) echo "label must be lowercase letters, digits and dashes" >&2; exit 1 ;;
  esac
  backup_once "${1:-}" manual || exit 1
  exit 0
fi

echo "$(date '+%F %T') backup loop started: daily after ${HOUR}:00, keeping ${KEEP} days"
# After the PC (or Docker) restarts, every container starts at once; wait for the database before the first try.
for _ in $(seq 1 60); do pg_isready -q && break; sleep 5; done
while true; do
  today=$(date +%Y-%m-%d)
  hour=$(date +%H)
  hour=${hour#0}
  if [ "$hour" -ge "$HOUR" ] && ! has_nightly "$today"; then
    backup_once "" nightly || echo "$(date '+%F %T') backup FAILED, will retry in 10 minutes" >&2
  fi
  sleep 600
done

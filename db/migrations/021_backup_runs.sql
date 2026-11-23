-- 021: a record of every backup run, so Admin → About can show when the last backup ran and whether it worked, and
-- warn when the last good one is old. The nightly job (scripts/backup.sh, in its own container) adds a row with psql
-- after each try; the app adds one for the backup it takes before migrating the database (src/backup.ts). Only what
-- an admin needs to judge a backup: kind, label, times, file names and sizes, and a short error. No secrets, and
-- nothing from the records themselves.
--
-- The backup files in the backup folder are the backups; this table only describes them. Restoring a backup brings
-- back that backup's copy of this table too, so runs after it drop out of the list (the files stay).

CREATE TABLE backup_runs (
  id             bigserial   PRIMARY KEY,
  -- nightly: the daily loop; manual: `backup.sh [label]` by hand or from restore.sh; pre-migrate: the app, before
  -- applying database migrations
  kind           text        NOT NULL CHECK (kind IN ('nightly', 'manual', 'pre-migrate')),
  label          text        CHECK (label ~ '^[a-z0-9-]{1,100}$'),    -- e.g. before-update, before-migrate-021
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  ok             boolean     NOT NULL,
  db_file        text        CHECK (length(db_file) <= 200),           -- file names only, never a path
  db_bytes       bigint      CHECK (db_bytes >= 0),
  uploads_file   text        CHECK (length(uploads_file) <= 200),
  uploads_bytes  bigint      CHECK (uploads_bytes >= 0),
  error          text        CHECK (length(error) <= 1000)
);
CREATE INDEX backup_runs_finished ON backup_runs (finished_at DESC);

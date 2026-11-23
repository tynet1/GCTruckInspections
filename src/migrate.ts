import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { recordBackupRun, takeBackup } from "./backup.ts";
import type { BackupResult } from "./backup.ts";
import { config } from "./config.ts";
import { pool } from "./db.ts";

const LOCK_ID = 727001;

export interface MigrateOptions {
  /** Folder of NNN_*.sql files (default db/migrations). */
  dir?: string;
  /** Takes the backup before migrating an existing database; null skips it. Default: takeBackup, unless
   * PRE_MIGRATE_BACKUP=off. */
  backup?: ((label: string) => Promise<BackupResult>) | null;
}

/** Thrown when the backup before migrating failed. Nothing was applied: the database is as it was. */
export class PreMigrateBackupError extends Error {}

/**
 * Apply db/migrations/NNN_*.sql in order, each in its own transaction. Safe to run concurrently.
 * On an existing database (one with migrations already applied) with migrations pending, a labeled backup
 * (before-migrate-NNN, NNN = the first pending one) is taken first, while holding the migration lock; if it fails,
 * nothing is applied and this throws PreMigrateBackupError. A new, empty database has nothing to back up.
 */
export async function migrate(log: (msg: string) => void = console.log, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? config.migrationsDir;
  const backup = opts.backup !== undefined ? opts.backup : config.preMigrateBackup ? takeBackup : null;
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const pending = files.filter((f) => !done.has(f));

    let taken: BackupResult | null = null;
    if (pending.length && done.size) {
      const label = `before-migrate-${pending[0].match(/^\d+/)![0]}`;
      if (!backup) {
        log(`PRE_MIGRATE_BACKUP is off: applying ${pending.length} migration(s) with no backup first`);
      } else {
        log(`backing up before applying ${pending.length} migration(s) (${pending.join(", ")}): ${label}`);
        const started_at = new Date();
        try {
          taken = await backup(label);
        } catch (e) {
          const why = (e as Error).message;
          await recordBackupRun({ kind: "pre-migrate", ok: false, label, started_at, error: why }, c).catch(() => {});
          throw new PreMigrateBackupError([
            "PRE-MIGRATION BACKUP FAILED, so no migrations were applied. The database is unchanged.",
            `  Pending: ${pending.join(", ")}`,
            `  Error: ${why}`,
            "  Fix the backup and start the app again: is the backup folder (BACKUP_DIR) mounted and writable,",
            "  with enough free space? Is pg_dump there, the same major version as the database server?",
            "  To migrate without a backup (not recommended), set PRE_MIGRATE_BACKUP=off.",
          ].join("\n"));
        }
        log(`pre-migration backup done: ${taken.db_file} (${taken.db_bytes} bytes), ${taken.uploads_file} (${taken.uploads_bytes} bytes)`);
      }
    }

    try {
      for (const f of pending) {
        const sql = await readFile(join(dir, f), "utf8");
        await c.query("BEGIN");
        try {
          await c.query(sql);
          await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
        }
        applied.push(f);
        log(`migration applied: ${f}`);
      }
    } finally {
      // Recorded after migrating, since the table it goes in may be one of the migrations (021). A backup kept
      // from an earlier try in this process (server.ts) is recorded once.
      if (taken && !taken.recorded) {
        taken.recorded = await recordBackupRun({ kind: "pre-migrate", ok: true, ...taken }, c)
          .catch((e) => { log(`couldn't record the pre-migration backup in backup_runs: ${(e as Error).message}`); return false; });
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    c.release();
  }
  return applied;
}

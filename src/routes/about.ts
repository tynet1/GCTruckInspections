// Admin → About & updates: the running version, the database's migration level, the last backup, and the optional
// update check (src/updates.ts). Admins only. Nothing here changes the server: updates are installed by whoever runs
// it (docs/DEPLOY.md §6).
import { readdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.ts";
import { backupFolderSummary } from "../backup.ts";
import { config } from "../config.ts";
import { one, q } from "../db.ts";
import { bad, notFound, obj } from "../http.ts";
import { setUpdateCheck, updateStatus } from "../updates.ts";

/** Warn when the newest good backup is older than this. */
export const BACKUP_STALE_DAYS = 2;

/** How to install an update: docs/DEPLOY.md §6 (keep the two the same). */
export const UPDATE_STEPS = [
  "# On the server, in the app's folder:",
  "docker compose exec -T backup /bin/sh /backup.sh before-update",
  "git pull --ff-only",
  "nohup sh -c 'docker compose up -d --build app > ~/app-update.log 2>&1; echo EXIT=$? >> ~/app-update.log' &",
  "# When ~/app-update.log ends with EXIT=0, restart the backup job so it runs the new backup.sh:",
  "docker compose up -d --no-deps --force-recreate backup",
];

const RUN_COLS = `id, kind, label, started_at, finished_at, ok, db_file, db_bytes, uploads_file, uploads_bytes, error`;

async function backupInfo() {
  const hasTable = !!(await one(`SELECT to_regclass('public.backup_runs') AS t`))?.t;
  const recent = hasTable ? await q(`SELECT ${RUN_COLS} FROM backup_runs ORDER BY finished_at DESC, id DESC LIMIT 10`) : [];
  const lastOk = hasTable ? await one(`SELECT ${RUN_COLS} FROM backup_runs WHERE ok ORDER BY finished_at DESC, id DESC LIMIT 1`) : undefined;
  const folder = await backupFolderSummary();
  // The folder is a second witness: a restore brings back an older copy of backup_runs, but not older files.
  const times = [lastOk?.finished_at, folder?.newest?.at].filter(Boolean).map((t) => new Date(t).getTime());
  const lastGood = times.length ? new Date(Math.max(...times)) : null;
  return {
    last: recent[0] ?? null,
    last_ok: lastOk ?? null,
    recent,
    folder,
    last_good_at: lastGood?.toISOString() ?? null,
    stale: !lastGood || Date.now() - lastGood.getTime() > BACKUP_STALE_DAYS * 24 * 3600_000,
    stale_days: BACKUP_STALE_DAYS,
    pre_migrate: config.preMigrateBackup,
  };
}

async function databaseInfo() {
  const rows = await q<{ name: string; applied_at: string }>(`SELECT name, applied_at FROM schema_migrations ORDER BY name`);
  const files = (await readdir(config.migrationsDir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied = new Set(rows.map((r) => r.name));
  const known = new Set(files);
  const latest = rows.at(-1) ?? null;
  return {
    latest: latest?.name ?? null,
    latest_applied_at: latest?.applied_at ?? null,
    count: rows.length,
    pending: files.filter((f) => !applied.has(f)),
    // Applied by a newer version of the app than this one (it was rolled back): the database is ahead of the code.
    unknown: rows.map((r) => r.name).filter((n) => !known.has(n)),
  };
}

export async function aboutInfo() {
  const [database, backups, updates] = await Promise.all([databaseInfo(), backupInfo(), updateStatus()]);
  return {
    version: config.version,
    node: process.version,
    database,
    backups,
    updates,
    update_steps: UPDATE_STEPS,
  };
}

export default async function aboutRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireRole("admin"));

  app.get("/admin/about", async () => aboutInfo());

  app.put("/admin/update-check", async (req) => {
    if (!config.updateCheckRepo) throw notFound("Update checks aren't set up on this server (UPDATE_CHECK_REPO).");
    const b = obj(req.body);
    if (typeof b.enabled !== "boolean") throw bad("enabled must be true or false.");
    await setUpdateCheck(b.enabled, req.user!.id);
    return aboutInfo();
  });
}

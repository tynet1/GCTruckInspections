// The app's own backup, taken before it migrates an existing database (src/migrate.ts). Same files and rules as the
// nightly job (scripts/backup.sh), so scripts/restore.sh restores it like any other:
//   <backup folder>/db_<stamp>.dump          pg_dump custom format
//   <backup folder>/uploads_<stamp>.tar.gz   every photo, signature and uploaded diagram
// <stamp> is YYYY-MM-DD_HHMMSS_<label> in local time (TZ). Each file is written as <name>.part, flushed to disk and
// renamed only when complete; an existing backup is never overwritten; a failed try leaves no files behind.
import { spawn } from "node:child_process";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "./config.ts";
import { one, pool } from "./db.ts";
import type { Db } from "./db.ts";

export interface BackupResult {
  label: string;
  started_at: Date;
  finished_at: Date;
  db_file: string;
  db_bytes: number;
  uploads_file: string;
  uploads_bytes: number;
  recorded?: boolean;    // set once it's in backup_runs
}

export interface BackupOptions {
  dir?: string;          // default: config.backupDir
  uploadDir?: string;    // default: config.uploadDir
  pgDump?: string[];     // command and leading arguments; default: [config.pgDump]
  tar?: string[];        // default: ["tar"]
  now?: () => Date;
  waitMs?: number;       // how long to wait before trying the next second's name when one is taken
}

export const LABEL_RE = /^[a-z0-9-]{1,100}$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** backup.sh's `date +%Y-%m-%d_%H%M%S`, in the server's local time. */
export function stampOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** pg_dump reads the connection from PG* variables. Without DATABASE_URL they're already set (docker-compose.yml);
 * with it, they're filled in from the URL, so the password never appears on a command line. */
export function pgEnv(url = config.databaseUrl): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!url) return env;
  const u = new URL(url);
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname.replace(/^\[(.*)\]$/, "$1"));
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (db) env.PGDATABASE = db;
  const host = u.searchParams.get("host"); // a Unix socket folder: postgres:///db?host=/var/run/postgresql
  if (host) env.PGHOST = host;
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

/** Run a command; resolves when it exits 0, otherwise rejects with the end of what it printed to stderr. */
function run(cmd: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    child.on("error", (e) => reject(new Error(`${cmd[0]} couldn't start: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd[0]} failed (${signal ?? `exit ${code}`})${err.trim() ? `: ${err.trim()}` : ""}`));
    });
  });
}

/** Flush a finished file to disk before it gets its final name, so a power cut can't leave a "complete" empty file. */
async function flush(path: string) {
  const fh = await open(path, "r+");
  try { await fh.sync(); } finally { await fh.close(); }
}

async function flushDir(dir: string) {
  try {
    const fh = await open(dir, "r");
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* Windows can't open a folder; Linux can */ }
}

/** Take one labeled backup (database + uploads). Throws if any part fails, leaving no files of this try behind. */
export async function takeBackup(label: string, opts: BackupOptions = {}): Promise<BackupResult> {
  if (!LABEL_RE.test(label)) throw new Error("A backup label is lowercase letters, digits and dashes.");
  const dir = opts.dir ?? config.backupDir;
  const uploadDir = opts.uploadDir ?? config.uploadDir;
  const now = opts.now ?? (() => new Date());
  const started_at = now();
  await mkdir(dir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });

  let stamp = `${stampOf(started_at)}_${label}`;
  const names = (s: string) => ({ db: join(dir, `db_${s}.dump`), up: join(dir, `uploads_${s}.tar.gz`) });
  while (await exists(names(stamp).db) || await exists(names(stamp).up)) {
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 1000));
    stamp = `${stampOf(now())}_${label}`;
  }
  const { db, up } = names(stamp);
  const done: string[] = [];
  try {
    await run([...(opts.pgDump ?? [config.pgDump]), "-Fc", "--lock-wait-timeout=60000", "-f", `${db}.part`], { env: pgEnv() });
    // A custom-format dump starts with "PGDMP"; anything else isn't one, whatever pg_dump's exit code said.
    const fh = await open(`${db}.part`, "r");
    const head = Buffer.alloc(5);
    try { await fh.read(head, 0, 5, 0); } finally { await fh.close(); }
    if (head.toString("latin1") !== "PGDMP") throw new Error("pg_dump didn't write a database dump.");
    await flush(`${db}.part`);
    await rename(`${db}.part`, db);
    done.push(db);

    // Run in the backup folder with a bare file name: GNU tar reads "C:\..." in -f as a remote host:path.
    await run([...(opts.tar ?? ["tar"]), "-czf", `${basename(up)}.part`, "-C", uploadDir, "."], { cwd: dir });
    await flush(`${up}.part`);
    await rename(`${up}.part`, up);
    done.push(up);
    await flushDir(dir);
  } catch (e) {
    // Unlike the nightly job, a half pair is removed too: this backup is only useful whole, and a restart loop
    // mustn't fill the disk (the database's own disk, often) with database dumps.
    for (const p of [`${db}.part`, `${up}.part`, ...done]) await unlink(p).catch(() => {});
    throw e;
  }
  return {
    label,
    started_at,
    finished_at: now(),
    db_file: `db_${stamp}.dump`,
    db_bytes: (await stat(db)).size,
    uploads_file: `uploads_${stamp}.tar.gz`,
    uploads_bytes: (await stat(up)).size,
  };
}

export interface BackupRun {
  kind: "nightly" | "manual" | "pre-migrate";
  ok: boolean;
  label: string | null;
  started_at: Date;
  finished_at?: Date;
  db_file?: string | null;
  db_bytes?: number | null;
  uploads_file?: string | null;
  uploads_bytes?: number | null;
  error?: string | null;
}

/** Add a row to backup_runs (021). Returns false when the table isn't there yet (a database before 021). */
export async function recordBackupRun(r: BackupRun, db: Db = pool): Promise<boolean> {
  const t = await one<{ t: string | null }>(`SELECT to_regclass('public.backup_runs')::text AS t`, [], db);
  if (!t?.t) return false;
  await db.query(
    `INSERT INTO backup_runs (kind, ok, label, started_at, finished_at, db_file, db_bytes, uploads_file, uploads_bytes, error)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9, left($10, 1000))`,
    [r.kind, r.ok, r.label, r.started_at, r.finished_at ?? null, r.db_file ?? null, r.db_bytes ?? null,
      r.uploads_file ?? null, r.uploads_bytes ?? null, r.error ?? null],
  );
  return true;
}

export interface BackupFolderSummary {
  pairs: number;                                   // complete backups: a database dump and its uploads archive
  newest: { stamp: string; at: string; db_bytes: number; uploads_bytes: number } | null;
}

const PAIR_RE = /^db_(\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?(?:_[a-z0-9-]+)?)\.dump$/;

/** What's in the backup folder, as a check on backup_runs (a restore brings back an older copy of that table).
 * Null when the folder can't be read (not mounted, or a development machine without one). */
export async function backupFolderSummary(dir = config.backupDir): Promise<BackupFolderSummary | null> {
  let names: string[];
  try { names = await readdir(dir); } catch { return null; }
  const have = new Set(names);
  let pairs = 0;
  let newest: BackupFolderSummary["newest"] = null;
  for (const n of names) {
    const m = PAIR_RE.exec(n);
    if (!m || !have.has(`uploads_${m[1]}.tar.gz`)) continue;
    try {
      const [d, u] = await Promise.all([stat(join(dir, n)), stat(join(dir, `uploads_${m[1]}.tar.gz`))]);
      pairs++;
      const at = new Date(Math.max(d.mtimeMs, u.mtimeMs));
      if (!newest || at.getTime() > Date.parse(newest.at)) {
        newest = { stamp: m[1], at: at.toISOString(), db_bytes: d.size, uploads_bytes: u.size };
      }
    } catch { /* pruned while we looked */ }
  }
  return { pairs, newest };
}

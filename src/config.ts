import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = process.env;
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name?: string; version?: string };

/** "owner/name" of a GitHub repository, or "" when unset or not in that shape. */
function repoName(v: string | undefined): string {
  const s = (v ?? "").trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(s) && !/\/\.\.?$/.test(s) ? s : "";
}

export const config = {
  root,
  // The running version, shown in Admin → About and compared with the latest release by the update check.
  version: String(pkg.version ?? "0.0.0"),
  appName: String(pkg.name ?? "app"),
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? "0.0.0.0",
  logLevel: env.LOG_LEVEL ?? "info",
  // node-postgres also reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE when DATABASE_URL is unset.
  databaseUrl: env.DATABASE_URL || undefined,
  uploadDir: resolve(root, env.UPLOAD_DIR ?? "data/uploads"),
  publicDir: resolve(root, "public"),
  migrationsDir: resolve(root, "db/migrations"),
  vehiclesCsv: resolve(root, env.SEED_VEHICLES_CSV ?? "seed/vehicles.csv"),
  // Backups: the folder the nightly job writes to (mounted at /backups in the app container too), where the app puts
  // its own backup before it migrates an existing database. PRE_MIGRATE_BACKUP=off skips that backup (dev and tests
  // only: then migrations run without a restore point). PG_DUMP: the pg_dump to use (must match the server's version).
  backupDir: resolve(root, env.BACKUP_DIR || "backups"),
  preMigrateBackup: !["off", "false", "0", "no"].includes((env.PRE_MIGRATE_BACKUP ?? "").trim().toLowerCase()),
  pgDump: env.PG_DUMP || "pg_dump",
  // Optional update check (Admin → About): the GitHub repository whose latest release is compared with `version`.
  // Blank hides the feature; an admin still has to turn it on.
  updateCheckRepo: repoName(env.UPDATE_CHECK_REPO),
  // "auto": Secure cookie when the request arrived over HTTPS (via X-Forwarded-Proto).
  cookieSecure: (env.COOKIE_SECURE ?? "auto") as "auto" | "true" | "false",
  // Which hops may set X-Forwarded-For/-Proto: Caddy and cloudflared sit on Docker's private network. The client's
  // address is the first one past them, so a phone can't pick its own address to dodge the sign-in limits.
  trustProxy: env.TRUST_PROXY || "loopback, linklocal, uniquelocal",
  admin: {
    name: env.ADMIN_NAME || "Admin",
    email: env.ADMIN_EMAIL || "",
    password: env.ADMIN_PASSWORD || "",
  },
  session: {
    crewDays: 30,
    staffDays: 14,
  },
  lockout: {
    // An account locks after this many wrong tries in a row...
    maxFailures: 5,
    // ...for 15 minutes, doubling with each lockout in the same 24 hours (15, 30, 60, 120), up to maxMinutes.
    minutes: 15,
    maxMinutes: 240,
    // Wrong PINs/passwords from one network (any accounts) before it has to wait.
    addressMaxFailures: 20,
    addressWindowMinutes: 60,
  },
  photo: {
    maxBytes: 12 * 1024 * 1024,
    orphanDays: 7,
    // Per person per 24 hours. Phones shrink photos to ~0.5 MB, so this is thousands of photos.
    dailyBytesPerUser: Number(env.UPLOAD_DAILY_MB || 1024) * 1024 * 1024,
    // Photos wait on the phone instead of filling the disk the database lives on.
    minFreeBytes: Number(env.UPLOAD_MIN_FREE_MB || 2048) * 1024 * 1024,
  },
} as const;

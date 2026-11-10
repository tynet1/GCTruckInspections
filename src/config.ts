import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = process.env;

export const config = {
  root,
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? "0.0.0.0",
  logLevel: env.LOG_LEVEL ?? "info",
  // node-postgres also reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE when DATABASE_URL is unset.
  databaseUrl: env.DATABASE_URL || undefined,
  uploadDir: resolve(root, env.UPLOAD_DIR ?? "data/uploads"),
  publicDir: resolve(root, "public"),
  migrationsDir: resolve(root, "db/migrations"),
  vehiclesCsv: resolve(root, env.SEED_VEHICLES_CSV ?? "seed/vehicles.csv"),
  // "auto": Secure cookie when the request arrived over HTTPS (via X-Forwarded-Proto).
  cookieSecure: (env.COOKIE_SECURE ?? "auto") as "auto" | "true" | "false",
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
    maxFailures: 5,
    minutes: 15,
  },
  photo: {
    maxBytes: 12 * 1024 * 1024,
    orphanDays: 7,
  },
} as const;

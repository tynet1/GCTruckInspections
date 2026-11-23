// Admin → About & updates and the backup before migrations, against a real Postgres. Needs TEST_DATABASE_URL like
// test/api.test.ts; it drops and recreates the public schema, so never point it at real data. The update check never
// reaches the network: GitHub is a stub.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("about & updates tests", { skip: "set TEST_DATABASE_URL to run" }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "gc-uploads-"));
  const backupDir = mkdtempSync(join(tmpdir(), "gc-backups-"));
  process.env.BACKUP_DIR = backupDir;
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "admin-password-1";
  process.env.LOG_LEVEL = "silent";
  delete process.env.UPDATE_CHECK_REPO;

  const { pool, q, one } = await import("../src/db.ts");
  const { migrate, PreMigrateBackupError } = await import("../src/migrate.ts");
  const { ensureAdmin, seedVehicles } = await import("../src/seed.ts");
  const { buildApp } = await import("../src/server.ts");
  const { hashSecret } = await import("../src/auth.ts");
  const { config } = await import("../src/config.ts");
  const { closePdfBrowser } = await import("../src/pdf.ts");
  const { takeBackup } = await import("../src/backup.ts");
  const { updateDeps, CHECK_EVERY_MS } = await import("../src/updates.ts");
  type BackupResult = Awaited<ReturnType<typeof takeBackup>>;

  // config is read-only for the app; the tests switch the update check's repository and the running version.
  const cfg = config as unknown as { updateCheckRepo: string; version: string };
  const realVersion = config.version;
  const H = { "x-gc-app": "1" };
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin = "", sup = "";
  const freshBackupCalls: string[] = [];

  async function inject(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
    return app.inject({
      method: method as "GET", url: "/api" + path,
      headers: { ...H, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const about = async (): Promise<any> => {
    const r = await inject("GET", "/admin/about", { cookie: admin });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };

  // ---------- GitHub stand-in ----------
  let clock = Date.parse("2026-11-23T15:00:00Z");
  let calls: { url: string; init: RequestInit }[] = [];
  let answer: () => Response | Promise<Response> = () => new Response("{}", { status: 500 });
  const release = (tag: string, extra: Record<string, unknown> = {}) => () => Response.json({
    tag_name: tag, name: "Spring release", published_at: "2026-11-20T10:00:00Z",
    body: "<script>alert('x')</script>\n- Faster PDFs", html_url: "https://evil.example/not-github", ...extra,
  });

  before(async () => {
    await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    // A new, empty database has nothing to back up.
    await migrate(() => {}, { backup: async (label) => { freshBackupCalls.push(label); throw new Error("not expected"); } });
    await ensureAdmin(() => {});
    await seedVehicles(() => {});
    await q(`INSERT INTO users (name, role, email, password_hash) VALUES ('Sam Super', 'supervisor', 'sup@test.local', $1)`,
      [await hashSecret("super-password-1")]);
    app = await buildApp({ logger: false });
    const login = async (email: string, password: string) => cookieOf(await inject("POST", "/auth/login", { body: { email, password } }));
    admin = await login("admin@test.local", "admin-password-1");
    sup = await login("sup@test.local", "super-password-1");
    updateDeps.now = () => clock;
    updateDeps.fetch = async (u, init) => { calls.push({ url: u, init }); return answer(); };
  });

  after(async () => {
    cfg.updateCheckRepo = "";
    cfg.version = realVersion;
    await app?.close();
    await closePdfBrowser();
    await pool.end();
  });

  describe("about", () => {
    test("admins only", async () => {
      assert.equal((await inject("GET", "/admin/about", { cookie: sup })).statusCode, 403);
      assert.equal((await inject("GET", "/admin/about")).statusCode, 401);
      assert.equal((await inject("PUT", "/admin/update-check", { cookie: sup, body: { enabled: true } })).statusCode, 403);
    });

    test("the running version and the database's migration level", async () => {
      const d = await about();
      const pkg = JSON.parse(readFileSync(join(config.root, "package.json"), "utf8"));
      assert.equal(d.version, pkg.version);
      const files = readdirSync(config.migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
      assert.equal(d.database.latest, files.at(-1));
      assert.equal(d.database.count, files.length);
      assert.deepEqual(d.database.pending, []);
      assert.deepEqual(d.database.unknown, []);
      assert.ok(d.database.latest_applied_at);
      assert.deepEqual(freshBackupCalls, [], "no backup before migrating a new, empty database");
    });

    test("no backup on record: warns", async () => {
      const b = (await about()).backups;
      assert.equal(b.last, null);
      assert.equal(b.last_good_at, null);
      assert.equal(b.stale, true);
      assert.deepEqual(b.folder, { pairs: 0, newest: null });
      assert.equal(b.pre_migrate, true);
    });

    test("last backup, whether it worked, and a warning when the last good one is over 2 days old", async () => {
      // What scripts/backup.sh records with psql.
      const run = (kind: string, ok: boolean, ago: string, extra = "NULL") => q(
        `INSERT INTO backup_runs (kind, ok, started_at, finished_at, label, db_file, db_bytes, uploads_file, uploads_bytes, error)
         VALUES ($1, $2, now() - $3::interval - interval '1 minute', now() - $3::interval, ${extra}, $4, $5, $6, $7, $8)`,
        [kind, ok, ago, ok ? "db_x.dump" : null, ok ? 1000 : null, ok ? "uploads_x.tar.gz" : null, ok ? 5000 : null, ok ? null : "pg_dump: error: no space"]);
      await run("nightly", true, "3 days");
      let b = (await about()).backups;
      assert.equal(b.last.kind, "nightly");
      assert.equal(b.last.ok, true);
      assert.equal(b.last.db_bytes, 1000);
      assert.equal(b.stale, true, "3 days old");

      await run("manual", true, "1 hour", "'before-update'");
      b = (await about()).backups;
      assert.equal(b.stale, false);
      assert.equal(b.last.label, "before-update");

      await run("nightly", false, "1 minute");
      b = (await about()).backups;
      assert.equal(b.last.ok, false, "the newest run failed");
      assert.equal(b.last.error, "pg_dump: error: no space");
      assert.equal(b.last_ok.label, "before-update");
      assert.equal(b.stale, false, "the last good one is still recent");
      assert.equal(b.recent.length, 3);
    });

    test("the backup folder is a second witness (a restore brings back an older backup_runs)", async () => {
      await q(`UPDATE backup_runs SET finished_at = finished_at - interval '5 days'`);
      assert.equal((await about()).backups.stale, true);
      writeFileSync(join(backupDir, "db_2026-11-23_020011.dump"), "PGDMP");
      assert.equal((await about()).backups.stale, true, "half a backup doesn't count");
      writeFileSync(join(backupDir, "uploads_2026-11-23_020011.tar.gz"), "x");
      const b = (await about()).backups;
      assert.equal(b.folder.pairs, 1);
      assert.equal(b.stale, false);
    });
  });

  describe("update check", () => {
    test("hidden when UPDATE_CHECK_REPO is blank", async () => {
      cfg.updateCheckRepo = "";
      assert.equal((await about()).updates, null);
      assert.equal((await inject("PUT", "/admin/update-check", { cookie: admin, body: { enabled: true } })).statusCode, 404);
      assert.equal(calls.length, 0);
    });

    test("off by default: nothing is sent", async () => {
      cfg.updateCheckRepo = "example-org/example-app";
      cfg.version = "1.2.0";
      const u = (await about()).updates;
      assert.equal(u.enabled, false);
      assert.equal(u.state, "off");
      assert.equal(u.repo, "example-org/example-app");
      assert.equal(calls.length, 0);
    });

    test("turned on: one plain GET to GitHub, then a newer release is shown", async () => {
      answer = release("v1.3.0");
      assert.equal((await inject("PUT", "/admin/update-check", { cookie: admin, body: { enabled: "yes" } })).statusCode, 400);
      const r = await inject("PUT", "/admin/update-check", { cookie: admin, body: { enabled: true } });
      assert.equal(r.statusCode, 200, r.body);
      const u = r.json().updates;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.github.com/repos/example-org/example-app/releases/latest");
      assert.equal(calls[0].init.method, "GET");
      const headers = new Headers(calls[0].init.headers);
      assert.deepEqual([...headers.keys()].sort(), ["accept", "user-agent", "x-github-api-version"], "nothing but what GitHub asks for");
      assert.equal(calls[0].init.body, undefined);
      assert.ok(!/1\.2\.0|admin|test\.local/.test(JSON.stringify(calls[0])), "no version, user or address sent");
      assert.equal(u.enabled, true);
      assert.equal(u.state, "available");
      assert.equal(u.current, "1.2.0");
      assert.equal(u.latest.version, "1.3.0");
      assert.equal(u.latest.name, "Spring release");
      assert.equal(u.latest.notes, "<script>alert('x')</script>\n- Faster PDFs", "the text as written; the screen escapes it");
      assert.equal(u.latest.url, "https://github.com/example-org/example-app/releases/tag/v1.3.0", "never a link from the answer");
      assert.equal(Date.parse(u.next_check_at) - Date.parse(u.checked_at), CHECK_EVERY_MS);
      assert.ok(r.json().update_steps.some((s: string) => s.includes("backup.sh before-update")));
    });

    test("at most once a day", async () => {
      clock += CHECK_EVERY_MS - 60_000;
      assert.equal((await about()).updates.state, "available");
      assert.equal(calls.length, 1, "still cached");
      clock += 120_000;
      answer = release("1.2.0");
      const u = (await about()).updates;
      assert.equal(calls.length, 2, "a day later it asks again");
      assert.equal(u.state, "current");
      assert.equal(u.latest.version, "1.2.0");
    });

    test("an update installed meanwhile shows as current without asking again", async () => {
      answer = release("v1.4.0");
      clock += CHECK_EVERY_MS;
      assert.equal((await about()).updates.state, "available");
      cfg.version = "1.4.0";
      assert.equal((await about()).updates.state, "current");
      assert.equal(calls.length, 3);
    });

    test("no network, rate limits and odd answers: \"couldn't check\", never an error page", async () => {
      const cases: [() => Response | Promise<Response>, RegExp][] = [
        [() => { throw new TypeError("fetch failed"); }, /Couldn't reach GitHub/],
        [() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, /didn't answer in time/],
        [() => new Response("{}", { status: 403 }), /limit/],
        [() => new Response("{}", { status: 429 }), /limit/],
        [() => new Response("{}", { status: 404 }), /No published release/],
        [() => new Response("{}", { status: 502 }), /502/],
        [() => new Response("not json", { status: 200 }), /couldn't be read/],
        [() => Response.json({ name: "x" }), /no version tag/],
      ];
      for (const [a, why] of cases) {
        answer = a;
        clock += CHECK_EVERY_MS;
        const r = await inject("GET", "/admin/about", { cookie: admin });
        assert.equal(r.statusCode, 200, r.body);
        const u = r.json().updates;
        assert.equal(u.state, "failed");
        assert.match(u.message, why);
        assert.equal(u.latest, null);
      }
      answer = release("nightly-2026-11-23");
      clock += CHECK_EVERY_MS;
      const u = (await about()).updates;
      assert.equal(u.state, "unknown");
      assert.match(u.message, /can't be compared/);
    });

    test("a failed check waits a day too", async () => {
      answer = () => new Response("{}", { status: 429 });
      clock += CHECK_EVERY_MS;
      await about();
      const n = calls.length;
      clock += 3600_000;
      await about();
      assert.equal(calls.length, n);
    });

    test("turned off: no more checks", async () => {
      const r = await inject("PUT", "/admin/update-check", { cookie: admin, body: { enabled: false } });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().updates.state, "off");
      const n = calls.length;
      clock += 5 * CHECK_EVERY_MS;
      assert.equal((await about()).updates.enabled, false);
      assert.equal(calls.length, n);
      const s = await one(`SELECT value, updated_by FROM settings WHERE key = 'update_check'`);
      assert.deepEqual(s.value, { enabled: false });
      assert.ok(s.updated_by, "who changed it");
    });
  });

  describe("backup before migrations", () => {
    // A copy of the real migrations plus test ones, so "pending migrations on an existing database" can be staged.
    const base = readdirSync(config.migrationsDir).filter((f) => f.endsWith(".sql"));
    function migrationsWith(extra: Record<string, string>) {
      const dir = mkdtempSync(join(tmpdir(), "gc-migrations-"));
      for (const f of base) copyFileSync(join(config.migrationsDir, f), join(dir, f));
      for (const [f, sql] of Object.entries(extra)) writeFileSync(join(dir, f), sql);
      return dir;
    }
    const probeA = { "990_probe_a.sql": "CREATE TABLE gate_probe_a (x int);" };
    const exists = async (t: string) => !!(await one(`SELECT to_regclass($1) AS t`, [t]))?.t;
    const appliedNames = async () => (await q(`SELECT name FROM schema_migrations`)).map((r) => r.name as string);
    const runs = (label: string) => q(`SELECT * FROM backup_runs WHERE kind = 'pre-migrate' AND label = $1 ORDER BY id`, [label]);
    const fake = join(mkdtempSync(join(tmpdir(), "gc-fake-")), "pg-dump.mjs");
    writeFileSync(fake, `import { writeFileSync } from "node:fs"; const a = process.argv.slice(2); writeFileSync(a[a.indexOf("-f") + 1], "PGDMP test");`);
    const gateDir = mkdtempSync(join(tmpdir(), "gc-backups-gate-"));
    const realBackup = (label: string) => takeBackup(label, { dir: gateDir, pgDump: [process.execPath, fake] });

    test("if the backup fails, no migration is applied and it says so loudly", async () => {
      const logs: string[] = [];
      await assert.rejects(
        migrate((m) => logs.push(m), { dir: migrationsWith(probeA), backup: async () => { throw new Error("No space left on device"); } }),
        (e: Error) => e instanceof PreMigrateBackupError && /PRE-MIGRATION BACKUP FAILED/.test(e.message)
          && /no migrations were applied/.test(e.message) && /990_probe_a\.sql/.test(e.message)
          && /No space left on device/.test(e.message) && /PRE_MIGRATE_BACKUP=off/.test(e.message),
      );
      assert.equal(await exists("gate_probe_a"), false);
      assert.ok(!(await appliedNames()).includes("990_probe_a.sql"));
      const [r] = await runs("before-migrate-990");
      assert.equal(r.ok, false);
      assert.equal(r.error, "No space left on device");
      assert.ok(logs.some((l) => /backing up before applying 1 migration/.test(l)));
    });

    test("with a backup, the pending migrations go in; the backup is recorded once, even across retries", async () => {
      // Like server.ts: retries in one process reuse the backup for the same first pending migration.
      const taken: string[] = [];
      let kept: BackupResult | null = null;
      const backupOnce = async (label: string) => (kept?.label === label ? kept : (taken.push(label), kept = await realBackup(label)));
      const dir = migrationsWith({ ...probeA, "991_broken.sql": "SELECT no_such_function();" });

      await assert.rejects(migrate(() => {}, { dir, backup: backupOnce }), /Migration 991_broken\.sql failed/);
      assert.deepEqual(taken, ["before-migrate-990"]);
      assert.equal(await exists("gate_probe_a"), true, "990 went in after its backup");
      const [r] = await runs("before-migrate-990");
      assert.equal(r.ok, true);
      assert.match(r.db_file, /^db_\d{4}-\d{2}-\d{2}_\d{6}_before-migrate-990\.dump$/);
      assert.match(r.uploads_file, /^uploads_\d{4}-\d{2}-\d{2}_\d{6}_before-migrate-990\.tar\.gz$/);
      assert.ok(r.db_bytes > 0 && r.uploads_bytes > 0);
      assert.deepEqual(readdirSync(gateDir).sort(), [r.db_file, r.uploads_file]);

      // 990 changed the database, so the next try backs up again (before 991), then reuses that one.
      await assert.rejects(migrate(() => {}, { dir, backup: backupOnce }), /991_broken/);
      await assert.rejects(migrate(() => {}, { dir, backup: backupOnce }), /991_broken/);
      assert.deepEqual(taken, ["before-migrate-990", "before-migrate-991"]);
      assert.equal((await runs("before-migrate-991")).length, 1);
      assert.equal(readdirSync(gateDir).length, 4);
    });

    test("PRE_MIGRATE_BACKUP=off migrates without a backup, and says so", async () => {
      const logs: string[] = [];
      const applied = await migrate((m) => logs.push(m), { dir: migrationsWith({ ...probeA, "992_probe_b.sql": "CREATE TABLE gate_probe_b (x int);" }), backup: null });
      assert.deepEqual(applied, ["992_probe_b.sql"]);
      assert.ok(logs.some((l) => /PRE_MIGRATE_BACKUP is off/.test(l)));
      assert.equal((await runs("before-migrate-992")).length, 0);
    });

    test("nothing pending: no backup", async () => {
      let called = 0;
      const applied = await migrate(() => {}, {
        dir: migrationsWith({ ...probeA, "992_probe_b.sql": "" }),
        backup: async (l) => { called++; return realBackup(l); },
      });
      assert.deepEqual(applied, []);
      assert.equal(called, 0);
    });

    test("About shows the pre-migration backup and database updates this version doesn't know", async () => {
      const d = await about();
      assert.deepEqual(d.database.unknown, ["990_probe_a.sql", "992_probe_b.sql"]);
      assert.equal(d.backups.recent.filter((r: { kind: string }) => r.kind === "pre-migrate").length, 3);
    });

    test("the default is the real backup, on unless PRE_MIGRATE_BACKUP=off", () => {
      assert.equal(config.preMigrateBackup, true);
      assert.equal(config.backupDir, backupDir);
    });
  });
}

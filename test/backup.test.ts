// The app's own backup (src/backup.ts) and the update check's version comparison (src/updates.ts). No database
// needed: pg_dump is a stand-in script, so these run everywhere; the real pg_dump is checked in the Docker image.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { backupFolderSummary, pgEnv, stampOf, takeBackup } from "../src/backup.ts";
import { compareVersions, parseVersion } from "../src/updates.ts";

const tools = mkdtempSync(join(tmpdir(), "gc-backup-tools-"));
// Stand-in pg_dump: `node fake.mjs <mode> ...pg_dump args`. ok writes a custom-format header and the PG* variables it
// was given; fail writes half a file and exits 1; junk exits 0 without writing a dump.
const fake = join(tools, "fake-pg-dump.mjs");
writeFileSync(fake, `
import { writeFileSync } from "node:fs";
const [mode, ...args] = process.argv.slice(2);
const f = args[args.indexOf("-f") + 1];
const pg = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PG")));
if (mode === "ok") writeFileSync(f, "PGDMP" + JSON.stringify({ args, pg }));
else if (mode === "fail") { writeFileSync(f, "PGDMP half"); console.error("pg_dump: error: connection to server failed: Connection refused"); process.exit(1); }
else writeFileSync(f, "hello");
`);
const failTar = join(tools, "fail-tar.mjs");
writeFileSync(failTar, `console.error("tar: No space left on device"); process.exit(2);`);
const pgDump = (mode: string) => [process.execPath, fake, mode];

function folders() {
  const dir = mkdtempSync(join(tmpdir(), "gc-backups-"));
  const uploads = mkdtempSync(join(tmpdir(), "gc-uploads-"));
  mkdirSync(join(uploads, "2026", "11"), { recursive: true });
  writeFileSync(join(uploads, "2026", "11", "photo.jpg"), "jpeg bytes");
  return { dir, uploads };
}

describe("backup before migrations", () => {
  test("writes db_<stamp>_<label>.dump and uploads_<stamp>_<label>.tar.gz, like backup.sh", async () => {
    const { dir, uploads } = folders();
    const at = new Date(2026, 10, 23, 14, 5, 9);
    const r = await takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: pgDump("ok"), now: () => at });
    assert.equal(r.db_file, "db_2026-11-23_140509_before-migrate-021.dump");
    assert.equal(r.uploads_file, "uploads_2026-11-23_140509_before-migrate-021.tar.gz");
    assert.deepEqual(readdirSync(dir).sort(), [r.db_file, r.uploads_file], "no .part files left");
    const dump = readFileSync(join(dir, r.db_file), "utf8");
    assert.ok(dump.startsWith("PGDMP"));
    assert.ok(JSON.parse(dump.slice(5)).args.includes("-Fc"), "custom format, which restore.sh's pg_restore reads");
    assert.equal(r.db_bytes, Buffer.byteLength(dump));
    const listed = execFileSync("tar", ["-tzf", r.uploads_file], { cwd: dir, encoding: "utf8" });
    assert.match(listed, /2026\/11\/photo\.jpg/, "the uploads archive holds the photos");
  });

  test("never overwrites a backup: a taken name waits for the next second", async () => {
    const { dir, uploads } = folders();
    const t0 = new Date(2026, 10, 23, 2, 0, 0);
    const taken = `db_${stampOf(t0)}_before-migrate-021.dump`;
    writeFileSync(join(dir, taken), "an older backup");
    let calls = 0;
    const now = () => new Date(t0.getTime() + (calls++ ? 1000 : 0));
    const r = await takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: pgDump("ok"), now, waitMs: 1 });
    assert.equal(r.db_file, `db_${stampOf(new Date(t0.getTime() + 1000))}_before-migrate-021.dump`);
    assert.equal(readFileSync(join(dir, taken), "utf8"), "an older backup");
  });

  test("a failed dump leaves no files and says why", async () => {
    const { dir, uploads } = folders();
    await assert.rejects(takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: pgDump("fail") }), /Connection refused/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("something that isn't a dump doesn't count, even with exit code 0", async () => {
    const { dir, uploads } = folders();
    await assert.rejects(takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: pgDump("junk") }), /didn't write a database dump/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("if the uploads archive fails, the half pair is removed too", async () => {
    const { dir, uploads } = folders();
    await assert.rejects(
      takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: pgDump("ok"), tar: [process.execPath, failTar] }),
      /No space left on device/,
    );
    assert.deepEqual(readdirSync(dir), []);
  });

  test("a missing pg_dump is a failure, not a crash", async () => {
    const { dir, uploads } = folders();
    await assert.rejects(takeBackup("before-migrate-021", { dir, uploadDir: uploads, pgDump: [join(tools, "no-such-pg_dump")] }), /couldn't start/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("labels are backup.sh's: lowercase letters, digits, dashes", async () => {
    const { dir, uploads } = folders();
    for (const bad of ["", "Before", "a b", "../x", "x".repeat(101)]) {
      await assert.rejects(takeBackup(bad, { dir, uploadDir: uploads, pgDump: pgDump("ok") }), /label/);
    }
  });

  test("the connection comes from DATABASE_URL as PG* variables, password off the command line", async () => {
    const env = pgEnv("postgres://gc%40x:p%40ss@db.example:5433/gc_test?sslmode=require");
    assert.equal(env.PGHOST, "db.example");
    assert.equal(env.PGPORT, "5433");
    assert.equal(env.PGUSER, "gc@x");
    assert.equal(env.PGPASSWORD, "p@ss");
    assert.equal(env.PGDATABASE, "gc_test");
    assert.equal(env.PGSSLMODE, "require");
    assert.equal(pgEnv("postgres://[::1]:5432/x").PGHOST, "::1");
    const { dir, uploads } = folders();
    const saved = process.env.DATABASE_URL;
    const r = await takeBackup("x", { dir, uploadDir: uploads, pgDump: pgDump("ok") });
    const seen = JSON.parse(readFileSync(join(dir, r.db_file), "utf8").slice(5));
    assert.ok(!seen.args.some((a: string) => /postgres:\/\//.test(a)), "no connection URL in the arguments");
    assert.equal(process.env.DATABASE_URL, saved);
  });

  test("the backup folder summary counts complete pairs only", async () => {
    assert.equal(await backupFolderSummary(join(tools, "missing")), null);
    const dir = mkdtempSync(join(tmpdir(), "gc-backups-"));
    assert.deepEqual(await backupFolderSummary(dir), { pairs: 0, newest: null });
    const pair = (stamp: string, when: Date) => {
      for (const f of [`db_${stamp}.dump`, `uploads_${stamp}.tar.gz`]) {
        writeFileSync(join(dir, f), "x");
        utimesSync(join(dir, f), when, when);
      }
    };
    pair("2026-11-20_020011", new Date(2026, 10, 20, 2, 0, 11));
    pair("2026-11-21_0200", new Date(2026, 10, 21, 2, 0)); // an older script's HHMM name
    pair("2026-11-22_101500_before-update", new Date(2026, 10, 22, 10, 15));
    writeFileSync(join(dir, "db_2026-11-23_020000.dump"), "x"); // its uploads archive never finished
    writeFileSync(join(dir, "db_2026-11-23_030000.dump.part"), "x");
    const s = await backupFolderSummary(dir);
    assert.equal(s!.pairs, 3);
    assert.equal(s!.newest!.stamp, "2026-11-22_101500_before-update");
    assert.ok(existsSync(join(dir, "db_2026-11-23_020000.dump")), "only looks, never touches");
  });
});

describe("update check versions", () => {
  const v = (s: string) => parseVersion(s)!;
  test("parses release tags", () => {
    assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [] });
    assert.deepEqual(parseVersion("1.2.3-beta.1+build.5"), { major: 1, minor: 2, patch: 3, pre: ["beta", "1"] });
    for (const bad of ["", "1.2", "latest", "v1.2.3.4", "01.2.3", "1.2.3-", null, undefined]) assert.equal(parseVersion(bad), null, String(bad));
  });

  test("orders versions like semver", () => {
    const order = ["0.1.0", "0.9.0", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(compareVersions(v(order[i]), v(order[i + 1])) < 0, `${order[i]} < ${order[i + 1]}`);
      assert.ok(compareVersions(v(order[i + 1]), v(order[i])) > 0, `${order[i + 1]} > ${order[i]}`);
    }
    assert.equal(compareVersions(v("v1.2.3"), v("1.2.3+other")), 0);
  });
});

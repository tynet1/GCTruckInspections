// End-to-end API tests against a real Postgres.
// Needs TEST_DATABASE_URL pointing at an empty, disposable database, e.g.
//   TEST_DATABASE_URL=postgres://gc:gcdev@localhost:54329/gc_test npm test
// The test drops and recreates the public schema, so never point it at real data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test("api tests", { skip: "set TEST_DATABASE_URL to run" }, () => {});
} else {
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "gc-uploads-"));
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "admin-password-1";
  process.env.LOG_LEVEL = "silent";

  const { pool, q, one } = await import("../src/db.ts");
  const { migrate } = await import("../src/migrate.ts");
  const { ensureAdmin, seedVehicles } = await import("../src/seed.ts");
  const { buildApp } = await import("../src/server.ts");
  const { hashSecret } = await import("../src/auth.ts");
  const { closePdfBrowser } = await import("../src/pdf.ts");
  const { cleanupOrphanPhotos } = await import("../src/routes/photos.ts");

  // 1x1 PNG and a tiny JPEG header are enough for the type sniffing.
  const PNG = "data:image/png;base64," + Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1),
  ]).toString("base64");
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);

  let app: Awaited<ReturnType<typeof buildApp>>;
  let crewCookie = "";
  let supCookie = "";
  let vehicleId = 0;
  let checklist: { id: number; section: string }[] = [];

  const H = { "x-gc-app": "1" };
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0];

  async function inject(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return app.inject({
      method: method as "GET",
      url: "/api" + path,
      headers: { ...H, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function submitBody(over: Record<string, unknown> = {}): Record<string, any> {
    const items = checklist.filter((c) => c.section !== "trailer").map((c) => ({ checklist_item_id: c.id, result: "ok" }));
    return {
      client_id: randomUUID(),
      vehicle_id: vehicleId,
      inspection_date: "2026-11-10",
      inspector_name: "Casey Crew",
      mileage: 48210,
      oil_change_due: false,
      existing_notes: "Scratch on tailgate",
      new_observations: null,
      comments: "All good",
      trailer: null,
      items,
      damage: [{ key: "a1", diagram: "truck", x: 0.25, y: 0.5, note: "Dent, rear quarter" }],
      photos: [],
      signature: PNG,
      ...over,
    };
  }

  /** Multipart POST: text fields first, then the file (the order the server reads them in). */
  async function postFile(cookie: string, path: string, fields: Record<string, string>, file: Buffer, filename = "a.jpg") {
    const boundary = "----gc" + randomUUID();
    const parts = Object.entries(fields).map(([k, v]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    const body = Buffer.concat([
      ...parts,
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: "POST", url: "/api" + path, payload: body,
      headers: { ...H, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
  }

  async function uploadPhoto(cookie: string, id = randomUUID()) {
    const boundary = "----gc" + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST", url: "/api/photos", payload: body,
      headers: { ...H, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    return { res, id };
  }

  before(async () => {
    await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(() => {});
    await ensureAdmin(() => {});
    await seedVehicles(() => {});
    await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Casey Crew', 'crew', $1)`, [await hashSecret("1234")]);
    await q(`INSERT INTO users (name, role, email, password_hash) VALUES ('Sam Super', 'supervisor', 'sup@test.local', $1)`,
      [await hashSecret("super-password-1")]);
    app = await buildApp({ logger: false });
    const v = await one(`SELECT id FROM vehicles WHERE truck_code = 'AZ018'`);
    vehicleId = v.id;
    checklist = await q(`SELECT id, section FROM checklist_items WHERE active ORDER BY section, sort_order`);
  });

  after(async () => {
    await app?.close();
    await closePdfBrowser();
    await pool.end();
  });

  describe("auth", () => {
    test("crew list shows PIN users only", async () => {
      const res = await inject("GET", "/auth/crew");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().map((u: { name: string }) => u.name), ["Casey Crew"]);
    });

    test("wrong PIN is refused, right PIN signs in", async () => {
      const crew = await one(`SELECT id FROM users WHERE name = 'Casey Crew'`);
      const bad = await inject("POST", "/auth/pin", { body: { user_id: crew.id, pin: "9999" } });
      assert.equal(bad.statusCode, 401);
      const ok = await inject("POST", "/auth/pin", { body: { user_id: crew.id, pin: "1234" } });
      assert.equal(ok.statusCode, 200);
      crewCookie = cookieOf(ok);
      const me = await inject("GET", "/me", { cookie: crewCookie });
      assert.equal(me.json().role, "crew");
    });

    test("supervisor signs in with email and password", async () => {
      const ok = await inject("POST", "/auth/login", { body: { email: "SUP@test.local", password: "super-password-1" } });
      assert.equal(ok.statusCode, 200);
      supCookie = cookieOf(ok);
    });

    test("five wrong PINs lock the account", async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Lock Me', 'crew', $1)`, [await hashSecret("4321")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Lock Me'`);
      for (let i = 0; i < 5; i++) await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "0000" } });
      const res = await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "4321" } });
      assert.equal(res.statusCode, 429);
    });

    test("API refuses writes without the app header (CSRF guard)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/inspections", headers: { cookie: crewCookie }, payload: {} });
      assert.equal(res.statusCode, 403);
    });

    test("signed-out requests get 401", async () => {
      assert.equal((await inject("GET", "/vehicles")).statusCode, 401);
    });
  });

  describe("vehicles", () => {
    test("seeded fleet and diagrams", async () => {
      const res = await inject("GET", "/vehicles", { cookie: crewCookie });
      const list = res.json();
      assert.equal(list.length, 39);
      const az018 = list.find((v: { truck_code: string }) => v.truck_code === "AZ018");
      assert.equal(az018.diagram_url, "/diagrams/az018-truck.jpg");
      const az053 = list.find((v: { truck_code: string }) => v.truck_code === "AZ053");
      assert.equal(az053.diagram_url, "/diagrams/ford-f650.jpg");
      assert.equal(az053.pulls_trailer, false);
    });

    test("form config has 16 + 16 + 17 checklist items", async () => {
      const cfg = (await inject("GET", "/form-config", { cookie: crewCookie })).json();
      const count = (s: string) => cfg.checklist.filter((c: { section: string }) => c.section === s).length;
      assert.deepEqual([count("exterior"), count("interior"), count("trailer")], [16, 16, 17]);
      assert.equal(cfg.trailer_diagram_url, "/diagrams/trailer.jpg");
    });
  });

  describe("inspections", () => {
    let firstId = "";

    test("submit with a photo on a damage pin and a repair item", async () => {
      const { res: up, id: photoId } = await uploadPhoto(crewCookie);
      assert.equal(up.statusCode, 201);
      const again = await uploadPhoto(crewCookie, photoId);
      assert.equal(again.res.statusCode, 200, "re-uploading the same photo id is a no-op");

      const body = submitBody();
      const repairId = checklist[3].id;
      body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((i) =>
        i.checklist_item_id === repairId ? { ...i, result: "repair", note: "Left tail light out" } : i);
      body.photos = [{ id: photoId, caption: "Dent", damage_key: "a1" }];
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      firstId = res.json().id;

      const detail = (await inject("GET", `/inspections/${firstId}`, { cookie: crewCookie })).json();
      assert.equal(detail.items.length, 32);
      assert.equal(detail.items.filter((i: { result: string }) => i.result === "repair").length, 1);
      assert.equal(detail.damage[0].seq, 1);
      assert.equal(detail.photos[0].damage_mark_id, detail.damage[0].id);
      assert.equal(detail.status, "submitted");
    });

    test("retrying the same client_id returns the same record", async () => {
      const body = submitBody({ mileage: 48300 });
      const a = await inject("POST", "/inspections", { cookie: crewCookie, body });
      const b = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(a.statusCode, 201);
      assert.equal(b.statusCode, 200);
      assert.equal(a.json().id, b.json().id);
      assert.equal(b.json().duplicate, true);
    });

    test("a double tap (two submits at once) creates one record", async () => {
      const body = submitBody({ mileage: 48400 });
      const [a, b] = await Promise.all([
        inject("POST", "/inspections", { cookie: crewCookie, body }),
        inject("POST", "/inspections", { cookie: crewCookie, body }),
      ]);
      assert.equal(a.json().id, b.json().id);
      const n = await one(`SELECT count(*)::int AS n FROM inspections WHERE client_id = $1`, [body.client_id]);
      assert.equal(n.n, 1);
    });

    test("unanswered checklist items are refused with the list", async () => {
      const body = submitBody();
      body.items = (body.items as unknown[]).slice(2);
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.missing.length, 2);
    });

    test("trailer on means the 17 trailer items are required too", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ trailer: { number: "T-12", plate: "ABC123" } }) });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.missing.length, 17);
    });

    test("a Repair without a note is refused", async () => {
      const body = submitBody();
      (body.items as { result: string }[])[0].result = "repair";
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 422);
    });

    test("signature is required", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ signature: null }) });
      assert.equal(res.statusCode, 400);
    });

    test("photos that were never uploaded are reported", async () => {
      const res = await inject("POST", "/inspections", {
        cookie: crewCookie, body: submitBody({ photos: [{ id: randomUUID() }] }),
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().details.code, "photos_missing");
    });

    test("lower mileage is allowed but flagged", async () => {
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body: submitBody({ mileage: 1000 }) });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().mileage_flagged, true);
    });

    test("last inspection feeds the next form (notes and grey pins)", async () => {
      const last = (await inject("GET", `/vehicles/${vehicleId}/last`, { cookie: crewCookie })).json();
      assert.equal(last.inspection.existing_notes, "Scratch on tailgate");
      assert.equal(last.damage.length, 1);
      assert.equal(last.damage[0].diagram, "truck");
    });

    test("crew can't sign off; supervisor can, once", async () => {
      const crew = await inject("POST", `/inspections/${firstId}/review`, { cookie: crewCookie, body: { signature: PNG } });
      assert.equal(crew.statusCode, 403);
      const sup = await inject("POST", `/inspections/${firstId}/review`, { cookie: supCookie, body: { signature: PNG, note: "Odometer checked" } });
      assert.equal(sup.statusCode, 200, sup.body);
      const again = await inject("POST", `/inspections/${firstId}/review`, { cookie: supCookie, body: { signature: PNG } });
      assert.equal(again.statusCode, 409);
      const d = (await inject("GET", `/inspections/${firstId}`, { cookie: crewCookie })).json();
      assert.equal(d.status, "reviewed");
      assert.equal(d.supervisor.name, "Sam Super");
      assert.equal(d.supervisor.note, "Odometer checked");
    });

    test("supervisor resolves a repair; it leaves the open list", async () => {
      const before = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      const open = before.openRepairs.length;
      assert.ok(open >= 1);
      const item = before.openRepairs[0];
      assert.equal((await inject("POST", `/inspection-items/${item.id}/resolve`, { cookie: crewCookie, body: { note: "x" } })).statusCode, 403);
      const r = await inject("POST", `/inspection-items/${item.id}/resolve`, { cookie: supCookie, body: { note: "Replaced bulb" } });
      assert.equal(r.statusCode, 200);
      const afterRes = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      assert.equal(afterRes.openRepairs.length, open - 1);
    });

    test("submitted inspections are read-only in the database", async () => {
      await assert.rejects(q(`UPDATE inspections SET mileage = 1 WHERE id = $1`, [firstId]), /read-only/);
      await assert.rejects(q(`UPDATE inspection_items SET result = 'ok' WHERE inspection_id = $1`, [firstId]), /read-only/);
      await assert.rejects(q(`UPDATE damage_marks SET note = 'x' WHERE inspection_id = $1`, [firstId]), /read-only/);
    });

    test("PDF export (supervisor only)", { timeout: 60000 }, async () => {
      assert.equal((await inject("GET", `/inspections/${firstId}/pdf`, { cookie: crewCookie })).statusCode, 403);
      const res = await inject("GET", `/inspections/${firstId}/pdf`, { cookie: supCookie });
      assert.equal(res.statusCode, 200, res.body.slice(0, 200));
      assert.equal(res.headers["content-type"], "application/pdf");
      assert.match(String(res.headers["content-disposition"]), /AZ018_2026-11-10_inspection\.pdf/);
      assert.equal(res.rawPayload.subarray(0, 4).toString(), "%PDF");
    });
  });

  describe("admin", () => {
    let adminCookie = "";
    before(async () => {
      const login = await inject("POST", "/auth/login", { body: { email: "admin@test.local", password: "admin-password-1" } });
      adminCookie = cookieOf(login);
    });

    test("only admins reach admin routes", async () => {
      assert.equal((await inject("GET", "/admin/users", { cookie: supCookie })).statusCode, 403);
    });

    test("admin sets a truck's trailer type and diagram; old inspections keep the pictures they were drawn on", async () => {
      const trl = await postFile(adminCookie, "/admin/diagrams", { kind: "trailer", name: "16 ft dump trailer" }, JPEG);
      assert.equal(trl.statusCode, 201, trl.body);
      const body = await postFile(adminCookie, "/admin/diagrams", { kind: "truck", name: "Test body" }, JPEG);
      const trailerId = trl.json().id;
      const truckDiaId = body.json().id;
      const old = await one(`SELECT id, truck_diagram_id FROM inspections WHERE vehicle_id = $1 ORDER BY created_at LIMIT 1`, [vehicleId]);
      assert.ok(old.truck_diagram_id, "submit records the truck diagram");

      // A truck diagram can't be used as a trailer type.
      const wrong = await inject("PATCH", `/admin/vehicles/${vehicleId}`, { cookie: adminCookie, body: { trailer_diagram_id: truckDiaId } });
      assert.equal(wrong.statusCode, 400);

      const res = await inject("PATCH", `/admin/vehicles/${vehicleId}`, {
        cookie: adminCookie, body: { trailer_diagram_id: trailerId, diagram_id: truckDiaId, plate: "NEW123" },
      });
      assert.equal(res.statusCode, 200, res.body);
      const v = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json().vehicle;
      assert.equal(v.pulls_trailer, true);
      assert.equal(v.trailer_type, "16 ft dump trailer");
      assert.equal(v.trailer_diagram_url, `/api/diagrams/${trailerId}/image`);
      assert.equal(v.diagram_url, `/api/diagrams/${truckDiaId}/image`);
      assert.equal(v.plate, "NEW123");

      const oldDetail = (await inject("GET", `/inspections/${old.id}`, { cookie: crewCookie })).json();
      assert.equal(oldDetail.truck_diagram_url, "/diagrams/az018-truck.jpg", "old pins stay on the old picture");
      const last = (await inject("GET", `/vehicles/${vehicleId}/last`, { cookie: crewCookie })).json();
      assert.equal(last.damage.length, 0, "grey pins from a different picture are not shown");

      // A new inspection with the trailer records the trailer type.
      const sub = submitBody({
        trailer: { number: "T-7", plate: "TRL7" },
        truck_diagram_id: truckDiaId,
        trailer_diagram_id: trailerId,
        items: checklist.map((c) => ({ checklist_item_id: c.id, result: "ok" })),
        damage: [{ key: "t1", diagram: "trailer", x: 0.5, y: 0.5, note: "Bent fender" }],
        mileage: 60000,
      });
      const ins = await inject("POST", "/inspections", { cookie: crewCookie, body: sub });
      assert.equal(ins.statusCode, 201, ins.body);
      const d = (await inject("GET", `/inspections/${ins.json().id}`, { cookie: crewCookie })).json();
      assert.equal(d.trailer.type, "16 ft dump trailer");
      assert.equal(d.trailer_diagram_url, `/api/diagrams/${trailerId}/image`);
      assert.equal(d.truck_diagram_url, `/api/diagrams/${truckDiaId}/image`);

      const none = await inject("PATCH", `/admin/vehicles/${vehicleId}`, { cookie: adminCookie, body: { trailer_diagram_id: "" } });
      assert.equal(none.json().pulls_trailer, false);
      assert.equal(none.json().trailer_type, null);
    });

    test("branding: anyone can read it, only admins change it", async () => {
      const def = (await inject("GET", "/branding")).json();
      assert.equal(def.company_name, "Grounds Control");
      assert.equal(def.logo_url, null);

      const notAdmin = await inject("PUT", "/admin/branding", { cookie: supCookie, body: { company_name: "X" } });
      assert.equal(notAdmin.statusCode, 403);
      const badColor = await inject("PUT", "/admin/branding", { cookie: adminCookie, body: { color: "green" } });
      assert.equal(badColor.statusCode, 400);
      const ok = await inject("PUT", "/admin/branding", {
        cookie: adminCookie, body: { company_name: "Acme Landscaping", app_name: "Truck Checks", color: "#1F5F8B" },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(ok.json(), { company_name: "Acme Landscaping", app_name: "Truck Checks", color: "#1f5f8b", logo_url: null });
    });

    test("branding: logo upload, serve, PDF and remove", { timeout: 60000 }, async () => {
      const notImage = await postFile(adminCookie, "/admin/branding/logo", {}, Buffer.from("not an image at all"), "logo.svg");
      assert.equal(notImage.statusCode, 400);
      const png = Buffer.from(PNG.split(",")[1], "base64");
      const up = await postFile(adminCookie, "/admin/branding/logo", {}, png, "logo.png");
      assert.equal(up.statusCode, 200, up.body);
      const logoUrl: string = up.json().logo_url;
      assert.match(logoUrl, /^\/api\/branding\/logo\?v=[0-9a-f]{8}$/);
      assert.equal(up.json().company_name, "Acme Landscaping", "other settings are kept");

      const img = await app.inject({ method: "GET", url: logoUrl });
      assert.equal(img.statusCode, 200);
      assert.equal(img.headers["content-type"], "image/png");
      assert.match(String(img.headers["cache-control"]), /immutable/);

      const insp = await one(`SELECT id FROM inspections ORDER BY created_at LIMIT 1`);
      const pdf = await inject("GET", `/inspections/${insp.id}/pdf`, { cookie: supCookie });
      assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));

      const del = await inject("DELETE", "/admin/branding/logo", { cookie: adminCookie });
      assert.equal(del.json().logo_url, null);
      assert.equal((await app.inject({ method: "GET", url: "/api/branding/logo" })).statusCode, 404);
    });

    test("admin can give someone the shop role", async () => {
      const add = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "Shop Test", role: "shop", pin: "2468" } });
      assert.equal(add.statusCode, 201, add.body);
    });

    test("admin adds a crew user who can then sign in", async () => {
      const add = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "New Crew", role: "crew", pin: "5555" } });
      assert.equal(add.statusCode, 201, add.body);
      const signin = await inject("POST", "/auth/pin", { body: { user_id: add.json().id, pin: "5555" } });
      assert.equal(signin.statusCode, 200);
      const bad = await inject("POST", "/admin/users", { cookie: adminCookie, body: { name: "x", role: "crew", pin: "12" } });
      assert.equal(bad.statusCode, 400);
    });
  });

  describe("maintenance log", () => {
    let shopCookie = "";
    let repairIds: number[] = [];
    let entryId = 0;
    let otherTruck = 0;

    function entryBody(over: Record<string, unknown> = {}) {
      return {
        client_id: randomUUID(),
        vehicle_id: vehicleId,
        service_date: "2026-11-10",
        mileage: 61000,
        category: "repair",
        description: "Replaced left tail light and brake light bulbs",
        parts: "2x 3157 bulbs",
        cost: "$18.40",
        performed_by: "Frank",
        ...over,
      };
    }

    before(async () => {
      await q(`INSERT INTO users (name, role, pin_hash) VALUES ('Frank Shop', 'shop', $1)`, [await hashSecret("1357")]);
      const u = await one(`SELECT id FROM users WHERE name = 'Frank Shop'`);
      shopCookie = cookieOf(await inject("POST", "/auth/pin", { body: { user_id: u.id, pin: "1357" } }));
      otherTruck = (await one(`SELECT id FROM vehicles WHERE truck_code = 'AZ053'`)).id;
      // A fresh inspection on AZ018 with two open repairs for the shop to fix.
      const body = submitBody({ mileage: 60500 });
      const [a, b] = [checklist[1].id, checklist[2].id];
      body.items = (body.items as { checklist_item_id: number; result: string; note?: string }[]).map((i) =>
        i.checklist_item_id === a || i.checklist_item_id === b ? { ...i, result: "repair", note: "Bulb out" } : i);
      const res = await inject("POST", "/inspections", { cookie: crewCookie, body });
      assert.equal(res.statusCode, 201, res.body);
      repairIds = (await q(`SELECT id FROM inspection_items WHERE inspection_id = $1 AND result = 'repair' ORDER BY id`, [res.json().id]))
        .map((r) => r.id);
      assert.equal(repairIds.length, 2);
    });

    test("who can see and write the log", async () => {
      assert.equal((await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: crewCookie })).statusCode, 403);
      assert.equal((await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: supCookie })).statusCode, 200);
      assert.equal((await inject("POST", "/service-logs", { cookie: supCookie, body: entryBody() })).statusCode, 403);
      assert.equal((await inject("POST", "/service-logs", { cookie: crewCookie, body: entryBody() })).statusCode, 403);
    });

    test("shop logs work that fixes a repair, with a receipt photo; a retry doesn't duplicate it", async () => {
      const { res: up, id: photoId } = await uploadPhoto(shopCookie);
      assert.equal(up.statusCode, 201);
      const body = entryBody({ repair_item_ids: [repairIds[0]], photos: [{ id: photoId, caption: "Receipt" }] });
      const a = await inject("POST", "/service-logs", { cookie: shopCookie, body });
      assert.equal(a.statusCode, 201, a.body);
      const b = await inject("POST", "/service-logs", { cookie: shopCookie, body });
      assert.equal(b.statusCode, 200);
      assert.equal(b.json().id, a.json().id);
      entryId = a.json().id;

      const e = (await inject("GET", `/service-logs/${entryId}`, { cookie: supCookie })).json();
      assert.equal(e.cost, 18.4);
      assert.equal(e.category_label, "Repair");
      assert.equal(e.repairs.length, 1);
      assert.equal(e.photos[0].caption, "Receipt");
      const item = await one(`SELECT resolved_at, resolution_note FROM inspection_items WHERE id = $1`, [repairIds[0]]);
      assert.ok(item.resolved_at, "the repair is closed");
      assert.match(item.resolution_note, /maintenance log/);
      const v = (await inject("GET", `/vehicles/${vehicleId}`, { cookie: crewCookie })).json();
      assert.ok(!v.openRepairs.some((r: { id: number }) => r.id === repairIds[0]));
    });

    test("bad input is refused", async () => {
      const noWork = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ description: " " }) });
      assert.equal(noWork.statusCode, 400);
      const badType = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ category: "paint" }) });
      assert.equal(badType.statusCode, 400);
      const badCost = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ cost: "lots" }) });
      assert.equal(badCost.statusCode, 400);
      const wrongTruck = await inject("POST", "/service-logs", {
        cookie: shopCookie, body: entryBody({ vehicle_id: otherTruck, repair_item_ids: [repairIds[1]] }),
      });
      assert.equal(wrongTruck.statusCode, 422);
      assert.equal(wrongTruck.json().details.code, "bad_repairs");
    });

    test("edits keep history; a stale edit is refused", async () => {
      const e = (await inject("GET", `/service-logs/${entryId}`, { cookie: shopCookie })).json();
      const ok = await inject("PATCH", `/service-logs/${entryId}`, {
        cookie: shopCookie, body: { version: e.version, cost: "21.90", repair_item_ids: [repairIds[1]] },
      });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().cost, 21.9);
      assert.equal(ok.json().repairs.length, 2);
      assert.deepEqual(ok.json().history[0].changes, [{ field: "cost", from: 18.4, to: 21.9 }]);
      const stale = await inject("PATCH", `/service-logs/${entryId}`, { cookie: shopCookie, body: { version: e.version, cost: "1" } });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().details.code, "stale");
    });

    test("next due shows on the truck", async () => {
      const r = await inject("POST", "/service-logs", {
        cookie: shopCookie,
        body: entryBody({ category: "oil_change", description: "Oil and filter", next_due_mileage: 61200, next_due_date: "2027-05-10" }),
      });
      assert.equal(r.statusCode, 201, r.body);
      const s = (await inject("GET", `/vehicles/${vehicleId}/service`, { cookie: shopCookie })).json();
      const oil = s.next_due.find((d: { category: string }) => d.category === "oil_change");
      assert.equal(oil.mileage, 61200);
      assert.equal(oil.state, "soon", "within 500 miles of the due mileage");
      assert.ok(s.entries.length >= 2);
    });

    test("voiding reopens the repairs it closed; entries and photos can't be deleted or changed in the database", async () => {
      const v = await inject("POST", `/service-logs/${entryId}/void`, { cookie: shopCookie, body: { reason: "Logged on the wrong day" } });
      assert.equal(v.statusCode, 200, v.body);
      assert.equal(v.json().voided.reason, "Logged on the wrong day");
      assert.equal(v.json().history.at(-1).voided, true);
      const open = await q(`SELECT id FROM inspection_items WHERE id = ANY($1::int[]) AND resolved_at IS NULL`, [repairIds]);
      assert.equal(open.length, 2, "both repairs are open again");
      assert.equal((await inject("PATCH", `/service-logs/${entryId}`, { cookie: shopCookie, body: { version: v.json().version, cost: "1" } })).statusCode, 409);
      assert.equal((await inject("POST", `/service-logs/${entryId}/void`, { cookie: shopCookie, body: { reason: "again" } })).statusCode, 409);

      // A reopened repair can be fixed by a new entry.
      const again = await inject("POST", "/service-logs", { cookie: shopCookie, body: entryBody({ repair_item_ids: [repairIds[0]] }) });
      assert.equal(again.statusCode, 201, again.body);

      await assert.rejects(q(`DELETE FROM service_logs WHERE id = $1`, [entryId]), /can't be deleted/);
      await assert.rejects(q(`UPDATE photos SET caption = 'x' WHERE service_log_id = $1`, [entryId]), /read-only/);
      await assert.rejects(q(`UPDATE service_log_history SET old_row = '{}'`), /can't be updated/);
    });

    test("orphan photo cleanup never removes maintenance photos", async () => {
      await pool.query(`ALTER TABLE photos DISABLE TRIGGER photos_immutable`);
      await q(`UPDATE photos SET created_at = now() - interval '30 days' WHERE service_log_id = $1`, [entryId]);
      await pool.query(`ALTER TABLE photos ENABLE TRIGGER photos_immutable`);
      await cleanupOrphanPhotos(() => {});
      const left = await q(`SELECT id FROM photos WHERE service_log_id = $1`, [entryId]);
      assert.equal(left.length, 1);
    });
  });
}

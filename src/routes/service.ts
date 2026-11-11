// Maintenance log (phase 2): the shop manager records work done on a truck.
// Data safety (SPEC §4a): entries are voided, never deleted; each edit keeps the previous version
// (database trigger); a stale edit is refused instead of overwriting someone else's change.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { requireRole } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { bad, conflict, HttpError, idParam, int, isValidDate, notFound, obj, reqStr, str, UUID_RE } from "../http.ts";

export const CATEGORIES: Record<string, string> = {
  oil_change: "Oil change",
  tires: "Tires",
  brakes: "Brakes",
  repair: "Repair",
  preventive: "Preventive maintenance",
  inspection: "Inspection / registration",
  other: "Other",
};

/**
 * Which open repairs the form ticks for you when you pick a type of work (matched on the checklist label,
 * truck sections only). They're only suggestions: the shop sees the ticks and can untick anything not fixed.
 */
export const AUTO_TICK: Record<string, { match: string; not?: string; sections: string[] }> = {
  oil_change: { match: "\\boil\\b", sections: ["exterior", "interior"] },
  tires: { match: "\\btires?\\b", sections: ["exterior", "interior"] },
  brakes: { match: "brake", not: "light", sections: ["exterior", "interior"] },
  inspection: { match: "registration|license plate|reg tag", sections: ["exterior", "interior"] },
};

/** Fields an entry has, in the order the history shows them. */
const FIELDS = [
  "service_date", "mileage", "category", "description", "parts", "cost", "performed_by", "vendor",
  "notes", "next_due_mileage", "next_due_date",
] as const;
type Field = (typeof FIELDS)[number];
type Fields = Partial<Record<Field, string | number | null>>;

const canRead = { preHandler: requireRole("supervisor", "shop") };
const canWrite = { preHandler: requireRole("admin", "shop") };

function optDate(v: unknown, label: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!isValidDate(s)) throw bad(`${label} must be a date.`);
  return s;
}

function money(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) throw bad("Cost must be an amount like 125.50.");
  return Number(s);
}

/** Validate entry fields. On create every required field must be there; on edit only what was sent. */
export function parseFields(b: Record<string, unknown>, creating: boolean): Fields {
  const f: Fields = {};
  const has = (k: string) => creating || b[k] !== undefined;
  if (has("service_date")) {
    const d = String(b.service_date ?? "");
    if (!isValidDate(d)) throw bad("Date is required.");
    const max = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    if (d > max || d < "2000-01-01") throw bad("Date looks wrong. Check the service date.");
    f.service_date = d;
  }
  if (has("mileage")) f.mileage = int(b.mileage, "Mileage", 0, 9_999_999);
  if (has("category")) {
    const c = String(b.category ?? "");
    if (!CATEGORIES[c]) throw bad("Pick the type of work.");
    f.category = c;
  }
  if (has("description")) f.description = reqStr(b.description, "Work done", 2000);
  if (b.parts !== undefined) f.parts = str(b.parts, "Parts", 2000);
  if (b.cost !== undefined) f.cost = money(b.cost);
  if (b.performed_by !== undefined) f.performed_by = str(b.performed_by, "Done by", 100);
  if (b.vendor !== undefined) f.vendor = str(b.vendor, "Vendor", 100);
  if (b.notes !== undefined) f.notes = str(b.notes, "Notes", 5000);
  if (b.next_due_mileage !== undefined) {
    f.next_due_mileage = b.next_due_mileage === null || b.next_due_mileage === ""
      ? null : int(b.next_due_mileage, "Next due mileage", 0, 9_999_999);
  }
  if (b.next_due_date !== undefined) f.next_due_date = optDate(b.next_due_date, "Next due date");
  return f;
}

function idList(v: unknown, field: string, max: number): number[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) throw bad(`${field} must be a list.`);
  return [...new Set(v.map((x) => int(x, field, 1)))];
}

function photoList(v: unknown): { id: string; caption: string | null }[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 40) throw bad("Too many photos.");
  const seen = new Set<string>();
  return v.map((x) => {
    const o = obj(x, "photo");
    const id = String(o.id ?? "").toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) throw bad("Each photo needs a unique id.");
    seen.add(id);
    return { id, caption: str(o.caption, "Photo caption", 300) };
  });
}

/** Photos must be uploaded by this user and not attached anywhere else (or already on this entry). */
async function checkPhotos(photos: { id: string }[], userId: number, entryId: number | null) {
  if (!photos.length) return;
  const ids = photos.map((p) => p.id);
  const found = await q(`SELECT id, inspection_id, service_log_id, uploaded_by FROM photos WHERE id = ANY($1::uuid[])`, [ids]);
  const ok = new Set(found
    .filter((f) => f.inspection_id == null && (f.service_log_id == null ? f.uploaded_by === userId : f.service_log_id === entryId))
    .map((f) => f.id));
  const notReady = ids.filter((id) => !ok.has(id));
  if (notReady.length) {
    throw new HttpError(422, "Some photos haven't finished uploading yet.", { code: "photos_missing", photos: notReady });
  }
}

async function attachPhotos(c: PoolClient, entryId: number, photos: { id: string; caption: string | null }[], userId: number) {
  for (const p of photos) {
    const r = await c.query(
      `UPDATE photos SET service_log_id = $2, caption = $3
        WHERE id = $1 AND uploaded_by = $4 AND inspection_id IS NULL AND service_log_id IS NULL`,
      [p.id, entryId, p.caption, userId],
    );
    if (r.rowCount === 1) continue;
    const mine = await c.query(`SELECT 1 FROM photos WHERE id = $1 AND service_log_id = $2`, [p.id, entryId]);
    if (!mine.rowCount) throw conflict("A photo couldn't be attached. Remove it and add it again.");
  }
}

/**
 * Link repair items (from this truck's inspections) to the entry and close the ones still open.
 * An item another entry already fixed is left alone, so a retried or offline save never fails on it.
 */
async function attachRepairs(c: PoolClient, entryId: number, vehicleId: number, ids: number[], userId: number, work: string) {
  if (!ids.length) return;
  const rows = (await c.query(
    `SELECT ii.id, ii.result, ii.resolved_at, i.vehicle_id,
            EXISTS (SELECT 1 FROM service_log_repairs r WHERE r.inspection_item_id = ii.id AND r.active) AS linked
       FROM inspection_items ii JOIN inspections i ON i.id = ii.inspection_id
      WHERE ii.id = ANY($1::int[])
      FOR UPDATE OF ii`,
    [ids],
  )).rows;
  const wrong = ids.filter((id) => {
    const r = rows.find((x) => x.id === id);
    return !r || r.result !== "repair" || r.vehicle_id !== vehicleId;
  });
  if (wrong.length) {
    throw new HttpError(422, "Some of the repairs picked aren't repairs on this truck. Reload and pick again.", { code: "bad_repairs", items: wrong });
  }
  const note = `Fixed (maintenance log): ${work}`.slice(0, 1000);
  for (const r of rows) {
    if (r.linked) continue;
    const here = !r.resolved_at;
    if (here) {
      await c.query(`UPDATE inspection_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
        [r.id, userId, note]);
    }
    await c.query(
      `INSERT INTO service_log_repairs (service_log_id, inspection_item_id, resolved_here) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [entryId, r.id, here],
    );
  }
}

const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

/** One entry with its repairs, photos and edit history. */
export async function loadEntry(id: number) {
  const e = await one(
    `SELECT s.*, v.truck_code, v.year, v.make, v.model,
            cu.name AS created_by_name, uu.name AS updated_by_name, vu.name AS voided_by_name
       FROM service_logs s
       JOIN vehicles v ON v.id = s.vehicle_id
       LEFT JOIN users cu ON cu.id = s.created_by
       LEFT JOIN users uu ON uu.id = s.updated_by
       LEFT JOIN users vu ON vu.id = s.voided_by
      WHERE s.id = $1`,
    [id],
  );
  if (!e) throw notFound("Maintenance entry not found.");
  const repairs = await q(
    `SELECT ii.id, ii.label_snapshot AS label, ii.section, ii.note, ii.resolved_at, r.active, r.resolved_here,
            i.id AS inspection_id, i.inspection_date
       FROM service_log_repairs r
       JOIN inspection_items ii ON ii.id = r.inspection_item_id
       JOIN inspections i ON i.id = ii.inspection_id
      WHERE r.service_log_id = $1
      ORDER BY i.inspection_date, ii.id`,
    [id],
  );
  const photos = await q(`SELECT id, caption FROM photos WHERE service_log_id = $1 ORDER BY created_at, id`, [id]);
  const hist = await q(
    `SELECT h.changed_at, h.old_row, u.name AS changed_by_name
       FROM service_log_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.service_log_id = $1 ORDER BY h.id`,
    [id],
  );
  // Each history row holds the version before a change; compare it with the next version.
  const versions = [...hist.map((h) => h.old_row as Record<string, unknown>), e];
  const history = hist.map((h, i) => {
    const before = versions[i];
    const after = versions[i + 1];
    const voided = !before.voided_at && !!after.voided_at;
    return {
      changed_at: h.changed_at,
      changed_by_name: h.changed_by_name,
      voided,
      changes: voided ? [] : FIELDS.filter((f) => !same(before[f], after[f])).map((f) => ({ field: f, from: before[f] ?? null, to: after[f] ?? null })),
    };
  });
  return {
    id: e.id,
    vehicle: { id: e.vehicle_id, truck_code: e.truck_code, year: e.year, make: e.make, model: e.model },
    ...Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? null])),
    category_label: CATEGORIES[e.category] ?? e.category,
    version: e.version,
    created_at: e.created_at,
    created_by_name: e.created_by_name,
    updated_at: e.updated_at,
    updated_by_name: e.updated_by_name,
    voided: e.voided_at ? { at: e.voided_at, by: e.voided_by_name, reason: e.void_reason } : null,
    repairs,
    photos,
    history,
  };
}

/**
 * Live (not voided) maintenance entries that fixed repairs on one inspection, oldest first, for the PDF.
 * `repairs` are the ones on this inspection; `other_repairs` counts any it fixed on other inspections.
 */
export interface MaintenanceEntry {
  id: number;
  service_date: string;
  mileage: number | null;
  category: string;
  category_label: string;
  description: string;
  parts: string | null;
  cost: number | null;
  performed_by: string | null;
  vendor: string | null;
  notes: string | null;
  created_at: Date;
  created_by_name: string | null;
  edits: number;
  repairs: { id: number; label: string; note: string | null }[];
  other_repairs: number;
  photos: { id: string; caption: string | null; file_path: string }[];
}

export async function maintenanceForInspection(inspectionId: string): Promise<MaintenanceEntry[]> {
  const entries = await q(
    `SELECT DISTINCT s.id, s.service_date, s.mileage, s.category, s.description, s.parts, s.cost, s.performed_by,
            s.vendor, s.notes, s.created_at, cu.name AS created_by_name,
            (SELECT count(*) FROM service_log_history h WHERE h.service_log_id = s.id)::int AS edits
       FROM service_log_repairs r
       JOIN inspection_items ii ON ii.id = r.inspection_item_id
       JOIN service_logs s ON s.id = r.service_log_id
       LEFT JOIN users cu ON cu.id = s.created_by
      WHERE ii.inspection_id = $1 AND r.active AND s.voided_at IS NULL
      ORDER BY s.service_date, s.id`,
    [inspectionId],
  );
  if (!entries.length) return [];
  const ids = entries.map((e) => e.id);
  const repairs = await q(
    `SELECT r.service_log_id, ii.id, ii.label_snapshot AS label, ii.note, (ii.inspection_id = $2) AS here
       FROM service_log_repairs r JOIN inspection_items ii ON ii.id = r.inspection_item_id
      WHERE r.service_log_id = ANY($1::int[]) AND r.active
      ORDER BY ii.section, ii.id`,
    [ids, inspectionId],
  );
  const photos = await q(
    `SELECT id, service_log_id, caption, file_path FROM photos WHERE service_log_id = ANY($1::int[]) ORDER BY created_at, id`,
    [ids],
  );
  return entries.map((e) => ({
    ...e,
    category_label: CATEGORIES[e.category] ?? e.category,
    repairs: repairs.filter((r) => r.service_log_id === e.id && r.here).map(({ id, label, note }) => ({ id, label, note })),
    other_repairs: repairs.filter((r) => r.service_log_id === e.id && !r.here).length,
    photos: photos.filter((p) => p.service_log_id === e.id).map(({ id, caption, file_path }) => ({ id, caption, file_path })),
  }));
}

const LIST_COLS = `
  s.id, s.vehicle_id, v.truck_code, s.service_date, s.mileage, s.category, s.description, s.cost,
  s.performed_by, s.vendor, (s.voided_at IS NOT NULL) AS voided,
  (SELECT count(*) FROM service_log_repairs r WHERE r.service_log_id = s.id AND r.active)::int AS repair_count,
  (SELECT count(*) FROM photos p WHERE p.service_log_id = s.id)::int AS photo_count`;

const withLabel = <T extends { category: string }>(r: T) => ({ ...r, category_label: CATEGORIES[r.category] ?? r.category });

class DuplicateSave extends Error {}

export default async function serviceRoutes(app: FastifyInstance) {
  app.get("/service-config", canRead, async () => ({
    categories: Object.entries(CATEGORIES).map(([id, label]) => ({ id, label, auto: AUTO_TICK[id] ?? null })),
  }));

  // A truck's maintenance history, plus what's due next.
  app.get("/vehicles/:id/service", canRead, async (req) => {
    const vid = idParam(req.params);
    if (!(await one(`SELECT 1 FROM vehicles WHERE id = $1`, [vid]))) throw notFound("Truck not found.");
    const entries = await q(
      `SELECT ${LIST_COLS} FROM service_logs s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.vehicle_id = $1 ORDER BY s.service_date DESC, s.id DESC LIMIT 500`,
      [vid],
    );
    const current = await one<{ miles: number | null }>(
      `SELECT GREATEST(
         (SELECT max(mileage) FROM inspections WHERE vehicle_id = $1),
         (SELECT max(mileage) FROM service_logs WHERE vehicle_id = $1 AND voided_at IS NULL)) AS miles`,
      [vid],
    );
    // Next due per type of work: from the newest live entry of that type (an older due date is out of date).
    const due = await q(
      `SELECT * FROM (
         SELECT DISTINCT ON (category) id, category, service_date, next_due_mileage, next_due_date,
                (next_due_date <= current_date) AS date_due, (next_due_date <= current_date + 14) AS date_soon
           FROM service_logs WHERE vehicle_id = $1 AND voided_at IS NULL
          ORDER BY category, service_date DESC, id DESC) d
        WHERE next_due_mileage IS NOT NULL OR next_due_date IS NOT NULL
        ORDER BY category`,
      [vid],
    );
    const miles = current?.miles ?? null;
    return {
      current_mileage: miles,
      next_due: due.map((d) => {
        const milesDue = d.next_due_mileage != null && miles != null && miles >= d.next_due_mileage;
        const milesSoon = d.next_due_mileage != null && miles != null && miles >= d.next_due_mileage - 500;
        return {
          entry_id: d.id,
          category: d.category,
          category_label: CATEGORIES[d.category] ?? d.category,
          mileage: d.next_due_mileage,
          date: d.next_due_date,
          state: milesDue || d.date_due ? "due" : milesSoon || d.date_soon ? "soon" : "ok",
        };
      }),
      entries: entries.map(withLabel),
    };
  });

  // Recent entries across the fleet (home screen).
  app.get("/service-logs", canRead, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string } | undefined)?.limit) || 20, 200);
    const rows = await q(
      `SELECT ${LIST_COLS} FROM service_logs s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.voided_at IS NULL ORDER BY s.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(withLabel);
  });

  app.get("/service-logs/:id", canRead, async (req) => loadEntry(idParam(req.params)));

  // New entry. Idempotent on client_id, like inspections, so a retried save never makes a duplicate.
  app.post("/service-logs", canWrite, async (req, reply) => {
    const user = req.user!;
    const b = obj(req.body);
    const clientId = String(b.client_id ?? "").toLowerCase();
    if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
    const dup = await one(`SELECT id FROM service_logs WHERE client_id = $1`, [clientId]);
    if (dup) return reply.code(200).send({ id: dup.id, duplicate: true });

    const vehicleId = int(b.vehicle_id, "vehicle_id", 1);
    if (!(await one(`SELECT 1 FROM vehicles WHERE id = $1`, [vehicleId]))) throw bad("That truck doesn't exist.");
    const f = parseFields(b, true);
    const repairs = idList(b.repair_item_ids, "repair_item_ids", 100);
    const photos = photoList(b.photos);
    await checkPhotos(photos, user.id, null);

    try {
      const id = await tx(async (c) => {
        const cols: Record<string, unknown> = { ...f, vehicle_id: vehicleId, client_id: clientId, created_by: user.id, updated_by: user.id };
        const keys = Object.keys(cols);
        const ins = await c.query(
          `INSERT INTO service_logs (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
           ON CONFLICT (client_id) DO NOTHING RETURNING id`,
          Object.values(cols),
        );
        if (!ins.rows[0]) throw new DuplicateSave();
        const newId: number = ins.rows[0].id;
        await attachRepairs(c, newId, vehicleId, repairs, user.id, String(f.description));
        await attachPhotos(c, newId, photos, user.id);
        return newId;
      });
      return reply.code(201).send({ id, duplicate: false });
    } catch (e) {
      if (e instanceof DuplicateSave) {
        const d = await one(`SELECT id FROM service_logs WHERE client_id = $1`, [clientId]);
        if (d) return reply.code(200).send({ id: d.id, duplicate: true });
      }
      throw e;
    }
  });

  // Edit. `version` must match the version the editor loaded; otherwise someone else changed it first.
  app.patch("/service-logs/:id", canWrite, async (req) => {
    const user = req.user!;
    const id = idParam(req.params);
    const b = obj(req.body);
    const version = int(b.version, "version", 1);
    const f = parseFields(b, false);
    const repairs = idList(b.repair_item_ids, "repair_item_ids", 100);
    const photos = photoList(b.photos);
    await checkPhotos(photos, user.id, id);

    await tx(async (c) => {
      const cur = (await c.query(`SELECT * FROM service_logs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw notFound("Maintenance entry not found.");
      if (cur.voided_at) throw conflict("This entry was voided, so it can't be changed.");
      if (cur.version !== version) {
        throw new HttpError(409, "Someone changed this entry after you opened it. Reload it, check their changes, then make yours again.",
          { code: "stale" });
      }
      const changed = (Object.keys(f) as Field[]).filter((k) => !same(cur[k], f[k]));
      if (changed.length || repairs.length || photos.length) {
        // Even an edit that only adds photos or repairs bumps the version and records who did it.
        await c.query(
          `UPDATE service_logs SET ${[...changed.map((k, i) => `${k} = $${i + 3}`), "updated_by = $2"].join(", ")} WHERE id = $1`,
          [id, user.id, ...changed.map((k) => f[k])],
        );
      }
      await attachRepairs(c, id, cur.vehicle_id, repairs, user.id, String(f.description ?? cur.description));
      await attachPhotos(c, id, photos, user.id);
    });
    return loadEntry(id);
  });

  // Void (never delete). Repairs this entry closed are reopened so they can be fixed by another entry.
  app.post("/service-logs/:id/void", canWrite, async (req) => {
    const user = req.user!;
    const id = idParam(req.params);
    const reason = reqStr(obj(req.body ?? {}).reason, "Reason", 500);
    await tx(async (c) => {
      const r = await c.query(
        `UPDATE service_logs SET voided_at = now(), voided_by = $2, void_reason = $3, updated_by = $2
          WHERE id = $1 AND voided_at IS NULL RETURNING id`,
        [id, user.id, reason],
      );
      if (!r.rowCount) {
        const exists = await c.query(`SELECT 1 FROM service_logs WHERE id = $1`, [id]);
        if (!exists.rowCount) throw notFound("Maintenance entry not found.");
        throw conflict("This entry was already voided.");
      }
      await c.query(
        `UPDATE inspection_items ii SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
           FROM service_log_repairs r
          WHERE r.service_log_id = $1 AND r.active AND r.resolved_here AND ii.id = r.inspection_item_id`,
        [id],
      );
      await c.query(`UPDATE service_log_repairs SET active = false WHERE service_log_id = $1`, [id]);
    });
    return loadEntry(id);
  });
}
